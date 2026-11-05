export const LOGGING_SITE_CUSTOMIZE = String.raw`
import marimohub_logging
marimohub_logging.chain_sitecustomize(__file__)
marimohub_logging.install()
`;

export const LOGGING_BOOTSTRAP = String.raw`
import atexit
import base64
import importlib.machinery
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import queue
import random
import sys
import threading
import time
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import weakref

_processors = []
_pid = None
_stopped = False
_diagnostic_lock = threading.Lock()
_RECORD_FIELDS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}
SHUTDOWN_TIMEOUT = 3


def diagnostic(reason, destination=None, count=None):
    event = {"event": "notebook_log_export", "reason": reason}
    if destination is not None:
        event["destination"] = destination
    if count is not None:
        event["dropped_records"] = count
    try:
        with _diagnostic_lock:
            print(json.dumps(event), file=sys.__stderr__)
    except Exception:
        pass


def chain_sitecustomize(current):
    try:
        own = Path(current).resolve().parent
        paths = [p for p in sys.path if Path(p or ".").resolve() != own]
        spec = importlib.machinery.PathFinder.find_spec("sitecustomize", paths)
        if spec is not None and spec.loader is not None:
            module = importlib.util.module_from_spec(spec)
            sys.modules["sitecustomize"] = module
            spec.loader.exec_module(module)
    except Exception:
        diagnostic("sitecustomize_failed")


def any_value(value, depth=0):
    if depth > 8:
        raise ValueError("Log attributes exceed the nesting limit")
    if value is None:
        return {}
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int) and -(2 ** 63) <= value < 2 ** 63:
        return {"intValue": str(value)}
    if isinstance(value, float) and math.isfinite(value):
        return {"doubleValue": value}
    if isinstance(value, bytes):
        return {"bytesValue": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [any_value(v, depth + 1) for v in value]}}
    if isinstance(value, dict):
        return {"kvlistValue": {"values": attributes(value, depth + 1)}}
    return {"stringValue": str(value)}


def attributes(values, depth=0):
    return [{"key": str(key), "value": any_value(value, depth)} for key, value in values.items()]


def encode_record(record):
    extra = {key: value for key, value in record.__dict__.items() if key not in _RECORD_FIELDS}
    extra.update({"code.file.path": record.pathname, "code.function.name": record.funcName, "code.line.number": record.lineno})
    if record.exc_info:
        kind, error, _ = record.exc_info
        extra.update({
            "exception.type": kind.__qualname__, "exception.message": str(error),
            "exception.stacktrace": logging.Formatter().formatException(record.exc_info),
        })
    entry = {
        "timeUnixNano": str(int(record.created * 1_000_000_000)),
        "observedTimeUnixNano": str(time.time_ns()),
        "severityNumber": max(1, min(24, (record.levelno // 10) * 4 + 1)),
        "severityText": record.levelname,
        "body": {"stringValue": record.getMessage()},
        "attributes": attributes(extra),
    }
    # Read an existing trace context without importing or configuring the user's OTel SDK.
    trace = sys.modules.get("opentelemetry.trace")
    if trace is not None:
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            entry.update(traceId=f"{context.trace_id:032x}", spanId=f"{context.span_id:016x}", flags=int(context.trace_flags))
    if len(json.dumps(entry).encode()) > 64 * 1024:
        raise ValueError("Log record exceeds the size limit")
    return record.name, entry


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        # Authentication headers must never follow redirects to another destination.
        return None


class Processor:
    def __init__(self, destination):
        self.name = destination["name"]
        self.url = destination["url"]
        url = urlsplit(self.url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("Invalid logs URL")
        self.headers = {**destination["headers"], "Content-Type": "application/json"}
        self.resource = {"attributes": attributes({
            **destination["attributes"], "service.name": destination["serviceName"],
            "marimohub.integration": self.name, "process.pid": os.getpid(),
        })}
        self.opener = build_opener(NoRedirect())
        self.queue = queue.Queue(maxsize=2048)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.pending = 0
        self.dropped = 0
        self.last_report = 0
        self.worker = threading.Thread(target=self.run, name="marimohub-log-export", daemon=True)

    def on_emit(self, record):
        encoded = encode_record(record)
        with self.lock:
            if self.stop.is_set():
                return
            try:
                self.queue.put_nowait(encoded)
                self.pending += 1
            except queue.Full:
                self.dropped += 1

    def export(self, batch):
        scopes = {}
        for name, record in batch:
            scopes.setdefault(name, []).append(record)
        payload = {"resourceLogs": [{"resource": self.resource, "scopeLogs": [
            {"scope": {"name": name}, "logRecords": records} for name, records in scopes.items()
        ]}]}
        request = Request(self.url, data=json.dumps(payload).encode(), headers=self.headers)
        deadline = time.monotonic() + 2
        for attempt in range(2):
            retry_after = None
            try:
                with self.opener.open(request, timeout=max(0.01, deadline - time.monotonic())) as response:
                    # Loki acknowledges OTLP ingestion with 204 and no response body.
                    if response.status == 204:
                        return 0
                    if response.status != 200:
                        return len(batch)
                    body = response.read(64 * 1024 + 1)
                if len(body) > 64 * 1024:
                    return len(batch)
                # Partial acceptance must not be retried: that would duplicate accepted records.
                rejected = int(json.loads(body or b"{}").get("partialSuccess", {}).get("rejectedLogRecords", 0))
                return rejected if 0 <= rejected <= len(batch) else len(batch)
            except HTTPError as error:
                try:
                    if error.code not in (429, 502, 503, 504):
                        return len(batch)
                    retry_after = error.headers.get("Retry-After")
                finally:
                    error.close()
            except (URLError, OSError):
                pass
            if attempt == 1:
                break
            delay = random.uniform(0.1, 0.3)
            if retry_after:
                try:
                    delay = max(0, int(retry_after))
                except ValueError:
                    try:
                        delay = max(0, parsedate_to_datetime(retry_after).timestamp() - time.time())
                    except (TypeError, ValueError, OverflowError):
                        pass
            if delay >= deadline - time.monotonic():
                break
            time.sleep(delay)
        return len(batch)

    def run(self):
        while not self.stop.is_set() or not self.queue.empty():
            try:
                batch = [self.queue.get(timeout=0.1)]
            except queue.Empty:
                continue
            self.stop.wait(0.2)
            while len(batch) < 64:
                try:
                    batch.append(self.queue.get_nowait())
                except queue.Empty:
                    break
            try:
                dropped = self.export(batch)
            except Exception:
                dropped = len(batch)
            with self.lock:
                self.pending -= len(batch)
                self.dropped += dropped
                if self.dropped and (self.stop.is_set() or time.monotonic() - self.last_report > 30):
                    diagnostic("delivery_failed_or_queue_full", self.name, self.dropped)
                    self.dropped = 0
                    self.last_report = time.monotonic()


class Handler(logging.Handler):
    def __init__(self, level, processor):
        super().__init__(level)
        self.processor = processor
        self.seen = weakref.WeakSet()

    def filter(self, record):
        return not record.name.startswith(("opentelemetry", "urllib3", "requests")) and super().filter(record)

    def emit(self, record):
        if record in self.seen:
            return
        self.seen.add(record)
        try:
            self.processor.on_emit(record)
        except Exception:
            diagnostic("record_encoding_failed")


def stop_processors(processors):
    deadline = time.monotonic() + SHUTDOWN_TIMEOUT
    for processor in processors:
        processor.stop.set()
    for processor in processors:
        if processor.worker.ident is not None:
            processor.worker.join(max(0, deadline - time.monotonic()))
        if processor.pending:
            diagnostic("shutdown_timeout", processor.name, processor.pending)


def shutdown():
    global _stopped
    if not _stopped:
        _stopped = True
        stop_processors(_processors)


def install():
    global _pid
    if _pid == os.getpid():
        return
    _pid = os.getpid()
    try:
        _install()
    except Exception:
        diagnostic("initialization_failed")


def _install():
    destinations = json.loads(Path(__file__).with_name("logging.json").read_text())
    from marimo import _loggers
    from marimo._runtime import handlers
    original_sigterm = handlers.construct_sigterm_handler
    marimo_logger = _loggers.marimo_logger()
    minimum = min(getattr(logging, d["level"]) for d in destinations)
    prepared = []
    try:
        for destination in destinations:
            processor = Processor(destination)
            prepared.append((processor, Handler(getattr(logging, destination["level"]), processor)))
        for processor, _ in prepared:
            processor.worker.start()
    except Exception:
        stop_processors([processor for processor, _ in prepared])
        raise

    root = logging.getLogger()
    if not root.handlers:
        # Adding a remote handler prevents logging.basicConfig() from installing
        # its default console handler. Resolve stderr per emit for cell output.
        class Stderr:
            def write(self, value):
                return sys.stderr.write(value)
            def flush(self):
                return sys.stderr.flush()
        console = logging.StreamHandler(Stderr())
        console.setLevel(root.level)
        console.setFormatter(logging.Formatter(logging.BASIC_FORMAT))
        root.addHandler(console)
    root.setLevel(min(root.level, minimum))
    # marimo resets its logger threshold at CLI and kernel startup. Keep remote
    # verbosity independent of the levels on its existing console/file handlers.
    original_set_level = _loggers.set_level
    def set_level(*args, **kwargs):
        original_set_level(*args, **kwargs)
        marimo_logger.setLevel(min(marimo_logger.level, minimum))
    _loggers.set_level = set_level
    marimo_logger.setLevel(min(marimo_logger.level, minimum))

    for processor, handler in prepared:
        _processors.append(processor)
        root.addHandler(handler)
        marimo_logger.addHandler(handler)

    atexit.register(shutdown)
    from multiprocessing.util import Finalize
    Finalize(None, shutdown, exitpriority=10)
    # marimo's kernel SIGTERM handler uses os._exit(), bypassing both exit hooks.
    def construct_sigterm_handler(kernel):
        original = original_sigterm(kernel)
        def terminate(signum, frame):
            shutdown()
            original(signum, frame)
        return terminate
    handlers.construct_sigterm_handler = construct_sigterm_handler

`;

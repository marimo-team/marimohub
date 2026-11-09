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
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, getproxies_environment, proxy_bypass_environment
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


def configure_proxy(request, proxies):
    proxy = proxies.get(request.type)
    if not proxy or proxy_bypass_environment(request.host, proxies):
        return
    proxy = urlsplit(proxy if "://" in proxy else request.type + "://" + proxy)
    if proxy.scheme not in ("http", "https") or not proxy.hostname:
        raise ValueError("Invalid proxy URL")
    if proxy.username and proxy.password:
        credentials = unquote(proxy.username) + ":" + unquote(proxy.password)
        request.add_header("Proxy-Authorization", "Basic " + base64.b64encode(credentials.encode()).decode("ascii"))
    request.add_unredirected_header("Host", request.host)
    request.set_proxy(unquote(proxy.netloc.rsplit("@", 1)[-1]), proxy.scheme)


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
        # Both macOS proxy discovery and bypass checks call fork-unsafe CFNetwork.
        self.proxies = getproxies_environment()
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
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
        configure_proxy(request, self.proxies)
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


EXCLUDED_LOGGERS = ("opentelemetry", "urllib3", "requests")


class Handler(logging.Handler):
    def __init__(self, level, processor, logger_names=()):
        super().__init__(level)
        self.processor = processor
        self.logger_filters = [logging.Filter(name) for name in logger_names]
        self.seen = weakref.WeakSet()

    def filter(self, record):
        name = record.name
        if self.logger_filters and not any(f.filter(record) for f in self.logger_filters):
            return False
        return not any(name == prefix or name.startswith(prefix + ".") for prefix in EXCLUDED_LOGGERS) and super().filter(record)

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


def arm_finalizer(_=None):
    from multiprocessing.util import Finalize
    Finalize(None, shutdown, exitpriority=10)


def after_fork():
    global _processors, _pid, _stopped, _diagnostic_lock
    # Only the calling thread survives fork. Never join inherited workers or
    # acquire their queues, events, or locks; another vanished thread may own them.
    _processors = []
    _pid = os.getpid()
    _stopped = False
    _diagnostic_lock = threading.Lock()
    try:
        for logger in (logging.getLogger(), logging.getLogger("marimo")):
            for handler in list(logger.handlers):
                if isinstance(handler, Handler):
                    logger.removeHandler(handler)
        _install(install_hooks=False)
    except Exception:
        diagnostic("initialization_failed")


def install():
    global _pid
    if _pid == os.getpid():
        return
    _pid = os.getpid()
    try:
        _install()
        if hasattr(os, "register_at_fork"):
            from multiprocessing.util import register_after_fork
            # multiprocessing clears inherited finalizers after os.register_at_fork
            # callbacks, then runs its own after-fork callbacks.
            register_after_fork(shutdown, arm_finalizer)
            os.register_at_fork(after_in_child=after_fork)
    except Exception:
        diagnostic("initialization_failed")


def _install(install_hooks=True):
    destinations = json.loads(Path(__file__).with_name("logging.json").read_text())
    minimum = min(getattr(logging, d["level"]) for d in destinations)
    prepared = []
    try:
        for destination in destinations:
            processor = Processor(destination)
            prepared.append((processor, Handler(getattr(logging, destination["level"]), processor, destination.get("loggerNames", []))))
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
    marimo_logger = logging.getLogger("marimo")
    marimo_logger.setLevel(min(marimo_logger.level, minimum))

    for processor, handler in prepared:
        _processors.append(processor)
        root.addHandler(handler)
        marimo_logger.addHandler(handler)

    arm_finalizer()
    if install_hooks:
        atexit.register(shutdown)
        install_marimo_hooks(marimo_logger, minimum)


def install_marimo_hooks(marimo_logger, minimum):
    # marimo resets its logger threshold at CLI and kernel startup. Keep remote
    # verbosity independent of the levels on its existing console/file handlers.
    try:
        from marimo import _loggers
        original_set_level = _loggers.set_level
        if not callable(original_set_level):
            raise TypeError("Unsupported marimo level hook")
        def set_level(*args, **kwargs):
            original_set_level(*args, **kwargs)
            marimo_logger.setLevel(min(marimo_logger.level, minimum))
        _loggers.set_level = set_level
        marimo_logger.setLevel(min(marimo_logger.level, minimum))
    except Exception:
        diagnostic("marimo_level_hook_failed")

    # marimo's kernel SIGTERM handler uses os._exit(), bypassing both exit hooks.
    try:
        from marimo._runtime import handlers
        original_sigterm = handlers.construct_sigterm_handler
        if not callable(original_sigterm):
            raise TypeError("Unsupported marimo SIGTERM hook")
        def construct_sigterm_handler(kernel):
            original = original_sigterm(kernel)
            def terminate(signum, frame):
                shutdown()
                original(signum, frame)
            return terminate
        handlers.construct_sigterm_handler = construct_sigterm_handler
    except Exception:
        diagnostic("marimo_sigterm_hook_failed")

`;

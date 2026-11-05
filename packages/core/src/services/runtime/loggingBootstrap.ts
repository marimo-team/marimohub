export const LOGGING_SITE_CUSTOMIZE = String.raw`
import marimohub_logging
marimohub_logging.chain_sitecustomize(__file__)
marimohub_logging.install()
`;

export const LOGGING_BOOTSTRAP = String.raw`
import atexit
import importlib.machinery
import importlib.util
import json
import logging
import os
from pathlib import Path
import queue
import sys
import threading
import time
import weakref

_processors = []
_pid = None
_stopped = False
SHUTDOWN_TIMEOUT = 3


def diagnostic(reason, destination=None, count=None):
    event = {"event": "notebook_log_export", "reason": reason}
    if destination is not None:
        event["destination"] = destination
    if count is not None:
        event["dropped_records"] = count
    try:
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


def stop_processors(processors):
    deadline = time.monotonic() + SHUTDOWN_TIMEOUT
    for processor in processors:
        processor.stop.set()
    for processor in processors:
        processor.shutdown(max(0, deadline - time.monotonic()))
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
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler, LogRecordProcessor, ReadableLogRecord
    from opentelemetry.sdk._logs.export import LogRecordExportResult
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.exporter.otlp.proto.http import Compression
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    import requests

    class ExportSession(requests.Session):
        def post(self, *args, **kwargs):
            # Custom auth headers must never follow a redirect to another destination.
            kwargs["allow_redirects"] = False
            response = super().post(*args, **kwargs)
            if 300 <= response.status_code < 400:
                response.close()
                raise requests.exceptions.RequestException("OTLP redirects are disabled")
            return response

    class SafeDiagnostic(logging.Filter):
        def filter(self, record):
            record.msg = "Notebook OTLP export failed; check destination configuration and connectivity."
            record.args = ()
            record.exc_info = None
            record.exc_text = None
            return True

    def close_exporter(exporter, name):
        try:
            exporter.shutdown()
        except Exception:
            diagnostic("exporter_shutdown_failed", name)

    class Processor(LogRecordProcessor):
        def __init__(self, name, exporter):
            self.name = name
            self.exporter = exporter
            self.queue = queue.Queue(maxsize=2048)
            self.stop = threading.Event()
            self.condition = threading.Condition()
            self.pending = 0
            self.dropped = 0
            self.last_report = 0
            self.worker = threading.Thread(target=self.run, name="marimohub-log-export", daemon=True)

        def on_emit(self, record):
            readable = ReadableLogRecord(
                log_record=record.log_record, resource=record.resource,
                instrumentation_scope=record.instrumentation_scope, limits=record.limits,
            )
            with self.condition:
                if self.stop.is_set():
                    return
                try:
                    self.queue.put_nowait(readable)
                    self.pending += 1
                except queue.Full:
                    self.dropped += 1

        def run(self):
            try:
                while not self.stop.is_set() or not self.queue.empty():
                    try:
                        batch = [self.queue.get(timeout=0.1)]
                    except queue.Empty:
                        continue
                    # Allow short bursts to share a request without delaying shutdown.
                    self.stop.wait(0.2)
                    while len(batch) < 64:
                        try:
                            batch.append(self.queue.get_nowait())
                        except queue.Empty:
                            break
                    try:
                        success = self.exporter.export(batch) == LogRecordExportResult.SUCCESS
                    except Exception:
                        success = False
                    with self.condition:
                        self.pending -= len(batch)
                        if not success:
                            self.dropped += len(batch)
                        if self.dropped and (self.stop.is_set() or time.monotonic() - self.last_report > 30):
                            diagnostic("delivery_failed_or_queue_full", self.name, self.dropped)
                            self.dropped = 0
                            self.last_report = time.monotonic()
                        self.condition.notify_all()
            finally:
                close_exporter(self.exporter, self.name)

        def force_flush(self, timeout_millis=3000):
            with self.condition:
                return self.condition.wait_for(lambda: self.pending == 0, timeout=min(timeout_millis / 1000, SHUTDOWN_TIMEOUT))

        def shutdown(self, timeout=SHUTDOWN_TIMEOUT):
            self.stop.set()
            if self.worker.ident is None:
                close_exporter(self.exporter, self.name)
            else:
                self.worker.join(timeout)

    class Handler(LoggingHandler):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.seen = weakref.WeakSet()

        def filter(self, record):
            return not record.name.startswith(("opentelemetry", "urllib3", "requests")) and super().filter(record)

        def emit(self, record):
            if record in self.seen:
                return
            self.seen.add(record)
            try:
                super().emit(record)
            except Exception:
                diagnostic("record_encoding_failed")

        def flush(self):
            # One shared shutdown deadline covers every destination.
            pass

    destinations = json.loads(Path(__file__).with_name("logging.json").read_text())
    from marimo import _loggers
    from marimo._runtime import handlers
    original_sigterm = handlers.construct_sigterm_handler
    marimo_logger = _loggers.marimo_logger()
    minimum = min(getattr(logging, d["level"]) for d in destinations)
    prepared = []
    diagnostic_logger = logging.getLogger("opentelemetry.exporter.otlp.proto.http._log_exporter")
    diagnostic_filter = SafeDiagnostic()
    diagnostic_logger.addFilter(diagnostic_filter)
    try:
        for destination in destinations:
            session = ExportSession()
            try:
                session.auth = lambda request: request
                exporter = OTLPLogExporter(
                    endpoint=destination["url"], headers=destination["headers"],
                    timeout=2, compression=Compression.NoCompression, session=session,
                )
                # Empty SDK header mappings fall back to ambient OTEL_* credentials.
                session.headers.clear()
                session.headers.update({"Content-Type": "application/x-protobuf", **destination["headers"]})
                provider = LoggerProvider(resource=Resource({
                    **destination["attributes"], "service.name": destination["serviceName"],
                    "marimohub.integration": destination["name"], "process.pid": os.getpid(),
                }), shutdown_on_exit=False)
                processor = Processor(destination["name"], exporter)
                provider.add_log_record_processor(processor)
                handler = Handler(level=getattr(logging, destination["level"]), logger_provider=provider)
                prepared.append((processor, handler))
            except Exception:
                session.close()
                raise
        # A failed destination must not leave handlers or hooks from earlier destinations.
        for processor, _ in prepared:
            processor.worker.start()
    except Exception:
        try:
            stop_processors([processor for processor, _ in prepared])
        finally:
            diagnostic_logger.removeFilter(diagnostic_filter)
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

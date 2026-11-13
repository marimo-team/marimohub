import asyncio
import errno
from collections import deque
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import stat
import threading


class CaptureUnsupported(Exception):
    pass


MAX_ARTIFACT_BYTES = 25 * 1024 * 1024


def read_file(root, relative):
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise CaptureUnsupported("CAPTURE_INVALID_PATH")
            if metadata.st_size > MAX_ARTIFACT_BYTES:
                raise CaptureUnsupported("ARTIFACT_TOO_LARGE")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                content = source.read(MAX_ARTIFACT_BYTES + 1)
                if len(content) > MAX_ARTIFACT_BYTES:
                    raise CaptureUnsupported("ARTIFACT_TOO_LARGE")
                return content
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)


def write_file(target, chunks):
    target.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with target.open("xb") as output:
        for chunk in chunks:
            data = chunk.encode() if isinstance(chunk, str) else chunk
            total += len(data)
            if total > MAX_ARTIFACT_BYTES:
                raise CaptureUnsupported("ARTIFACT_TOO_LARGE")
            output.write(data)
        output.flush()
        os.fsync(output.fileno())


class CaptureGate:
    def __init__(self):
        self.closed = False
        self.notifications_closed = False
        self.active = set()
        self.activity_changed = asyncio.Event()
        self.resumed = asyncio.Event()
        self.resumed.set()
        self.pending = deque()
        self.pending_bytes = 0
        self.overflow = False
        self.autosave_failed = False
        self.lock = threading.RLock()
        self.app = None
        self.server = None

    def notification(self, callback, *args, **kwargs):
        with self.lock:
            if self.notifications_closed:
                size = sum(len(value) if isinstance(value, bytes) else len(repr(value)) for value in args)
                if len(self.pending) >= 10000 or self.pending_bytes + size > 32 * 1024 * 1024:
                    self.overflow = True
                    self.notifications_closed = False
                    while self.pending:
                        saved, values, named = self.pending.popleft()
                        saved(*values, **named)
                    self.pending_bytes = 0
                    callback(*args, **kwargs)
                    return
                self.pending.append((callback, args, kwargs))
                self.pending_bytes += size
                return
            callback(*args, **kwargs)

    def sessions(self):
        manager = getattr(self.app.state, "session_manager", None)
        sessions = getattr(manager, "sessions", None)
        if not isinstance(sessions, dict):
            raise CaptureUnsupported("CAPTURE_RUNTIME_UNSUPPORTED")
        return list(sessions.values())

    async def drain(self):
        self.closed = True
        self.resumed.clear()
        async def wait_idle():
            while self.active:
                self.activity_changed.clear()
                await self.activity_changed.wait()
        await asyncio.wait_for(wait_idle(), 15)
        with self.lock:
            self.notifications_closed = True
        for session in self.sessions():
            listener_found = False
            for extension in session.extensions:
                runner = getattr(extension, "_autosave_runner", None)
                if runner is not None:
                    listener_found = True
                    if not callable(getattr(runner, "drain", None)):
                        raise CaptureUnsupported("CAPTURE_RUNTIME_UNSUPPORTED")
                    await runner.drain()
            if not listener_found:
                raise CaptureUnsupported("CAPTURE_RUNTIME_UNSUPPORTED")
        if self.autosave_failed:
            raise CaptureUnsupported("CAPTURE_NATIVE_SAVE_FAILED")

    def resume(self):
        with self.lock:
            self.notifications_closed = False
            while self.pending:
                callback, args, kwargs = self.pending.popleft()
                callback(*args, **kwargs)
            self.pending_bytes = 0
            self.overflow = False
            self.closed = False
            self.resumed.set()

    def checkpoint(self, request):
        if not self.closed or not self.notifications_closed or self.active or self.overflow:
            raise CaptureUnsupported("CAPTURE_NOT_DRAINED")
        workdir = Path(request["workdir"]).resolve()
        entry = Path(request["entry"])
        if entry.is_absolute() or ".." in entry.parts:
            raise CaptureUnsupported("CAPTURE_INVALID_PATH")
        source = workdir / entry
        checkpoint = Path(request["checkpoint"])
        serializer = importlib.import_module("marimo._session.state.serialize").serialize_session_view
        metadata_hash = importlib.import_module("marimo._utils.inline_script_metadata").script_metadata_hash_from_filename
        matches = [session for session in self.sessions()
                   if session.app_file_manager.path is not None and Path(session.app_file_manager.path).resolve() == source.resolve()]
        if len(matches) > 1:
            raise CaptureUnsupported("CAPTURE_MULTIPLE_DOCUMENTS")
        try:
            source_bytes = read_file(workdir, entry)
        except FileNotFoundError:
            raise CaptureUnsupported('SOURCE_MISSING') from None
        write_file(checkpoint / entry, [source_bytes])
        try:
            deps = read_file(workdir, Path("pyproject.toml"))
        except FileNotFoundError:
            deps = None
        if deps is not None:
            write_file(checkpoint / "pyproject.toml", [deps])
        native_path = entry.parent / "__marimo__" / "session" / (entry.name + ".json")
        if matches:
            session = matches[0]
            snapshot = serializer(session.session_view, session.document.cell_ids,
                                  drop_virtual_file_outputs=True,
                                  script_metadata_hash=metadata_hash(str(source)))
            write_file(checkpoint / native_path, json.JSONEncoder().iterencode(snapshot))
        else:
            try:
                content = read_file(workdir, native_path)
            except FileNotFoundError:
                content = None
            if content is not None:
                json.loads(content)
                write_file(checkpoint / native_path, [content])
        html = entry.parent / "__marimo__" / (source.stem + ".html")
        try:
            write_file(checkpoint / html, [read_file(workdir, html)])
        except (OSError, CaptureUnsupported):
            (checkpoint / html).unlink(missing_ok=True)
        return {"ok": True, "capabilities": ["http-drain", "native-snapshot", "writer-pause"]}

    async def control(self, reader, writer):
        pause = False
        try:
            request = json.loads(await reader.readline())
            action = request.get("action")
            if action == 'status':
                response = {'ok': True, 'state': 'paused' if self.closed else 'running'}
            elif action == "drain":
                await self.drain()
                response = {"ok": True}
            elif action == "resume":
                self.resume()
                response = {"ok": True}
            elif action == "checkpoint":
                response = self.checkpoint(request)
                with (Path(request["checkpoint"]) / "ready.json").open("x") as ready:
                    json.dump(response, ready)
                    ready.flush()
                    os.fsync(ready.fileno())
                pause = True
            else:
                raise CaptureUnsupported("UNKNOWN_CAPTURE_OPERATION")
        except CaptureUnsupported as error:
            response = {"ok": False, "code": str(error)}
        except OSError as error:
            code = "CAPTURE_INVALID_PATH" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "CAPTURE_READ_FAILED"
            response = {"ok": False, "code": code}
        except Exception:
            response = {"ok": False, "code": "CAPTURE_UNAVAILABLE"}
        # No event-loop turn may admit another native mutation after the snapshot.
        if pause:
            os.kill(os.getpid(), signal.SIGSTOP)
        writer.write(json.dumps(response).encode() + b"\n")
        await writer.drain()
        writer.close()


class DrainMiddleware:
    def __init__(self, app, gate):
        self.app = app
        self.gate = gate

    async def __call__(self, scope, receive, send):
        gate = self.gate
        if scope["type"] == "lifespan":
            path = Path(os.environ["MARIMOHUB_LIFECYCLE_DIR"]) / "native.sock"
            if path.exists():
                path.unlink()
            gate.server = await asyncio.start_unix_server(gate.control, str(path), limit=64 * 1024)
            os.chmod(path, 0o600)
            try:
                await self.app(scope, receive, send)
            finally:
                gate.server.close()
                await gate.server.wait_closed()
            return
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        if gate.closed:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            else:
                body = b'{"code":"SESSION_CAPTURE_IN_PROGRESS"}'
                await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"application/json"), (b"retry-after", b"1")]})
                await send({"type": "http.response.body", "body": body})
            return
        task = asyncio.current_task()
        gate.active.add(task)
        accepted = False

        def idle():
            gate.active.discard(task)
            gate.activity_changed.set()

        async def wrapped_receive():
            if scope["type"] != "websocket":
                return await receive()
            if accepted:
                idle()
            message = await receive()
            await gate.resumed.wait()
            gate.active.add(task)
            return message

        async def wrapped_send(message):
            nonlocal accepted
            if message["type"] == "websocket.accept":
                accepted = True
            # Read-only streams can stay connected; their request setup is drained.
            if scope["type"] == "http" and scope["method"] in ("GET", "HEAD", "OPTIONS") and message["type"] == "http.response.body":
                idle()
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        finally:
            idle()


def install_status_only(directory):
    import socketserver
    import threading

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            request = json.loads(self.rfile.readline(64 * 1024))
            reply = {'ok': True, 'state': 'running'} if request.get('action') == 'status' else {'ok': False, 'code': 'CAPTURE_RUNTIME_UNSUPPORTED', 'state': 'running'}
            self.wfile.write(json.dumps(reply).encode() + b'\n')

    path = Path(directory) / 'native.sock'
    path.unlink(missing_ok=True)
    server = socketserver.ThreadingUnixStreamServer(str(path), Handler)
    os.chmod(path, 0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def install():
    version = importlib.metadata.version("marimo").split(".")
    if version[:2] != ["0", "24"]:
        raise CaptureUnsupported("CAPTURE_RUNTIME_UNSUPPORTED")
    gate = CaptureGate()
    extensions = importlib.import_module("marimo._session.extensions.extensions")
    listener = extensions.NotificationListenerExtension
    original_notification = listener._on_kernel_message

    def notification(self, session, message):
        gate.notification(original_notification, self, session, message)

    listener._on_kernel_message = notification
    session_type = importlib.import_module("marimo._session.session").SessionImpl
    original_notify = session_type.notify

    def notify(self, *args, **kwargs):
        gate.notification(original_notify, self, *args, **kwargs)

    session_type.notify = notify
    runner_type = extensions.SerialTaskRunner
    original_submit = runner_type.submit

    def submit(self, work, **kwargs):
        def tracked():
            try:
                result = work()
                gate.autosave_failed = False
                return result
            except Exception:
                gate.autosave_failed = True
                raise
        return original_submit(self, tracked if self._thread_name_prefix == "marimo-autosave" else work, **kwargs)

    runner_type.submit = submit
    module = importlib.import_module("marimo._server.main")
    create = module.create_starlette_app

    def create_app(*args, **kwargs):
        app = create(*args, **kwargs)
        gate.app = app
        app.add_middleware(DrainMiddleware, gate=gate)
        return app

    module.create_starlette_app = create_app
    return gate

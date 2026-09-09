#!/usr/bin/env python3
"""Small authenticated control agent for a private ECS Fargate task."""

from __future__ import annotations

import base64
import binascii
import hmac
import http.server
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any

PROTOCOL_VERSION = 2
MAX_BODY_BYTES = 40 * 1024 * 1024
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_WRITE_BATCH_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = ((MAX_FILE_BYTES + 2) // 3) * 4
MAX_LOG_BYTES = 64 * 1024


class AgentError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _bounded_timeout(value: Any, default: int = 30_000) -> float:
    if value is None:
        return default / 1000
    if isinstance(value, bool):
        raise AgentError(400, "timeoutMs must be an integer")
    try:
        milliseconds = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise AgentError(400, "timeoutMs must be an integer") from exc
    if isinstance(value, float) and value != milliseconds:
        raise AgentError(400, "timeoutMs must be an integer")
    if milliseconds < 0:
        raise AgentError(400, "timeoutMs must not be negative")
    return milliseconds / 1000


def _read_limited(path: str, limit: int) -> bytes:
    with open(path, "rb") as stream:
        data = stream.read(limit + 1)
    return data[:limit]


def _kill_group(process: subprocess.Popen[Any], sig: int = signal.SIGTERM) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        return


def _wait_process(process: subprocess.Popen[Any], timeout: float) -> int:
    try:
        return process.wait(timeout=None if timeout == 0 else timeout)
    except subprocess.TimeoutExpired:
        _kill_group(process, signal.SIGKILL)
        process.wait()
        return 124


class _BoundedCapture:
    def __init__(self, stream: Any, limit: int, keep_tail: bool):
        self._stream = stream
        self._limit = limit
        self._keep_tail = keep_tail
        self._data = bytearray()
        self._truncated = False
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        try:
            while chunk := self._stream.read(64 * 1024):
                with self._lock:
                    if self._keep_tail:
                        self._data.extend(chunk)
                        excess = len(self._data) - self._limit
                        if excess > 0:
                            self._truncated = True
                            del self._data[:excess]
                    else:
                        remaining = self._limit - len(self._data)
                        if len(chunk) > remaining:
                            self._truncated = True
                        if remaining > 0:
                            self._data.extend(chunk[:remaining])
        finally:
            self._stream.close()

    def wait(self) -> None:
        self._thread.join()

    def read(self) -> bytes:
        with self._lock:
            return bytes(self._data)

    def truncated(self) -> bool:
        with self._lock:
            return self._truncated


class ProcessTable:
    def __init__(self, state: "AgentState"):
        self._state = state
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def _remove(self, process_id: str, item: dict[str, Any]) -> None:
        with self._lock:
            if self._items.get(process_id) is item:
                del self._items[process_id]

    def _capture_finished(self, item: dict[str, Any]) -> None:
        with item["capture_lock"]:
            if item.get("captured"):
                return
            item["stdout_capture"].wait()
            item["stderr_capture"].wait()
            item["stdout_tail"] = item["stdout_capture"].read().decode(
                "utf-8", errors="replace"
            )
            item["stderr_tail"] = item["stderr_capture"].read().decode(
                "utf-8", errors="replace"
            )
            item["captured"] = True

    def _watch(self, item: dict[str, Any]) -> None:
        item["process"].wait()
        self._capture_finished(item)

    def _expire(self, process_id: str, item: dict[str, Any], timeout: float) -> None:
        process = item["process"]
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(process, signal.SIGKILL)
            process.wait()
        self._capture_finished(item)

    def start(self, payload: dict[str, Any]) -> str:
        command = payload.get("command")
        if not isinstance(command, str) or not command:
            raise AgentError(400, "command is required")
        process_id = payload.get("processId")
        if not isinstance(process_id, str) or not process_id or len(process_id) > 128:
            process_id = f"fargate-{uuid.uuid4().hex}"
        with self._lock:
            existing = self._items.get(process_id)
        if existing is not None:
            if existing["process"].poll() is None:
                raise AgentError(409, "process id already exists")
            self._remove(process_id, existing)
        cwd = payload.get("cwd", "/workspace")
        if not isinstance(cwd, str):
            raise AgentError(400, "cwd must be a string")
        timeout = _bounded_timeout(payload.get("timeoutMs"), 0)
        try:
            process = subprocess.Popen(
                ["sh", "-lc", command],
                cwd=cwd,
                env=self._state.environment(payload.get("env")),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            raise AgentError(400, f"could not start process: {exc.strerror or 'spawn failed'}") from exc
        if process.stdout is None or process.stderr is None:
            raise AgentError(500, "could not capture process output")
        item = {
            "process": process,
            "stdout_capture": _BoundedCapture(process.stdout, MAX_LOG_BYTES, True),
            "stderr_capture": _BoundedCapture(process.stderr, MAX_LOG_BYTES, True),
            "capture_lock": threading.Lock(),
        }
        conflicting = False
        with self._lock:
            existing = self._items.get(process_id)
            if existing is not None and existing["process"].poll() is None:
                conflicting = True
            else:
                if existing is not None:
                    del self._items[process_id]
                self._items[process_id] = item
        if conflicting:
            _kill_group(process, signal.SIGKILL)
            process.wait()
            self._capture_finished(item)
            raise AgentError(409, "process id already exists")
        if timeout:
            threading.Thread(
                target=self._expire,
                args=(process_id, item, timeout),
                daemon=True,
            ).start()
        else:
            threading.Thread(target=self._watch, args=(item,), daemon=True).start()
        return process_id

    def get(self, process_id: str) -> dict[str, Any]:
        with self._lock:
            item = self._items.get(process_id)
        if item is None:
            raise AgentError(404, "process not found")
        return item

    def kill(self, process_id: str, sig: int = signal.SIGTERM) -> None:
        item = self.get(process_id)
        _kill_group(item["process"], sig)
        try:
            item["process"].wait(timeout=1)
        except subprocess.TimeoutExpired:
            _kill_group(item["process"], signal.SIGKILL)
            item["process"].wait()
        self._capture_finished(item)
        self._remove(process_id, item)

    def logs(self, process_id: str) -> dict[str, str]:
        item = self.get(process_id)
        try:
            if item["process"].poll() is not None:
                self._capture_finished(item)
            if item.get("captured"):
                return {"stdout": item["stdout_tail"], "stderr": item["stderr_tail"]}
            return {
                "stdout": item["stdout_capture"].read().decode("utf-8", errors="replace"),
                "stderr": item["stderr_capture"].read().decode("utf-8", errors="replace"),
            }
        finally:
            if item["process"].poll() is not None:
                self._remove(process_id, item)


class AgentState:
    def __init__(self, token: str | None = None):
        self.token = token or os.environ.get("MARIMOHUB_AGENT_TOKEN", "")
        if len(self.token.encode("utf-8")) < 32:
            raise ValueError("MARIMOHUB_AGENT_TOKEN must be at least 32 bytes")
        self.forced: dict[str, str] = {}
        self.defaults: dict[str, str] = {}
        self._environment_lock = threading.Lock()
        self.processes = ProcessTable(self)

    def authenticate(self, supplied: str | None) -> bool:
        if not supplied:
            return False
        if supplied.lower().startswith("bearer "):
            supplied = supplied[7:].strip()
        return hmac.compare_digest(supplied.encode("utf-8"), self.token.encode("utf-8"))

    def environment(self, overrides: Any = None) -> dict[str, str]:
        values = dict(os.environ)
        values.pop("MARIMOHUB_AGENT_TOKEN", None)
        values.pop("MARIMOHUB_AGENT_SECRET", None)
        with self._environment_lock:
            defaults = dict(self.defaults)
            forced = dict(self.forced)
        for key, value in defaults.items():
            values.setdefault(key, value)
        if isinstance(overrides, dict):
            for key, value in overrides.items():
                if isinstance(key, str) and isinstance(value, str) and key not in {
                    "MARIMOHUB_AGENT_TOKEN",
                    "MARIMOHUB_AGENT_SECRET",
                }:
                    values[key] = value
        values.update(forced)
        values.pop("MARIMOHUB_AGENT_TOKEN", None)
        values.pop("MARIMOHUB_AGENT_SECRET", None)
        return values

    def update_environment(
        self, forced: dict[str, str], defaults: dict[str, str]
    ) -> None:
        with self._environment_lock:
            self.forced.update(forced)
            self.defaults.update(defaults)

    def execute(self, payload: dict[str, Any]) -> dict[str, Any]:
        command = payload.get("command")
        if not isinstance(command, str) or not command:
            raise AgentError(400, "command is required")
        cwd = payload.get("cwd", "/workspace")
        if not isinstance(cwd, str):
            raise AgentError(400, "cwd must be a string")
        try:
            process = subprocess.Popen(
                ["sh", "-lc", command],
                cwd=cwd,
                env=self.environment(payload.get("env")),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            raise AgentError(400, f"could not execute command: {exc.strerror or 'spawn failed'}") from exc
        if process.stdout is None or process.stderr is None:
            raise AgentError(500, "could not capture command output")
        stdout_capture = _BoundedCapture(process.stdout, MAX_OUTPUT_BYTES, False)
        stderr_capture = _BoundedCapture(process.stderr, MAX_OUTPUT_BYTES, False)
        code = _wait_process(process, _bounded_timeout(payload.get("timeoutMs")))
        stdout_capture.wait()
        stderr_capture.wait()
        if stdout_capture.truncated() or stderr_capture.truncated():
            return {
                "success": False,
                "exitCode": code,
                "stdout": "",
                "stderr": "command output exceeds the agent limit",
            }
        output = stdout_capture.read()
        error = stderr_capture.read()
        return {
            "success": code == 0,
            "exitCode": code,
            "stdout": output.decode("utf-8", errors="replace"),
            "stderr": error.decode("utf-8", errors="replace"),
        }


class AgentHandler(http.server.BaseHTTPRequestHandler):
    server_version = "marimohub-fargate-agent/1"

    @property
    def state(self) -> AgentState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        # Requests can contain notebook data and credentials; do not log them.
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, status: int = 204) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body(self) -> dict[str, Any]:
        value = self.headers.get("Content-Length")
        if value is None:
            raise AgentError(411, "Content-Length is required")
        try:
            length = int(value)
        except ValueError as exc:
            raise AgentError(400, "invalid Content-Length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise AgentError(413, "request body exceeds the agent limit")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise AgentError(400, "incomplete request body")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AgentError(400, "request body must be JSON") from exc
        if not isinstance(parsed, dict):
            raise AgentError(400, "request body must be an object")
        return parsed

    def _auth(self) -> None:
        if not self.state.authenticate(self.headers.get("Authorization")):
            raise AgentError(401, "unauthorized")

    def _dispatch(self, method: str) -> None:
        self._auth()
        path, _, query = self.path.partition("?")
        if method == "GET" and path == "/health":
            self._json(200, {"ok": True, "protocolVersion": PROTOCOL_VERSION, "agentVersion": "1"})
            return
        if method == "POST" and path in {"/exec", "/exec-stream"}:
            self._json(200, self.state.execute(self._body()))
            return
        if method == "GET" and path == "/files/read":
            values = urllib.parse.parse_qs(query)
            requested = values.get("path", [""])[0]
            if not requested:
                raise AgentError(400, "path is required")
            try:
                data = _read_limited(requested, MAX_FILE_BYTES + 1)
            except FileNotFoundError as exc:
                raise AgentError(404, "file not found") from exc
            except IsADirectoryError as exc:
                raise AgentError(400, "path is a directory") from exc
            if len(data) > MAX_FILE_BYTES:
                raise AgentError(413, "file exceeds the agent limit")
            self._json(200, {"contentBase64": base64.b64encode(data).decode("ascii")})
            return
        if method == "POST" and path == "/files/write":
            payload = self._body()
            files = payload.get("files")
            if not isinstance(files, list) or not files:
                raise AgentError(400, "files must be a non-empty list")
            total = 0
            decoded: list[tuple[str, bytes]] = []
            for entry in files:
                if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("contentBase64"), str):
                    raise AgentError(400, "each file requires path and contentBase64")
                try:
                    content = base64.b64decode(entry["contentBase64"], validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise AgentError(400, "invalid base64 file content") from exc
                if len(content) > MAX_FILE_BYTES:
                    raise AgentError(413, "file exceeds the agent limit")
                total += len(content)
                decoded.append((entry["path"], content))
            if len(decoded) > 1 and total > MAX_WRITE_BATCH_BYTES:
                raise AgentError(413, "file batch exceeds the preferred batch limit")
            for requested, content in decoded:
                parent = os.path.dirname(requested)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                temporary = f"{requested}.marimohub-{secrets.token_hex(6)}.tmp"
                with open(temporary, "wb") as stream:
                    stream.write(content)
                os.replace(temporary, requested)
            self._json(200, {"written": len(decoded)})
            return
        if method == "POST" and path == "/env":
            payload = self._body()
            forced = payload.get("forced", {})
            defaults = payload.get("defaults", {})
            if not isinstance(forced, dict) or not isinstance(defaults, dict):
                raise AgentError(400, "forced and defaults must be objects")
            for key, value in forced.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    raise AgentError(400, "environment values must be strings")
            for key, value in defaults.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    raise AgentError(400, "environment values must be strings")
            self.state.update_environment(
                {
                    key: value
                    for key, value in forced.items()
                    if key not in {"MARIMOHUB_AGENT_TOKEN", "MARIMOHUB_AGENT_SECRET"}
                },
                {
                    key: value
                    for key, value in defaults.items()
                    if key not in {"MARIMOHUB_AGENT_TOKEN", "MARIMOHUB_AGENT_SECRET"}
                },
            )
            self._json(200, {"ok": True})
            return
        if method == "POST" and path == "/processes":
            self._json(201, {"id": self.state.processes.start(self._body())})
            return
        if path.startswith("/processes/"):
            rest = path[len("/processes/") :]
            process_id, _, action = rest.partition("/")
            process_id = urllib.parse.unquote(process_id)
            if method == "POST" and action == "wait-port":
                payload = self._body()
                self._wait_port(process_id, payload)
                self._json(200, {"ready": True})
                return
            if method == "GET" and action == "logs":
                self._json(200, self.state.processes.logs(process_id))
                return
            if method == "DELETE" and not action:
                signal_name = urllib.parse.parse_qs(query).get("signal", ["TERM"])[0].upper()
                signals = {name.removeprefix("SIG"): value for name, value in signal.__dict__.items() if name.startswith("SIG") and isinstance(value, int)}
                sig = signals.get(signal_name)
                if sig is None or sig in {signal.SIGKILL, signal.SIGSTOP}:
                    raise AgentError(400, "unsupported process signal")
                self.state.processes.kill(process_id, sig)
                self._empty()
                return
        raise AgentError(404, "route not found")

    def _wait_port(self, process_id: str, payload: dict[str, Any]) -> None:
        item = self.state.processes.get(process_id)
        port = payload.get("port")
        if not isinstance(port, int) or port < 1 or port > 65535:
            raise AgentError(400, "port must be an integer between 1 and 65535")
        timeout = _bounded_timeout(payload.get("timeoutMs"), 30_000)
        mode = payload.get("mode", "tcp")
        path = payload.get("path", "/")
        deadline = time.monotonic() + timeout if timeout else None
        while deadline is None or time.monotonic() < deadline:
            if item["process"].poll() is not None:
                self.state.processes._capture_finished(item)
                raise AgentError(409, "process exited before port became ready")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2) as connection:
                    if mode == "http":
                        request = f"GET {path if isinstance(path, str) and path.startswith('/') else '/'} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                        connection.sendall(request.encode("ascii"))
                        if not connection.recv(64):
                            raise OSError("empty HTTP response")
                    return
            except OSError:
                time.sleep(0.05)
        raise AgentError(408, f"timed out waiting for port {port}")

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._dispatch("GET")
        except AgentError as exc:
            self._json(exc.status, {"error": str(exc)})
        except Exception:
            self._json(500, {"error": "agent request failed"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._dispatch("POST")
        except AgentError as exc:
            self._json(exc.status, {"error": str(exc)})
        except Exception:
            self._json(500, {"error": "agent request failed"})

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self._dispatch("DELETE")
        except AgentError as exc:
            self._json(exc.status, {"error": str(exc)})
        except Exception:
            self._json(500, {"error": "agent request failed"})


class AgentServer(http.server.ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], state: AgentState):
        super().__init__(address, AgentHandler)
        self.state = state
        self.daemon_threads = True


def run_server(host: str = "0.0.0.0", port: int | None = None, token: str | None = None) -> None:
    selected_port = port if port is not None else int(os.environ.get("MARIMOHUB_AGENT_PORT", "2717"))
    server = AgentServer((host, selected_port), AgentState(token))
    try:
        server.serve_forever()
    finally:
        server.server_close()


def check_health(host: str = "127.0.0.1", port: int | None = None, token: str | None = None) -> bool:
    selected_port = (
        port if port is not None else int(os.environ.get("MARIMOHUB_AGENT_PORT", "2717"))
    )
    selected_token = token or os.environ.get("MARIMOHUB_AGENT_TOKEN", "")
    request = urllib.request.Request(
        f"http://{host}:{selected_port}/health",
        headers={"Authorization": f"Bearer {selected_token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            body = json.load(response)
        return (
            response.status == 200
            and body.get("ok") is True
            and body.get("protocolVersion") == PROTOCOL_VERSION
        )
    except (AttributeError, OSError, ValueError):
        return False


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--token-fd":
        with os.fdopen(int(sys.argv[2]), "rb") as token_stream:
            inherited_token = token_stream.read().decode("utf-8")
        run_server(token=inherited_token)
        raise SystemExit(0)
    if sys.argv[1:]:
        raise SystemExit("usage: fargate_agent.py")
    token = os.environ.get("MARIMOHUB_AGENT_TOKEN", "")
    encoded_token = token.encode("utf-8")
    if len(encoded_token) > 4096:
        raise SystemExit("MARIMOHUB_AGENT_TOKEN must not exceed 4096 bytes")
    token_fd, token_writer = os.pipe()
    try:
        os.write(token_writer, encoded_token)
    finally:
        os.close(token_writer)
    os.set_inheritable(token_fd, True)
    try:
        environment = dict(os.environ)
        environment.pop("MARIMOHUB_AGENT_TOKEN", None)
        environment.pop("MARIMOHUB_AGENT_SECRET", None)
        os.execve(
            sys.executable,
            [sys.executable, os.path.abspath(__file__), "--token-fd", str(token_fd)],
            environment,
        )
    finally:
        os.close(token_fd)

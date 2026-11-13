import ctypes
import fcntl
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import uuid


class LifecycleError(Exception):
    pass


def exchange(path, request, timeout=20):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(path))
        connection.sendall(json.dumps(request).encode() + b"\n")
        response = connection.makefile("rb").readline(1024 * 1024)
    result = json.loads(response)
    if not result.get("ok"):
        raise LifecycleError(result.get("code", "CAPTURE_UNAVAILABLE"))
    return result


class ProcessTree:
    def __init__(self, root):
        self.root = root

    def table(self):
        result = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                result[int(entry.name)] = (int(fields[1]), fields[19], fields[0])
            except (FileNotFoundError, ProcessLookupError):
                pass
        return result

    def identity(self, pid):
        item = self.table().get(pid)
        return item[1] if item else None

    def signal(self, pid, identity, sig):
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            return
        try:
            if self.identity(pid) == identity:
                signal.pidfd_send_signal(descriptor, sig)
        except ProcessLookupError:
            pass
        finally:
            os.close(descriptor)

    def freeze(self, frozen, excluded=(), before_signal=lambda: None, deadline=None):
        deadline = deadline if deadline is not None else time.monotonic() + 20
        visited = {self.root}
        while True:
            if time.monotonic() >= deadline or len(visited) > 1024:
                raise LifecycleError('CAPTURE_DRAIN_TIMEOUT')
            table = self.table()
            children = [(pid, entry) for pid, entry in table.items()
                        if entry[0] in visited and pid not in visited]
            if not children:
                return frozen
            for pid, (_, identity, state) in children:
                if time.monotonic() >= deadline or len(visited) > 1024:
                    raise LifecycleError('CAPTURE_DRAIN_TIMEOUT')
                if pid not in excluded:
                    frozen[pid] = identity
                    before_signal()
                    self.signal(pid, identity, signal.SIGSTOP)
                    process_deadline = min(deadline, time.monotonic() + 2)
                    while True:
                        current = self.table().get(pid)
                        if not current or current[1] != identity or current[2] in ("T", "t", "Z"):
                            break
                        if time.monotonic() >= process_deadline:
                            raise LifecycleError("CAPTURE_DRAIN_TIMEOUT")
                        time.sleep(0.005)
                visited.add(pid)

    def resume(self, processes):
        for pid, identity in reversed(list(processes.items())):
            self.signal(pid, identity, signal.SIGCONT)

    def stop(self, processes):
        for pid, identity in processes.items():
            self.signal(pid, identity, signal.SIGKILL)


class Supervisor:
    def __init__(self, directory, worker, tree=None, clock=time.monotonic):
        self.directory = Path(directory)
        self.worker = worker
        self.tree = tree or ProcessTree(os.getpid())
        self.clock = clock
        self.lock = threading.RLock()
        self.attempt = None
        self.frozen = {}
        self.journal_failed = False
        self.receipt = self.directory / "stop.json"
        self.journal = self.directory / "attempt.json"
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.generation = json.loads(self.journal.read_text()).get('generation', 0) if self.journal.exists() else 0
        self.recover_stop()

    def recover_stop(self):
        if self.receipt.exists():
            receipt = json.loads(self.receipt.read_text())
            self.frozen = {int(pid): identity for pid, identity in receipt["processes"].items()}
            self.attempt = {"token": receipt["token"], "state": "stopped"}
            self.tree.stop(self.frozen)

    def native(self, action, **fields):
        return exchange(self.directory / "native.sock", {"action": action, **fields})

    def checkpoint(self, checkpoint, request):
        ready = checkpoint / "ready.json"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(20)
            connection.connect(str(self.directory / "native.sock"))
            connection.sendall(json.dumps({"action": "checkpoint", "checkpoint": str(checkpoint), "entry": request["entry"], "workdir": request["workdir"]}).encode() + b"\n")
            deadline = self.clock() + 20
            while self.clock() < deadline:
                worker = self.tree.table().get(self.worker)
                if ready.exists() and worker and worker[2] in ("T", "t"):
                    return json.loads(ready.read_text())
                if select.select([connection], [], [], 0.01)[0]:
                    response = json.loads(connection.makefile("rb").readline(1024 * 1024))
                    raise LifecycleError(response.get("code", "CAPTURE_UNAVAILABLE"))
        raise LifecycleError("CAPTURE_DRAIN_TIMEOUT")

    def write_receipt(self, value):
        self.write_record(self.receipt, value)

    def write_record(self, path, value):
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def save_attempt(self, state=None):
        self.write_record(self.journal, {"generation": self.generation, "worker": self.worker, **(self.attempt or {}), "processes": self.frozen, **({"state": state} if state else {})})

    def abort(self):
        self.recover_stop()
        if self.attempt and self.attempt["state"] == "stopped":
            raise LifecycleError("CAPTURE_ALREADY_STOPPED")
        self.tree.resume(self.frozen)
        try:
            self.native("resume")
        except BaseException:
            if self.attempt:
                self.attempt['state'] = 'resuming'
            raise
        try:
            if self.attempt and self.attempt.get("checkpoint"):
                shutil.rmtree(self.attempt["checkpoint"], ignore_errors=True)
            self.save_attempt("aborted")
            self.journal_failed = False
        except BaseException:
            self.journal_failed = True
            raise
        finally:
            self.attempt = None
            self.frozen = {}

    def expire(self):
        with self.lock:
            if self.attempt and (self.attempt['state'] == 'resuming' or self.attempt["state"] == "paused" and self.clock() >= self.attempt["deadline"]):
                self.abort()

    def handle(self, request):
        with self.lock:
            self.expire()
            action = request.get("action")
            if action == 'status':
                return {"ok": True, "generation": self.generation, **(self.attempt or {'state': 'running'})}
            token = request.get("token")
            try:
                uuid.UUID(token)
            except (ValueError, TypeError, AttributeError):
                raise LifecycleError("INVALID_CAPTURE_TOKEN")
            if action == "prepare":
                if self.journal_failed:
                    self.save_attempt('aborted')
                    self.journal_failed = False
                if self.attempt:
                    if self.attempt["token"] == token:
                        return {"ok": True, **self.attempt}
                    raise LifecycleError("CAPTURE_BUSY")
                if request.get('generation') != self.generation:
                    raise LifecycleError('CAPTURE_EXPIRED')
                self.generation += 1
                checkpoint = self.directory / "captures" / token
                checkpoint.mkdir(mode=0o700, parents=True, exist_ok=False)
                self.attempt = {"token": token, "state": "preparing", "deadline": self.clock() + 60, "checkpoint": str(checkpoint)}
                worker_identity = self.tree.identity(self.worker)
                if worker_identity is not None:
                    self.frozen[self.worker] = worker_identity
                try:
                    self.save_attempt()
                    self.native("drain")
                    self.tree.freeze(self.frozen, excluded=(self.worker,), before_signal=self.save_attempt, deadline=self.attempt['deadline'])
                    reply = self.checkpoint(checkpoint, request)
                    before = set(self.frozen)
                    self.tree.freeze(self.frozen, before_signal=self.save_attempt, deadline=self.attempt['deadline'])
                    if set(self.frozen) - before - {self.worker}:
                        raise LifecycleError("CAPTURE_WRITERS_CHANGED")
                    if self.clock() >= self.attempt["deadline"]:
                        raise LifecycleError("CAPTURE_DRAIN_TIMEOUT")
                    self.attempt.update(state="paused", capabilities=reply.get("capabilities"))
                    self.save_attempt()
                    return {"ok": True, **self.attempt}
                except BaseException:
                    self.abort()
                    raise
            if not self.attempt or self.attempt["token"] != token:
                raise LifecycleError("CAPTURE_EXPIRED")
            if action == "abort":
                if self.attempt["state"] == "stopped":
                    raise LifecycleError("CAPTURE_ALREADY_STOPPED")
                self.abort()
                return {"ok": True, "state": "running"}
            if action == "commit-stop":
                if self.attempt["state"] not in ("paused", "stopped"):
                    raise LifecycleError("CAPTURE_NOT_PREPARED")
                # A stop receipt disables watchdog resumption before killing writers.
                self.write_receipt({"token": token, "state": "stopped", "processes": self.frozen})
                self.attempt["state"] = "stopped"
                self.tree.stop(self.frozen)
                return {"ok": True, "state": "stopped", "token": token}
            raise LifecycleError("UNKNOWN_CAPTURE_OPERATION")


def recover_dead_supervisor(directory):
    directory = Path(directory)
    with (directory / 'supervisor.lock').open('a') as lifetime:
        try:
            fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LifecycleError('CAPTURE_UNAVAILABLE')
        tree = ProcessTree(os.getpid())
        receipt = directory / 'stop.json'
        if receipt.exists():
            saved = json.loads(receipt.read_text())
            tree.stop({int(pid): identity for pid, identity in saved['processes'].items()})
            return {'ok': True, 'state': 'stopped', 'token': saved['token']}
        journal = directory / 'attempt.json'
        if journal.exists():
            saved = json.loads(journal.read_text())
            if saved['state'] in ('preparing', 'paused'):
                tree.resume({int(pid): identity for pid, identity in saved['processes'].items()})
                exchange(directory / 'native.sock', {'action': 'resume'})
                checkpoint = directory / 'captures' / saved['token']
                shutil.rmtree(checkpoint, ignore_errors=True)
        (directory / 'capability.json').write_text(json.dumps({'supported': False, 'protocol': 1}))
        return {'ok': True, 'state': 'running', 'supported': False}


def supervise(argv):
    if sys.platform != "linux":
        raise LifecycleError("CAPTURE_PLATFORM_UNSUPPORTED")
    # Adopt orphaned descendants so double-forked runtime writers remain owned.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise LifecycleError("CAPTURE_PLATFORM_UNSUPPORTED")
    directory = Path(os.environ["MARIMOHUB_LIFECYCLE_DIR"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    lifetime = (directory / 'supervisor.lock').open('a')
    fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    worker = None if (directory / "stop.json").exists() else subprocess.Popen([sys.executable, *argv], env={**os.environ, "MARIMOHUB_LIFECYCLE_CHILD": "1"})
    supervisor = Supervisor(directory, worker.pid if worker else None)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            try:
                request = json.loads(self.rfile.readline(64 * 1024))
                response = supervisor.handle(request)
            except LifecycleError as error:
                response = {"ok": False, "code": str(error)}
            except Exception:
                response = {"ok": False, "code": "CAPTURE_UNAVAILABLE"}
            self.wfile.write(json.dumps(response).encode() + b"\n")

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    control = directory / "control.sock"
    if control.exists():
        control.unlink()
    server = Server(str(control), Handler)
    os.chmod(control, 0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        while worker and worker.poll() is None or supervisor.attempt and supervisor.attempt["state"] == "stopped":
            try:
                supervisor.expire()
            except Exception:
                pass
            time.sleep(0.1)
    finally:
        server.shutdown()
        if supervisor.attempt and supervisor.attempt["state"] != "stopped":
            supervisor.abort()
    return worker.returncode if worker else 0

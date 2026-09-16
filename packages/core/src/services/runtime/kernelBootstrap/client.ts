export const KERNEL_BOOTSTRAP_CLIENT = String.raw`
import fcntl, hashlib, json, signal, sys, time, uuid
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

class Incompatible(Exception):
    pass

class EditorData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attrs):
        if tag in ("marimo-server-token", "marimo-user-config"):
            self.values[tag] = dict(attrs)

    @classmethod
    def read(cls, html):
        editor = cls()
        editor.feed(html)
        try:
            token = editor.values["marimo-server-token"]["data-token"]
            config = json.loads(editor.values["marimo-user-config"]["data-config"])
            auto_run = config["runtime"]["auto_instantiate"]
            if not isinstance(auto_run, bool) or not isinstance(token, str) or not token:
                raise Incompatible()
            return token, auto_run
        except (KeyError, ValueError, TypeError):
            raise Incompatible() from None

class MarimoClient:
    def __init__(self, cfg, remaining):
        self.remaining = remaining
        self.base = "http://127.0.0.1:" + str(cfg["port"]) + cfg["base_url"]
        self.opener = build_opener(ProxyHandler({}))
        token = Path(cfg["token_file"]).read_text().strip()
        self.auth = {"Authorization": "Bearer " + token}
        self.headers = dict(self.auth)

    def request(self, path, body=None, session_id=None):
        headers = dict(self.headers)
        if body is not None:
            headers["Content-Type"] = "application/json"
        if session_id is not None:
            headers["Marimo-Session-Id"] = session_id
        data = None if body is None else json.dumps(body).encode()
        request = Request(self.base + path, data=data, headers=headers)
        with self.opener.open(request, timeout=self.remaining()) as response:
            return response.read().decode()

    def sessions(self):
        sessions = json.loads(self.request("/api/sessions"))
        if not isinstance(sessions, dict) or any(
            not key or not isinstance(value, dict) for key, value in sessions.items()
        ):
            raise Incompatible()
        return sessions

    def configure(self):
        token, self.auto_run = EditorData.read(self.request("/"))
        self.headers["Marimo-Server-Token"] = token
        return hashlib.sha256(token.encode()).hexdigest()

    def is_live(self, session_id):
        state = json.loads(self.request("/api/kernel/status", session_id=session_id))
        return isinstance(state, dict) and state.get("state") in ("idle", "running")

    def initialize(self, session_id):
        # Marimo ignores CreateNotebook commands once cells are registered, so
        # an ambiguously accepted POST can be retried without replaying cells.
        response = json.loads(self.request("/api/kernel/instantiate", {
            "objectIds": [], "values": [], "autoRun": self.auto_run,
        }, session_id))
        if not isinstance(response, dict) or response.get("success") is not True:
            raise RuntimeError()
        if not self.is_live(session_id):
            raise RuntimeError()

    @contextmanager
    def session(self, sessions):
        if sessions:
            yield next(iter(sessions))
            return
        from websockets.sync.client import connect
        session_id = str(uuid.uuid4())
        with connect(
            self.base.replace("http://", "ws://", 1) + "/ws?session_id=" + session_id,
            additional_headers=self.auth,
            open_timeout=self.remaining(), close_timeout=min(1, self.remaining()),
            max_size=16 * 1024 * 1024,
        ) as ws:
            while True:
                message = json.loads(ws.recv(timeout=self.remaining()))
                if isinstance(message, dict) and message.get("op") == "kernel-ready":
                    break
            yield session_id

@contextmanager
def bootstrap_lock(token_file, inspect, remaining):
    # Use the sandbox-scoped token path to keep coordination outside workspace capture.
    with open(token_file + ".bootstrap.lock", "a+") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if inspect:
                    raise TimeoutError()
                time.sleep(min(0.05, remaining()))
        yield lock

def was_initialized(lock, identity, sessions):
    lock.seek(0)
    try:
        accepted = json.load(lock)
    except ValueError:
        return None
    if not isinstance(accepted, dict) or accepted.get("server") != identity:
        return None
    session_id = accepted.get("session")
    return session_id if isinstance(session_id, str) and session_id in sessions else None

def record_initialized(lock, identity, session_id):
    lock.seek(0)
    lock.truncate()
    json.dump({"server": identity, "session": session_id}, lock)
    lock.flush()

def bootstrap(cfg, remaining):
    client = MarimoClient(cfg, remaining)
    with bootstrap_lock(cfg["token_file"], cfg["inspect"], remaining) as lock:
        sessions = client.sessions()
        identity = client.configure()
        if cfg["inspect"]:
            session_id = was_initialized(lock, identity, sessions)
            return "ready" if session_id and client.is_live(session_id) else "initializing"
        with client.session(sessions) as session_id:
            client.initialize(session_id)
            record_initialized(lock, identity, session_id)
        return "ready"

def run_client(cfg):
    deadline = time.monotonic() + cfg["seconds"]
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError()
        return value
    def alarm(*_):
        raise TimeoutError()
    signal.signal(signal.SIGALRM, alarm)
    try:
        signal.setitimer(signal.ITIMER_REAL, remaining())
        return bootstrap(cfg, remaining)
    except (ImportError, Incompatible):
        return "awaiting_client"
    except TimeoutError:
        return "initializing"
    except HTTPError as error:
        return "awaiting_client" if error.code in (404, 405) else "unavailable"
    except Exception:
        return "unavailable"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)

if __name__ == "__main__":
    try:
        status = run_client(json.load(sys.stdin))
    except Exception:
        status = "unavailable"
    print(json.dumps({"status": status}))
`;

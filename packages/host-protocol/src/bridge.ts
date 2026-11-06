export { HostEventSchema, HostReplySchema } from './events';
export type { HostEvent, HostReply, HostRequest } from './events';

/**
 * Runs inside the sandbox with the marimo server's Python: it finds the server's private host
 * discovery record, so the discovery token never leaves the sandbox, and relays one request.
 * Stdin carries `{ port, base_url, server_args, request }`; stdout carries a `HostReply`.
 */
export const HOST_BRIDGE_CLIENT = String.raw`
import json, os, signal, stat, sys
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit, quote
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from marimo._utils.xdg import marimo_state_dir
from marimo._server.host import HOST_API_PATH

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def discover(cfg):
    from psutil import Process, Error, process_iter
    # Exec commands do not inherit the environment injected into the marimo process.
    for process in process_iter(["cmdline"]):
        if process.info["cmdline"] != cfg["server_args"]:
            continue
        try:
            environment = process.environ()
        except Error:
            continue
        for key in ("HOME", "XDG_STATE_HOME"):
            if key in environment:
                os.environ[key] = environment[key]
            else:
                os.environ.pop(key, None)
        server_pid = process.pid
        break
    else:
        raise RuntimeError("Host process unavailable")
    for path in (marimo_state_dir() / "hosts-v1").glob("*.json"):
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                continue
            record = json.loads(path.read_text())
            url = urlsplit(record["url"])
            if (record["version"] != 1 or url.scheme != "http"
                or url.hostname not in ("127.0.0.1", "::1", "localhost")
                or url.port != cfg["port"] or url.path != cfg["base_url"] + HOST_API_PATH
                or url.username or url.password or url.query or url.fragment):
                continue
            process = record["process"]
            if process["pid"] != server_pid:
                continue
            started = datetime.fromisoformat(process["started_at"].replace("Z", "+00:00")).timestamp()
            if abs(Process(process["pid"]).create_time() - started) > 1:
                continue
            return record
        except (OSError, ValueError, KeyError, TypeError, AttributeError, Error):
            continue
    raise RuntimeError("Host discovery unavailable")

def events(response, snapshot=False):
    result, current, data, total = [], {}, [], 0
    def expired(*_):
        raise TimeoutError()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 10 if snapshot else 2)
    try:
        while True:
            line = response.readline(8 * 1024 * 1024 + 1)
            if not line:
                break
            total += len(line)
            if total > 8 * 1024 * 1024:
                raise RuntimeError("Host response exceeds limit")
            line = line.decode().rstrip("\r\n")
            if not line:
                if "event" in current:
                    current["data"] = json.loads("\n".join(data) or "{}")
                    result.append(current)
                    if current["event"] == "reset" and not snapshot:
                        snapshot = True
                        signal.setitimer(signal.ITIMER_REAL, 10)
                    if snapshot and current["event"] == "ready":
                        return result
                current, data = {}, []
            elif not line.startswith(":"):
                field, _, value = line.partition(":")
                value = value.removeprefix(" ")
                if field in ("event", "id"):
                    current[field] = value
                elif field == "data":
                    data.append(value)
    except TimeoutError:
        pass
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    if snapshot:
        raise RuntimeError("Incomplete host snapshot") from None
    return result

def run(cfg):
    record = discover(cfg)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    def request(path, method="GET", body=None, headers=None):
        headers = {**(headers or {}), "Authorization": "Bearer " + record["token"]}
        headers["Accept"] = "text/event-stream" if method == "GET" else "application/json"
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = Request(record["url"] + path, method=method, headers=headers,
                      data=None if body is None else json.dumps(body).encode())
        return opener.open(req, timeout=15)
    kinds = "project,notebook,runtime" if cfg["request"]["path"] == "/catalog" else "project,notebook"
    with request("/events?types=" + kinds) as response:
        catalog = events(response, snapshot=True)
    projects = {e["data"]["project"]["id"]: e["data"]["project"] for e in catalog if e["event"] == "project"}
    notebooks = [e["data"]["notebook"] for e in catalog if e["event"] == "notebook"]
    target = Path(cfg["request"]["notebookPath"]).resolve()
    matches = [n for n in notebooks if n.get("path") is not None
               and projects.get(n["project_id"], {}).get("root") is not None
               and (Path(projects[n["project_id"]]["root"]) / n["path"]).resolve() == target]
    if len(matches) != 1:
        raise RuntimeError("Notebook absent or ambiguous in runtime host")
    notebook = matches[0]
    req = cfg["request"]
    if req["path"] == "/catalog":
        return {"status": 200, "notebook": notebook, "events": [
            e for e in catalog if e["event"] == "runtime" and e["data"]["runtime"]["notebook_id"] == notebook["id"]]}
    path = "/notebooks/" + quote(notebook["id"], safe="") + req["path"]
    try:
        with request(path, req["method"], req.get("body"), req.get("headers")) as response:
            if req["method"] == "GET":
                return {"status": response.status, "notebook": notebook, "events": events(response,
                    snapshot=not req.get("headers", {}).get("Last-Event-ID"))}
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise RuntimeError("Host response exceeds limit")
            return {"status": response.status, "notebook": notebook, "body": json.loads(data) if data else None}
    except HTTPError as error:
        if error.code < 400:
            raise
        return {"status": error.code, "notebook": notebook, "body": json.loads(error.read(1024 * 1024))}

if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception:
        print(json.dumps({"error": "Runtime host unavailable"}))
`;

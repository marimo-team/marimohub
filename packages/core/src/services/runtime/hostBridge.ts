import { z } from 'zod';
import { withDeadline } from '../../async';
import { UnavailableError } from '../../errors';
import type { SandboxInstance } from '../../ports/sandbox';
import { KERNEL_AUTH_TOKEN_FILE } from './kernelAuth';
import { KERNEL_BOOTSTRAP_LAUNCHER } from './kernelBootstrap/command';
import { shellQuote } from './shell';

const EventSchema = z.object({
	event: z.string(),
	id: z.string().optional(),
	data: z.record(z.string(), z.unknown()),
});
export type HostEvent = z.infer<typeof EventSchema>;
const ReplySchema = z.object({
	status: z.number().int().min(100).max(599),
	body: z.unknown().optional(),
	events: z.array(EventSchema).optional(),
	notebook: z.looseObject({ id: z.string(), operations: z.array(z.string()) }),
});
export type HostReply = z.infer<typeof ReplySchema>;

export interface HostRequest {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	path: string;
	notebookPath: string;
	body?: unknown;
	headers?: Record<string, string>;
}

// Runs in the server's Python environment: discovery credentials never leave the sandbox.
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
        except (OSError, ValueError, KeyError, Error):
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
    with request("/events") as response:
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

export function hostBridgeCommand(requestPath: string): string {
	const source = `${KERNEL_BOOTSTRAP_LAUNCHER}
try:
    for args in commands(5):
        token_file = None if "--no-token" in args and "edit" in args else ${JSON.stringify(KERNEL_AUTH_TOKEN_FILE)}
        runtime = server_runtime(args, token_file)
        if runtime is None:
            continue
        executable, port, base_url = runtime
        config = {"port": port, "base_url": base_url, "server_args": args,
                  "request": json.loads(Path(${JSON.stringify(requestPath)}).read_text())}
        result = subprocess.run([executable, "-c", ${JSON.stringify(HOST_BRIDGE_CLIENT)}],
            input=json.dumps(config), text=True, capture_output=True, timeout=30)
        if result.returncode == 0:
            reply = json.loads(result.stdout)
            # Local sandboxes share processes; only the matching notebook can answer.
            if "status" in reply and "notebook" in reply:
                print(result.stdout)
                break
    else:
        print("{}")
except Exception:
    print("{}")
finally:
    Path(${JSON.stringify(requestPath)}).unlink(missing_ok=True)
`;
	return `python3 -c ${shellQuote(source)}`;
}

export async function requestRuntimeHost(
	sandbox: SandboxInstance,
	request: HostRequest,
	signal?: AbortSignal,
): Promise<HostReply> {
	const unavailable = () => new UnavailableError('The runtime host API is unavailable');
	const requestPath = `/tmp/.marimohub-host-${crypto.randomUUID()}.json`;
	try {
		const result = await withDeadline(
			async (activeSignal) => {
				await sandbox.writeFiles([{ path: requestPath, content: JSON.stringify(request) }]);
				activeSignal.throwIfAborted();
				return sandbox.exec(
					hostBridgeCommand(sandbox.resolveProcessPath?.(requestPath) ?? requestPath),
					{
						timeout: 32_000,
						maxOutputBytes: 16 * 1024 * 1024,
					},
				);
			},
			{ timeoutMs: 33_000, timeoutError: unavailable, signal },
		);
		if (!result.success) throw unavailable();
		return ReplySchema.parse(JSON.parse(result.stdout));
	} catch (error) {
		if (signal?.aborted) throw error;
		throw unavailable();
	}
}

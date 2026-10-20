import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxInstance } from '../../ports/sandbox';
import { HOST_BRIDGE_CLIENT, hostBridgeCommand, requestRuntimeHost } from './hostBridge';
import { KERNEL_AUTH_TOKEN_FILE } from './kernelAuth';

const run = promisify(execFile);

describe('runtime host bridge', () => {
	it.each(['initial', 'reset'])(
		'requires a complete %s snapshot on EOF or timeout',
		async (kind) => {
			const script = String.raw`
import io, sys, types
xdg = types.ModuleType("marimo._utils.xdg")
xdg.marimo_state_dir = lambda: None
sys.modules["marimo._utils.xdg"] = xdg
host = types.ModuleType("marimo._server.host")
host.HOST_API_PATH = "/api/marimo/v1"
sys.modules["marimo._server.host"] = host
`;
			const assertions = String.raw`
initial = sys.argv[1] == "initial"
prefix = b"" if initial else b"event: reset\ndata: {}\n\n"
partial = prefix + b'event: cell\ndata: {"cell": {"id": "c"}}\n\n'
class TimedOut(io.BytesIO):
    def readline(self, limit):
        line = super().readline(limit)
        if not line:
            raise TimeoutError()
        return line
for response in (io.BytesIO(partial), TimedOut(partial)):
    try:
        events(response, snapshot=initial)
    except RuntimeError as error:
        assert str(error) == "Incomplete host snapshot"
    else:
        raise AssertionError("Accepted an incomplete snapshot")
complete = partial + b"id: cursor\nevent: ready\ndata: {}\n\n"
result = events(TimedOut(complete), snapshot=initial)
assert result[-1]["event"] == "ready"
assert result[-1]["id"] == "cursor"
assert len(result) == (2 if initial else 3)
live = b'id: live\nevent: cell\ndata: {"cell": {"id": "c"}}\n\n'
for response in (io.BytesIO(live), TimedOut(live)):
    assert events(response) == [{"event": "cell", "id": "live", "data": {"cell": {"id": "c"}}}]
`;
			await run('python3', [
				'-c',
				`${script}\n${HOST_BRIDGE_CLIENT.replace('if __name__ == "__main__":', 'if False:')}\n${assertions}`,
				kind,
			]);
		},
	);

	it.each([['--no-token'], ['--token-password-file', KERNEL_AUTH_TOKEN_FILE]])(
		'finds the matching notebook with server auth flags %j',
		async (...auth) => {
			const script = String.raw`
import json, shlex, sys, tempfile, types
from pathlib import Path
with tempfile.TemporaryDirectory() as directory:
    request = Path(directory) / "request.json"
    request.write_text(json.dumps({"method": "GET", "path": "/events", "notebookPath": "/workspace/notebook.py"}))
    source = shlex.split(sys.argv[1])[2].replace(
        json.dumps("/tmp/host-bridge-test-request.json"), json.dumps(str(request)))
    prefix, marker, body = source.partition("\ntry:\n    for args in commands(5):")
    assert marker
    exec(prefix)
    server_args = ["python", "-m", "marimo", "edit", "--port", "2718", *json.loads(sys.argv[2])]
    other_args = [arg if arg != "2718" else "2719" for arg in server_args]
    commands = lambda timeout: iter([other_args, server_args])
    calls = []
    def execute(command, **kwargs):
        config = json.loads(kwargs["input"])
        calls.append(config)
        assert request.exists()
        reply = {"error": "Notebook absent"} if config["port"] == 2719 else {
            "status": 200, "notebook": {"id": "local", "operations": []}, "events": []}
        return types.SimpleNamespace(returncode=0, stdout=json.dumps(reply))
    subprocess.run = execute
    exec(marker + body)
    assert len(calls) == 2
    assert calls[-1]["server_args"] == server_args
    assert calls[-1]["request"]["notebookPath"] == "/workspace/notebook.py"
    assert not request.exists()
`;
			const result = await run('python3', [
				'-c',
				script,
				hostBridgeCommand('/tmp/host-bridge-test-request.json'),
				JSON.stringify(auth),
			]);
			expect(JSON.parse(result.stdout)).toMatchObject({ status: 200, notebook: { id: 'local' } });
		},
	);

	it('uses the server state directory, selects the exact notebook, and keeps bearer requests on loopback', async () => {
		const script = String.raw`
import json, os, sys, tempfile, threading, types
from pathlib import Path
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root = Path(tempfile.mkdtemp())
state = root / "hosts-v1"
state.mkdir()
xdg = types.ModuleType("marimo._utils.xdg")
xdg.marimo_state_dir = lambda: Path(os.environ["XDG_STATE_HOME"])
sys.modules["marimo._utils.xdg"] = xdg
host = types.ModuleType("marimo._server.host")
host.HOST_API_PATH = "/api/marimo/v1"
sys.modules["marimo._server.host"] = host
psutil = types.ModuleType("psutil")
psutil.Process = lambda pid: types.SimpleNamespace(create_time=lambda: 1000)
psutil.Error = OSError
server_args = ["python", "-m", "marimo", "edit", "--port", "2718"]
psutil.process_iter = lambda attrs: [
    types.SimpleNamespace(pid=999, info={"cmdline": ["unrelated"]}),
    types.SimpleNamespace(pid=os.getpid(), info={"cmdline": server_args},
                          environ=lambda: {"XDG_STATE_HOME": str(root)}),
]
sys.modules["psutil"] = psutil
os.environ["XDG_STATE_HOME"] = str(root / "wrong-exec-state")
seen = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        seen.append((self.path, self.headers.get("Authorization")))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if self.path.endswith("/events") and "/notebooks/" not in self.path:
            records = [
                ("project", {"project": {"id": "p", "root": "/workspace"}}),
                ("notebook", {"notebook": {"id": "wrong", "project_id": "p", "path": "other.py", "operations": []}}),
                ("notebook", {"notebook": {"id": "right", "project_id": "p", "path": "notebook.py", "operations": ["notebook.edit"]}}),
            ]
        else:
            records = [("cell", {"cell": {"id": "c", "notebook_id": "right", "code": "x = 1"}})]
        for kind, value in records:
            self.wfile.write(("event: " + kind + "\ndata: " + json.dumps(value) + "\n\n").encode())
        self.wfile.write(b"id: c1\nevent: ready\ndata: {}\n\n")
    def do_POST(self):
        seen.append((self.path, self.headers.get("Authorization"), self.headers.get("Idempotency-Key"),
                     json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"document":{"notebook_id":"right"},"cells":{}}')
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
record = state / "host.json"
record.write_text(json.dumps({"version": 1, "url": "http://127.0.0.1:" + str(server.server_port) + "/prefix/api/marimo/v1",
    "token": "private-token", "process": {"pid": os.getpid(), "started_at": datetime.fromtimestamp(1000, timezone.utc).isoformat()}}))
record.chmod(0o600)
`;
		const assertions = String.raw`
cfg = {"port": server.server_port, "base_url": "/prefix", "server_args": server_args,
       "request": {"method": "GET", "path": "/events", "notebookPath": "/workspace/notebook.py"}}
result = run(cfg)
assert result["notebook"]["id"] == "right"
assert result["events"][0]["event"] == "cell"
assert result["events"][-1]["id"] == "c1"
cfg["request"] = {"method": "POST", "path": "/edits", "notebookPath": "/workspace/notebook.py",
                  "headers": {"Idempotency-Key": "retry"}, "body": {"changes": []}}
assert run(cfg)["status"] == 200
assert seen[-1] == ("/prefix/api/marimo/v1/notebooks/right/edits", "Bearer private-token", "retry", {"changes": []})
assert all(request[1] == "Bearer private-token" for request in seen)
assert "private-token" not in json.dumps(result)
assert os.environ["XDG_STATE_HOME"] == str(root)
saved_record = record.read_text()
wrong_process = json.loads(saved_record)
wrong_process["process"]["pid"] += 1
record.write_text(json.dumps(wrong_process))
try:
    discover(cfg)
    raise AssertionError("another process's discovery record was accepted")
except RuntimeError:
    pass
record.write_text(saved_record)
record.chmod(0o644)
try:
    discover(cfg)
    raise AssertionError("public discovery record was accepted")
except RuntimeError:
    pass
server.shutdown()
`;
		await run('python3', [
			'-c',
			`${script}\n${HOST_BRIDGE_CLIENT.replace('if __name__ == "__main__":', 'if False:')}\n${assertions}`,
		]);
	});

	it('keeps large request bodies out of shell arguments and sanitizes failures', async () => {
		const writeFiles = vi.fn().mockResolvedValue(undefined);
		const exec = vi.fn().mockResolvedValue({
			success: true,
			stdout: JSON.stringify({
				status: 200,
				notebook: { id: 'local', operations: [] },
				body: {},
			}),
			stderr: '',
		});
		const sandbox = { writeFiles, exec } as unknown as SandboxInstance;
		const code = 'x'.repeat(256_000);
		await requestRuntimeHost(sandbox, {
			method: 'POST',
			path: '/edits',
			notebookPath: '/workspace/notebook.py',
			body: { code },
		});
		expect(writeFiles.mock.calls[0][0][0].content).toContain(code);
		expect(exec.mock.calls[0][0]).not.toContain(code);
		expect(exec.mock.calls[0][0]).toContain('unlink');
		exec.mockResolvedValue({ success: true, stdout: 'private-token', stderr: '' });
		await expect(
			requestRuntimeHost(sandbox, {
				method: 'GET',
				path: '/catalog',
				notebookPath: '/workspace/notebook.py',
			}),
		).rejects.toThrow('The runtime host API is unavailable');
	});
});

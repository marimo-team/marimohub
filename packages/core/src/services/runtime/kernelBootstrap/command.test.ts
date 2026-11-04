import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { KERNEL_BOOTSTRAP_LAUNCHER } from './command';

const run = promisify(execFile);
async function python(assertions: string) {
	await run('python3', ['-c', `${KERNEL_BOOTSTRAP_LAUNCHER}\n${assertions}`]);
}

describe('sandbox bootstrap launcher', () => {
	it('reconstructs only the expected bridge argument in flattened ps output', async () => {
		await python(String.raw`
from types import SimpleNamespace
from unittest.mock import patch
for bridge in ("/mapped path/custom bridge.py", "/mapped  path/équipe/custom bridge.py", "/mapped O'Brien/custom 'bridge'.py"):
    args = ["/env/bin/python3", bridge, "--quiet", "edit", "notebook.py", "--no-token", "--port=2718"]
    for line in (" ".join(args), shlex.join(args)):
        diagnostics = {}
        with patch.object(Path, "is_dir", return_value=False), patch.object(subprocess, "check_output", return_value=line):
            with patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"status":"ready"}')) as run:
                assert run_launcher("/tmp/token", 2, True, "client", 2718, bridge, diagnostics) == "ready"
                run.assert_called_once()
                assert run.call_args.args[0] == [args[0], "-c", "client"]
        assert diagnostics["runtime_kind"] == "bridge"
        assert diagnostics["port_matches"] == 1
bridge = "/mapped path/custom bridge.py"
flags = " --no-token --port=2718"
for command in ("python3 " + bridge + ".bak", "python3 other.py " + bridge,
                "python3 /other/path/custom bridge.py"):
    assert server_runtime(ps_arguments(command + flags, bridge), "/tmp/token", 2718, bridge) is None
# Unlike ps output, /proc already preserves argv boundaries; never join separate arguments there.
assert server_runtime(["python3", *bridge.split(), "--no-token", "--port=2718"], "/tmp/token", 2718, bridge) is None
`);
	});
	it('counts numerically equivalent ports using the same validation as discovery', async () => {
		await python(String.raw`
from types import SimpleNamespace
from unittest.mock import patch
for value, matches in (("2718", 1), ("02718", 1), ("+2718", 1), ("2719", 0), ("invalid", 0), ("0", 0), ("65536", 0), ("", 0)):
    for flags in (["--port=" + value], ["--port", value]):
        args = ["python3", "-m", "marimo", "--no-token", *flags]
        diagnostics = {}
        with patch.dict(globals(), {"commands": lambda *_: iter([args])}):
            with patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"status":"ready"}')) as run:
                assert run_launcher("/tmp/token", 2, True, "client", 2718, diagnostics=diagnostics) == ("ready" if matches else "awaiting_client")
                assert run.call_count == matches
        assert diagnostics["port_matches"] == matches
`);
	});
	it('discovers a bridge from Linux argv while skipping unreadable and exited processes', async () => {
		await python(String.raw`
from types import SimpleNamespace
from unittest.mock import Mock, patch
bridge = "/mapped path/équipe/marimohub-bridge/sb-test/marimo-bridge.py"
args = ["/env/bin/python3", bridge, "--quiet", "edit", "notebook.py", "--no-token", "--port=2718", "--base-url=/prefix/"]
entries = [SimpleNamespace(read_bytes=Mock(side_effect=FileNotFoundError())),
           SimpleNamespace(read_bytes=Mock(side_effect=PermissionError())),
           SimpleNamespace(read_bytes=Mock(return_value=b"\xff")),
           SimpleNamespace(read_bytes=Mock(return_value=b"")),
           SimpleNamespace(read_bytes=Mock(return_value=("\0".join(args) + "\0").encode()))]
diagnostics = {}
with patch.object(Path, "is_dir", return_value=True), patch.object(Path, "glob", return_value=entries):
    with patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"status":"ready"}')) as run:
        assert run_launcher("/tmp/token", 2, True, "client", 2718, bridge, diagnostics) == "ready"
        assert run.call_args.args[0] == [args[0], "-c", "client"]
        cfg = json.loads(run.call_args.kwargs["input"])
        assert cfg["base_url"] == "/prefix"
        assert cfg["authenticated"] is False
        assert cfg["inspect"] is True
assert diagnostics == {"stage": "client", "processes_scanned": 2, "port_matches": 1, "runtime_kind": "bridge", "authenticated": False}
`);
	});
	it('discovers only the expected tokenless bridge launcher on the sandbox port', async () => {
		await python(String.raw`
bridge = "/tmp/marimohub-bridge/sb-test/marimo-bridge.py"
args = ["/env/bin/python3", bridge, "--quiet", "edit", "notebook.py", "--no-token", "--port=43210"]
assert server_runtime(args, "/tmp/token", 43210, bridge) == ("/env/bin/python3", 43210, "", False)
assert server_runtime(args, "/tmp/token", 2718, bridge) is None
assert server_runtime(args, "/tmp/token", 43210) is None
for other in ("/workspace/marimo-bridge.py", "/tmp/marimohub-bridge/sb-other/marimo-bridge.py", "marimo-bridge.py"):
    assert server_runtime([args[0], other, *args[2:]], "/tmp/token", 43210, bridge) is None
assert server_runtime(args + ["--token-password-file=/tmp/other"], "/tmp/token", 43210, bridge) is None
assert server_runtime(["sh", *args[1:]], "/tmp/token", 43210, bridge) is None
authenticated = [arg for arg in args if arg != "--no-token"] + ["--token-password-file=/tmp/token"]
assert server_runtime(authenticated, "/tmp/token", 43210, bridge) == ("/env/bin/python3", 43210, "", True)
assert server_runtime(authenticated, "/tmp/other", 43210, bridge) is None
for port in ("", "bad", "0", "-1", "65536"):
    assert server_runtime([arg for arg in args if not arg.startswith("--port=")] + ["--port=" + port], "/tmp/token", 43210, bridge) is None
`);
	});
	it('distinguishes discovery failure from a client compatibility failure without exposing output', async () => {
		await python(String.raw`
from types import SimpleNamespace
from unittest.mock import patch
bridge = "/tmp/marimohub-bridge/sb-test/marimo-bridge.py"
args = ["python3", bridge, "--no-token", "--port=2718"]
diagnostics = {}
with patch.dict(globals(), {"commands": lambda *_: iter([args])}):
    assert run_launcher("/tmp/token", 1, False, "client", 2718, diagnostics=diagnostics) == "awaiting_client"
    assert diagnostics == {"stage": "discovery", "reason": "runtime_not_found", "processes_scanned": 1, "port_matches": 1}
    result = SimpleNamespace(returncode=0, stdout=json.dumps({"status": "awaiting_client", "diagnostics": {"stage": "configure", "reason": "incompatible_runtime"}}), stderr="private token")
    diagnostics = {}
    with patch.object(subprocess, "run", return_value=result):
        assert run_launcher("/tmp/token", 1, False, "client", 2718, bridge, diagnostics) == "awaiting_client"
    assert diagnostics == {"stage": "configure", "reason": "incompatible_runtime", "processes_scanned": 1, "port_matches": 1, "runtime_kind": "bridge", "authenticated": False}
for result, reason in ((SimpleNamespace(returncode=1, stdout="private", stderr="private"), "client_exit"),
                       (SimpleNamespace(returncode=0, stdout="private", stderr="private"), "invalid_output")):
    diagnostics = {}
    assert client_outcome(result, diagnostics) == "unavailable"
    assert diagnostics == {"reason": reason}
`);
	});
	it('discovers tokenless marimo only on the sandbox port', async () => {
		await python(String.raw`
from tempfile import TemporaryDirectory
with TemporaryDirectory() as directory:
    script = Path(directory) / "marimo"
    script.write_text("#!/env/bin/python3\n")
    for command in (["/env/bin/python3", "-m", "marimo"],
                    ["/env/bin/python3", str(script)], [str(script)]):
        for flags in (["--port", "43210", "--base-url", "/prefix/"],
                      ["--port=43210", "--base-url=/prefix/"]):
            args = command + ["--quiet", "edit", "notebook.py", "--no-token"] + flags
            assert server_runtime(args, "/tmp/token", 43210) == ("/env/bin/python3", 43210, "/prefix", False)
            assert server_runtime(args, "/tmp/token", 2718) is None
            assert server_runtime(args + ["--token-password-file=/tmp/other"], "/tmp/token", 43210) is None
for command in (["uv", "run", "marimo"], ["python3", "other.py"], ["python3", "-c", "marimo"]):
    assert server_runtime(command + ["--no-token", "--port=43210"], "/tmp/token", 43210) is None
`);
	});
	it('passes tokenless authentication and routing to the client after skipping other sandboxes', async () => {
		await python(String.raw`
from types import SimpleNamespace
from unittest.mock import patch
processes = [["python3", "-m", "marimo", "edit", "--no-token", "--port=" + port, "--base-url=/prefix/"]
             for port in ("2718", "43210")]
with patch.dict(globals(), {"commands": lambda *_: iter(processes)}):
    with patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"status":"ready"}')) as run:
        assert run_launcher("/tmp/token", 1, False, "client", 43210) == "ready"
        run.assert_called_once()
        cfg = json.loads(run.call_args.kwargs["input"])
        assert cfg["authenticated"] is False
        assert cfg["port"] == 43210
        assert cfg["base_url"] == "/prefix"
        assert cfg["token_file"] == "/tmp/token"
`);
	});
	it('matches the sandbox token path and parses separate and joined flags', async () => {
		await python(String.raw`
for flags in (["--token-password-file", "/tmp/token", "--port", "2718", "--base-url", "/prefix/"],
              ["--token-password-file=/tmp/token", "--port=2718", "--base-url=/prefix/"]):
    assert server_runtime(["/env/bin/python3", "-m", "marimo"] + flags, "/tmp/token", 2718) == ("/env/bin/python3", 2718, "/prefix", True)
    assert server_runtime(["uv", "run", "marimo"] + flags, "/tmp/token", 2718) is None
    assert server_runtime(["python3"] + flags, "/tmp/another-sandbox", 2718) is None
for port in ("", "bad", "-1", "0", "65536"):
    assert server_runtime(["python3", "--token-password-file=/tmp/token", "--port=" + port], "/tmp/token", 2718) is None
assert server_runtime([], "/tmp/token", 2718) is None
assert server_runtime(["python3", "--token-password-file=/tmp/token", "--port"], "/tmp/token", 2718) is None
`);
	});
	it('sanitizes malformed output and rejects a failed client claiming success', async () => {
		await python(String.raw`
from types import SimpleNamespace
for stdout in ("", "invalid", "[]", "null", '{"status":"secret"}', '{"status":"ready"}\nextra'):
    assert client_outcome(SimpleNamespace(returncode=0, stdout=stdout)) == "unavailable"
assert client_outcome(SimpleNamespace(returncode=1, stdout='{"status":"ready"}')) == "unavailable"
for status in ("ready", "initializing", "awaiting_client", "unavailable"):
    assert client_outcome(SimpleNamespace(returncode=0, stdout=json.dumps({"status": status, "secret": "hidden"}))) == status
`);
	});
	it('classifies missing runtimes, discovery failures, and client timeouts', async () => {
		await python(String.raw`
from unittest.mock import patch
with patch.dict(globals(), {"commands": lambda *_: iter([])}):
    assert run_launcher("/tmp/token", 1, False, "", 2718) == "awaiting_client"
for error, expected in ((OSError("secret"), "unavailable"), (subprocess.TimeoutExpired("secret", 1), "initializing")):
    def broken(*_):
        raise error
    with patch.dict(globals(), {"commands": broken}):
        assert run_launcher("/tmp/token", 1, False, "", 2718) == expected
with patch.dict(globals(), {"commands": lambda *_: iter([["python3", "--token-password-file=/tmp/token", "--port=2718"]])}):
    with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("secret", 1)):
        assert run_launcher("/tmp/token", 1, False, "", 2718) == "initializing"
`);
	});
});

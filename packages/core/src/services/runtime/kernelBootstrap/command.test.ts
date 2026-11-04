import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { KERNEL_BOOTSTRAP_LAUNCHER } from './command';

const run = promisify(execFile);
async function python(assertions: string) {
	await run('python3', ['-c', `${KERNEL_BOOTSTRAP_LAUNCHER}\n${assertions}`]);
}

describe('sandbox bootstrap launcher', () => {
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
with patch.dict(globals(), {"commands": lambda _: iter(processes)}):
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
with patch.dict(globals(), {"commands": lambda _: iter([])}):
    assert run_launcher("/tmp/token", 1, False, "", 2718) == "awaiting_client"
for error, expected in ((OSError("secret"), "unavailable"), (subprocess.TimeoutExpired("secret", 1), "initializing")):
    def broken(_):
        raise error
    with patch.dict(globals(), {"commands": broken}):
        assert run_launcher("/tmp/token", 1, False, "", 2718) == expected
with patch.dict(globals(), {"commands": lambda _: iter([["python3", "--token-password-file=/tmp/token", "--port=2718"]])}):
    with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("secret", 1)):
        assert run_launcher("/tmp/token", 1, False, "", 2718) == "initializing"
`);
	});
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { KERNEL_BOOTSTRAP_LAUNCHER } from './command';

const run = promisify(execFile);
async function python(assertions: string) {
	await run('python3', ['-c', `${KERNEL_BOOTSTRAP_LAUNCHER}\n${assertions}`]);
}

describe('sandbox bootstrap launcher', () => {
	it('matches the sandbox token path and parses separate and joined flags', async () => {
		await python(String.raw`
for flags in (["--token-password-file", "/tmp/token", "--port", "2718", "--base-url", "/prefix/"],
              ["--token-password-file=/tmp/token", "--port=2718", "--base-url=/prefix/"]):
    assert server_runtime(["/env/bin/python3", "-m", "marimo"] + flags, "/tmp/token") == ("/env/bin/python3", 2718, "/prefix")
    assert server_runtime(["uv", "run", "marimo"] + flags, "/tmp/token") is None
    assert server_runtime(["python3"] + flags, "/tmp/another-sandbox") is None
for port in ("", "bad", "-1", "0", "65536"):
    assert server_runtime(["python3", "--token-password-file=/tmp/token", "--port=" + port], "/tmp/token") is None
assert server_runtime([], "/tmp/token") is None
assert server_runtime(["python3", "--token-password-file=/tmp/token", "--port"], "/tmp/token") is None
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
    assert run_launcher("/tmp/token", 1, False, "") == "awaiting_client"
for error, expected in ((OSError("secret"), "unavailable"), (subprocess.TimeoutExpired("secret", 1), "initializing")):
    def broken(_):
        raise error
    with patch.dict(globals(), {"commands": broken}):
        assert run_launcher("/tmp/token", 1, False, "") == expected
with patch.dict(globals(), {"commands": lambda _: iter([["python3", "--token-password-file=/tmp/token", "--port=2718"]])}):
    with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("secret", 1)):
        assert run_launcher("/tmp/token", 1, False, "") == "initializing"
`);
	});
});

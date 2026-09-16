import { KERNEL_AUTH_TOKEN_FILE } from '../kernelAuth';
import { shellQuote } from '../shell';
import { KERNEL_BOOTSTRAP_CLIENT } from './client';

export const KERNEL_BOOTSTRAP_LAUNCHER = String.raw`
import json, shlex, subprocess, time
from pathlib import Path

def commands(timeout):
    if Path("/proc").is_dir():
        for entry in Path("/proc").glob("[0-9]*/cmdline"):
            try:
                yield entry.read_bytes().decode().strip("\0").split("\0")
            except (OSError, UnicodeError):
                pass
    else:
        output = subprocess.check_output(["ps", "-axo", "command="], text=True, timeout=timeout)
        for line in output.splitlines():
            try:
                yield shlex.split(line)
            except ValueError:
                pass

def argument(args, name):
    for index, value in enumerate(args):
        if value == name and index + 1 < len(args):
            return args[index + 1]
        if value.startswith(name + "="):
            return value[len(name) + 1:]
    return None

def server_runtime(args, token_file):
    # Match the sandbox token path because local sandboxes share a process namespace.
    if not args or argument(args, "--token-password-file") != token_file:
        return None
    try:
        port = int(argument(args, "--port"))
        if not 1 <= port <= 65535:
            return None
        executable = args[0]
        name = Path(executable).name
        if name == "marimo":
            executable = Path(executable).read_text().splitlines()[0].removeprefix("#!").strip()
        elif not name.startswith("python"):
            return None
        return executable, port, (argument(args, "--base-url") or "").rstrip("/")
    except (TypeError, ValueError, OSError, IndexError):
        return None

def client_outcome(result):
    if result.returncode != 0:
        return "unavailable"
    try:
        value = json.loads(result.stdout)
        status = value.get("status") if isinstance(value, dict) else None
        return status if status in ("ready", "initializing", "awaiting_client", "unavailable") else "unavailable"
    except ValueError:
        return "unavailable"

def run_launcher(token_file, seconds, inspect, client):
    deadline = time.monotonic() + seconds
    try:
        for args in commands(seconds):
            runtime = server_runtime(args, token_file)
            if runtime is None:
                continue
            executable, port, base_url = runtime
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "initializing"
            config = {"token_file": token_file, "port": port, "base_url": base_url,
                      "seconds": remaining, "inspect": inspect}
            # Use the server's environment without installing dependencies. Credentials
            # and routing prefixes stay inside the sandbox, outside command arguments.
            result = subprocess.run([executable, "-c", client], input=json.dumps(config),
                text=True, capture_output=True, timeout=remaining)
            return client_outcome(result)
        return "awaiting_client"
    except subprocess.TimeoutExpired:
        return "initializing"
    except Exception:
        return "unavailable"
`;

export function kernelBootstrapCommand(timeoutMs: number, inspectOnly = false): string {
	const source = `${KERNEL_BOOTSTRAP_LAUNCHER}
status = run_launcher(${JSON.stringify(KERNEL_AUTH_TOKEN_FILE)}, ${timeoutMs / 1000}, ${inspectOnly ? 'True' : 'False'}, ${JSON.stringify(KERNEL_BOOTSTRAP_CLIENT)})
print(json.dumps({"status": status}))
`;
	return `python3 -c ${shellQuote(source)}`;
}

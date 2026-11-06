import { MARIMO_PORT } from '../../../constants';
import { KERNEL_AUTH_TOKEN_FILE } from '../kernelAuth';
import { shellQuote } from '../shell';
import { KERNEL_BOOTSTRAP_CLIENT } from './client';

export const KERNEL_BOOTSTRAP_LAUNCHER = String.raw`
import json, shlex, subprocess, time
from pathlib import Path

def ps_arguments(line, bridge_launcher):
    # ps flattens argv without quoting paths. Reconstruct only the expected second argument.
    if bridge_launcher:
        before, found, after = line.partition(bridge_launcher)
        if found and before and before[-1].isspace() and (not after or after[0].isspace()):
            executable = shlex.split(before)
            if len(executable) == 1:
                return [*executable, bridge_launcher, *shlex.split(after)]
    return shlex.split(line)

def commands(timeout, bridge_launcher=None):
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
                yield ps_arguments(line, bridge_launcher)
            except ValueError:
                pass

def argument(args, name):
    for index, value in enumerate(args):
        if value == name and index + 1 < len(args):
            return args[index + 1]
        if value.startswith(name + "="):
            return value[len(name) + 1:]
    return None

def is_bridge(args, bridge_launcher):
    return bridge_launcher is not None and len(args) > 1 and args[1] == bridge_launcher

def server_port(args):
    try:
        port = int(argument(args, "--port"))
        return port if 1 <= port <= 65535 else None
    except (TypeError, ValueError):
        return None

def server_runtime(args, token_file, expected_port, bridge_launcher=None):
    if not args:
        return None
    try:
        port = server_port(args)
        if port is None:
            return None
        authenticated = "--no-token" not in args
        if authenticated:
            if argument(args, "--token-password-file") != token_file:
                return None
        else:
            # Local sandboxes share a process namespace but have distinct mapped ports.
            if port != expected_port or argument(args, "--token-password-file") is not None:
                return None
            # The bridge changes sys.argv[0], but OS process listings retain its script path.
            if not (Path(args[0]).name == "marimo" or
                    len(args) > 1 and Path(args[1]).name == "marimo" or
                    args[1:3] == ["-m", "marimo"] or
                    is_bridge(args, bridge_launcher)):
                return None
        executable = args[0]
        name = Path(executable).name
        if name == "marimo":
            executable = Path(executable).read_text().splitlines()[0].removeprefix("#!").strip()
        elif not name.startswith("python"):
            return None
        return executable, port, (argument(args, "--base-url") or "").rstrip("/"), authenticated
    except (TypeError, ValueError, OSError, IndexError):
        return None

def discover_runtimes(token_file, expected_port, bridge_launcher=None, timeout=5, diagnostics=None):
    for args in commands(timeout, bridge_launcher):
        if diagnostics is not None:
            diagnostics["processes_scanned"] += 1
            if server_port(args) == expected_port:
                diagnostics["port_matches"] += 1
        runtime = server_runtime(args, token_file, expected_port, bridge_launcher)
        if runtime is not None:
            yield args, runtime

def client_outcome(result, diagnostics=None):
    if diagnostics is None:
        diagnostics = {}
    if result.returncode != 0:
        diagnostics["reason"] = "client_exit"
        return "unavailable"
    try:
        value = json.loads(result.stdout)
        status = value.get("status") if isinstance(value, dict) else None
        if status in ("ready", "initializing", "awaiting_client", "unavailable"):
            if isinstance(value.get("diagnostics"), dict):
                diagnostics.update(value["diagnostics"])
            return status
    except ValueError:
        pass
    diagnostics["reason"] = "invalid_output"
    return "unavailable"

def run_launcher(token_file, seconds, inspect, client, expected_port, bridge_launcher=None, diagnostics=None):
    if diagnostics is None:
        diagnostics = {}
    diagnostics.update(stage="discovery", processes_scanned=0, port_matches=0)
    deadline = time.monotonic() + seconds
    try:
        for args, runtime in discover_runtimes(token_file, expected_port, bridge_launcher, seconds, diagnostics):
            executable, port, base_url, authenticated = runtime
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                diagnostics["reason"] = "timeout"
                return "initializing"
            diagnostics.update(stage="client", authenticated=authenticated,
                               runtime_kind="bridge" if is_bridge(args, bridge_launcher) else "marimo")
            config = {"token_file": token_file, "port": port, "base_url": base_url,
                      "seconds": remaining, "inspect": inspect, "authenticated": authenticated}
            # Use the server's environment without installing dependencies. Credentials
            # and routing prefixes stay inside the sandbox, outside command arguments.
            result = subprocess.run([executable, "-c", client], input=json.dumps(config),
                text=True, capture_output=True, timeout=remaining)
            return client_outcome(result, diagnostics)
        diagnostics["reason"] = "runtime_not_found"
        return "awaiting_client"
    except subprocess.TimeoutExpired:
        diagnostics["reason"] = "timeout"
        return "initializing"
    except Exception:
        diagnostics["reason"] = "launcher_error"
        return "unavailable"
`;

export function kernelBootstrapCommand(
	timeoutMs: number,
	inspectOnly = false,
	port = MARIMO_PORT,
	bridgeLauncher?: string,
): string {
	const source = `${KERNEL_BOOTSTRAP_LAUNCHER}
diagnostics = {}
status = run_launcher(${JSON.stringify(KERNEL_AUTH_TOKEN_FILE)}, ${timeoutMs / 1000}, ${inspectOnly ? 'True' : 'False'}, ${JSON.stringify(KERNEL_BOOTSTRAP_CLIENT)}, ${port}, ${bridgeLauncher ? JSON.stringify(bridgeLauncher) : 'None'}, diagnostics)
print(json.dumps({"status": status, "diagnostics": diagnostics}))
`;
	return `python3 -c ${shellQuote(source)}`;
}

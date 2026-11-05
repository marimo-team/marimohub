import { HOST_BRIDGE_CLIENT, HostReplySchema } from '@marimo-hub/host-protocol/bridge';
import type { HostReply, HostRequest } from '@marimo-hub/host-protocol/bridge';
import { withDeadline } from '../../async';
import { MARIMO_PORT } from '../../constants';
import { UnavailableError } from '../../errors';
import type { SandboxInstance } from '../../ports/sandbox';
import { KERNEL_AUTH_TOKEN_FILE } from './kernelAuth';
import { KERNEL_BOOTSTRAP_LAUNCHER } from './kernelBootstrap/command';
import { notebookBridgePaths } from './notebookBridgePaths';
import { shellQuote } from './shell';

export { HOST_BRIDGE_CLIENT };
export type { HostEvent, HostReply, HostRequest } from '@marimo-hub/host-protocol/bridge';

export function hostBridgeCommand(
	requestPath: string,
	port = MARIMO_PORT,
	bridgeLauncher?: string,
): string {
	const source = `${KERNEL_BOOTSTRAP_LAUNCHER}
bridge_launcher = ${bridgeLauncher ? JSON.stringify(bridgeLauncher) : 'None'}
try:
    for args in commands(5, bridge_launcher):
        runtime = server_runtime(args, ${JSON.stringify(KERNEL_AUTH_TOKEN_FILE)}, ${port}, bridge_launcher)
        if runtime is None:
            continue
        executable, port, base_url, authenticated = runtime
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
	bridge?: { sandboxId: string; launcher: string },
): Promise<HostReply> {
	const unavailable = () => new UnavailableError('The runtime host API is unavailable');
	const requestPath = `/tmp/.marimohub-host-${crypto.randomUUID()}.json`;
	try {
		const result = await withDeadline(
			async (activeSignal) => {
				await sandbox.writeFiles([{ path: requestPath, content: JSON.stringify(request) }]);
				activeSignal.throwIfAborted();
				const kernelUrl = `http://127.0.0.1:${MARIMO_PORT}`;
				const processUrl = new URL(sandbox.resolveProcessUrl?.(kernelUrl) ?? kernelUrl);
				const port = Number(processUrl.port || (processUrl.protocol === 'https:' ? 443 : 80));
				const launcherPath = bridge
					? notebookBridgePaths(bridge.sandboxId, bridge.launcher).launcher
					: undefined;
				return sandbox.exec(
					hostBridgeCommand(
						sandbox.resolveProcessPath?.(requestPath) ?? requestPath,
						port,
						launcherPath ? (sandbox.resolveProcessPath?.(launcherPath) ?? launcherPath) : undefined,
					),
					{
						timeout: 32_000,
						maxOutputBytes: 16 * 1024 * 1024,
					},
				);
			},
			{ timeoutMs: 33_000, timeoutError: unavailable, signal },
		);
		if (!result.success) throw unavailable();
		return HostReplySchema.parse(JSON.parse(result.stdout));
	} catch (error) {
		if (signal?.aborted) throw error;
		throw unavailable();
	}
}

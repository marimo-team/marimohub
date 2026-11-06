import { MARIMO_PORT } from '../../constants';
import type { SandboxInstance } from '../../ports/sandbox';

export interface NotebookBridgeTarget {
	sandboxId: string;
	launcher: string;
}

export function notebookBridgePaths(sandboxId: string, launcher: string) {
	const directory = `/tmp/marimohub-bridge/${sandboxId}`;
	return { directory, launcher: `${directory}/${launcher}` };
}

export function resolveBridgeLauncher(
	sandbox: Pick<SandboxInstance, 'resolveProcessPath'>,
	bridge?: NotebookBridgeTarget,
): string | undefined {
	if (!bridge) return undefined;
	const { launcher } = notebookBridgePaths(bridge.sandboxId, bridge.launcher);
	return sandbox.resolveProcessPath?.(launcher) ?? launcher;
}

/** The kernel port as seen by processes inside the sandbox, which adapters may remap. */
export function sandboxKernelPort(sandbox: Pick<SandboxInstance, 'resolveProcessUrl'>): number {
	const kernelUrl = `http://127.0.0.1:${MARIMO_PORT}`;
	const processUrl = new URL(sandbox.resolveProcessUrl?.(kernelUrl) ?? kernelUrl);
	const port = Number(processUrl.port || (processUrl.protocol === 'https:' ? 443 : 80));
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : MARIMO_PORT;
}

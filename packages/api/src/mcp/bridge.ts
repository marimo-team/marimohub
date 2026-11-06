import type { ApiDeps } from '../context';

export function notebookBridgeFor(
	deps: Pick<ApiDeps, 'sandbox'>,
	sandboxId: string,
): { sandboxId: string; launcher: string } | undefined {
	const bridge = deps.sandbox.notebookBridge;
	return bridge ? { sandboxId, launcher: bridge.launcher } : undefined;
}

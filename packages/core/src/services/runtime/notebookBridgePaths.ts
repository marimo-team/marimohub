export function notebookBridgePaths(sandboxId: string, launcher = 'marimo-bridge.py') {
	const directory = `/tmp/marimohub-bridge/${sandboxId}`;
	return { directory, launcher: `${directory}/${launcher}` };
}

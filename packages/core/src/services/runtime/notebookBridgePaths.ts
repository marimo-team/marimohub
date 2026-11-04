export function notebookBridgePaths(sandboxId: string, launcher: string) {
	const directory = `/tmp/marimohub-bridge/${sandboxId}`;
	return { directory, launcher: `${directory}/${launcher}` };
}

/** Runtime payload supplied by the composition root, installed before the CLI starts. */
export interface NotebookBridgeRuntime {
	launcher: string;
	files: readonly { name: string; content: string | Uint8Array }[];
}

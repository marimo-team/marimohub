import { z } from 'zod';

const pendingMoveSchema = z.object({
	notebook: z.object({
		id: z.string(),
		title: z.string(),
		updated_at: z.string(),
		source_type: z.string(),
	}),
	destination: z.string(),
	key: z.string(),
});
export type PendingNotebookMove = z.infer<typeof pendingMoveSchema>;
export type MovableNotebook = PendingNotebookMove['notebook'];
const storageKey = (pid: string) => `pending-notebook-moves:${pid}`;

export function pendingNotebookMoves(pid: string): PendingNotebookMove[] {
	try {
		return z
			.array(pendingMoveSchema)
			.parse(JSON.parse(sessionStorage.getItem(storageKey(pid)) ?? '[]'));
	} catch {
		return [];
	}
}

function writePendingNotebookMoves(pid: string, moves: PendingNotebookMove[]): void {
	try {
		sessionStorage.setItem(storageKey(pid), JSON.stringify(moves));
	} catch {
		// Storage can be disabled or full; the dialog retains its current attempt in memory.
	}
}

export function savePendingNotebookMove(pid: string, move: PendingNotebookMove): void {
	const remaining = pendingNotebookMoves(pid).filter(
		(item) => item.notebook.id !== move.notebook.id,
	);
	writePendingNotebookMoves(pid, [...remaining, move]);
}

export function clearPendingNotebookMove(pid: string, nid: string): void {
	writePendingNotebookMoves(
		pid,
		pendingNotebookMoves(pid).filter((item) => item.notebook.id !== nid),
	);
}

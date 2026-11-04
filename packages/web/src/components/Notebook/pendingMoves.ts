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

export function savePendingNotebookMove(pid: string, move: PendingNotebookMove): void {
	const remaining = pendingNotebookMoves(pid).filter(
		(item) => item.notebook.id !== move.notebook.id,
	);
	sessionStorage.setItem(storageKey(pid), JSON.stringify([...remaining, move]));
}

export function clearPendingNotebookMove(pid: string, nid: string): void {
	const remaining = pendingNotebookMoves(pid).filter((item) => item.notebook.id !== nid);
	sessionStorage.setItem(storageKey(pid), JSON.stringify(remaining));
}

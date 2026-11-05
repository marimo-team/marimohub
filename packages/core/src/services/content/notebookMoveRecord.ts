import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { ConflictError } from '../../errors';
import { paths } from '../../paths';
import {
	FsSnapshotSchema,
	NotebookIdSchema,
	NotebookMetaSchema,
	ProjectIdSchema,
	SourceSchema,
	UserIdSchema,
} from '../../schema';
import { listAllObjects } from '../catalog/storage';

/** How long one executor may run a move without renewing; a retry takes over after expiry. */
export const NOTEBOOK_MOVE_LEASE_MS = 60_000;

export const NotebookMoveSchema = z.object({
	schema_version: z.literal(1),
	/** Attempt identifier; also stamped into the source metadata as `move_id`. */
	id: z.string(),
	notebook_id: NotebookIdSchema,
	source: ProjectIdSchema,
	destination: ProjectIdSchema,
	actor: UserIdSchema,
	/** The notebook's `updated_at` once moved. */
	updated_at: z.string(),
	phase: z.enum(['preparing', 'copying', 'published', 'complete']),
	lease: z.object({ executor: z.string(), expires_at: z.number() }).nullable(),
	/** Hidden preview runtime notebooks that travel with the parent. */
	runtimes: z.array(NotebookIdSchema),
	snapshots: z.array(FsSnapshotSchema).default([]),
	search_refreshed: z.boolean().default(false),
	/** Source metadata captured before fencing; the published entry derives from it. */
	meta: NotebookMetaSchema,
	source_record: SourceSchema,
});
export type NotebookMove = z.infer<typeof NotebookMoveSchema>;

export async function readNotebookMove(bucket: Bucket, key: string) {
	const object = await bucket.get(key);
	if (!object) return null;
	return { etag: object.etag, move: NotebookMoveSchema.parse(await object.json()) };
}

/** Catalog recovery rebuilds project indexes and must not race an unpublished move. */
export async function assertNoPendingNotebookMoves(bucket: Bucket): Promise<void> {
	for (const object of await listAllObjects(bucket, paths.notebookMoves)) {
		const stored = await readNotebookMove(bucket, object.key);
		if (stored && stored.move.phase !== 'complete')
			throw new ConflictError('Complete or cancel pending notebook moves before catalog recovery');
	}
}

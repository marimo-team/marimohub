import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { NotInitializedError, PreconditionFailedError } from '../../errors';
import { createSnapshotId } from '../../ids';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { CURRENT_SNAPSHOT_VERSION, CatalogSchema, readStored, SnapshotSchema } from '../../schema';
import type { Catalog, Snapshot, SnapshotNotebookEntry, SnapshotProjectEntry } from '../../schema';
import { withCasRetry } from './cas';
import type { CasRetryOptions } from './cas';
import type { EventService } from './EventService';

type Awaitable<T> = T | Promise<T>;

/**
 * Lazy-migration seam for snapshots. The read schema is forward-tolerant (it
 * accepts any `schema_version`), so a snapshot written by a newer replica parses
 * without throwing; this function normalizes such a snapshot to the current
 * in-memory shape before it is mutated and re-written.
 *
 * Today this is the identity function — the only live version is v1. When a v2
 * snapshot shape ships, add a branch here keyed on `raw.schema_version` (e.g.
 * `if (raw.schema_version === 1) return migrateSnapshotV1toV2(raw);`). Because
 * every read path runs the snapshot through this seam before mutating, and
 * writes always stamp `CURRENT_SNAPSHOT_VERSION`, the next written snapshot is
 * automatically upgraded — the documented "lazy upgrade" strategy.
 */
export function upgradeSnapshot(raw: Snapshot): Snapshot {
	// if (raw.schema_version === 1) return migrateSnapshotV1toV2(raw);
	return raw;
}

export class CatalogService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
		private events?: EventService,
		/** Retry timing override; metrics hooks remain owned by this service. */
		private casRetry?: Pick<CasRetryOptions, 'retries' | 'backoffMs'>,
	) {}

	async initialize(actor: UserId): Promise<Snapshot> {
		const existing = await this.bucket.get(paths.catalog);
		if (existing) {
			return this.getCurrentSnapshot();
		}

		const snapshotId = createSnapshotId();
		const now = new Date().toISOString();

		const snapshot: Snapshot = {
			snapshot_id: snapshotId,
			schema_version: CURRENT_SNAPSHOT_VERSION,
			created_at: now,
			operation: 'system.initialize',
			actor,
			projects: [],
		};

		await this.bucket.put(paths.snapshot(snapshotId), JSON.stringify(snapshot));

		const catalog: Catalog = {
			version: 1,
			updated_at: now,
			current_snapshot_id: snapshotId,
			current_snapshot_key: paths.snapshot(snapshotId),
			previous_snapshot_id: null,
		};

		// Create-if-absent: the early get() above short-circuits the common
		// already-initialized case, but a concurrent first request could race in
		// the window between that get() and this write. The conditional put makes
		// bootstrap atomic — exactly one writer creates catalog.json.
		try {
			await this.bucket.put(paths.catalog, JSON.stringify(catalog), { onlyIfNotExists: true });
			return snapshot;
		} catch (err) {
			if (err instanceof PreconditionFailedError) {
				// Another initializer won the race. The snapshot we just wrote is now
				// unreferenced — delete it best-effort and return the committed state.
				//
				// INVARIANT (corruption safety): a writer only ever deletes a snapshot
				// it itself just wrote and never committed (`snapshotId` here is local to
				// this call and was never pointed at by catalog.json). No code path
				// deletes a committed snapshot, so the pointer can never be left dangling
				// by a writer. Snapshot retention (MaintenanceService) upholds the same
				// rule by refusing to delete the current/previous snapshot.
				await this.bucket.delete(paths.snapshot(snapshotId)).catch(() => {});
				return this.getCurrentSnapshot();
			}
			throw err;
		}
	}

	async getCurrentSnapshot(): Promise<Snapshot> {
		const catalogObj = await this.bucket.get(paths.catalog);
		if (!catalogObj) {
			throw new NotInitializedError('Catalog not found — call initialize() first');
		}

		const catalog = await readStored(CatalogSchema, catalogObj, paths.catalog);
		const snapshotObj = await this.bucket.get(catalog.current_snapshot_key);
		if (!snapshotObj) {
			throw new NotInitializedError(`Snapshot ${catalog.current_snapshot_id} not found`);
		}

		return upgradeSnapshot(
			await readStored(SnapshotSchema, snapshotObj, catalog.current_snapshot_key),
		);
	}

	/**
	 * `mutateFn` runs inside each catalog CAS attempt and may be asynchronous. It
	 * must be safe to run again after a lost pointer race.
	 */
	async mutateSnapshot(
		operation: string,
		actor: UserId,
		mutateFn: (snapshot: Snapshot) => Awaitable<Snapshot>,
		context?: Record<string, unknown>,
	): Promise<Snapshot> {
		// One CAS attempt: read the catalog + its current snapshot, write a new
		// snapshot, and conditionally swap the catalog pointer onto it. The retry
		// loop / backoff / conflict accounting lives in `withCasRetry`.
		const snapshot = await withCasRetry(
			this.bucket,
			async (cas) => {
				const catalogObj = await this.bucket.get(paths.catalog);
				if (!catalogObj) {
					throw new NotInitializedError('Catalog not found — call initialize() first');
				}

				const catalogEtag = catalogObj.etag;
				const catalog = await readStored(CatalogSchema, catalogObj, paths.catalog);

				const snapshotObj = await this.bucket.get(catalog.current_snapshot_key);
				if (!snapshotObj) {
					throw new NotInitializedError(`Snapshot ${catalog.current_snapshot_id} not found`);
				}

				const currentSnapshot = upgradeSnapshot(
					await readStored(SnapshotSchema, snapshotObj, catalog.current_snapshot_key),
				);

				const newSnapshotId = createSnapshotId();
				const now = new Date().toISOString();

				const mutated = await mutateFn(currentSnapshot);
				const newSnapshot: Snapshot = {
					...mutated,
					snapshot_id: newSnapshotId,
					// Downgrade-guard: never stamp a version lower than what we read. During
					// a rolling deploy an old replica (CURRENT_SNAPSHOT_VERSION = 1) may read
					// a v2 snapshot a newer replica committed; preserving the higher version
					// (together with the unknown-field-preserving SnapshotSchema) means the
					// old replica can safely re-commit without downgrading the chain. This is
					// the "old code tolerates new" rolling-deploy policy (development_docs/migrations.md).
					schema_version: Math.max(CURRENT_SNAPSHOT_VERSION, currentSnapshot.schema_version),
					created_at: now,
					operation,
					actor,
				};

				await this.bucket.put(paths.snapshot(newSnapshotId), JSON.stringify(newSnapshot));

				const newCatalog: Catalog = {
					version: 1,
					updated_at: now,
					current_snapshot_id: newSnapshotId,
					current_snapshot_key: paths.snapshot(newSnapshotId),
					previous_snapshot_id: catalog.current_snapshot_id,
				};

				try {
					await cas.put(paths.catalog, JSON.stringify(newCatalog), {
						onlyIfEtagMatches: catalogEtag,
					});
					return newSnapshot;
				} catch (err) {
					// The catalog swap failed (lost the race, or a transient error), so the
					// snapshot we just wrote is unreferenced. Delete it (best-effort) so a
					// failed attempt never leaves an orphan a prefix-listing could mistake
					// for the head, then rethrow (the CAS writer marks a lost race for retry).
					//
					// INVARIANT (corruption safety): `newSnapshotId` was created in this
					// attempt and the catalog never pointed at it, so this only ever deletes
					// a snapshot this writer wrote and never committed.
					await this.bucket.delete(paths.snapshot(newSnapshotId)).catch(() => {});
					throw err;
				}
			},
			{
				...this.casRetry,
				onAttempt: () => this.metrics.increment('catalog.cas.attempt'),
				onConflict: () => this.metrics.increment('catalog.cas.conflict'),
				onExhausted: () => this.metrics.increment('catalog.cas.exhausted'),
			},
		);
		// Audit trail: append once per WINNING commit (never per CAS attempt), and
		// never let a failed append break the mutation itself.
		if (this.events) {
			try {
				await this.events.append({ event: operation, actor, ...context });
			} catch {
				this.metrics.increment('events.append_failed');
			}
		}
		return snapshot;
	}

	/**
	 * CAS-mutate the snapshot to patch a single project's summary entry. `patch`
	 * receives the matched entry and returns the fields to merge; a project that
	 * doesn't match is left untouched (and if none matches, the snapshot is
	 * rewritten unchanged). Returning `undefined` applies no entry fields. Async
	 * patches run again when the catalog CAS retries.
	 */
	updateProjectEntry(
		operation: string,
		actor: UserId,
		projectId: ProjectId,
		patch: (project: SnapshotProjectEntry) => Awaitable<Partial<SnapshotProjectEntry> | undefined>,
		context: Record<string, unknown> = { project_id: projectId },
	): Promise<Snapshot> {
		return this.mutateSnapshot(
			operation,
			actor,
			async (snap) => {
				const project = snap.projects.find((entry) => entry.id === projectId);
				if (project === undefined) return snap;
				const projectPatch = (await patch(project)) ?? {};
				return {
					...snap,
					projects: snap.projects.map((entry) =>
						entry.id === projectId ? { ...entry, ...projectPatch } : entry,
					),
				};
			},
			context,
		);
	}

	/**
	 * CAS-mutate the snapshot to append a notebook entry to its project, bumping
	 * the project's `notebook_count` and `updated_at` (taken from the entry) in the
	 * same write. Shared by the local and synced create paths.
	 */
	appendNotebookEntry(
		operation: string,
		actor: UserId,
		projectId: ProjectId,
		entry: SnapshotNotebookEntry,
	): Promise<Snapshot> {
		return this.updateProjectEntry(
			operation,
			actor,
			projectId,
			(p) => ({
				updated_at: entry.updated_at,
				notebook_count: p.notebook_count + 1,
				notebooks: [...p.notebooks, entry],
			}),
			{ project_id: projectId, notebook_id: entry.id },
		);
	}

	/**
	 * CAS-mutate the snapshot to patch a single notebook entry within its project.
	 * `patch` returns the notebook fields to merge; the optional `projectPatch`
	 * merges other project-level fields (e.g. `notebook_count`) in the same write.
	 * A patched notebook `updated_at` automatically advances the project's aggregate
	 * timestamp. Returning `undefined` applies no notebook fields. A notebook that
	 * doesn't match is left untouched.
	 */
	updateNotebookEntry(
		operation: string,
		actor: UserId,
		projectId: ProjectId,
		notebookId: NotebookId,
		patch: (
			notebook: SnapshotNotebookEntry,
		) => Awaitable<Partial<SnapshotNotebookEntry> | undefined>,
		projectPatch?: (
			project: SnapshotProjectEntry,
		) => Awaitable<Partial<SnapshotProjectEntry> | undefined>,
	): Promise<Snapshot> {
		return this.updateProjectEntry(
			operation,
			actor,
			projectId,
			async (p) => {
				const notebook = p.notebooks.find((entry) => entry.id === notebookId);
				const notebookPatch = notebook === undefined ? undefined : ((await patch(notebook)) ?? {});
				const resolvedProjectPatch = (await projectPatch?.(p)) ?? {};
				let updatedAt = p.updated_at;
				for (const candidate of [notebookPatch?.updated_at, resolvedProjectPatch?.updated_at]) {
					if (candidate !== undefined && candidate > updatedAt) updatedAt = candidate;
				}
				return {
					...resolvedProjectPatch,
					updated_at: updatedAt,
					notebooks:
						notebookPatch === undefined
							? p.notebooks
							: p.notebooks.map((entry) =>
									entry.id === notebookId ? { ...entry, ...notebookPatch } : entry,
								),
				};
			},
			{ project_id: projectId, notebook_id: notebookId },
		);
	}
}

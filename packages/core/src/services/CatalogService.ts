import type { Bucket } from '../ports/bucket';
import { type Metrics, noopMetrics } from '../ports/metrics';
import { ConflictError, NotInitializedError, PreconditionFailedError } from '../errors';
import { createSnapshotId } from '../ids';
import { paths } from '../paths';
import {
	CURRENT_SNAPSHOT_VERSION,
	CatalogSchema,
	SnapshotSchema,
	type Catalog,
	type Snapshot,
} from '../schema';

const MAX_RETRIES = 5;

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
	) {}

	async initialize(actor: string): Promise<Snapshot> {
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

		const catalog = CatalogSchema.parse(await catalogObj.json());
		const snapshotObj = await this.bucket.get(catalog.current_snapshot_key);
		if (!snapshotObj) {
			throw new NotInitializedError(`Snapshot ${catalog.current_snapshot_id} not found`);
		}

		return upgradeSnapshot(SnapshotSchema.parse(await snapshotObj.json()));
	}

	async mutateSnapshot(
		operation: string,
		actor: string,
		mutateFn: (snapshot: Snapshot) => Snapshot,
	): Promise<Snapshot> {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			this.metrics.increment('catalog.cas.attempt');
			const catalogObj = await this.bucket.get(paths.catalog);
			if (!catalogObj) {
				throw new NotInitializedError('Catalog not found — call initialize() first');
			}

			const catalogEtag = catalogObj.etag;
			const catalog = CatalogSchema.parse(await catalogObj.json());

			const snapshotObj = await this.bucket.get(catalog.current_snapshot_key);
			if (!snapshotObj) {
				throw new NotInitializedError(`Snapshot ${catalog.current_snapshot_id} not found`);
			}

			const currentSnapshot = upgradeSnapshot(SnapshotSchema.parse(await snapshotObj.json()));

			const newSnapshotId = createSnapshotId();
			const now = new Date().toISOString();

			const mutated = mutateFn(currentSnapshot);
			const newSnapshot: Snapshot = {
				...mutated,
				snapshot_id: newSnapshotId,
				// Downgrade-guard: never stamp a version lower than what we read. During
				// a rolling deploy an old replica (CURRENT_SNAPSHOT_VERSION = 1) may read
				// a v2 snapshot a newer replica committed; preserving the higher version
				// (together with the unknown-field-preserving SnapshotSchema) means the
				// old replica can safely re-commit without downgrading the chain. This is
				// the "old code tolerates new" rolling-deploy policy (docs/migrations.md).
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
				await this.bucket.put(paths.catalog, JSON.stringify(newCatalog), {
					onlyIfEtagMatches: catalogEtag,
				});
				return newSnapshot;
			} catch (err) {
				// The catalog swap failed, so the snapshot we just wrote is now
				// unreferenced. Delete it (best-effort) so a failed attempt never
				// leaves an orphan that a prefix-listing could mistake for the head.
				//
				// INVARIANT (corruption safety): `newSnapshotId` was created in this
				// attempt and the catalog never pointed at it (the swap is what failed),
				// so this only ever deletes a snapshot this writer wrote and never
				// committed — a committed snapshot is never deleted here.
				await this.bucket.delete(paths.snapshot(newSnapshotId)).catch(() => {});

				if (err instanceof PreconditionFailedError) {
					this.metrics.increment('catalog.cas.conflict');
					// Exponential backoff: 50ms, 100ms, 150ms, 200ms, 250ms
					await sleep(50 * (attempt + 1));
					continue;
				}
				throw err;
			}
		}

		this.metrics.increment('catalog.cas.exhausted');
		throw new ConflictError('Write conflict: max retries exceeded');
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

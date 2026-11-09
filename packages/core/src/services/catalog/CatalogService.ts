import { deferOrAwait } from '../../ports/backgroundWork';
import type { BackgroundWork } from '../../ports/backgroundWork';
import type { Bucket, BucketListResult } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import {
	ConflictError,
	NotFoundError,
	NotInitializedError,
	PreconditionFailedError,
	ValidationError,
} from '../../errors';
import { sleep } from '../../duration';
import { createSnapshotId } from '../../ids';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { memberRefMatchesSubject } from '../../identityMatch';
import {
	CURRENT_SNAPSHOT_VERSION,
	CatalogSchema,
	ProjectSchema,
	readStored,
	SnapshotSchema,
} from '../../schema';
import type { Catalog, Snapshot, SnapshotNotebookEntry, SnapshotProjectEntry } from '../../schema';
import { MetadataCache } from '../content/metadataCache';
import { projectsById, snapshotCache, snapshotJson } from './snapshotCache';
import { withCasRetry } from './cas';
import { planCatalogRecovery } from './recovery';
import type { CatalogRecoverySource } from './recovery';
import type { CasRetryOptions } from './cas';
import type { EventService } from './EventService';

// Aborts an idempotent append's CAS attempt without writing a snapshot.
class NotebookEntryExistsError extends Error {
	constructor(readonly snapshot: Snapshot) {
		super('Notebook entry already exists');
		this.name = 'NotebookEntryExistsError';
	}
}

type Awaitable<T> = T | Promise<T>;

const INITIALIZE_RECHECK_MS = 250;
const INITIALIZE_SNAPSHOT_SCAN_LIMIT = 20;

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
	private readonly cache: ReturnType<typeof snapshotCache>;
	private readonly pointer: MetadataCache<Catalog>;

	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
		private events?: EventService,
		/** Retry timing override; metrics hooks remain owned by this service. */
		private casRetry?: Pick<CasRetryOptions, 'retries' | 'backoffMs'>,
		private initializeRecheckMs = INITIALIZE_RECHECK_MS,
		cacheBucket: Bucket = bucket,
		private backgroundWork?: BackgroundWork,
	) {
		this.cache = snapshotCache(cacheBucket);
		this.pointer = new MetadataCache(bucket, 1, this.cache.pointer);
	}

	async initialize(actor: UserId): Promise<Snapshot> {
		const existing = await this.bucket.get(paths.catalog);
		if (existing) {
			return this.getCurrentSnapshot();
		}

		const [projects, snapshots] = await Promise.all([
			this.bucket.list({ prefix: 'projects/', limit: 1 }),
			this.bucket.list({ prefix: paths.snapshotsPrefix, limit: INITIALIZE_SNAPSHOT_SCAN_LIMIT }),
		]);
		const hasProjects = projects.objects.length > 0 || projects.delimitedPrefixes.length > 0;
		if (hasProjects || !(await this.onlyEmptyInitializeSnapshots(snapshots))) {
			if (await this.bucket.head(paths.catalog)) return this.getCurrentSnapshot();
			// A concurrent initializer may be between its snapshot put and its catalog put.
			await sleep(this.initializeRecheckMs);
			if (await this.bucket.head(paths.catalog)) return this.getCurrentSnapshot();
			throw new NotInitializedError(
				'Catalog recovery required: catalog.json is missing but stored projects or snapshots remain. Run catalog recovery before restarting the service.',
			);
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
				// this call and was never pointed at by catalog.json). Only a
				// PreconditionFailedError proves that; after any other catalog write error
				// the write may have committed, so the snapshot is kept. No code path
				// deletes a committed snapshot, so the pointer can never be left dangling
				// by a writer. Snapshot retention (MaintenanceService) upholds the same
				// rule by refusing to delete the current/previous snapshot.
				await this.bucket.delete(paths.snapshot(snapshotId)).catch(() => {});
				return this.getCurrentSnapshot();
			}
			throw err;
		}
	}

	/**
	 * Empty `system.initialize` snapshots are left by a concurrent initializer or one that
	 * crashed before its catalog put. They hold no data, so a fresh boot may proceed; the
	 * create-if-absent catalog put still picks exactly one winner.
	 */
	private async onlyEmptyInitializeSnapshots(listing: BucketListResult): Promise<boolean> {
		if (listing.truncated || listing.delimitedPrefixes.length > 0) return false;
		const results = await Promise.all(
			listing.objects.map(async ({ key }) => {
				const object = await this.bucket.get(key);
				// The losing initializer deletes its own snapshot.
				if (!object) return true;
				try {
					const snapshot = await readStored(SnapshotSchema, object, key);
					return snapshot.operation === 'system.initialize' && snapshot.projects.length === 0;
				} catch {
					return false;
				}
			}),
		);
		return results.every(Boolean);
	}

	/** Shared immutable snapshot; mutations must use mutateSnapshot. */
	async getCurrentSnapshot(): Promise<Snapshot> {
		return this.readSnapshot(await this.readCurrentCatalog());
	}

	async getCurrentSnapshotEntry() {
		return this.readSnapshotEntry(await this.readCurrentCatalog());
	}

	async candidatesFor(user: { id: UserId; email: string; groups?: readonly string[] }) {
		const entry = await this.getCurrentSnapshotEntry();
		return new Set(
			[...entry.candidatesFor(user)].filter(
				(id) => entry.byProjectId.get(id)?.status !== 'deleted',
			),
		);
	}

	async hasProjectInvolvement(user: {
		id: UserId;
		email: string;
		groups?: readonly string[];
	}): Promise<boolean> {
		const candidates = await this.candidatesFor(user);
		// A failed roster projection must not preserve a revoked directory grant.
		for (const id of candidates) {
			const project = await this.readProject(id);
			if (!project || project.status === 'deleted') continue;
			if (
				project.owner === user.id ||
				project.members.some((m) => memberRefMatchesSubject(m, user))
			) {
				return true;
			}
		}
		return false;
	}

	private async readProject(id: ProjectId) {
		const key = paths.project(id).meta;
		const object = await this.bucket.get(key);
		return object ? readStored(ProjectSchema, object, key) : null;
	}

	private async readCurrentCatalog(): Promise<Catalog> {
		const catalog = await this.pointer.read(
			[paths.catalog],
			(object) => readStored(CatalogSchema, object, paths.catalog),
			'validated',
		);
		if (!catalog) throw new NotInitializedError('Catalog not found — call initialize() first');
		return catalog;
	}

	private async readSnapshot(catalog: Catalog): Promise<Snapshot> {
		return (await this.readSnapshotEntry(catalog)).snapshot;
	}

	private readSnapshotEntry(catalog: Catalog) {
		return this.cache.read(catalog.current_snapshot_key, async () => {
			const object = await this.bucket.get(catalog.current_snapshot_key);
			if (!object)
				throw new NotInitializedError(
					`Catalog recovery required: snapshot ${catalog.current_snapshot_id} not found`,
				);
			return upgradeSnapshot(
				await readStored(SnapshotSchema, object, catalog.current_snapshot_key),
			);
		});
	}

	planRecovery(source: CatalogRecoverySource) {
		return planCatalogRecovery(this.bucket, source);
	}

	async recover(
		source: CatalogRecoverySource,
		actor: UserId,
		options: { token: string; writersStopped: true; acceptWarnings?: boolean },
	): Promise<Snapshot> {
		if (!options.writersStopped) {
			throw new ValidationError(
				'Stop all API, scheduler, maintenance, and sandbox writers before recovery.',
			);
		}
		const report = await this.planRecovery(source);
		if (report.token !== options.token) {
			throw new ConflictError(
				'Recovery report is stale. Inspect storage again before applying recovery.',
			);
		}
		if (report.issues.some((issue) => issue.severity === 'error')) {
			throw new ValidationError(
				'Recovery is blocked by invalid or missing records. Review the report.',
			);
		}
		if (!options.acceptWarnings && report.issues.some((issue) => issue.severity === 'warning')) {
			throw new ValidationError(
				'Review recovery warnings and explicitly accept them before applying.',
			);
		}
		const snapshot = SnapshotSchema.parse({
			...report.snapshot,
			snapshot_id: createSnapshotId(),
			schema_version: Math.max(CURRENT_SNAPSHOT_VERSION, report.snapshot?.schema_version ?? 1),
			created_at: new Date().toISOString(),
			operation: 'system.recover',
			actor,
			projects: report.projects,
		});
		const previousSnapshotId =
			report.candidates.find((candidate) => candidate.reference === 'current')?.id ??
			report.snapshot?.snapshot_id ??
			null;
		return this.commitRecovery(snapshot, report.catalogEtag, previousSnapshotId, { source });
	}

	/**
	 * The only catalog.json writer besides `mutateSnapshot`: offline recovery replaces the
	 * whole snapshot instead of reading the current one, so it stays private to `recover`.
	 * One CAS attempt; a lost race means the operator must inspect storage again.
	 */
	private async commitRecovery(
		snapshot: Snapshot,
		expectedCatalogEtag: string | null,
		previousSnapshotId: Snapshot['snapshot_id'] | null,
		context: Record<string, unknown>,
	): Promise<Snapshot> {
		this.metrics.increment('catalog.cas.attempt');
		const catalogObj = await this.bucket.get(paths.catalog);
		if ((catalogObj?.etag ?? null) !== expectedCatalogEtag) {
			throw new ConflictError('Catalog changed after recovery inspection. Inspect storage again.');
		}
		const key = paths.snapshot(snapshot.snapshot_id);
		await this.bucket.put(key, JSON.stringify(snapshot), { onlyIfNotExists: true });
		const catalog: Catalog = {
			version: 1,
			updated_at: snapshot.created_at,
			current_snapshot_id: snapshot.snapshot_id,
			current_snapshot_key: key,
			previous_snapshot_id: previousSnapshotId,
		};
		try {
			await this.bucket.put(
				paths.catalog,
				JSON.stringify(catalog),
				catalogObj ? { onlyIfEtagMatches: catalogObj.etag } : { onlyIfNotExists: true },
			);
		} catch (err) {
			// A lost CAS proves the snapshot was never committed, so delete it (see the
			// initialize() invariant). Any other error may follow a commit whose response was
			// lost, so the snapshot is kept.
			if (err instanceof PreconditionFailedError) {
				this.metrics.increment('catalog.cas.conflict');
				await this.bucket.delete(key).catch(() => {});
				throw new ConflictError('Catalog recovery lost a write conflict. Inspect storage again.', {
					cause: err,
				});
			}
			throw err;
		}
		this.cache.set(key, snapshot);
		await this.appendAudit(snapshot.operation, snapshot.actor, context);
		return snapshot;
	}

	private async appendAudit(operation: string, actor: UserId, context?: Record<string, unknown>) {
		// Never let a failed append break the committed mutation.
		if (!this.events) return;
		await deferOrAwait(
			this.backgroundWork,
			'catalog.audit',
			async () => {
				try {
					await this.events!.append({ event: operation, actor, ...context });
				} catch {
					this.metrics.increment('events.append_failed');
					// Storage errors can carry credentials in fields beyond their message.
					throw new Error('Catalog audit append failed');
				}
			},
			this.metrics,
			{ audit_event: operation, actor },
		);
	}

	/**
	 * `mutateFn` runs inside each catalog CAS attempt and may be asynchronous. It
	 * must be safe to run again after a lost pointer race. Returning its unchanged
	 * input skips writes and audit events. In-place edits still commit.
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
		const { snapshot, committed } = await withCasRetry(
			this.bucket,
			async (cas) => {
				const catalogObj = await this.bucket.get(paths.catalog);
				if (!catalogObj)
					throw new NotInitializedError('Catalog not found — call initialize() first');
				const catalog = await readStored(CatalogSchema, catalogObj, paths.catalog);
				const currentSnapshot = await this.readSnapshot(catalog);

				const draft = structuredClone(currentSnapshot);
				const result = await mutateFn(draft);
				if (result === draft && JSON.stringify(result) === snapshotJson(currentSnapshot)) {
					return { snapshot: currentSnapshot, committed: false };
				}

				const newSnapshotId = createSnapshotId();
				const now = new Date().toISOString();
				const newSnapshot: Snapshot = {
					...result,
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

				// Serialize before the first yield: callback-owned entries may change during publication.
				const body = JSON.stringify(newSnapshot);
				await this.bucket.put(paths.snapshot(newSnapshotId), body, { onlyIfNotExists: true });

				const newCatalog: Catalog = {
					version: 1,
					updated_at: now,
					current_snapshot_id: newSnapshotId,
					current_snapshot_key: paths.snapshot(newSnapshotId),
					previous_snapshot_id: catalog.current_snapshot_id,
				};

				try {
					await cas.put(paths.catalog, JSON.stringify(newCatalog), {
						onlyIfEtagMatches: catalogObj.etag,
					});
					const published = JSON.parse(body) as Snapshot;
					this.cache.set(newCatalog.current_snapshot_key, published, body);
					return { snapshot: published, committed: true };
				} catch (err) {
					// Only a lost CAS proves the pointer never moved; any other error may follow a
					// commit whose response was lost, so the snapshot is kept (see initialize()).
					// `cas.put` wraps the PreconditionFailedError so withCasRetry can retry it.
					if (err instanceof Error && err.cause instanceof PreconditionFailedError) {
						await this.bucket.delete(paths.snapshot(newSnapshotId)).catch(() => {});
					}
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
		// Audit once per WINNING commit, never per CAS attempt.
		if (committed) await this.appendAudit(operation, actor, context);
		return snapshot;
	}

	/**
	 * CAS-mutate the snapshot to patch a single project's summary entry. `patch`
	 * receives the matched entry and returns the fields to merge; a project that
	 * doesn't match is left untouched (and if none matches, nothing is
	 * committed). Returning `undefined` applies no entry fields. Async
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
				const project = projectsById(snap).get(projectId);
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
	 *
	 * `ifAbsent` makes a replayed append idempotent: when the entry already exists
	 * it returns the current snapshot without committing (or auditing) a new one,
	 * and a missing or deleted project is a `NotFoundError` instead of a no-op.
	 */
	async appendNotebookEntry(
		operation: string,
		actor: UserId,
		projectId: ProjectId,
		entry: SnapshotNotebookEntry,
		options: { ifAbsent?: boolean } = {},
	): Promise<Snapshot> {
		try {
			return await this.mutateSnapshot(
				operation,
				actor,
				(snap) => {
					const project = projectsById(snap).get(projectId);
					if (options.ifAbsent) {
						if (!project || project.status === 'deleted')
							throw new NotFoundError('Project not found');
						if (project.notebooks.some((notebook) => notebook.id === entry.id))
							throw new NotebookEntryExistsError(snap);
					}
					if (project === undefined) return snap;
					return {
						...snap,
						projects: snap.projects.map((p) =>
							p.id === projectId
								? {
										...p,
										updated_at: entry.updated_at,
										notebook_count: p.notebook_count + 1,
										notebooks: [...p.notebooks, entry],
									}
								: p,
						),
					};
				},
				{ project_id: projectId, notebook_id: entry.id },
			);
		} catch (error) {
			if (error instanceof NotebookEntryExistsError) return error.snapshot;
			throw error;
		}
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
		context: Record<string, unknown> = { project_id: projectId, notebook_id: notebookId },
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
			context,
		);
	}
}

import { cachedRead } from '../../async';
import { NotebookId, ProjectId } from '../../ids';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { readForInspection } from './inspection';
import { listAllObjects } from '../catalog/storage';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { ConflictError, NotFoundError } from '../../errors';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import type { KnownObject } from '../catalog/cas';
import { AppPoolSchema, emptyAppPool } from './AppPoolRouter';
import type { AppPool } from './AppPoolRouter';

function isIsoTimestamp(value: number | undefined): boolean {
	if (value === undefined) return true;
	const year = new Date(value).getUTCFullYear();
	return year >= 0 && year <= 9999;
}

const InspectablePoolSchema = AppPoolSchema.refine(
	(pool) =>
		pool.members.every(
			(member) => isIsoTimestamp(member.created_at) && isIsoTimestamp(member.idle_since),
		) &&
		pool.assignments.every(
			(assignment) =>
				isIsoTimestamp(assignment.grace_until) &&
				assignment.visits.every((visit) => isIsoTimestamp(visit.expires_at)),
		),
	'Pool timestamps cannot be represented as ISO dates',
);

export class AppPoolStore {
	async freezeForMove(pid: ProjectId, nid: NotebookId): Promise<void> {
		await withCasRetry(this.bucket, async (cas) => {
			const key = paths.appPool(pid, nid);
			const object = await this.bucket.get(key);
			const pool = object ? await readStored(AppPoolSchema, object, key) : emptyAppPool();
			if (pool.members.length > 0)
				throw new ConflictError('Wait for app pool cleanup before moving');
			await cas.put(
				key,
				JSON.stringify({ ...emptyAppPool(), deleted_at: pool.deleted_at ?? Date.now() }),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
		});
	}

	/**
	 * Reopens the source pool after a cancelled move; the destination keeps its tombstone.
	 * Members admitted before the fence stay so their sandboxes are still reclaimed.
	 */
	async cancelNotebookMove(source: ProjectId, nid: NotebookId): Promise<void> {
		await withCasRetry(this.bucket, async (cas) => {
			const key = paths.appPool(source, nid);
			const object = await this.bucket.get(key);
			if (!object) return;
			const { deleted_at: _frozen, ...pool } = await readStored(AppPoolSchema, object, key);
			await cas.put(key, JSON.stringify(pool), { onlyIfEtagMatches: object.etag });
		});
	}

	async finishNotebookMove(
		source: ProjectId,
		destination: ProjectId,
		nid: NotebookId,
	): Promise<void> {
		for (const pid of [source, destination]) {
			await withCasRetry(this.bucket, async (cas) => {
				const key = paths.appPool(pid, nid);
				const object = await this.bucket.get(key);
				if (!object) return;
				const pool = await readStored(AppPoolSchema, object, key);
				// A cleanup retry must not evict members admitted since the destination reopened.
				if (pid === destination && pool.deleted_at === undefined) return;
				const next = { ...emptyAppPool(), ...(pid === source ? { deleted_at: Date.now() } : {}) };
				await cas.put(key, JSON.stringify(next), { onlyIfEtagMatches: object.etag });
			});
		}
	}

	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	async read(projectId: ProjectId, notebookId: NotebookId): Promise<AppPool | null> {
		return (await this.readWithEtag(projectId, notebookId))?.value ?? null;
	}

	async readWithEtag(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<KnownObject<AppPool> | null> {
		const key = paths.appPool(projectId, notebookId);
		const object = await this.bucket.get(key);
		return object
			? { value: await readStored(AppPoolSchema, object, key), etag: object.etag }
			: null;
	}

	async inspectAll() {
		const objects = await listAllObjects(this.bucket, paths.appPoolsPrefix);
		let incomplete = false;
		const entries = await mapWithConcurrency(objects, BUCKET_SCAN_CONCURRENCY, async (object) => {
			const [projectId, notebook] = object.key.slice(paths.appPoolsPrefix.length).split('/');
			const notebookId = notebook?.replace(/\.json$/, '');
			if (
				!ProjectId.is(projectId) ||
				!NotebookId.is(notebookId) ||
				object.key !== paths.appPool(projectId, notebookId)
			) {
				incomplete = true;
				return null;
			}
			const pool = await readForInspection(
				this.bucket,
				object.key,
				InspectablePoolSchema,
				'app_pool.inspect',
			);
			if (!pool) incomplete = true;
			return { project_id: projectId, notebook_id: notebookId, pool };
		});
		return { entries: entries.filter((entry) => entry !== null), incomplete };
	}

	/** Share snapshots within one read-only request or maintenance pass, never across requests. */
	reader() {
		const reads = new Map<string, Promise<AppPool | null>>();
		return (projectId: ProjectId, notebookId: NotebookId) => {
			const key = paths.appPool(projectId, notebookId);
			return cachedRead(reads, key, () => this.read(projectId, notebookId));
		};
	}

	async mutate<T>(
		projectId: ProjectId,
		notebookId: NotebookId,
		update: (pool: AppPool) => { pool: AppPool; value: T } | Promise<{ pool: AppPool; value: T }>,
		known?: KnownObject<AppPool> | null,
	): Promise<T> {
		const key = paths.appPool(projectId, notebookId);
		let initial = known;
		return withCasRetry(
			this.bucket,
			async (writer) => {
				const record =
					initial === undefined ? await this.readWithEtag(projectId, notebookId) : initial;
				initial = undefined;
				const pool = record ? structuredClone(record.value) : emptyAppPool();
				const before = JSON.stringify(pool);
				const deletedAt = pool.deleted_at;
				const { pool: next, value } = await update(pool);
				if (
					deletedAt !== undefined &&
					(next.deleted_at !== deletedAt ||
						next.assignments.length > 0 ||
						next.members.some((member) => member.state !== 'retiring'))
				) {
					throw new NotFoundError('The app notebook was deleted');
				}
				const serialized = JSON.stringify(next);
				if (serialized === before) return value;
				await writer.put(
					key,
					serialized,
					record ? { onlyIfEtagMatches: record.etag } : { onlyIfNotExists: true },
				);
				return value;
			},
			{
				retries: 12,
				onConflict: () => this.metrics.increment('app_pool.cas.conflicts'),
				onExhausted: () => this.metrics.increment('app_pool.cas.exhausted'),
			},
		);
	}

	async retireForDeletion(projectId: ProjectId, notebookId: NotebookId): Promise<void> {
		await this.mutate(projectId, notebookId, (pool) => {
			// Keep the tombstone after reclamation so delayed admissions cannot recreate the pool.
			pool.deleted_at ??= Date.now();
			for (const member of pool.members) member.state = 'retiring';
			pool.assignments = [];
			return { pool, value: undefined };
		});
	}
}

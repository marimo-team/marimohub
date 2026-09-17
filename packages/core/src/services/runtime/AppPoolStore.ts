import { NotebookId, ProjectId } from '../../ids';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { readForInspection } from './inspection';
import { listAllObjects } from '../catalog/storage';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { NotFoundError } from '../../errors';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { withCasRetry } from '../catalog/cas';
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
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	async read(projectId: ProjectId, notebookId: NotebookId): Promise<AppPool | null> {
		const key = paths.appPool(projectId, notebookId);
		const object = await this.bucket.get(key);
		return object ? readStored(AppPoolSchema, object, key) : null;
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
			let read = reads.get(key);
			if (!read) {
				read = this.read(projectId, notebookId);
				reads.set(key, read);
			}
			return read;
		};
	}

	async mutate<T>(
		projectId: ProjectId,
		notebookId: NotebookId,
		update: (pool: AppPool) => { pool: AppPool; value: T } | Promise<{ pool: AppPool; value: T }>,
	): Promise<T> {
		const key = paths.appPool(projectId, notebookId);
		return withCasRetry(
			this.bucket,
			async (writer) => {
				const object = await this.bucket.get(key);
				const pool = object ? await readStored(AppPoolSchema, object, key) : emptyAppPool();
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
					object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
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

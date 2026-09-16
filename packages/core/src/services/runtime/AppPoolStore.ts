import type { NotebookId, ProjectId } from '../../ids';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { NotFoundError } from '../../errors';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { AppPoolSchema, emptyAppPool } from './AppPoolRouter';
import type { AppPool } from './AppPoolRouter';

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

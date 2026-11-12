import { z } from 'zod';
import { utcTimestamp } from '../../stringFormats';
import { createSnapshotId } from '../../ids';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { migrationTelemetry, MigrationProgressSchema } from './migrationInspection';
import type { MigrationDescriptor, MigrationInspection, MigrationRow } from './migrationInspection';
import { StoredObjectError, readStored } from '../../schema';
import { putIfMatch } from './cas';

export interface MigrationContext {
	cursor?: string;
	signal?: AbortSignal;
}

export type MigrationBatch = ({ done: true } | { done: false; cursor?: string }) & {
	progress?: { delta: number; total?: number };
	waiting_reason?: 'waiting_for_initialization';
};

export interface BackgroundMigration extends MigrationDescriptor {
	/** Earlier migrations that must complete first. Defaults to every earlier registered migration. */
	after?: readonly string[];
	/** Bounded, idempotent work. A crash or expired lease can replay this batch. */
	runBatch(context: MigrationContext): Promise<MigrationBatch>;
}

const migrationRecord = z.looseObject({ ...migrationTelemetry, version: z.literal(1) });
const migrationCheckpoint = migrationRecord.extend({ cursor: z.string().optional() });

export const MigrationStateSchema = z.discriminatedUnion('status', [
	migrationRecord.extend({ status: z.literal('complete'), completed_at: utcTimestamp() }),
	migrationCheckpoint.extend({ status: z.literal('pending') }),
	migrationCheckpoint.extend({
		status: z.literal('running'),
		lease: z.string().min(1),
		expires_at: z.number().int().nonnegative(),
	}),
]);

type MigrationState = z.infer<typeof MigrationStateSchema>;

const LEASE_MS = 60_000;
// Transient failures retry on the next tick; a stuck migration backs off.
const FAILURES_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export class MigrationService {
	private readonly completed = new Set<string>();
	private inFlight?: Promise<boolean>;
	private refreshInFlight?: Promise<void>;
	private nextRefreshAt = 0;
	private readonly migrations: readonly BackgroundMigration[];
	private readonly prerequisites = new Map<string, readonly string[]>();
	private readonly failures = new Map<string, { count: number; retryAt: number }>();

	constructor(
		private bucket: Bucket,
		migrations: readonly BackgroundMigration[],
		private readonly retired: readonly MigrationDescriptor[] = [],
	) {
		const ids = new Set<string>();
		for (const { id } of [...migrations, ...retired]) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id))
				throw new Error(`Invalid or duplicate migration ID: ${id}`);
			ids.add(id);
		}
		const earlier = new Set<string>();
		for (const migration of migrations) {
			const after = migration.after ?? [...earlier];
			const unknown = after.find((dependency) => !earlier.has(dependency));
			if (unknown !== undefined)
				throw new Error(`Migration ${migration.id} must follow registered migration ${unknown}`);
			this.prerequisites.set(migration.id, after);
			earlier.add(migration.id);
		}
		this.migrations = [...migrations];
	}

	async inspect(): Promise<MigrationInspection> {
		const definitions = [...this.migrations, ...this.retired];
		const records = await mapWithConcurrency(definitions, 4, async ({ id }) => {
			try {
				return { state: (await this.readState(id)).state };
			} catch (error) {
				return {
					error:
						error instanceof StoredObjectError ? ('blocked' as const) : ('unavailable' as const),
				};
			}
		});
		const byId = new Map(definitions.map((definition, index) => [definition.id, records[index]]));
		const readyReceipts = new Set<string>();
		for (const migration of this.migrations) {
			if (
				byId.get(migration.id)?.state?.status === 'complete' &&
				this.ready(migration.id, readyReceipts)
			)
				readyReceipts.add(migration.id);
		}
		const now = Date.now();
		const rows: MigrationRow[] = definitions.map((definition, index) => {
			const { state, error } = records[index];
			const retired = index >= this.migrations.length;
			const dependencies = (this.prerequisites.get(definition.id) ?? []).filter(
				(id) => !readyReceipts.has(id),
			);
			let status: MigrationRow['status'] = error ?? 'waiting';
			if (!error) {
				if (state?.status === 'complete') status = 'completed';
				else if (retired) status = 'not_recorded';
				else if (state?.status === 'running' && state.expires_at > now) status = 'running';
				else if (dependencies.length > 0) status = 'dependency';
				else if (state?.waiting_reason) status = 'initializing';
				else if (state?.failure) status = 'retrying';
				else if (state?.status === 'running') status = 'resuming';
			}
			return {
				id: definition.id,
				title: definition.title ?? definition.id,
				description: definition.description ?? '',
				impact: definition.impact ?? '',
				progress_unit: definition.progressUnit,
				retired,
				status,
				dependencies,
				started_at: state?.started_at,
				last_attempt_at: state?.last_attempt_at,
				last_progress_at: state?.last_progress_at,
				attempts: state?.attempts,
				completed_at: state?.status === 'complete' ? state.completed_at : undefined,
				progress: state?.progress,
				failure: state?.failure
					? {
							...state.failure,
							message:
								state.failure.code === 'timeout'
									? 'The attempt timed out. It will retry automatically.'
									: 'The attempt failed. Check server logs; it will retry automatically.',
						}
					: undefined,
			};
		});
		const active = rows.filter((row) => !row.retired);
		const counts = { waiting: 0, running: 0, completed: 0, needs_attention: 0 };
		for (const row of active) {
			if (row.status === 'unavailable') continue;
			if (row.status === 'completed') counts.completed++;
			else if (row.status === 'running') counts.running++;
			else if (row.status === 'retrying' || row.status === 'blocked') counts.needs_attention++;
			else counts.waiting++;
		}
		const candidates = active.filter(
			(row) => !['completed', 'blocked', 'unavailable', 'dependency'].includes(row.status),
		);
		const incomplete = rows.some((row) => row.status === 'unavailable');
		const activeUnavailable = active.some((row) => row.status === 'unavailable');
		return {
			rows,
			counts,
			observed_at: new Date(now).toISOString(),
			incomplete,
			action: active.every((row) => row.status === 'completed')
				? 'already_complete'
				: candidates.length > 0
					? 'ready'
					: activeUnavailable
						? 'unavailable'
						: 'blocked',
			poll: candidates.length > 0 || activeUnavailable,
		};
	}

	/** Readiness checks never perform storage I/O. */
	isComplete(id: string): boolean {
		return this.completed.has(id);
	}

	/** Read-only startup refresh for runtimes whose request isolates do not run ticks. */
	refreshCompleted(): Promise<void> | undefined {
		// Only the caller that starts a refresh receives it: the Worker registers the promise on
		// that invocation's execution context, and a concurrent request must not re-register it.
		if (
			this.refreshInFlight ||
			this.completed.size === this.migrations.length ||
			Date.now() < this.nextRefreshAt
		)
			return undefined;
		this.nextRefreshAt = Date.now() + 5_000;
		this.refreshInFlight = this.readCompleted().finally(() => {
			this.refreshInFlight = undefined;
		});
		return this.refreshInFlight;
	}

	private ready(id: string, completed = this.completed): boolean {
		return this.prerequisites.get(id)!.every((dependency) => completed.has(dependency));
	}

	private async readCompleted(): Promise<void> {
		for (const migration of this.migrations) {
			if (this.completed.has(migration.id) || !this.ready(migration.id)) continue;
			const { state } = await this.readState(migration.id);
			if (state?.status === 'complete') this.completed.add(migration.id);
		}
	}

	private async readState(id: string): Promise<{ state?: MigrationState; etag?: string }> {
		const key = paths.migration(id);
		const object = await this.bucket.get(key);
		if (!object) return {};
		return { state: await readStored(MigrationStateSchema, object, key), etag: object.etag };
	}

	/**
	 * Run at most one successful batch; a failed one lets the next ready migration run.
	 * True means every registered migration is complete.
	 */
	tick(signal?: AbortSignal): Promise<boolean> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.advance(signal).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	/** A failing migration does not block independent ones; its first error is rethrown. */
	private async advance(signal?: AbortSignal): Promise<boolean> {
		let failure: { error: unknown } | undefined;
		for (const migration of this.migrations) {
			signal?.throwIfAborted();
			if (this.completed.has(migration.id) || !this.ready(migration.id)) continue;
			const failed = this.failures.get(migration.id);
			if (failed && failed.retryAt > Date.now()) continue;
			let ranBatch: boolean;
			try {
				ranBatch = await this.step(migration, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				const count = (failed?.count ?? 0) + 1;
				const backoff =
					count < FAILURES_BEFORE_BACKOFF
						? 0
						: Math.min(BACKOFF_MS * 2 ** (count - FAILURES_BEFORE_BACKOFF), MAX_BACKOFF_MS);
				this.failures.set(migration.id, { count, retryAt: Date.now() + backoff });
				failure ??= { error };
				continue;
			}
			this.failures.delete(migration.id);
			if (ranBatch) break;
		}
		if (failure) throw failure.error;
		return this.completed.size === this.migrations.length;
	}

	/** Returns whether a batch was checkpointed, which ends the tick. */
	private async step(migration: BackgroundMigration, signal?: AbortSignal): Promise<boolean> {
		const key = paths.migration(migration.id);
		const { state, etag: stateEtag } = await this.readState(migration.id);
		if (state?.status === 'complete') {
			this.completed.add(migration.id);
			return false;
		}
		if (state?.status === 'running' && state.expires_at > Date.now()) return false;
		signal?.throwIfAborted();
		const expiresAt = Date.now() + LEASE_MS;
		const pending: MigrationState = {
			...state,
			version: 1,
			status: 'pending',
			cursor: state?.cursor,
			started_at: state ? state.started_at : new Date().toISOString(),
			last_attempt_at: new Date().toISOString(),
			attempts: (state?.attempts ?? 0) + 1,
		};
		delete pending.lease;
		delete pending.expires_at;
		const etag = await this.writeState(
			key,
			{
				...pending,
				status: 'running',
				lease: createSnapshotId(),
				expires_at: expiresAt,
			},
			stateEtag,
		);
		if (etag === undefined) return false;
		let published = false;
		try {
			signal?.throwIfAborted();
			const result = await migration.runBatch({ cursor: state?.cursor, signal });
			signal?.throwIfAborted();
			if (Date.now() >= expiresAt) return false;
			if (result.waiting_reason && result.progress)
				throw new Error('Waiting batches cannot publish progress');
			const progress = result.progress
				? MigrationProgressSchema.parse({
						processed:
							(state?.progress?.processed ?? 0) +
							z.number().int().nonnegative().parse(result.progress.delta),
						total: result.progress.total,
						partial: state?.progress?.partial ?? state?.cursor !== undefined,
					})
				: state?.progress;
			const checkpoint = {
				...pending,
				progress,
				waiting_reason: result.waiting_reason,
				failure: undefined,
				last_progress_at: result.waiting_reason
					? state?.last_progress_at
					: new Date().toISOString(),
			};
			if (result.done) delete checkpoint.cursor;
			published =
				(await this.writeState(
					key,
					result.done
						? { ...checkpoint, status: 'complete', completed_at: new Date().toISOString() }
						: { ...checkpoint, cursor: result.cursor },
					etag,
				)) !== undefined;
			if (!published) return false;
			if (result.done) this.completed.add(migration.id);
			if (result.done || result.cursor !== state?.cursor)
				logEvent({
					level: 'info',
					event: result.done ? 'migration_completed' : 'migration_progress',
					migration: migration.id,
				});
			return true;
		} catch (error) {
			if (!signal?.aborted || ['TimeoutError', 'LoopDeadlineError'].includes(signal.reason?.name)) {
				pending.waiting_reason = undefined;
				pending.failure = {
					code: signal?.aborted ? 'timeout' : 'migration_failed',
					at: new Date().toISOString(),
				};
			}
			throw error;
		} finally {
			// The acquisition ETag prevents a late worker from rewinding a successor's cursor.
			if (!published) {
				try {
					await this.writeState(key, pending, etag);
				} catch (error) {
					logOperationalError(
						'migration_release_failed',
						{ operation: 'migration.release', migration: migration.id },
						error,
					);
				}
			}
		}
	}

	// Contention yields to the current lease holder; storage failures remain errors.
	private writeState(
		key: string,
		state: MigrationState,
		etag?: string,
	): Promise<string | undefined> {
		return putIfMatch(this.bucket, key, JSON.stringify(state), etag);
	}
}

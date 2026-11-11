import { z } from 'zod';
import { utcTimestamp } from '../../stringFormats';
import { createSnapshotId } from '../../ids';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import { readStored } from '../../schema';
import { putIfMatch } from './cas';

export interface MigrationContext {
	cursor?: string;
	signal?: AbortSignal;
}

export type MigrationBatch = { done: true } | { done: false; cursor?: string };

export interface BackgroundMigration {
	/** Permanent identity: change the ID when changing the migration's meaning. */
	id: string;
	/** Earlier migrations that must complete first. Defaults to every earlier registered migration. */
	after?: readonly string[];
	/** Bounded, idempotent work. A crash or expired lease can replay this batch. */
	runBatch(context: MigrationContext): Promise<MigrationBatch>;
}

export const MigrationStateSchema = z.discriminatedUnion('status', [
	z.object({ version: z.literal(1), status: z.literal('complete'), completed_at: utcTimestamp() }),
	z.object({ version: z.literal(1), status: z.literal('pending'), cursor: z.string().optional() }),
	z.object({
		version: z.literal(1),
		status: z.literal('running'),
		cursor: z.string().optional(),
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
	) {
		const ids = new Set<string>();
		for (const migration of migrations) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(migration.id) || ids.has(migration.id)) {
				throw new Error(`Invalid or duplicate migration ID: ${migration.id}`);
			}
			const after = migration.after ?? [...ids];
			const unknown = after.find((dependency) => !ids.has(dependency));
			if (unknown !== undefined) {
				throw new Error(`Migration ${migration.id} must follow registered migration ${unknown}`);
			}
			this.prerequisites.set(migration.id, after);
			ids.add(migration.id);
		}
		this.migrations = [...migrations];
	}

	/** Readiness checks never perform storage I/O. */
	isComplete(id: string): boolean {
		return this.completed.has(id);
	}

	/** Read-only startup refresh for runtimes whose request isolates do not run ticks. */
	refreshCompleted(): Promise<void> | undefined {
		if (this.refreshInFlight) return this.refreshInFlight;
		if (this.completed.size === this.migrations.length || Date.now() < this.nextRefreshAt)
			return undefined;
		this.nextRefreshAt = Date.now() + 5_000;
		this.refreshInFlight = this.readCompleted().finally(() => {
			this.refreshInFlight = undefined;
		});
		return this.refreshInFlight;
	}

	private ready(id: string): boolean {
		return this.prerequisites.get(id)!.every((dependency) => this.completed.has(dependency));
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

	/** Returns whether a batch ran, which ends the tick. */
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
		const pending: MigrationState = { version: 1, status: 'pending', cursor: state?.cursor };
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
			if (Date.now() >= expiresAt) return true;
			published =
				(await this.writeState(
					key,
					result.done
						? { version: 1, status: 'complete', completed_at: new Date().toISOString() }
						: { ...pending, cursor: result.cursor },
					etag,
				)) !== undefined;
			if (!published) return true;
			if (result.done) this.completed.add(migration.id);
			if (result.done || result.cursor !== state?.cursor)
				logEvent({
					level: 'info',
					event: result.done ? 'migration_completed' : 'migration_progress',
					migration: migration.id,
				});
			return true;
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

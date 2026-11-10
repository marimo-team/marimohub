import { z } from 'zod';
import { utcTimestamp } from '../../stringFormats';
import { PreconditionFailedError } from '../../errors';
import { createSnapshotId } from '../../ids';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import { readStored } from '../../schema';

export interface MigrationContext {
	cursor?: string;
	signal?: AbortSignal;
}

export type MigrationBatch = { done: true } | { done: false; cursor?: string };

export interface BackgroundMigration {
	/** Permanent identity: change the ID when changing the migration's meaning. */
	id: string;
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

export class MigrationService {
	private readonly completed = new Set<string>();
	private inFlight?: Promise<boolean>;
	private readonly migrations: readonly BackgroundMigration[];

	constructor(
		private bucket: Bucket,
		migrations: readonly BackgroundMigration[],
	) {
		const ids = new Set<string>();
		for (const migration of migrations) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(migration.id) || ids.has(migration.id)) {
				throw new Error(`Invalid or duplicate migration ID: ${migration.id}`);
			}
			ids.add(migration.id);
		}
		this.migrations = [...migrations];
	}

	/** Run at most one batch; true means every registered migration is complete. */
	tick(signal?: AbortSignal): Promise<boolean> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.advance(signal).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async advance(signal?: AbortSignal): Promise<boolean> {
		for (const migration of this.migrations) {
			signal?.throwIfAborted();
			if (this.completed.has(migration.id)) continue;
			const key = paths.migration(migration.id);
			const object = await this.bucket.get(key);
			const state = object ? await readStored(MigrationStateSchema, object, key) : undefined;
			if (state?.status === 'complete') {
				this.completed.add(migration.id);
				continue;
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
				object?.etag,
			);
			if (etag === undefined) return false;
			let published = false;
			try {
				signal?.throwIfAborted();
				const result = await migration.runBatch({ cursor: state?.cursor, signal });
				signal?.throwIfAborted();
				if (Date.now() >= expiresAt) return false;
				published =
					(await this.writeState(
						key,
						result.done
							? { version: 1, status: 'complete', completed_at: new Date().toISOString() }
							: { ...pending, cursor: result.cursor },
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
				return this.completed.size === this.migrations.length;
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
		return true;
	}

	private async writeState(
		key: string,
		state: MigrationState,
		etag?: string,
	): Promise<string | undefined> {
		try {
			const written = await this.bucket.put(
				key,
				JSON.stringify(state),
				etag === undefined ? { onlyIfNotExists: true } : { onlyIfEtagMatches: etag },
			);
			return written.etag;
		} catch (error) {
			// Contention yields to the current lease holder; storage failures remain errors.
			if (error instanceof PreconditionFailedError) return undefined;
			throw error;
		}
	}
}

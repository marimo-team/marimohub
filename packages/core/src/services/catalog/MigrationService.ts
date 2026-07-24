/**
 * PROTOTYPE — UNWIRED. Do not import this from `apps/server`, `packages/api`,
 * any route, or any cron. It exists to validate the fan-out migration contract
 * described in `development_docs/migrations.md` (grounded in `bucket_spec.md` §9) against
 * `MemoryBucket`. When the first real `v2` of a per-object schema ships, this is
 * where the runner gets finished and deliberately wired up.
 *
 * Intentionally NOT re-exported from `services/index.ts` or the package root.
 */
import { SYSTEM_ACTOR } from '../../ids';
import type { Bucket } from '../../ports/bucket';
import { EventService } from './EventService';

/** Per-object schema types that use the fan-out migration strategy. */
export type MigrationTargetType = 'meta' | 'project' | 'source' | 'version';

/**
 * Maps a target type to the prefix it is listed under and the key suffix that
 * identifies its objects. Snapshots (lazy upgrade), `catalog.json` (in-place),
 * and events (immutable) are deliberately absent — they do not use fan-out.
 */
const TARGETS: Record<MigrationTargetType, { prefix: string; suffix: string }> = {
	meta: { prefix: 'projects/', suffix: '/meta.json' },
	project: { prefix: 'projects/', suffix: '/project.json' },
	source: { prefix: 'projects/', suffix: '/source.json' },
	version: { prefix: 'projects/', suffix: '/version.json' },
};

/** A versioned object as read from the bucket, before migration. */
type Migratable = Record<string, unknown> & { schema_version?: unknown };

/** Pure transform: take the old-shape object, return the new-shape object. */
export type MigrateFn = (data: Migratable) => Migratable;

export interface MigrationResult {
	/** Objects whose `schema_version === fromVersion` and were rewritten. */
	migrated: number;
	/** Objects skipped (already at toVersion, or some other version). */
	skipped: number;
	/** Total objects of this target type that were examined. */
	scanned: number;
}

/**
 * Fan-out migration runner (prototype). Walks every object of `targetType`,
 * and for each one still at `fromVersion`, applies `migrateFn`, stamps
 * `schema_version = toVersion`, and writes it back. Emits a single
 * `migration.run` event on completion.
 *
 * - **Idempotent:** the `schema_version === fromVersion` guard means re-running
 *   skips objects already migrated, so each object is migrated at most once.
 * - **Resumable:** listing pages on the bucket `cursor`, so a job interrupted by
 *   a runtime time limit can be re-run and continue.
 */
export class MigrationService {
	private readonly events: EventService;

	constructor(private bucket: Bucket) {
		this.events = new EventService(bucket);
	}

	async runMigration(
		fromVersion: number,
		toVersion: number,
		targetType: MigrationTargetType,
		migrateFn: MigrateFn,
	): Promise<MigrationResult> {
		const { prefix, suffix } = TARGETS[targetType];
		const result: MigrationResult = { migrated: 0, skipped: 0, scanned: 0 };

		// Paginate the listing on the bucket cursor so the job stays within the
		// runtime's per-invocation request/time limits and is resumable.
		let cursor: string | undefined;
		do {
			const page = await this.bucket.list({ prefix, cursor });

			for (const obj of page.objects) {
				if (!obj.key.endsWith(suffix)) continue;
				result.scanned++;

				const body = await this.bucket.get(obj.key);
				if (!body) continue;

				// A single corrupt/unparseable object must not abort the whole run and
				// strand its valid siblings unmigrated. Count it as skipped (logged) and
				// move on; a re-run after the object is repaired will pick it up.
				let data: Migratable;
				try {
					data = (await body.json()) as Migratable;
				} catch (err) {
					console.warn(`runMigration: skipping unreadable object ${obj.key}: ${String(err)}`);
					result.skipped++;
					continue;
				}

				// Idempotency guard: only objects still at fromVersion are migrated.
				// Re-running after a partial run skips everything already at toVersion.
				if (data.schema_version !== fromVersion) {
					result.skipped++;
					continue;
				}

				const migrated = migrateFn(data);
				migrated.schema_version = toVersion;
				await this.bucket.put(obj.key, JSON.stringify(migrated));
				result.migrated++;
			}

			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);

		// Completion is verifiable from the immutable event log.
		await this.events.append({
			event: 'migration.run',
			actor: SYSTEM_ACTOR,
			target_type: targetType,
			from_version: fromVersion,
			to_version: toVersion,
			migrated: result.migrated,
			skipped: result.skipped,
			scanned: result.scanned,
		});

		return result;
	}
}

/**
 * Example migration (prototype). A synthetic v1→v2 that adds a `migrated_marker`
 * field, demonstrating the `MigrateFn` shape. Pure and side-effect free; the
 * runner stamps `schema_version` separately, so this fn must not touch it.
 */
export const exampleMigrateV1toV2: MigrateFn = (data) => {
	return { ...data, migrated_marker: true };
};

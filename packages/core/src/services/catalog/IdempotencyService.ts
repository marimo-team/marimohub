import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { PreconditionFailedError } from '../../errors';
import { toHex } from '../../internal/hex';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { listAllObjects } from './storage';

const DEFAULT_RETENTION_MS = Millis.days(1);

const IdempotencyRecordSchema = z.object({
	schema_version: z.literal(1),
	scope: z.string(),
	data: z.unknown(),
	created_at: z.iso.datetime(),
});

type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

async function digestKey(scope: string, key: string): Promise<string> {
	// Hash so an arbitrary client key never produces an unsafe/oversized object key,
	// and the (scope, key) pair maps to exactly one object.
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${scope}\n${key}`));
	return toHex(new Uint8Array(bytes));
}

/**
 * At-most-once replay for the create routes, keyed by `(user, route,
 * Idempotency-Key)`. Records live under `_system/idempotency/` as append-only
 * objects pruned by the maintenance sweep (24h). Concurrent first-use of the same
 * key is resolved last-writer-loses via create-if-absent, so a small double-create
 * window exists under simultaneous first use — acceptable.
 */
export class IdempotencyService {
	constructor(private bucket: Bucket) {}

	/** The recorded `data` for a prior `(scope, key)`, or null if this is a first use. */
	async lookup(scope: string, key: string): Promise<{ data: unknown } | null> {
		const objectKey = paths.idempotencyKey(await digestKey(scope, key));
		const obj = await this.bucket.get(objectKey);
		if (!obj) return null;
		// A corrupt record must not brick this key for the whole retention window:
		// fail open (treat as first use) rather than 500 every replay until it prunes.
		let record: IdempotencyRecord;
		try {
			record = await readStored(IdempotencyRecordSchema, obj, objectKey);
		} catch (err) {
			logOperationalError(
				'stored_object_skipped',
				{ operation: 'idempotency.lookup', object: objectKey },
				err,
			);
			return null;
		}
		if (record.scope !== scope) return null;
		return { data: record.data };
	}

	/** Record a first-use response. Best-effort: a lost create-if-absent race is ignored. */
	async record(scope: string, key: string, data: unknown): Promise<void> {
		const objectKey = paths.idempotencyKey(await digestKey(scope, key));
		const record: IdempotencyRecord = {
			schema_version: 1,
			scope,
			data,
			created_at: new Date().toISOString(),
		};
		try {
			await this.bucket.put(objectKey, JSON.stringify(record), { onlyIfNotExists: true });
		} catch (err) {
			if (!(err instanceof PreconditionFailedError)) throw err;
			let existing;
			try {
				existing = await this.bucket.get(objectKey);
			} catch (repairErr) {
				logOperationalError(
					'idempotency_record_repair_failed',
					{ operation: 'idempotency.record', object: objectKey },
					repairErr,
				);
				return;
			}
			if (!existing) return;
			let corruption: unknown;
			try {
				await readStored(IdempotencyRecordSchema, existing, objectKey);
				return;
			} catch (readErr) {
				corruption = readErr;
			}
			try {
				await this.bucket.put(objectKey, JSON.stringify(record), {
					onlyIfEtagMatches: existing.etag,
				});
				logOperationalError(
					'corrupt_idempotency_record_replaced',
					{ operation: 'idempotency.record', object: objectKey },
					corruption,
				);
			} catch (replaceErr) {
				if (replaceErr instanceof PreconditionFailedError) return;
				logOperationalError(
					'idempotency_record_repair_failed',
					{ operation: 'idempotency.record', object: objectKey },
					replaceErr,
				);
			}
		}
	}

	/** Delete records past the retention window (by object `uploaded` time). */
	async prune(retentionMs = DEFAULT_RETENTION_MS): Promise<number> {
		const cutoff = Date.now() - retentionMs;
		const objects = await listAllObjects(this.bucket, paths.idempotencyPrefix);
		const stale = objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
		if (stale.length > 0) await this.bucket.delete(stale);
		return stale.length;
	}
}

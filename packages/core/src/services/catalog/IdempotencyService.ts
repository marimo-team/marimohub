import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { PreconditionFailedError } from '../../errors';
import { toHex } from '../../internal/hex';
import { paths } from '../../paths';
import { listAllObjects } from './storage';

const DEFAULT_RETENTION_MS = Millis.days(1);

interface IdempotencyRecord {
	schema_version: 1;
	/** `${userId}:${routeId}` — stored so a hash collision across scopes can't replay. */
	scope: string;
	/** The recorded `data` payload of the original response envelope. */
	data: unknown;
	created_at: string;
}

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
 * window exists under simultaneous first use — acceptable per plan 033.
 */
export class IdempotencyService {
	constructor(private bucket: Bucket) {}

	/** The recorded `data` for a prior `(scope, key)`, or null if this is a first use. */
	async lookup(scope: string, key: string): Promise<{ data: unknown } | null> {
		const obj = await this.bucket.get(paths.idempotencyKey(await digestKey(scope, key)));
		if (!obj) return null;
		const record = (await obj.json()) as IdempotencyRecord;
		if (record.scope !== scope) return null;
		return { data: record.data };
	}

	/** Record a first-use response. Best-effort: a lost create-if-absent race is ignored. */
	async record(scope: string, key: string, data: unknown): Promise<void> {
		const record: IdempotencyRecord = {
			schema_version: 1,
			scope,
			data,
			created_at: new Date().toISOString(),
		};
		try {
			await this.bucket.put(
				paths.idempotencyKey(await digestKey(scope, key)),
				JSON.stringify(record),
				{ onlyIfNotExists: true },
			);
		} catch (err) {
			if (!(err instanceof PreconditionFailedError)) throw err;
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

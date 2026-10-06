import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { PreconditionFailedError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { parseStored, StoredObjectError } from '../../schema';
import { putIfAbsent } from './cas';

/**
 * Advisory lease for the single-writer maintenance sweep, built on the same
 * compare-and-swap primitive the catalog uses — no etcd, no extra infrastructure.
 *
 * The deployment is *expected* to run the reaper on exactly one replica (a
 * dedicated `replicas: 1` Deployment, or the Cloudflare `scheduled` trigger which
 * is a platform singleton). This lease is defense-in-depth: if a
 * misconfiguration or a rolling update ever runs two reapers, only the lease
 * holder proceeds, so two sweeps can't race on deletes. It is NOT a
 * general-purpose distributed lock.
 */
// The server passes each attempt's remaining deadline; this only covers callers
// without one, such as the Cloudflare worker's scheduled sweep.
const DEFAULT_TTL_MS = Millis.minutes(10);

const LockRecordSchema = z.object({
	holder: z.string(),
	expires_at: z.iso.datetime(),
});
type LockRecord = z.infer<typeof LockRecordSchema>;

export class MaintenanceLock {
	constructor(
		private bucket: Bucket,
		/** Bucket key of the lease object — pass a distinct key per independent sweep. */
		private key: string = paths.maintenanceLock,
	) {}

	/**
	 * Try to acquire (or steal an expired) lease. Returns true iff this holder now
	 * owns it. Acquisition is atomic via create-if-absent / CAS, so concurrent
	 * callers can never both win.
	 */
	async acquire(holder: string, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
		const acquired = await this.tryAcquire(holder, ttlMs);
		// Contention is not an error, so surface it as an attribute on the caller's span.
		trace.getActiveSpan()?.setAttribute('marimohub.lock.acquired', acquired);
		return acquired;
	}

	private async tryAcquire(holder: string, ttlMs: number): Promise<boolean> {
		const now = Date.now();
		const record: LockRecord = { holder, expires_at: new Date(now + ttlMs).toISOString() };
		const body = JSON.stringify(record);

		// Fast path: no lock yet.
		if (await this.tryCreate(body)) return true;

		// A lock exists — read it. Renew if we already hold it, steal if it's
		// expired, otherwise back off. The write is CAS on the current ETag so two
		// callers can't both win.
		const existing = await this.bucket.get(this.key);
		if (!existing) {
			// Vanished between the failed create and this read — one more create try.
			return this.tryCreate(body);
		}

		const current = this.parse(await existing.text(), 'maintenance_lock.acquire');
		const heldByOther = current && current.holder !== holder;
		if (heldByOther && new Date(current.expires_at).getTime() > now) {
			return false; // someone else holds it and it hasn't expired
		}

		// Either ours (renew, extending the TTL) or expired (steal).
		try {
			await this.bucket.put(this.key, body, { onlyIfEtagMatches: existing.etag });
			return true;
		} catch (err) {
			if (err instanceof PreconditionFailedError) return false; // another writer won the CAS
			throw err;
		}
	}

	/**
	 * Release the lease (best-effort) by expiring it in place. The write is CAS on
	 * the ETag read here, so a lease another replica stole after this holder's TTL
	 * lapsed is never clobbered. The TTL is the real safety net; this frees it sooner.
	 */
	async release(holder: string, signal?: AbortSignal): Promise<void> {
		const existing = await this.bucket.get(this.key);
		if (!existing) return;
		const current = this.parse(await existing.text(), 'maintenance_lock.release');
		if (signal?.aborted || !current || current.holder !== holder) return;
		const expired: LockRecord = { holder, expires_at: new Date(Date.now()).toISOString() };
		await this.bucket
			.put(this.key, JSON.stringify(expired), { onlyIfEtagMatches: existing.etag })
			.catch((err) => {
				if (err instanceof PreconditionFailedError) return;
				logOperationalError(
					'maintenance_lock_release_failed',
					{ operation: 'maintenance_lock.release', object: this.key },
					err,
				);
			});
	}

	private tryCreate(body: string): Promise<boolean> {
		return putIfAbsent(this.bucket, this.key, body);
	}

	private parse(text: string, operation: string): LockRecord | null {
		try {
			return parseStored(LockRecordSchema, JSON.parse(text), this.key);
		} catch (err) {
			const safeError =
				err instanceof SyntaxError
					? new StoredObjectError(this.key, 'invalid_json', { causeName: err.name })
					: err;
			logOperationalError(
				'corrupt_maintenance_lock_ignored',
				{ operation, object: this.key },
				safeError,
			);
			return null;
		}
	}
}

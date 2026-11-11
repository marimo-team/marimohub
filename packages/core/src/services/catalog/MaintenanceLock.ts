import { utcTimestamp } from '../../stringFormats';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { PreconditionFailedError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { parseStored, StoredObjectError } from '../../schema';

// Callers without a loop deadline use this TTL, including scheduled Workers.
const DEFAULT_TTL_MS = Millis.minutes(10);

const LockRecordSchema = z.object({
	holder: z.string(),
	expires_at: utcTimestamp(),
});
type LockRecord = z.infer<typeof LockRecordSchema>;

/**
 * Advisory CAS lease for maintenance replicas. Each independent sweep needs its own key.
 * Expiry permits takeover but does not cancel or fence work already in progress.
 */
export class MaintenanceLock {
	private held: { holder: string; etag: string; expiresAt: number } | undefined;
	constructor(
		private bucket: Bucket,
		private key: string = paths.maintenanceLock,
	) {}

	/** Create, renew, or take over an expired lease with CAS. */
	async acquire(holder: string, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
		const acquired = await this.tryAcquire(holder, ttlMs);
		// Contention is not an error, so surface it as an attribute on the caller's span.
		trace.getActiveSpan()?.setAttribute('marimohub.lock.acquired', acquired);
		return acquired;
	}

	/** Reuse local ownership only while enough lease time remains for the next attempt. */
	async hold(holder: string, ttlMs: number, minimumRemainingMs: number): Promise<boolean> {
		const held = this.held;
		const now = Date.now();
		if (held?.holder === holder && held.expiresAt > now) {
			if (held.expiresAt - now >= minimumRemainingMs) {
				trace.getActiveSpan()?.setAttribute('marimohub.lock.acquired', true);
				return true;
			}
			const record: LockRecord = { holder, expires_at: new Date(now + ttlMs).toISOString() };
			const acquired = await this.writeLease(record, { onlyIfEtagMatches: held.etag });
			trace.getActiveSpan()?.setAttribute('marimohub.lock.acquired', acquired);
			return acquired;
		}
		return this.acquire(holder, ttlMs);
	}

	private async tryAcquire(holder: string, ttlMs: number): Promise<boolean> {
		const now = Date.now();
		const record: LockRecord = { holder, expires_at: new Date(now + ttlMs).toISOString() };
		const existing = await this.bucket.get(this.key);
		if (!existing) return this.writeLease(record, { onlyIfNotExists: true });

		const current = this.parse(await existing.text(), 'maintenance_lock.acquire');
		const heldByOther = current && current.holder !== holder;
		// A concurrent release can stamp an expiry after the initial clock read.
		if (heldByOther && new Date(current.expires_at).getTime() > Date.now()) {
			return false;
		}

		return this.writeLease(record, { onlyIfEtagMatches: existing.etag });
	}

	private async writeLease(
		record: LockRecord,
		condition: { onlyIfNotExists: true } | { onlyIfEtagMatches: string },
	): Promise<boolean> {
		try {
			const written = await this.bucket.put(this.key, JSON.stringify(record), condition);
			this.held = {
				holder: record.holder,
				etag: written.etag,
				expiresAt: Date.parse(record.expires_at),
			};
			return true;
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				this.held = undefined;
				return false;
			}
			throw error;
		}
	}

	/** The acquisition ETag fences release against a successor, even after expiry. */
	async release(holder: string, signal?: AbortSignal): Promise<void> {
		const held = this.held;
		if (!held || held.holder !== holder) return;
		this.held = undefined;
		if (signal?.aborted) return;
		const expired: LockRecord = { holder, expires_at: new Date(Date.now()).toISOString() };
		await this.bucket
			.put(this.key, JSON.stringify(expired), { onlyIfEtagMatches: held.etag })
			.catch((err) => {
				if (err instanceof PreconditionFailedError) return;
				logOperationalError(
					'maintenance_lock_release_failed',
					{ operation: 'maintenance_lock.release', object: this.key },
					err,
				);
			});
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

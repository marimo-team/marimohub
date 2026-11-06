import {
	decideHostRetryAcquire,
	HOST_CLAIM_LEASE_MS,
	HOST_RETRY_REFRESH_MS,
	HOST_RETRY_WINDOW_MS,
	settleHostRetryClaim,
} from '@marimo-hub/host-protocol/retry-store';
import type {
	HostRetryAcquisition,
	HostRetryClaim,
	HostRetryRecord,
	HostRetryReply,
	HostRetryStore as HostRetryStorePort,
} from '@marimo-hub/host-protocol/retry-store';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { ConflictError, PreconditionFailedError, UnavailableError } from '../../errors';
import { sha256Hex } from '../../internal/sha256';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { readStored, StoredObjectError } from '../../schema';
import { withCasRetry } from '../catalog/cas';

export { HOST_CLAIM_LEASE_MS, HOST_RETRY_REFRESH_MS, HOST_RETRY_WINDOW_MS };
/** Matches `IdempotencyService`'s retention; far beyond any lease or retry window. */
export const HOST_RETRY_TOMBSTONE_GRACE_MS = Millis.days(1);
const ReplySchema = z.object({ status: z.number().int().min(100).max(599), body: z.unknown() });
const RecordFields = z.object({
	schema_version: z.literal(1),
	fingerprint: z.string().min(1),
	owner: z.uuid().optional(),
	claimed_at: z.number().nonnegative(),
	session_id: z.string().min(1).optional(),
	dispatched: z.boolean(),
	expires: z.number().nonnegative().optional(),
	reply: ReplySchema.optional(),
});
// A record is either held by an owner or carries an expiry. A union, rather than a refinement,
// keeps that invariant in the generated JSON Schema.
export const HostRetryRecordSchema = z.union([
	RecordFields.extend({ owner: z.uuid() }),
	// Compaction tombstones written by pre-release builds omit `claimed_at`; they hold no
	// claim or receipt, so an epoch default changes nothing about how they settle.
	RecordFields.extend({
		expires: z.number().nonnegative(),
		claimed_at: z.number().nonnegative().default(0),
	}),
]);
export const HostRetryCleanupSchema = z.object({ after: z.string().optional() });
type Record = z.infer<typeof HostRetryRecordSchema>;
export type { HostRetryClaim, HostRetryReply };

function fromStored(record: Record): HostRetryRecord {
	return {
		fingerprint: record.fingerprint,
		owner: record.owner,
		claimedAt: record.claimed_at,
		sessionId: record.session_id,
		dispatched: record.dispatched,
		expires: record.expires,
		reply: record.reply,
	};
}

function toStored(record: HostRetryRecord): string {
	return JSON.stringify({
		schema_version: 1,
		fingerprint: record.fingerprint,
		owner: record.owner,
		claimed_at: record.claimedAt,
		session_id: record.sessionId,
		dispatched: record.dispatched,
		expires: record.expires,
		reply: record.reply,
	} satisfies z.input<typeof RecordFields>);
}

/** The library's retry contract, kept in the bucket so every API instance shares one view. */
export class HostRetryStore implements HostRetryStorePort {
	constructor(private readonly bucket: Bucket) {}

	async acquire(
		scope: string,
		key: string,
		fingerprint: string,
		refresh: boolean,
	): Promise<HostRetryAcquisition> {
		const objectKey = paths.hostRetry(await sha256Hex(JSON.stringify([scope, key])));
		return withCasRetry(this.bucket, async (writer) => {
			const object = await this.bucket.get(objectKey);
			const previous = object ? await readStored(HostRetryRecordSchema, object, objectKey) : null;
			const owner = crypto.randomUUID();
			const decision = decideHostRetryAcquire(
				previous && fromStored(previous),
				fingerprint,
				refresh,
				owner,
				Date.now(),
			);
			if (decision.kind === 'conflict')
				throw new ConflictError('Idempotency-Key was used for a different request');
			if (decision.kind !== 'claim') return decision;
			await writer.put(
				objectKey,
				toStored(decision.record),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return {
				kind: 'claimed',
				claim: { key: objectKey, owner, sessionId: decision.record.sessionId },
			};
		});
	}

	async dispatch(claim: HostRetryClaim, sessionId?: string): Promise<void> {
		await this.update(claim, (record) => {
			if (record.sessionId && sessionId !== record.sessionId)
				throw new ConflictError('The request is bound to another runtime');
			return { ...record, dispatched: true, sessionId };
		});
		claim.sessionId = sessionId;
	}

	async finish(claim: HostRetryClaim, reply?: HostRetryReply): Promise<void> {
		await this.update(claim, (record) => settleHostRetryClaim(record, reply, Date.now()));
	}

	async compactExpired(): Promise<number> {
		let compacted = 0;
		const cursorObject = await this.bucket.get(paths.hostRetryCleanup);
		const cursor = cursorObject
			? await readStored(HostRetryCleanupSchema, cursorObject, paths.hostRetryCleanup)
			: {};
		const page = await this.bucket.list({
			prefix: paths.hostRetriesPrefix,
			limit: 100,
			startAfter: cursor.after,
		});
		for (const { key, uploaded } of page.objects) {
			const age = Date.now() - uploaded.getTime();
			if (age < HOST_RETRY_WINDOW_MS) continue;
			const object = await this.bucket.get(key);
			if (!object) continue;
			let record: Record;
			try {
				record = await readStored(HostRetryRecordSchema, object, key);
			} catch (error) {
				if (!(error instanceof StoredObjectError)) throw error;
				logOperationalError(
					'stored_object_skipped',
					{ operation: 'hostRetries.compactExpired', object: key },
					error,
				);
				continue;
			}
			if (record.owner || (record.expires ?? 0) > Date.now()) continue;
			if (age >= HOST_RETRY_TOMBSTONE_GRACE_MS) {
				// The port has no conditional delete. A request reusing this key between the read and
				// the delete loses its claim and fails its owner check; only one that also dispatches
				// in that window can repeat, after a day without use. IdempotencyService accepts the
				// same race.
				await this.bucket.delete(key);
				compacted++;
				continue;
			}
			if (!record.expires) continue;
			try {
				// Retain the CAS head through the grace so a delayed writer cannot resurrect a removed claim.
				await this.bucket.put(
					key,
					JSON.stringify({
						schema_version: 1,
						fingerprint: record.fingerprint,
						claimed_at: record.claimed_at,
						dispatched: false,
						expires: 0,
					}),
					{ onlyIfEtagMatches: object.etag },
				);
				compacted++;
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
		}
		try {
			await this.bucket.put(
				paths.hostRetryCleanup,
				JSON.stringify({
					after: page.truncated ? page.objects.at(-1)?.key : undefined,
				}),
				cursorObject ? { onlyIfEtagMatches: cursorObject.etag } : { onlyIfNotExists: true },
			);
		} catch (error) {
			if (!(error instanceof PreconditionFailedError)) throw error;
		}
		return compacted;
	}

	private async update(
		claim: HostRetryClaim,
		change: (record: HostRetryRecord) => HostRetryRecord,
	): Promise<void> {
		await withCasRetry(this.bucket, async (writer) => {
			const object = await this.bucket.get(claim.key);
			const record = object ? await readStored(HostRetryRecordSchema, object, claim.key) : null;
			if (!object || !record || record.owner !== claim.owner)
				throw new UnavailableError('Host retry claim is no longer owned by this request');
			await writer.put(claim.key, toStored(change(fromStored(record))), {
				onlyIfEtagMatches: object.etag,
			});
		});
	}
}

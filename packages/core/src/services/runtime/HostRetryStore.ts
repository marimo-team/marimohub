import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { ConflictError, PreconditionFailedError, UnavailableError } from '../../errors';
import { sha256Hex } from '../../internal/sha256';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { readStored, StoredObjectError } from '../../schema';
import { withCasRetry } from '../catalog/cas';

export const HOST_RETRY_WINDOW_MS = 5 * 60_000;
const ReplySchema = z.object({ status: z.number().int().min(100).max(599), body: z.unknown() });
export const HostRetryRecordSchema = z
	.object({
		schema_version: z.literal(1),
		fingerprint: z.string().min(1),
		owner: z.uuid().optional(),
		session_id: z.string().min(1).optional(),
		dispatched: z.boolean(),
		expires: z.number().nonnegative().optional(),
		reply: ReplySchema.optional(),
	})
	.refine((record) => record.owner !== undefined || record.expires !== undefined, {
		message: 'Host retry record requires an owner or expiry',
	});
export const HostRetryCleanupSchema = z.object({ after: z.string().optional() });
type Record = z.infer<typeof HostRetryRecordSchema>;
export type HostRetryReply = z.infer<typeof ReplySchema>;
export interface HostRetryClaim {
	key: string;
	owner: string;
	sessionId?: string;
}

export class HostRetryStore {
	constructor(private readonly bucket: Bucket) {}

	async acquire(
		scope: string,
		key: string,
		fingerprint: string,
		refresh: boolean,
	): Promise<
		| { kind: 'claimed'; claim: HostRetryClaim }
		| { kind: 'reply'; reply: HostRetryReply }
		| { kind: 'pending' }
	> {
		const objectKey = paths.hostRetry(await sha256Hex(JSON.stringify([scope, key])));
		return withCasRetry(this.bucket, async (writer) => {
			const object = await this.bucket.get(objectKey);
			const previous = object ? await readStored(HostRetryRecordSchema, object, objectKey) : null;
			const live = previous && (previous.owner || (previous.expires ?? 0) > Date.now());
			if (live && previous.fingerprint !== fingerprint)
				throw new ConflictError('Idempotency-Key was used for a different request');
			if (live && previous.owner) return { kind: 'pending' };
			if (live && previous.reply && !refresh) return { kind: 'reply', reply: previous.reply };
			const owner = crypto.randomUUID();
			const record: Record = {
				schema_version: 1,
				fingerprint,
				owner,
				dispatched: false,
				...(live ? { session_id: previous.session_id, expires: previous.expires } : {}),
			};
			await writer.put(
				objectKey,
				JSON.stringify(record),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return { kind: 'claimed', claim: { key: objectKey, owner, sessionId: record.session_id } };
		});
	}

	async dispatch(claim: HostRetryClaim, sessionId?: string): Promise<void> {
		await this.update(claim, (record) => {
			if (record.session_id && sessionId !== record.session_id)
				throw new ConflictError('The request is bound to another runtime');
			return { ...record, dispatched: true, session_id: sessionId };
		});
		claim.sessionId = sessionId;
	}

	async finish(claim: HostRetryClaim, reply?: HostRetryReply): Promise<void> {
		await this.update(claim, (record) => {
			// An unacknowledged Hub mutation cannot be safely re-executed after a crash or lost reply.
			if (!reply && record.dispatched && !record.session_id) return record;
			const keep = record.session_id || (reply && reply.status < 400);
			return {
				...record,
				owner: undefined,
				expires: keep ? (record.expires ?? Date.now() + HOST_RETRY_WINDOW_MS) : 0,
				reply: reply && reply.status < 400 ? reply : undefined,
			};
		});
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
			if (uploaded.getTime() + HOST_RETRY_WINDOW_MS > Date.now()) continue;
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
			if (record.owner || !record.expires || record.expires > Date.now()) continue;
			try {
				// Retain the CAS head so a delayed writer cannot resurrect a removed claim.
				await this.bucket.put(
					key,
					JSON.stringify({
						schema_version: 1,
						fingerprint: record.fingerprint,
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

	private async update(claim: HostRetryClaim, change: (record: Record) => Record): Promise<void> {
		await withCasRetry(this.bucket, async (writer) => {
			const object = await this.bucket.get(claim.key);
			const record = object ? await readStored(HostRetryRecordSchema, object, claim.key) : null;
			if (!record || record.owner !== claim.owner)
				throw new UnavailableError('Host retry claim is no longer owned by this request');
			await writer.put(claim.key, JSON.stringify(change(record)), {
				onlyIfEtagMatches: object!.etag,
			});
		});
	}
}

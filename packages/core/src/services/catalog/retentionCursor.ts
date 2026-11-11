import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { logOperationalError } from '../../operationalLog';
import { parseStored, readStoredJson } from '../../schema';
import { putIfMatch } from './cas';

const CursorSchema = z.object({ after: z.string().max(1024), next_at: z.number().optional() });

export interface RetentionCursor {
	after: string;
	/** Earliest epoch-ms time for the next pass, for scans paced over a period. */
	next_at?: number;
	etag?: string;
	/** Set when the stored cursor was unreadable, so the next write replaces it. */
	reset?: true;
}

/**
 * A cursor is disposable scan state: corruption restarts the scan instead of stopping it, and
 * the ETag is kept so the next write CAS-replaces the bad object.
 */
export async function readRetentionCursor(bucket: Bucket, key: string): Promise<RetentionCursor> {
	const object = await bucket.get(key);
	if (!object) return { after: '' };
	try {
		if (object.size > 4096) throw new Error('Retention cursor exceeds budget');
		return {
			...parseStored(CursorSchema, await readStoredJson(object, key), key),
			etag: object.etag,
		};
	} catch (error) {
		logOperationalError(
			'stored_object_skipped',
			{ operation: 'retention.cursor.read', object: key },
			error,
		);
		return { after: '', etag: object.etag, reset: true };
	}
}

/** Skips the write when the cursor is unchanged. A lost CAS keeps the competing cursor. */
export async function writeRetentionCursor(
	bucket: Bucket,
	key: string,
	after: string,
	previous: RetentionCursor,
	nextAt?: number,
): Promise<void> {
	if (
		previous.etag !== undefined &&
		!previous.reset &&
		previous.after === after &&
		previous.next_at === nextAt
	)
		return;
	await putIfMatch(
		bucket,
		key,
		JSON.stringify(nextAt === undefined ? { after } : { after, next_at: nextAt }),
		previous.etag,
	);
}

export function retentionBatch<T extends { key: string }>(
	items: T[],
	after: string,
	limit: number,
): T[] {
	const ordered = items.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const start = Math.max(
		0,
		ordered.findIndex((item) => item.key > after),
	);
	return ordered.slice(start, start + limit);
}

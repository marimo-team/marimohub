import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { PreconditionFailedError } from '../../errors';

const CursorSchema = z.object({ after: z.string().max(1024) });

export async function readRetentionCursor(bucket: Bucket, key: string) {
	const object = await bucket.get(key);
	if (!object) return { after: '', etag: undefined as string | undefined };
	if (object.size > 4096) throw new Error('Retention cursor exceeds budget');
	return { ...CursorSchema.parse(await object.json()), etag: object.etag };
}

export async function writeRetentionCursor(
	bucket: Bucket,
	key: string,
	after: string,
	etag?: string,
) {
	try {
		await bucket.put(
			key,
			JSON.stringify({ after }),
			etag !== undefined ? { onlyIfEtagMatches: etag } : { onlyIfNotExists: true },
		);
	} catch (error) {
		if (!(error instanceof PreconditionFailedError)) throw error;
	}
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

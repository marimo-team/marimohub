import type { Bucket, BucketObject } from '../../ports/bucket';

/**
 * List every object under a prefix, paginating on the bucket cursor until the
 * listing is no longer truncated. The default list page is ~1000 objects, so a
 * prefix with more than that (e.g. `_system/sessions/`) spans multiple pages;
 * callers that must see the whole set use this rather than a single `bucket.list`.
 */
export async function listAllObjects(bucket: Bucket, prefix: string): Promise<BucketObject[]> {
	const objects: BucketObject[] = [];
	let cursor: string | undefined;
	do {
		const res = await bucket.list({ prefix, cursor });
		objects.push(...res.objects);
		cursor = res.truncated ? res.cursor : undefined;
	} while (cursor);
	return objects;
}

/**
 * List every object key under a prefix, paginating on the bucket cursor until
 * the listing is no longer truncated. The default list page is 1000 keys, so a
 * project subtree or a long version history can span multiple pages; callers
 * that need the full set (e.g. recursive delete) must use this rather than a
 * single `bucket.list`.
 */
export async function listAllKeys(bucket: Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const res = await bucket.list({ prefix, cursor });
		for (const o of res.objects) {
			keys.push(o.key);
		}
		cursor = res.truncated ? res.cursor : undefined;
	} while (cursor);
	return keys;
}

/** Collect every rolled-up prefix because remote stores paginate delimiter listings. */
export async function listAllPrefixes(
	bucket: Bucket,
	prefix: string,
	delimiter = '/',
): Promise<string[]> {
	const prefixes = new Set<string>();
	let cursor: string | undefined;
	do {
		const result = await bucket.list({ prefix, delimiter, cursor });
		for (const delimitedPrefix of result.delimitedPrefixes) {
			prefixes.add(delimitedPrefix);
		}
		cursor = result.truncated ? result.cursor : undefined;
	} while (cursor);
	return [...prefixes].sort();
}

/**
 * Recursively delete every object under a prefix (the paginated list + batch
 * delete used by the hard-delete paths). Returns the number of keys removed.
 */
export async function deleteByPrefix(bucket: Bucket, prefix: string): Promise<number> {
	const keys = await listAllKeys(bucket, prefix);
	if (keys.length > 0) {
		await bucket.delete(keys);
	}
	return keys.length;
}

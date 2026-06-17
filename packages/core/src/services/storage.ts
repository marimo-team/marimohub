import type { Bucket } from '../ports/bucket';

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

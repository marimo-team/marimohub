import { METADATA_CACHE_MAX_ENTRIES } from '../../constants';
import { EtagRecordCache } from '../../etagRecordCache';
import type { Bucket, BucketObjectBody } from '../../ports/bucket';

export type ReadConsistency = 'fresh' | 'validated';

/**
 * Reuses parsed metadata only after storage confirms its ETag. Never serves stale on error.
 * Validated reads return a clone so callers cannot mutate the cached record.
 */
export class MetadataCache<T> {
	private readonly entries: EtagRecordCache<T>;

	constructor(
		private readonly bucket: Bucket,
		maxSize = METADATA_CACHE_MAX_ENTRIES,
	) {
		this.entries = new EtagRecordCache(maxSize);
	}

	async read(
		keys: readonly string[],
		parse: (object: BucketObjectBody) => Promise<T>,
		consistency: ReadConsistency = 'fresh',
	): Promise<T | null> {
		if (consistency === 'validated' && keys.some((key) => this.entries.has(key))) {
			const head = await firstExisting(keys, (key) => this.bucket.head(key));
			if (!head) {
				for (const key of keys) this.entries.delete(key);
				return null;
			}
			const cached = this.entries.get(head.key, head.etag);
			if (cached !== undefined) return structuredClone(cached);
		}
		const object = await firstExisting(keys, (key) => this.bucket.get(key));
		if (!object) return null;
		const value = await parse(object);
		// A write can occur between HEAD and GET, so use the fetched ETag.
		if (consistency !== 'validated') return value;
		this.entries.set(object.key, object.etag, value);
		return structuredClone(value);
	}
}

async function firstExisting<T>(
	keys: readonly string[],
	read: (key: string) => Promise<T | null>,
): Promise<T | null> {
	for (const key of keys) {
		const object = await read(key);
		if (object !== null) return object;
	}
	return null;
}

import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { METADATA_CACHE_MAX_ENTRIES } from '../../constants';
import { EtagRecordCache } from '../../etagRecordCache';
import { isNotModified } from '../../ports/bucket';
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
		entries?: EtagRecordCache<T>,
		private readonly metrics: Metrics = noopMetrics,
		private readonly labels: { cache: string; service: string } | Record<string, never> = {},
	) {
		this.entries = entries ?? new EtagRecordCache(maxSize);
	}

	async read(
		keys: readonly string[],
		parse: (object: BucketObjectBody) => Promise<T>,
		consistency: ReadConsistency = 'fresh',
	): Promise<T | null> {
		for (const key of keys) {
			const cached = consistency === 'validated' ? this.entries.peek(key) : undefined;
			const object = cached
				? await this.bucket.get(key, { ifNoneMatch: cached.etag })
				: await this.bucket.get(key);
			if (!object) {
				if (cached) this.metrics.increment('cache.conditional.reads', 1, { result: 'missing' });
				this.metrics.increment('cache.metadata.reads', 1, {
					...this.labels,
					result: 'miss',
					consistency,
				});
				this.entries.delete(key);
				continue;
			}
			if (isNotModified(object)) {
				if (!cached || cached.etag !== object.etag) {
					if (cached) this.metrics.increment('cache.conditional.reads', 1, { result: 'invalid' });
					throw new Error('Invalid conditional read response');
				}
				this.metrics.increment('cache.conditional.reads', 1, { result: 'not_modified' });
				this.metrics.increment('cache.metadata.reads', 1, {
					...this.labels,
					result: 'hit',
					consistency,
				});
				this.entries.get(key, cached.etag);
				return structuredClone(cached.value);
			}
			if (cached) this.metrics.increment('cache.conditional.reads', 1, { result: 'modified' });
			this.metrics.increment('cache.metadata.reads', 1, {
				...this.labels,
				result: 'miss',
				consistency,
			});
			const value = await parse(object);
			if (consistency !== 'validated') return value;
			this.entries.set(key, object.etag, value);
			return structuredClone(value);
		}
		return null;
	}
}

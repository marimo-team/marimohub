import { BoundedLruMap } from './cache';
import { METADATA_CACHE_MAX_ENTRIES } from './constants';

/**
 * Bounded LRU cache. Reads require the current ETag, and writes use the fetched
 * ETag. An empty ETag is uncacheable: adapters fall back to `''` when the store
 * returns none, and two such values would falsely match. Values are stored by
 * reference, so callers clone before handing them out.
 */
export class EtagRecordCache<T> {
	private readonly entries: BoundedLruMap<string, { etag: string; value: T }>;

	constructor(maxSize = METADATA_CACHE_MAX_ENTRIES) {
		this.entries = new BoundedLruMap(maxSize);
	}

	get size(): number {
		return this.entries.size;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	get(key: string, etag: string): T | undefined {
		if (!etag) return undefined;
		// Peek first so a mismatch does not refresh the stale entry's LRU position.
		const entry = this.entries.peek(key);
		if (!entry || entry.etag !== etag) return undefined;
		return this.entries.get(key)?.value;
	}

	set(key: string, etag: string, value: T): void {
		if (!etag) {
			this.entries.delete(key);
			return;
		}
		this.entries.set(key, { etag, value });
	}

	delete(key: string): void {
		this.entries.delete(key);
	}
}

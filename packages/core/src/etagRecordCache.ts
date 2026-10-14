/**
 * Bounded LRU cache. Reads require the current ETag, and writes use the fetched
 * ETag. Values are shared references that callers must not mutate.
 */
export class EtagRecordCache<T> {
	private readonly entries = new Map<string, { etag: string; value: T }>();

	constructor(private readonly maxSize = 10_000) {
		if (!Number.isInteger(maxSize) || maxSize <= 0) {
			throw new RangeError('maxSize must be a positive integer');
		}
	}

	get size(): number {
		return this.entries.size;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	get(key: string, etag: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry || entry.etag !== etag) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: string, etag: string, value: T): void {
		this.entries.delete(key);
		this.entries.set(key, { etag, value });
		while (this.entries.size > this.maxSize) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}

	delete(key: string): void {
		this.entries.delete(key);
	}
}

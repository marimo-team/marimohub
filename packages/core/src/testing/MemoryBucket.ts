import { PreconditionFailedError } from '../errors';
import { assertValidBucketListLimit, compareBucketKeys } from '../ports/bucket';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketGetOptions,
	BucketGetResult,
	BucketPutOptions,
} from '../ports/bucket';

interface StoredObject {
	metadata: Pick<BucketPutOptions, 'httpMetadata' | 'customMetadata'>;
	body: Uint8Array;
	etag: string;
	uploaded: Date;
}

export class MemoryBucket implements Bucket {
	private store = new Map<string, StoredObject>();
	private sortedKeys?: string[];
	private etagCounter = 0;
	private etagPrefix = 'etag-';
	private clones = 0;

	private nextEtag(): string {
		this.etagCounter++;
		return `${this.etagPrefix}${this.etagCounter}`;
	}

	/**
	 * A copy with its own key space that keeps every existing ETag, so CAS tokens
	 * and ETag fingerprints taken from the source stay valid on it. New writes on
	 * the copy mint ETags under a distinct prefix, so the two never collide after
	 * they diverge. Stored objects are never mutated in place (`put` replaces the
	 * entry), so sharing the entries and their bodies is safe.
	 */
	clone(): MemoryBucket {
		const copy = new MemoryBucket();
		copy.store = new Map(this.store);
		copy.sortedKeys = this.sortedKeys;
		copy.etagCounter = this.etagCounter;
		copy.etagPrefix = `${this.etagPrefix}c${++this.clones}-`;
		return copy;
	}

	get(key: string): Promise<BucketObjectBody | null>;
	get(key: string, options?: BucketGetOptions): Promise<BucketGetResult>;
	async get(key: string, options?: BucketGetOptions): Promise<BucketGetResult> {
		const stored = this.store.get(key);
		if (!stored) return null;

		if (options?.ifNoneMatch && options.ifNoneMatch === stored.etag) {
			return { key, etag: stored.etag, notModified: true };
		}
		const { body, etag, uploaded } = stored;
		return {
			key,
			etag,
			size: body.length,
			uploaded,
			...structuredClone(stored.metadata),
			text: async () => new TextDecoder().decode(body),
			json: async <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
			bytes: async () => body,
		};
	}

	async head(key: string): Promise<BucketObject | null> {
		const stored = this.store.get(key);
		if (!stored) return null;

		return {
			key,
			etag: stored.etag,
			size: stored.body.length,
			uploaded: stored.uploaded,
			...structuredClone(stored.metadata),
		};
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: BucketPutOptions,
	): Promise<BucketObject> {
		if (options?.onlyIfEtagMatches && options?.onlyIfNotExists) {
			throw new Error('onlyIfEtagMatches and onlyIfNotExists are mutually exclusive');
		}

		if (options?.onlyIfNotExists && this.store.has(key)) {
			throw new PreconditionFailedError(`Key "${key}" already exists`);
		}

		if (options?.onlyIfEtagMatches) {
			const existing = this.store.get(key);
			if (!existing || existing.etag !== options.onlyIfEtagMatches) {
				throw new PreconditionFailedError(`ETag mismatch for key "${key}"`);
			}
		}

		const body = typeof value === 'string' ? new TextEncoder().encode(value) : value;
		const etag = this.nextEtag();
		const uploaded = new Date();
		const metadata = structuredClone({
			...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
			...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
		});
		if (!this.store.has(key)) this.sortedKeys = undefined;
		this.store.set(key, { body, etag, uploaded, metadata });

		return { key, etag, size: body.length, uploaded };
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		for (const k of keys) {
			if (this.store.delete(k)) this.sortedKeys = undefined;
		}
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		assertValidBucketListLimit(options?.limit);
		const prefix = options?.prefix ?? '';
		const delimiter = options?.delimiter;
		const limit = options?.limit ?? 1000;
		// Both `cursor` (resume token) and `startAfter` are exclusive lower bounds on
		// the key; honor whichever is larger.
		const after = [options?.cursor, options?.startAfter]
			.filter((v): v is string => Boolean(v))
			.sort(compareBucketKeys)
			.pop();

		// Migration pages must not re-sort or revisit the entire fixture on each request.
		const sorted = (this.sortedKeys ??= [...this.store.keys()].sort(compareBucketKeys));
		let start = 0;
		let end = sorted.length;
		while (start < end) {
			const mid = Math.floor((start + end) / 2);
			if (
				compareBucketKeys(sorted[mid], prefix) < 0 ||
				(after && compareBucketKeys(sorted[mid], after) <= 0)
			)
				start = mid + 1;
			else end = mid;
		}

		const prefixes = new Set<string>();
		const objectKeys: string[] = [];
		let emitted = 0;
		let lastConsumed: string | undefined;
		let truncated = false;
		for (let i = start; i < sorted.length; i++) {
			const key = sorted[i];
			if (!key.startsWith(prefix)) break;
			if (delimiter) {
				const rest = key.slice(prefix.length);
				const idx = rest.indexOf(delimiter);
				if (idx !== -1) {
					const delimitedPrefix = prefix + rest.slice(0, idx + delimiter.length);
					if (prefixes.has(delimitedPrefix)) {
						lastConsumed = key;
						continue;
					}
					if (emitted === limit) {
						truncated = true;
						break;
					}
					prefixes.add(delimitedPrefix);
					emitted++;
					lastConsumed = key;
					continue;
				}
			}
			if (emitted === limit) {
				truncated = true;
				break;
			}
			objectKeys.push(key);
			emitted++;
			lastConsumed = key;
		}

		const objects: BucketObject[] = objectKeys.map((key) => {
			const stored = this.store.get(key)!;
			return { key, etag: stored.etag, size: stored.body.length, uploaded: stored.uploaded };
		});

		return {
			objects,
			truncated,
			cursor: truncated ? lastConsumed : undefined,
			delimitedPrefixes: [...prefixes].sort(compareBucketKeys),
		};
	}
}

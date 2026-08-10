import { PreconditionFailedError } from '../errors';
import { assertValidBucketListLimit } from '../ports/bucket';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '../ports/bucket';

interface StoredObject {
	body: Uint8Array;
	etag: string;
	uploaded: Date;
}

export class MemoryBucket implements Bucket {
	private store = new Map<string, StoredObject>();
	private etagCounter = 0;

	private nextEtag(): string {
		this.etagCounter++;
		return `etag-${this.etagCounter}`;
	}

	async get(key: string): Promise<BucketObjectBody | null> {
		const stored = this.store.get(key);
		if (!stored) return null;

		const { body, etag, uploaded } = stored;
		return {
			key,
			etag,
			size: body.length,
			uploaded,
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
		this.store.set(key, { body, etag, uploaded });

		return { key, etag, size: body.length, uploaded };
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		for (const k of keys) {
			this.store.delete(k);
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
			.sort()
			.pop();

		const sorted = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

		const prefixes = new Set<string>();
		const objectKeys: string[] = [];
		let emitted = 0;
		let lastConsumed: string | undefined;
		let truncated = false;
		for (const key of sorted) {
			if (after && key <= after) continue;
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
			delimitedPrefixes: [...prefixes].sort(),
		};
	}
}

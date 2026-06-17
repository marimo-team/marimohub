import { PreconditionFailedError } from '../errors';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '../ports/bucket';

interface StoredObject {
	body: string;
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
			text: async () => body,
			json: async <T>() => JSON.parse(body) as T,
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

	async put(key: string, value: string, options?: BucketPutOptions): Promise<BucketObject> {
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

		const etag = this.nextEtag();
		const uploaded = new Date();
		this.store.set(key, { body: value, etag, uploaded });

		return { key, etag, size: value.length, uploaded };
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		for (const k of keys) {
			this.store.delete(k);
		}
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		const prefix = options?.prefix ?? '';
		const delimiter = options?.delimiter;
		const limit = options?.limit ?? 1000;
		const startAfter = options?.startAfter;

		const allKeys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

		const objects: BucketObject[] = [];
		const prefixes = new Set<string>();

		for (const key of allKeys) {
			if (startAfter && key <= startAfter) continue;

			if (delimiter) {
				const rest = key.slice(prefix.length);
				const delimIdx = rest.indexOf(delimiter);
				if (delimIdx !== -1) {
					prefixes.add(prefix + rest.slice(0, delimIdx + delimiter.length));
					continue;
				}
			}

			const stored = this.store.get(key)!;
			objects.push({
				key,
				etag: stored.etag,
				size: stored.body.length,
				uploaded: stored.uploaded,
			});

			if (objects.length >= limit) break;
		}

		return {
			objects,
			truncated: false,
			delimitedPrefixes: [...prefixes].sort(),
		};
	}
}

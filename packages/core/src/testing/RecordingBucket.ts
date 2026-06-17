import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '../ports/bucket';
import { MemoryBucket } from './MemoryBucket';

/** Every call a test wants to assert against, captured in call order. */
export interface BucketCalls {
	get: string[];
	head: string[];
	put: { key: string; bytes: number }[];
	delete: string[][];
	list: BucketListOptions[];
}

/**
 * A `Bucket` decorator that delegates to an inner bucket (default
 * `MemoryBucket`) while recording every call. Composition over the port: tests
 * assert access patterns — e.g. that an oversized key was *never* `get`-ed, so it
 * was never buffered into memory — without ad-hoc `vi.spyOn` per test. Because it
 * is a faithful pass-through it also satisfies the bucket contract suite.
 */
export class RecordingBucket implements Bucket {
	readonly calls: BucketCalls = { get: [], head: [], put: [], delete: [], list: [] };

	constructor(private readonly inner: Bucket = new MemoryBucket()) {}

	async get(key: string): Promise<BucketObjectBody | null> {
		this.calls.get.push(key);
		return this.inner.get(key);
	}

	async head(key: string): Promise<BucketObject | null> {
		this.calls.head.push(key);
		return this.inner.head(key);
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: BucketPutOptions,
	): Promise<BucketObject> {
		const bytes = typeof value === 'string' ? new TextEncoder().encode(value).length : value.length;
		this.calls.put.push({ key, bytes });
		return this.inner.put(key, value, options);
	}

	async delete(key: string | string[]): Promise<void> {
		this.calls.delete.push(Array.isArray(key) ? key : [key]);
		return this.inner.delete(key);
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		this.calls.list.push(options ?? {});
		return this.inner.list(options);
	}
}

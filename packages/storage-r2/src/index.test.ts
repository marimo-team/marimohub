import { describe, it, expect } from 'vitest';
import { PreconditionFailedError } from '@marimo-hub/core';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { R2BucketAdapter } from './index';

// ---------------------------------------------------------------------------
// Fake R2Bucket — a Map-based implementation of the R2 surface the adapter
// uses. Honors `onlyIf.etagMatches` and `onlyIf.etagDoesNotMatch === '*'`
// (create-if-absent) by returning null on conflict, matching the real R2 API.
// ---------------------------------------------------------------------------

interface FakeStored {
	body: Uint8Array;
	etag: string;
	size: number;
	uploaded: Date;
}

function toBytes(value: string | ArrayBuffer | ArrayBufferView): Uint8Array {
	if (typeof value === 'string') return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

let etagCounter = 0;

function makeR2Object(key: string, stored: FakeStored): R2Object {
	return {
		key,
		version: '1',
		etag: stored.etag,
		httpEtag: `"${stored.etag}"`,
		size: stored.size,
		uploaded: stored.uploaded,
		checksums: {} as R2Checksums,
		httpMetadata: {} as R2HTTPMetadata,
		customMetadata: {},
		range: undefined as unknown as R2Range,
		storageClass: 'Standard',
		writeHttpMetadata: () => {},
	} as unknown as R2Object;
}

function makeR2ObjectBody(key: string, stored: FakeStored): R2ObjectBody {
	return {
		...makeR2Object(key, stored),
		body: null as unknown as ReadableStream,
		bodyUsed: false,
		text: async () => new TextDecoder().decode(stored.body),
		json: async <T>() => JSON.parse(new TextDecoder().decode(stored.body)) as T,
		arrayBuffer: async () =>
			stored.body.buffer.slice(
				stored.body.byteOffset,
				stored.body.byteOffset + stored.body.byteLength,
			) as ArrayBuffer,
		blob: async () => new Blob([new Uint8Array(stored.body)]),
	} as unknown as R2ObjectBody;
}

class FakeR2Bucket {
	private store = new Map<string, FakeStored>();

	async get(key: string): Promise<R2ObjectBody | null> {
		const stored = this.store.get(key);
		return stored ? makeR2ObjectBody(key, stored) : null;
	}

	async head(key: string): Promise<R2Object | null> {
		const stored = this.store.get(key);
		return stored ? makeR2Object(key, stored) : null;
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView,
		options?: R2PutOptions,
	): Promise<R2Object | null> {
		const existing = this.store.get(key);

		if (options?.onlyIf) {
			const cond = options.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string };
			if (cond.etagMatches !== undefined && (!existing || existing.etag !== cond.etagMatches)) {
				return null;
			}
			if (cond.etagDoesNotMatch === '*' && existing) {
				return null;
			}
		}

		etagCounter++;
		const etag = `etag-${etagCounter}`;
		const body = toBytes(value);
		const stored: FakeStored = { body, etag, size: body.length, uploaded: new Date() };
		this.store.set(key, stored);
		return makeR2Object(key, stored);
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		for (const k of keys) this.store.delete(k);
	}

	async list(options?: R2ListOptions): Promise<R2Objects> {
		const prefix = options?.prefix ?? '';
		const delimiter = options?.delimiter;
		const limit = options?.limit ?? 1000;
		const cursor = options?.cursor;
		const startAfter = options?.startAfter;

		const after = [cursor, startAfter]
			.filter((v): v is string => Boolean(v))
			.sort()
			.pop();

		const sorted = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

		const prefixes: string[] = [];
		const objectKeys: string[] = [];
		for (const key of sorted) {
			if (after && key <= after) continue;
			if (delimiter) {
				const rest = key.slice(prefix.length);
				const idx = rest.indexOf(delimiter);
				if (idx !== -1) {
					const pfx = prefix + rest.slice(0, idx + delimiter.length);
					if (!prefixes.includes(pfx)) prefixes.push(pfx);
					continue;
				}
			}
			objectKeys.push(key);
		}

		const pageKeys = delimiter ? objectKeys : objectKeys.slice(0, limit);
		const truncated = !delimiter && objectKeys.length > limit;

		const objects: R2Object[] = pageKeys.map((key) => {
			return makeR2Object(key, this.store.get(key)!);
		});

		return {
			objects,
			truncated,
			cursor: truncated ? pageKeys[pageKeys.length - 1] : undefined,
			delimitedPrefixes: prefixes,
		} as unknown as R2Objects;
	}
}

function makeFakeR2(): R2Bucket {
	return new FakeR2Bucket() as unknown as R2Bucket;
}

// ---------------------------------------------------------------------------
// Run the shared bucket contract suite against the R2BucketAdapter + fake R2.
// This validates CAS / create-if-absent parity with MemoryBucket and S3Storage.
// ---------------------------------------------------------------------------
bucketContract('R2BucketAdapter', () => new R2BucketAdapter(makeFakeR2()));

// ---------------------------------------------------------------------------
// Focused unit tests for the null→PreconditionFailedError mapping.
// ---------------------------------------------------------------------------
describe('R2BucketAdapter CAS error mapping', () => {
	it('put with onlyIfEtagMatches + wrong etag → PreconditionFailedError', async () => {
		const adapter = new R2BucketAdapter(makeFakeR2());
		await adapter.put('k', 'v1');
		await expect(
			adapter.put('k', 'v2', { onlyIfEtagMatches: 'wrong-etag' }),
		).rejects.toBeInstanceOf(PreconditionFailedError);
	});

	it('put with onlyIfNotExists on an existing key → PreconditionFailedError', async () => {
		const adapter = new R2BucketAdapter(makeFakeR2());
		await adapter.put('k', 'v1');
		await expect(adapter.put('k', 'v2', { onlyIfNotExists: true })).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
	});

	it('put with onlyIfNotExists on a missing key succeeds', async () => {
		const adapter = new R2BucketAdapter(makeFakeR2());
		const result = await adapter.put('new', 'v1', { onlyIfNotExists: true });
		expect(result.etag).toBeTruthy();
	});

	it('honors an empty-string onlyIfEtagMatches as a precondition (not a truthy skip)', async () => {
		const adapter = new R2BucketAdapter(makeFakeR2());
		// Real etags are never empty, but presence — not truthiness — must gate the
		// CAS: an empty-string etag can't match a stored non-empty etag, so the write
		// is rejected rather than silently applied unconditionally.
		await adapter.put('k', 'v1');
		await expect(adapter.put('k', 'v2', { onlyIfEtagMatches: '' })).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
	});
});

describe('R2BucketAdapter list / put forwarding', () => {
	function makeR2Object2(key: string): R2Object {
		return {
			key,
			etag: 'e',
			size: 1,
			uploaded: new Date(),
		} as unknown as R2Object;
	}

	it('surfaces a cursor only when the result is truncated', async () => {
		let toReturn: unknown;
		const r2 = {
			list: async () => toReturn,
		} as unknown as R2Bucket;
		const adapter = new R2BucketAdapter(r2);

		toReturn = { objects: [], truncated: false, cursor: 'leftover', delimitedPrefixes: [] };
		expect((await adapter.list()).cursor).toBeUndefined();

		toReturn = { objects: [], truncated: true, cursor: 'more', delimitedPrefixes: [] };
		const truncated = await adapter.list();
		expect(truncated.truncated).toBe(true);
		expect(truncated.cursor).toBe('more');
	});

	it('forwards prefix/delimiter/cursor/limit/startAfter to r2.list', async () => {
		let seen: R2ListOptions | undefined;
		const r2 = {
			list: async (opts?: R2ListOptions) => {
				seen = opts;
				return { objects: [], truncated: false, delimitedPrefixes: [] };
			},
		} as unknown as R2Bucket;
		const adapter = new R2BucketAdapter(r2);

		await adapter.list({
			prefix: 'p/',
			delimiter: '/',
			cursor: 'tok',
			limit: 42,
			startAfter: 'p/0',
		});

		expect(seen).toMatchObject({
			prefix: 'p/',
			delimiter: '/',
			cursor: 'tok',
			limit: 42,
			startAfter: 'p/0',
		});
	});

	it('passes through delimitedPrefixes from r2.list', async () => {
		const r2 = {
			list: async () => ({
				objects: [makeR2Object2('a/1')],
				truncated: false,
				delimitedPrefixes: ['a/', 'b/'],
			}),
		} as unknown as R2Bucket;
		const adapter = new R2BucketAdapter(r2);

		const res = await adapter.list({ delimiter: '/' });
		expect(res.delimitedPrefixes).toEqual(['a/', 'b/']);
	});

	it('forwards httpMetadata and customMetadata to r2.put', async () => {
		let seen: R2PutOptions | undefined;
		const r2 = {
			put: async (key: string, _value: unknown, opts?: R2PutOptions) => {
				seen = opts;
				return makeR2Object2(key);
			},
		} as unknown as R2Bucket;
		const adapter = new R2BucketAdapter(r2);

		await adapter.put('k', 'v', {
			httpMetadata: { contentType: 'text/x-python' },
			customMetadata: { source: 'git' },
		});

		expect(seen?.httpMetadata).toEqual({ contentType: 'text/x-python' });
		expect(seen?.customMetadata).toEqual({ source: 'git' });
	});
});

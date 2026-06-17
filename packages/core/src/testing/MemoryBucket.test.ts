import { describe, it, expect, beforeEach } from 'vitest';
import { PreconditionFailedError } from '../errors';
import { listAllObjects } from '../services/catalog/storage';
import { MemoryBucket } from './MemoryBucket';

describe('MemoryBucket', () => {
	let bucket: MemoryBucket;

	beforeEach(() => {
		bucket = new MemoryBucket();
	});

	describe('get/put', () => {
		it('returns null for missing key', async () => {
			expect(await bucket.get('missing')).toBeNull();
		});

		it('stores and retrieves text', async () => {
			await bucket.put('key', 'hello');
			const obj = await bucket.get('key');
			expect(await obj!.text()).toBe('hello');
		});

		it('stores and retrieves JSON', async () => {
			const data = { foo: 'bar', n: 42 };
			await bucket.put('key', JSON.stringify(data));
			const obj = await bucket.get('key');
			expect(await obj!.json()).toEqual(data);
		});

		it('returns correct metadata', async () => {
			const result = await bucket.put('key', 'hello');
			expect(result.key).toBe('key');
			expect(result.size).toBe(5);
			expect(result.etag).toBeTruthy();
			expect(result.uploaded).toBeInstanceOf(Date);
		});

		it('overwrites existing keys', async () => {
			await bucket.put('key', 'first');
			await bucket.put('key', 'second');
			const obj = await bucket.get('key');
			expect(await obj!.text()).toBe('second');
		});
	});

	describe('head', () => {
		it('returns null for missing key', async () => {
			expect(await bucket.head('missing')).toBeNull();
		});

		it('returns metadata without body', async () => {
			await bucket.put('key', 'hello');
			const head = await bucket.head('key');
			expect(head!.key).toBe('key');
			expect(head!.size).toBe(5);
			expect(head).not.toHaveProperty('text');
		});
	});

	describe('delete', () => {
		it('deletes a single key', async () => {
			await bucket.put('key', 'val');
			await bucket.delete('key');
			expect(await bucket.get('key')).toBeNull();
		});

		it('deletes multiple keys', async () => {
			await bucket.put('a', '1');
			await bucket.put('b', '2');
			await bucket.delete(['a', 'b']);
			expect(await bucket.get('a')).toBeNull();
			expect(await bucket.get('b')).toBeNull();
		});

		it('silently ignores missing keys', async () => {
			await expect(bucket.delete('nonexistent')).resolves.not.toThrow();
		});
	});

	describe('conditional put (onlyIfEtagMatches)', () => {
		it('succeeds when etag matches', async () => {
			const first = await bucket.put('key', 'v1');
			await bucket.put('key', 'v2', { onlyIfEtagMatches: first.etag });
			const obj = await bucket.get('key');
			expect(await obj!.text()).toBe('v2');
		});

		it('throws PreconditionFailedError when etag mismatches', async () => {
			await bucket.put('key', 'v1');
			await expect(bucket.put('key', 'v2', { onlyIfEtagMatches: 'wrong-etag' })).rejects.toThrow(
				PreconditionFailedError,
			);
		});

		it('throws PreconditionFailedError when key does not exist', async () => {
			await expect(bucket.put('missing', 'v1', { onlyIfEtagMatches: 'any-etag' })).rejects.toThrow(
				PreconditionFailedError,
			);
		});

		it('prevents stale writes in a race', async () => {
			const first = await bucket.put('key', 'v1');
			// Writer A reads etag
			const etagA = first.etag;
			// Writer B also reads etag (same value)
			const etagB = first.etag;

			// Writer A succeeds
			await bucket.put('key', 'from-A', { onlyIfEtagMatches: etagA });

			// Writer B fails — etag changed
			await expect(bucket.put('key', 'from-B', { onlyIfEtagMatches: etagB })).rejects.toThrow(
				PreconditionFailedError,
			);

			// Only A's write persisted
			const obj = await bucket.get('key');
			expect(await obj!.text()).toBe('from-A');
		});
	});

	describe('list', () => {
		beforeEach(async () => {
			await bucket.put('a/1.json', '{}');
			await bucket.put('a/2.json', '{}');
			await bucket.put('a/sub/3.json', '{}');
			await bucket.put('b/4.json', '{}');
		});

		it('lists all objects without options', async () => {
			const result = await bucket.list();
			expect(result.objects).toHaveLength(4);
		});

		it('filters by prefix', async () => {
			const result = await bucket.list({ prefix: 'a/' });
			expect(result.objects.map((o) => o.key)).toEqual(['a/1.json', 'a/2.json', 'a/sub/3.json']);
		});

		it('uses delimiter to group prefixes', async () => {
			const result = await bucket.list({ prefix: 'a/', delimiter: '/' });
			expect(result.objects.map((o) => o.key)).toEqual(['a/1.json', 'a/2.json']);
			expect(result.delimitedPrefixes).toEqual(['a/sub/']);
		});

		it('respects limit', async () => {
			const result = await bucket.list({ limit: 2 });
			expect(result.objects).toHaveLength(2);
		});

		it('respects startAfter', async () => {
			const result = await bucket.list({ startAfter: 'a/2.json' });
			expect(result.objects.map((o) => o.key)).toEqual(['a/sub/3.json', 'b/4.json']);
		});
	});

	describe('pagination', () => {
		it('returns the first page with truncated=true and a cursor when there are more than limit objects', async () => {
			// Put 1500 objects under a common prefix
			for (let i = 0; i < 1500; i++) {
				await bucket.put(`p/${String(i).padStart(4, '0')}`, '{}');
			}

			const page1 = await bucket.list({ prefix: 'p/' });
			expect(page1.objects).toHaveLength(1000);
			expect(page1.truncated).toBe(true);
			expect(page1.cursor).toBeDefined();

			const page2 = await bucket.list({ prefix: 'p/', cursor: page1.cursor });
			expect(page2.objects).toHaveLength(500);
			expect(page2.truncated).toBe(false);
		});

		it('listAllObjects returns all objects across page boundaries', async () => {
			for (let i = 0; i < 1500; i++) {
				await bucket.put(`p/${String(i).padStart(4, '0')}`, '{}');
			}

			const all = await listAllObjects(bucket, 'p/');
			expect(all).toHaveLength(1500);

			// Confirm all keys are distinct and all present
			const keys = new Set(all.map((o) => o.key));
			expect(keys.size).toBe(1500);
		});

		it('delimited listings still return all prefixes in one shot (no pagination)', async () => {
			for (let i = 0; i < 1500; i++) {
				await bucket.put(`p/${String(i).padStart(4, '0')}/data`, '{}');
			}

			// With a delimiter, should return all 1500 collapsed prefixes in one call
			const result = await bucket.list({ prefix: 'p/', delimiter: '/' });
			expect(result.truncated).toBe(false);
			expect(result.delimitedPrefixes).toHaveLength(1500);
		});
	});
});

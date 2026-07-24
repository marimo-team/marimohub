import { describe, it, expect, vi } from 'vitest';
import { MemoryBucket } from '../../testing';
import type { BucketListOptions } from '../../ports/bucket';
import { deleteByPrefix, listAllKeys, listAllObjects } from './storage';

/**
 * MemoryBucket pages at `limit` (default 1000). These helpers never pass a
 * limit, so to exercise the multi-page cursor loop without writing 1000+
 * objects we force a tiny page size here.
 */
class SmallPageBucket extends MemoryBucket {
	constructor(private readonly pageSize: number) {
		super();
	}
	override list(options?: BucketListOptions) {
		return super.list({ ...options, limit: options?.limit ?? this.pageSize });
	}
}

async function seed(bucket: MemoryBucket, keys: string[]): Promise<void> {
	for (const k of keys) {
		await bucket.put(k, `body-of-${k}`);
	}
}

describe('listAllObjects', () => {
	it('returns [] for an empty prefix', async () => {
		const bucket = new MemoryBucket();
		expect(await listAllObjects(bucket, 'projects/')).toEqual([]);
	});

	it('returns every object under the prefix on a single page', async () => {
		const bucket = new MemoryBucket();
		await seed(bucket, ['projects/a', 'projects/b', 'other/c']);

		const objects = await listAllObjects(bucket, 'projects/');
		expect(objects.map((o) => o.key).sort()).toEqual(['projects/a', 'projects/b']);
	});

	it('follows the cursor across multiple pages and returns the full set', async () => {
		const bucket = new SmallPageBucket(2);
		const keys = Array.from({ length: 5 }, (_, i) => `_system/sessions/s${i}`);
		await seed(bucket, keys);

		const objects = await listAllObjects(bucket, '_system/sessions/');
		expect(objects.map((o) => o.key).sort()).toEqual([...keys].sort());
	});

	it('stops paging once the listing is no longer truncated', async () => {
		const bucket = new SmallPageBucket(2);
		await seed(bucket, ['p/1', 'p/2', 'p/3']); // 3 objects, page size 2 => 2 pages
		const spy = vi.spyOn(bucket, 'list');

		await listAllObjects(bucket, 'p/');

		// page 1 (2 objects, truncated) + page 2 (1 object, not truncated) = 2 calls
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('does not page beyond the last full page (no extra empty fetch)', async () => {
		const bucket = new SmallPageBucket(2);
		await seed(bucket, ['p/1', 'p/2', 'p/3', 'p/4']); // exactly 2 full pages
		const spy = vi.spyOn(bucket, 'list');

		const objects = await listAllObjects(bucket, 'p/');

		expect(objects).toHaveLength(4);
		// MemoryBucket marks a page truncated only when more keys remain, so the
		// second (final) page is not truncated and the loop stops at 2 calls.
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe('listAllKeys', () => {
	it('returns [] for an empty prefix', async () => {
		const bucket = new MemoryBucket();
		expect(await listAllKeys(bucket, 'projects/')).toEqual([]);
	});

	it('returns only keys (strings) under the prefix', async () => {
		const bucket = new MemoryBucket();
		await seed(bucket, ['projects/x/a', 'projects/x/b', 'projects/y/c']);

		const keys = await listAllKeys(bucket, 'projects/x/');
		expect(keys.sort()).toEqual(['projects/x/a', 'projects/x/b']);
	});

	it('paginates across the cursor for long subtrees', async () => {
		const bucket = new SmallPageBucket(3);
		const keys = Array.from({ length: 7 }, (_, i) => `projects/p/v${i}`);
		await seed(bucket, keys);

		const got = await listAllKeys(bucket, 'projects/p/');
		expect(got.sort()).toEqual([...keys].sort());
	});
});

describe('deleteByPrefix', () => {
	it('deletes every key under the prefix and returns the count', async () => {
		const bucket = new MemoryBucket();
		await seed(bucket, ['p/a', 'p/b', 'p/c', 'other/x']);

		const count = await deleteByPrefix(bucket, 'p/');

		expect(count).toBe(3);
		expect(await listAllKeys(bucket, 'p/')).toEqual([]);
		expect(await listAllKeys(bucket, 'other/')).toEqual(['other/x']);
	});

	it('no-ops (returns 0, never calls bucket.delete) for an empty prefix', async () => {
		const bucket = new MemoryBucket();
		const delSpy = vi.spyOn(bucket, 'delete');

		expect(await deleteByPrefix(bucket, 'nothing/')).toBe(0);
		expect(delSpy).not.toHaveBeenCalled();
	});
});

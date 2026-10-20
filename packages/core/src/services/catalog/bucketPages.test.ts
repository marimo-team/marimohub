import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import type { BucketListResult } from '../../ports/bucket';
import { iterateBucketPages, listAllKeys, listAllObjects, listAllPrefixes } from './storage';

function page(values: Partial<BucketListResult> = {}): BucketListResult {
	return { objects: [], delimitedPrefixes: [], truncated: false, ...values };
}

describe('iterateBucketPages', () => {
	it('fetches lazily, forwards all options, and traverses empty and prefix-only pages', async () => {
		const bucket = new MemoryBucket();
		const pages = [
			page({ truncated: true, cursor: 'second' }),
			page({ delimitedPrefixes: ['p/b/'], truncated: true, cursor: 'third' }),
			page(),
		];
		const list = vi.spyOn(bucket, 'list');
		pages.forEach((value) => list.mockResolvedValueOnce(value));
		const options = {
			prefix: 'p/',
			delimiter: '/',
			cursor: 'initial',
			limit: 2,
			startAfter: 'p/a',
		};
		const iterator = iterateBucketPages(bucket, options);
		expect(list).not.toHaveBeenCalled();
		const results = [];
		for await (const result of iterator) results.push(result);
		expect(results).toEqual(pages);
		expect(list.mock.calls).toEqual(
			['initial', 'second', 'third'].map((cursor) => [{ ...options, cursor }]),
		);
		expect(options.cursor).toBe('initial');
	});

	it.each([
		page({ truncated: false, cursor: 'ignored' }),
		page({ truncated: true }),
		page({ truncated: true, cursor: '' }),
	])('stops unless both truncated and a nonempty cursor are present', async (result) => {
		const bucket = new MemoryBucket();
		const list = vi.spyOn(bucket, 'list').mockResolvedValue(result);
		const results = [];
		for await (const value of iterateBucketPages(bucket)) results.push(value);
		expect(results).toEqual([result]);
		expect(list).toHaveBeenCalledOnce();
	});

	it('does not prefetch after an early break and propagates upstream errors', async () => {
		const bucket = new MemoryBucket();
		const failure = new Error('offline');
		const list = vi
			.spyOn(bucket, 'list')
			.mockResolvedValueOnce(page({ truncated: true, cursor: 'next' }))
			.mockRejectedValue(failure);
		for await (const _page of iterateBucketPages(bucket)) break;
		expect(list).toHaveBeenCalledOnce();
		await expect(iterateBucketPages(bucket)[Symbol.asyncIterator]().next()).rejects.toBe(failure);
	});

	it('collects objects and keys in order and deduplicates and sorts prefixes', async () => {
		const bucket = new MemoryBucket();
		const a = await bucket.put('p/a/file', 'a');
		const b = await bucket.put('p/b/file', 'b');
		const list = vi.spyOn(bucket, 'list');
		const setup = () =>
			list
				.mockResolvedValueOnce(
					page({ objects: [a], delimitedPrefixes: ['p/b/'], truncated: true, cursor: 'next' }),
				)
				.mockResolvedValueOnce(page({ objects: [b], delimitedPrefixes: ['p/a/', 'p/b/'] }));
		setup();
		expect(await listAllObjects(bucket, 'p/')).toEqual([a, b]);
		setup();
		expect(await listAllKeys(bucket, 'p/')).toEqual(['p/a/file', 'p/b/file']);
		setup();
		expect(await listAllPrefixes(bucket, 'p/', '/')).toEqual(['p/a/', 'p/b/']);
		expect(list).toHaveBeenLastCalledWith({ prefix: 'p/', delimiter: '/', cursor: 'next' });
	});
});

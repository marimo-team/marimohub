import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { MetadataCache } from './metadataCache';

describe('MetadataCache fallback keys', () => {
	it('preserves key priority as primary and fallback records appear and disappear', async () => {
		const bucket = new MemoryBucket();
		const cache = new MetadataCache<string>(bucket);
		const parse = vi.fn((object: { text(): Promise<string> }) => object.text());
		const read = () => cache.read(['primary', 'fallback'], parse, 'validated');
		await bucket.put('fallback', 'preview');
		expect(await read()).toBe('preview');
		expect(await read()).toBe('preview');
		expect(parse).toHaveBeenCalledTimes(1);
		await bucket.put('primary', 'notebook');
		expect(await read()).toBe('notebook');
		await bucket.delete('primary');
		expect(await read()).toBe('preview');
		await bucket.delete('fallback');
		expect(await read()).toBeNull();
		await bucket.put('fallback', 'new preview');
		expect(await read()).toBe('new preview');
	});

	it.each(['head', 'get'] as const)(
		'does not use fallback when the primary %s fails',
		async (method) => {
			const bucket = new MemoryBucket();
			const cache = new MetadataCache<string>(bucket);
			const read = () =>
				cache.read(['primary', 'fallback'], (object) => object.text(), 'validated');
			await bucket.put('fallback', 'preview');
			if (method === 'head') await read();
			const failure = vi.spyOn(bucket, method).mockRejectedValueOnce(new Error('unavailable'));
			await expect(read()).rejects.toThrow('unavailable');
			expect(failure).toHaveBeenCalledTimes(1);
			expect(failure).toHaveBeenCalledWith('primary');
			expect(await read()).toBe('preview');
		},
	);
});

describe('MetadataCache validated reads', () => {
	it('always downloads when the store reports an empty ETag', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('meta', 'value');
		const get = bucket.get.bind(bucket);
		const head = bucket.head.bind(bucket);
		vi.spyOn(bucket, 'head').mockImplementation(async (key) => {
			const object = await head(key);
			return object && { ...object, etag: '' };
		});
		const getSpy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			const object = await get(key);
			return object && Object.assign(object, { etag: '' });
		});
		const cache = new MetadataCache<string>(bucket);
		const read = () => cache.read(['meta'], (object) => object.text(), 'validated');
		expect(await read()).toBe('value');
		await bucket.put('meta', 'changed');
		expect(await read()).toBe('changed');
		expect(await read()).toBe('changed');
		expect(getSpy).toHaveBeenCalledTimes(3);
	});

	it('returns copies that callers cannot use to mutate the cache', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('meta', JSON.stringify({ tags: ['a'] }));
		const cache = new MetadataCache<{ tags: string[] }>(bucket);
		const read = () => cache.read(['meta'], (object) => object.json(), 'validated');
		(await read())!.tags.push('miss');
		const hit = await read();
		expect(hit).toEqual({ tags: ['a'] });
		hit!.tags.push('hit');
		expect(await read()).toEqual({ tags: ['a'] });
	});
});

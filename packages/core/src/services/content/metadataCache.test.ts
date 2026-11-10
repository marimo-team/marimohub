import type { Metrics } from '../../ports/metrics';
import { createServices } from '../index';
import { makeProject, makeNotebookMeta } from '../../testing/fixtures';
import { paths } from '../../paths';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { MetadataCache } from './metadataCache';

afterEach(() => vi.restoreAllMocks());

function recordCacheMetrics() {
	const reads = vi.fn();
	const conditional = vi.fn();
	const metrics: Metrics = {
		increment(name, value, tags) {
			if (name === 'cache.metadata.reads') reads(value, tags);
			else if (name === 'cache.conditional.reads') conditional(value, tags);
			else throw new Error(`Unexpected metric: ${name}`);
		},
		gauge() {},
	};
	return { metrics, reads, conditional };
}

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

	it.each([false, true])('does not use fallback on a failed GET (warm: %s)', async (warm) => {
		const bucket = new MemoryBucket();
		const cache = new MetadataCache<string>(bucket);
		const read = () => cache.read(['primary', 'fallback'], (object) => object.text(), 'validated');
		await bucket.put('fallback', 'preview');
		if (warm) await read();
		const failure = vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('unavailable'));
		await expect(read()).rejects.toThrow('unavailable');
		expect(failure).toHaveBeenCalledTimes(1);
		expect(failure).toHaveBeenCalledWith('primary');
		expect(await read()).toBe('preview');
	});
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

it('uses one GET on validated hits and changes, and evicts missing records', async () => {
	const bucket = new MemoryBucket();
	const first = await bucket.put('meta', 'first');
	const get = vi.spyOn(bucket, 'get');
	const head = vi.spyOn(bucket, 'head');
	const parse = vi.fn((object: { text(): Promise<string> }) => object.text());
	const cache = new MetadataCache<string>(bucket);
	const read = () => cache.read(['meta'], parse, 'validated');
	expect(await read()).toBe('first');
	expect(await read()).toBe('first');
	expect(get).toHaveBeenLastCalledWith('meta', { ifNoneMatch: first.etag });
	expect(parse).toHaveBeenCalledTimes(1);
	await bucket.put('meta', 'second');
	expect(await read()).toBe('second');
	expect(get).toHaveBeenCalledTimes(3);
	expect(parse).toHaveBeenCalledTimes(2);
	await bucket.delete('meta');
	expect(await read()).toBeNull();
	await bucket.put('meta', 'third');
	expect(await read()).toBe('third');
	expect(get).toHaveBeenLastCalledWith('meta');
	expect(head).not.toHaveBeenCalled();
});

describe('MetadataCache failure and race handling', () => {
	it('does not serve a cached fallback after primary parsing fails', async () => {
		const bucket = new MemoryBucket();
		const cache = new MetadataCache<{ role: string }>(bucket);
		const read = () => cache.read(['primary', 'fallback'], (object) => object.json(), 'validated');
		await bucket.put('fallback', '{"role":"viewer"}');
		expect(await read()).toEqual({ role: 'viewer' });
		await bucket.put('primary', '{');
		await expect(read()).rejects.toThrow(SyntaxError);
		await expect(read()).rejects.toThrow(SyntaxError);
		await bucket.put('primary', '{"role":"none"}');
		expect(await read()).toEqual({ role: 'none' });
	});

	it.each([false, true])('rejects an invalid not-modified response (warm: %s)', async (warm) => {
		const bucket = new MemoryBucket();
		await bucket.put('meta', 'stored');
		const cache = new MetadataCache<string>(bucket);
		const read = () => cache.read(['meta'], (object) => object.text(), 'validated');
		if (warm) await read();
		vi.spyOn(bucket, 'get').mockResolvedValueOnce({
			key: 'meta',
			etag: 'wrong',
			notModified: true,
		});
		await expect(read()).rejects.toThrow('Invalid conditional read response');
		expect(await read()).toBe('stored');
	});

	it('finishes a validated read after its cache entry is evicted', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('a', 'A');
		await bucket.put('b', 'B');
		const cache = new MetadataCache<string>(bucket, 1);
		const read = (key: string) => cache.read([key], (object) => object.text(), 'validated');
		await read('a');
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementationOnce(async (key, options) => {
			const response = await get(key, options);
			started.resolve();
			await release.promise;
			return response;
		});
		const pending = read('a');
		try {
			await started.promise;
			expect(await read('b')).toBe('B');
		} finally {
			release.resolve();
		}
		expect(await pending).toBe('A');
		await bucket.put('a', 'Changed');
		expect(await read('a')).toBe('Changed');
	});
});

it('counts validated hits, misses, and conditional outcomes without object-key labels', async () => {
	const { metrics, reads, conditional } = recordCacheMetrics();
	const bucket = new MemoryBucket();
	const cache = new MetadataCache<string>(bucket, undefined, undefined, metrics);
	const read = () => cache.read(['private-key'], (object) => object.text(), 'validated');
	await bucket.put('private-key', 'first');
	await read();
	await read();
	await bucket.put('private-key', 'second');
	await read();
	await bucket.delete('private-key');
	await read();
	await read();
	expect(reads.mock.calls).toEqual(
		['miss', 'hit', 'miss', 'miss', 'miss'].map((result) => [
			1,
			{ result, consistency: 'validated' },
		]),
	);
	expect(conditional.mock.calls).toEqual(
		['not_modified', 'modified', 'missing'].map((result) => [1, { result }]),
	);
});

it('does not count a rejected conditional response as a cache hit or valid not-modified response', async () => {
	const { metrics, reads, conditional } = recordCacheMetrics();
	const bucket = new MemoryBucket();
	await bucket.put('meta', 'stored');
	const cache = new MetadataCache<string>(bucket, undefined, undefined, metrics);
	const read = () => cache.read(['meta'], (object) => object.text(), 'validated');
	await read();
	reads.mockClear();
	vi.spyOn(bucket, 'get').mockResolvedValueOnce({
		key: 'meta',
		etag: 'wrong',
		notModified: true,
	});
	await expect(read()).rejects.toThrow('Invalid conditional read response');
	expect(reads).not.toHaveBeenCalled();
	expect(conditional).toHaveBeenCalledExactlyOnceWith(1, { result: 'invalid' });
	expect(await read()).toBe('stored');
	expect(reads).toHaveBeenCalledExactlyOnceWith(1, { result: 'hit', consistency: 'validated' });
	expect(conditional).toHaveBeenLastCalledWith(1, { result: 'not_modified' });
});

it.each(['project', 'notebook'])(
	'forwards %s cache outcomes to the injected service metrics',
	async (kind) => {
		const bucket = new MemoryBucket();
		const project = makeProject();
		const notebook = makeNotebookMeta({ project_id: project.id });
		await bucket.put(paths.project(project.id).meta, JSON.stringify(project));
		await bucket.put(
			paths.project(project.id).notebook(notebook.id).meta,
			JSON.stringify(notebook),
		);
		const { metrics, reads, conditional } = recordCacheMetrics();
		const services = createServices(bucket, metrics);
		const read =
			kind === 'project'
				? () => services.projects.getProject(project.id, { consistency: 'validated' })
				: () =>
						services.notebooks.getNotebookMeta(project.id, notebook.id, {
							consistency: 'validated',
						});
		await read();
		await read();
		expect(reads.mock.calls).toEqual([
			[1, { result: 'miss', consistency: 'validated' }],
			[1, { result: 'hit', consistency: 'validated' }],
		]);
		expect(conditional).toHaveBeenCalledExactlyOnceWith(1, { result: 'not_modified' });
	},
);

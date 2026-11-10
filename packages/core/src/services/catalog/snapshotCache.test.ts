import { afterEach, expect, it, vi } from 'vitest';
import { makeSnapshot, MemoryBucket } from '../../testing';
import { snapshotCache } from './snapshotCache';

afterEach(() => vi.restoreAllMocks());

it('counts cold, concurrent, warm, failed, and evicted snapshot loads', async () => {
	const metrics = { increment: vi.fn(), gauge: vi.fn() };
	const cache = snapshotCache(new MemoryBucket());
	const load = vi.fn(async () => makeSnapshot());
	const first = cache.read('a', load, metrics);
	const concurrent = cache.read('a', load, metrics);
	await Promise.all([first, concurrent]);
	await cache.read('a', load, metrics);
	expect(load).toHaveBeenCalledOnce();
	await cache.read('b', load, metrics);
	await cache.read('c', load, metrics);
	await cache.read('a', load, metrics);
	await expect(
		cache.read(
			'failed',
			async () => {
				throw new Error('unavailable');
			},
			metrics,
		),
	).rejects.toThrow('unavailable');
	await cache.read('failed', load, metrics);
	expect(metrics.increment.mock.calls.map(([, , tags]) => tags.result)).toEqual([
		'miss',
		'hit',
		'hit',
		'miss',
		'miss',
		'miss',
		'miss',
		'miss',
	]);
});

it('shares a failed load, then permits one fresh load and caches its result', async () => {
	const cache = snapshotCache(new MemoryBucket());
	const gate = Promise.withResolvers<ReturnType<typeof makeSnapshot>>();
	const load = vi.fn(() => gate.promise);
	const first = cache.read('snapshot', load);
	const second = cache.read('snapshot', load);
	const failure = new Error('storage unavailable');
	const settled = Promise.allSettled([first, second]);
	gate.reject(failure);
	expect(await settled).toEqual([
		{ status: 'rejected', reason: failure },
		{ status: 'rejected', reason: failure },
	]);
	expect(load).toHaveBeenCalledOnce();
	const snapshot = makeSnapshot();
	const retry = vi.fn(async () => snapshot);
	const [recovered, concurrent] = await Promise.all([
		cache.read('snapshot', retry),
		cache.read('snapshot', retry),
	]);
	expect(recovered.snapshot).toBe(snapshot);
	expect(concurrent).toBe(recovered);
	expect(await cache.read('snapshot', retry)).toBe(recovered);
	expect(retry).toHaveBeenCalledOnce();
});

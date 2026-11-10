import { metrics } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';
import { makeSnapshot, MemoryBucket } from '../../testing';
import { snapshotCache } from './snapshotCache';

afterEach(() => vi.restoreAllMocks());

it('counts cold, concurrent, warm, failed, and evicted snapshot loads', async () => {
	const meter = metrics.getMeter('test');
	const add = vi.fn();
	vi.spyOn(meter, 'createCounter').mockReturnValue({ add });
	vi.spyOn(metrics, 'getMeter').mockReturnValue(meter);
	const cache = snapshotCache(new MemoryBucket());
	const load = vi.fn(async () => makeSnapshot());
	const first = cache.read('a', load);
	const concurrent = cache.read('a', load);
	await Promise.all([first, concurrent]);
	await cache.read('a', load);
	expect(load).toHaveBeenCalledOnce();
	await cache.read('b', load);
	await cache.read('c', load);
	await cache.read('a', load);
	await expect(
		cache.read('failed', async () => {
			throw new Error('unavailable');
		}),
	).rejects.toThrow('unavailable');
	await cache.read('failed', load);
	expect(add.mock.calls.map(([, tags]) => tags.result)).toEqual([
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

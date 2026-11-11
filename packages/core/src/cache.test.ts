import { describe, expect, it, vi } from 'vitest';
import {
	BoundedLruMap,
	LazyMap,
	SingleFlight,
	StaleWhileRevalidateCache,
	ttlState,
	weakMemo,
} from './cache';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

describe('weakMemo', () => {
	it('creates one value per owner and keeps falsy values', () => {
		const create = vi.fn((owner: { n: number }) => owner.n);
		const memo = weakMemo(create);
		const zero = { n: 0 };
		const one = { n: 1 };
		expect(memo(zero)).toBe(0);
		expect(memo(zero)).toBe(0);
		expect(memo(one)).toBe(1);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it('clear forgets every owner', () => {
		const memo = weakMemo(() => ({}));
		const owner = {};
		const first = memo(owner);
		memo.clear();
		expect(memo(owner)).not.toBe(first);
	});
});

describe('ttlState', () => {
	it('classifies fresh, stale, and expired boundaries', () => {
		const policy = { freshForMs: 10, staleForMs: 20 };
		expect(ttlState(100, 109, policy)).toBe('fresh');
		expect(ttlState(100, 110, policy)).toBe('stale');
		expect(ttlState(100, 129, policy)).toBe('stale');
		expect(ttlState(100, 130, policy)).toBe('expired');
	});

	it('supports an unbounded stale interval', () => {
		expect(ttlState(0, Number.MAX_SAFE_INTEGER, { freshForMs: 10, staleForMs: Infinity })).toBe(
			'stale',
		);
	});

	it('treats clock rollback as zero age', () => {
		expect(ttlState(100, 50, { freshForMs: 10, staleForMs: 20 })).toBe('fresh');
	});

	it('expires immediately when both durations are zero', () => {
		expect(ttlState(100, 100, { freshForMs: 0, staleForMs: 0 })).toBe('expired');
	});

	it.each([-1, Number.NaN, Infinity, -Infinity])(
		'rejects an invalid fresh duration: %s',
		(freshForMs) => {
			expect(() => ttlState(0, 0, { freshForMs, staleForMs: 0 })).toThrow(RangeError);
		},
	);

	it.each([-1, Number.NaN, -Infinity])('rejects an invalid stale duration: %s', (staleForMs) => {
		expect(() => ttlState(0, 0, { freshForMs: 0, staleForMs })).toThrow(RangeError);
	});
});

describe('BoundedLruMap', () => {
	it('evicts the least recently used entry; get refreshes and peek does not', () => {
		const map = new BoundedLruMap<string, number>(2);
		map.set('a', 1);
		map.set('b', 2);
		expect(map.peek('a')).toBe(1);
		map.set('c', 3);
		expect(map.has('a')).toBe(false);
		expect(map.get('b')).toBe(2);
		map.set('d', 4);
		expect(map.has('c')).toBe(false);
		expect([map.get('b'), map.get('d'), map.size]).toEqual([2, 4, 2]);
	});

	it('replaces, deletes, and clears entries', () => {
		const map = new BoundedLruMap<string, number>(2);
		map.set('a', 1);
		map.set('a', 2);
		expect([map.get('a'), map.size]).toEqual([2, 1]);
		expect(map.delete('a')).toBe(true);
		expect(map.delete('a')).toBe(false);
		map.set('b', 1);
		map.clear();
		expect(map.size).toBe(0);
	});

	it.each([0, -1, 1.5, Infinity, Number.NaN])('rejects invalid capacity %s', (maxSize) => {
		expect(() => new BoundedLruMap(maxSize)).toThrow(RangeError);
	});

	it('evicts the least recently used entries until the total weight fits', () => {
		const map = new BoundedLruMap<string, number>(10, { weigh: (value) => value, maxWeight: 5 });
		map.set('a', 2);
		map.set('b', 2);
		map.get('a');
		map.set('c', 3);
		expect([map.has('a'), map.has('b'), map.has('c')]).toEqual([true, false, true]);
		map.set('c', 1);
		map.set('d', 4);
		expect(map.has('a')).toBe(false);
		expect([map.has('c'), map.has('d')]).toEqual([true, true]);
		map.delete('d');
		map.set('e', 4);
		expect([map.has('c'), map.has('e')]).toEqual([true, true]);
		map.set('f', 6);
		expect(map.size).toBe(0);
	});

	it.each([-1, Infinity, Number.NaN])('rejects an invalid maxWeight %s', (maxWeight) => {
		expect(() => new BoundedLruMap(2, { weigh: () => 1, maxWeight })).toThrow(RangeError);
	});

	it.each([
		['an invalid weight', -1],
		['an infinite weight', Infinity],
		['a NaN weight', Number.NaN],
		['a throwing weigher', 'throw'],
	] as const)('leaves the map and accounting unchanged after %s', (_, bad) => {
		const map = new BoundedLruMap<string, number | 'throw'>(10, {
			weigh: (value) => {
				if (value === 'throw') throw new Error('weigh failed');
				return value;
			},
			maxWeight: 5,
		});
		map.set('a', 2);
		map.set('b', 2);
		expect(() => map.set('a', bad)).toThrow();
		expect(map.peek('a')).toBe(2);
		expect(map.size).toBe(2);
		map.set('c', 1);
		expect([map.has('a'), map.has('b'), map.has('c')]).toEqual([true, true, true]);
		map.set('d', 1);
		expect(map.has('a')).toBe(false);
	});
});

describe('LazyMap', () => {
	it.each([0, -1, 1.5, Number.NaN, Infinity])('rejects an invalid max size: %s', (maxSize) => {
		expect(() => new LazyMap(async () => 'value', { maxSize })).toThrow(RangeError);
	});

	it('single-flights concurrent loads', async () => {
		const pending = deferred<string>();
		const load = vi.fn(() => pending.promise);
		const map = new LazyMap(load, { maxSize: 2 });

		const first = map.get('a');
		const second = map.get('a');
		pending.resolve('loaded');

		expect(await Promise.all([first, second])).toEqual(['loaded', 'loaded']);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('shares a rejected load and retries on the next request', async () => {
		const pending = deferred<string>();
		const load = vi
			.fn()
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValue('recovered');
		const map = new LazyMap(load, { maxSize: 2 });
		const first = map.get('a');
		const second = map.get('a');
		pending.reject(new Error('offline'));

		await expect(first).rejects.toThrow('offline');
		await expect(second).rejects.toThrow('offline');
		expect(await map.get('a')).toBe('recovered');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('turns a synchronous loader throw into a rejected promise', async () => {
		const map = new LazyMap<string, string>(
			() => {
				throw new Error('synchronous failure');
			},
			{ maxSize: 2 },
		);

		await expect(map.get('a')).rejects.toThrow('synchronous failure');
	});

	it('requires a per-call loader when constructed without one', async () => {
		expect(() => new LazyMap({ maxSize: 0 })).toThrow(RangeError);
		const map = new LazyMap<string, number>({ maxSize: 2 });
		await expect(map.get('a')).rejects.toThrow('load function is required');
		expect(map.hasPending('a')).toBe(false);
		await expect(map.getOrLoad('a', async () => 1)).resolves.toBe(1);
		await expect(map.get('a')).resolves.toBe(1);
		await expect(map.reload('a', { load: async () => 2 })).resolves.toBe(2);
		await expect(map.reload('a')).rejects.toThrow('load function is required');
		expect(map.getIfPresent('a')).toBe(2);
	});

	it('caches undefined values', async () => {
		const load = vi.fn(async () => {});
		const map = new LazyMap(load, { maxSize: 2 });

		expect(await map.get('a')).toBeUndefined();
		expect(await map.get('a')).toBeUndefined();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('evicts the least recently used value at its size bound', () => {
		const map = new LazyMap<string, number>(async () => 0, { maxSize: 2 });
		map.set('a', 1);
		map.set('b', 2);
		expect(map.getIfPresent('a')).toBe(1);
		map.set('c', 3);

		expect(map.getIfPresent('a')).toBe(1);
		expect(map.getIfPresent('b')).toBeUndefined();
		expect(map.getIfPresent('c')).toBe(3);
		expect(map.size).toBe(2);
	});

	it('evicts an undefined key without exceeding the size bound', () => {
		const map = new LazyMap<string | undefined, number>(async () => 0, { maxSize: 1 });
		map.set(undefined, 1);
		map.set('next', 2);

		expect(map.size).toBe(1);
		expect(map.getIfPresent(undefined)).toBeUndefined();
		expect(map.getIfPresent('next')).toBe(2);
	});

	it('reloads and replaces a cached value', async () => {
		const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
		const map = new LazyMap(load, { maxSize: 2 });

		expect(await map.get('a')).toBe('first');
		expect(await map.reload('a')).toBe('second');
		expect(await map.get('a')).toBe('second');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('does not overwrite an explicit set with an older in-flight load', async () => {
		const pending = deferred<string>();
		const map = new LazyMap(() => pending.promise, { maxSize: 2 });
		const loading = map.reload('a');
		map.set('a', 'newer');
		pending.resolve('older');

		expect(await loading).toBe('newer');
		expect(map.getIfPresent('a')).toBe('newer');
	});

	it('lets a forced load supersede an older in-flight load', async () => {
		const old = deferred<string>();
		const fresh = deferred<string>();
		const map = new LazyMap(() => old.promise, { maxSize: 2 });
		const loading = map.get('a');
		const refreshing = map.getOrLoad('a', () => fresh.promise, { force: true });
		expect(map.hasPending('a')).toBe(true);
		fresh.resolve('fresh');
		expect(await refreshing).toBe('fresh');
		old.resolve('old');
		expect(await loading).toBe('fresh');
		expect(map.getIfPresent('a')).toBe('fresh');
	});

	it('clears cached and pending entries', async () => {
		const pending = deferred<string>();
		const map = new LazyMap(() => pending.promise, { maxSize: 2 });
		const loading = map.get('a');
		map.set('b', 'cached');
		map.clear();
		expect(map.size).toBe(0);
		expect(map.hasPending('a')).toBe(false);
		pending.resolve('old');
		expect(await loading).toBe('old');
		expect(map.getIfPresent('a')).toBeUndefined();
	});

	it('lets an explicit undefined supersede an in-flight load', async () => {
		const pending = deferred<string | undefined>();
		const map = new LazyMap(() => pending.promise, { maxSize: 2 });
		const loading = map.reload('a');
		map.set('a', undefined);
		pending.resolve('older');

		expect(await loading).toBeUndefined();
		expect(await map.get('a')).toBeUndefined();
	});

	it('does not cache a load that was deleted while in flight', async () => {
		const pending = deferred<string>();
		const load = vi
			.fn()
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValue('new');
		const map = new LazyMap(load, { maxSize: 2 });
		const loading = map.get('a');
		expect(map.delete('a')).toBe(false);
		pending.resolve('old');

		expect(await loading).toBe('old');
		expect(map.getIfPresent('a')).toBeUndefined();
		expect(await map.get('a')).toBe('new');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('starts a new load after deleting an in-flight load', async () => {
		const old = deferred<string>();
		const load = vi
			.fn()
			.mockImplementationOnce(() => old.promise)
			.mockResolvedValueOnce('new');
		const map = new LazyMap(load, { maxSize: 2 });
		const superseded = map.get('a');
		map.delete('a');

		expect(await map.get('a')).toBe('new');
		old.resolve('old');
		expect(await superseded).toBe('new');
		expect(map.getIfPresent('a')).toBe('new');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('deletes cached values idempotently', () => {
		const map = new LazyMap<string, number>(async () => 0, { maxSize: 2 });
		map.set('a', 1);

		expect(map.delete('a')).toBe(true);
		expect(map.delete('a')).toBe(false);
		expect(map.size).toBe(0);
	});
});

describe('SingleFlight', () => {
	it('shares one in-flight load per key and forgets it once settled', async () => {
		const flight = new SingleFlight<string, number>();
		const first = deferred<number>();
		const load = vi.fn(() => first.promise);
		const a = flight.run('k', load);
		const b = flight.run('k', load);
		expect(load).toHaveBeenCalledTimes(1);
		expect(flight.has('k')).toBe(true);
		expect(flight.size).toBe(1);
		first.resolve(1);
		await expect(a).resolves.toBe(1);
		await expect(b).resolves.toBe(1);
		expect(flight.has('k')).toBe(false);
		await flight.run('k', load);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('shares a rejection and clears it so the next call retries', async () => {
		const flight = new SingleFlight<string, number>();
		const load = vi
			.fn<() => Promise<number>>()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce(2);
		const a = flight.run('k', load);
		const b = flight.run('k', load);
		await expect(a).rejects.toThrow('boom');
		await expect(b).rejects.toThrow('boom');
		await expect(flight.run('k', load)).resolves.toBe(2);
	});

	it('turns a synchronous loader throw into a rejected promise', async () => {
		const flight = new SingleFlight<string, number>();
		await expect(
			flight.run('k', () => {
				throw new Error('sync');
			}),
		).rejects.toThrow('sync');
		expect(flight.size).toBe(0);
	});

	it('keys loads independently and lets delete start a new load', async () => {
		const flight = new SingleFlight<string, number>();
		const slow = deferred<number>();
		const a = flight.run('a', () => slow.promise);
		await expect(flight.run('b', () => Promise.resolve(2))).resolves.toBe(2);
		expect(flight.delete('a')).toBe(true);
		await expect(flight.run('a', () => Promise.resolve(3))).resolves.toBe(3);
		slow.resolve(1);
		await expect(a).resolves.toBe(1);
		expect(flight.size).toBe(0);
	});
});

describe('StaleWhileRevalidateCache', () => {
	it.each([-1, Number.NaN, Infinity])(
		'rejects an invalid background retry duration: %s',
		(backgroundRetryMs) => {
			expect(
				() =>
					new StaleWhileRevalidateCache({
						backgroundRetryMs,
						load: async () => 'value',
						maxSize: 2,
						ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
					}),
			).toThrow(RangeError);
		},
	);

	it('requires a per-call loader when built without a default one', async () => {
		const cache = new StaleWhileRevalidateCache<string, string>({
			maxSize: 2,
			ttl: () => ({ freshForMs: 10, staleForMs: 0 }),
		});
		await expect(cache.get('k')).rejects.toThrow('LazyMap load function is required');
		const load = vi.fn(async (key: string) => `${key}!`);
		await expect(cache.get('k', load)).resolves.toBe('k!');
		await expect(cache.get('k', load)).resolves.toBe('k!');
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('caches a fresh value without reloading it', async () => {
		let now = 0;
		const load = vi.fn(async () => 'value');
		const ttl = vi.fn(() => ({ freshForMs: 10, staleForMs: 20 }));
		const cache = new StaleWhileRevalidateCache({ load, maxSize: 2, now: () => now, ttl });

		expect(await cache.get('a')).toBe('value');
		now = 9;
		expect(await cache.get('a')).toBe('value');
		expect(load).toHaveBeenCalledTimes(1);
		expect(ttl).toHaveBeenCalledWith('value', 'a');
	});

	it('does not cache a failed cold load and recovers on retry', async () => {
		const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('recovered');
		const cache = new StaleWhileRevalidateCache<string, string>({
			load,
			maxSize: 2,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		await expect(cache.get('a')).rejects.toThrow('offline');
		expect(cache.getIfPresent('a')).toBeUndefined();
		expect(await cache.get('a')).toBe('recovered');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('serves stale data while a single background refresh runs', async () => {
		let now = 0;
		const pending = deferred<string>();
		const load = vi
			.fn()
			.mockResolvedValueOnce('old')
			.mockImplementationOnce(() => pending.promise);
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		expect(await cache.get('a')).toBe('old');
		now = 11;
		expect(await Promise.all([cache.get('a'), cache.get('a')])).toEqual(['old', 'old']);
		expect(load).toHaveBeenCalledTimes(2);
		pending.resolve('new');
		await vi.waitFor(() => expect(cache.getIfPresent('a')).toBe('new'));
	});

	it('blocks on refresh after the hard expiry', async () => {
		let now = 0;
		const pending = deferred<string>();
		const load = vi
			.fn()
			.mockResolvedValueOnce('old')
			.mockImplementationOnce(() => pending.promise);
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		await cache.get('a');
		now = 30;
		let settled = false;
		const result = cache.get('a').then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		pending.resolve('new');
		expect(await result).toBe('new');
	});

	it('single-flights concurrent hard-expiry refreshes', async () => {
		let now = 0;
		const pending = deferred<string>();
		const load = vi
			.fn()
			.mockResolvedValueOnce('old')
			.mockImplementationOnce(() => pending.promise);
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		await cache.get('a');
		now = 30;
		const first = cache.get('a');
		const second = cache.get('a');
		pending.resolve('new');

		expect(await Promise.all([first, second])).toEqual(['new', 'new']);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('retains the prior value after a failed hard refresh and can recover', async () => {
		let now = 0;
		const load = vi
			.fn()
			.mockResolvedValueOnce('old')
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce('recovered');
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		await cache.get('a');
		now = 30;
		await expect(cache.get('a')).rejects.toThrow('offline');
		expect(cache.getIfPresent('a')).toBe('old');
		expect(await cache.get('a')).toBe('recovered');
	});

	it('reports one background failure and observes the retry cooldown', async () => {
		let now = 0;
		const error = new Error('offline');
		const onBackgroundError = vi.fn();
		const load = vi.fn().mockResolvedValueOnce('old').mockRejectedValue(error);
		const cache = new StaleWhileRevalidateCache({
			backgroundRetryMs: 5,
			load,
			maxSize: 2,
			now: () => now,
			onBackgroundError,
			ttl: () => ({ freshForMs: 10, staleForMs: Infinity }),
		});

		await cache.get('a');
		now = 11;
		await Promise.all([cache.get('a'), cache.get('a')]);
		await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledTimes(1));
		expect(await cache.get('a')).toBe('old');
		expect(load).toHaveBeenCalledTimes(2);

		now = 16;
		expect(await cache.get('a')).toBe('old');
		await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledTimes(2));
		expect(load).toHaveBeenCalledTimes(3);
	});

	it('serves stale data after a background failure without an error callback', async () => {
		let now = 0;
		const load = vi.fn().mockResolvedValueOnce('old').mockRejectedValue(new Error('offline'));
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: Infinity }),
		});

		await cache.get('a');
		now = 11;
		expect(await cache.get('a')).toBe('old');
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		expect(cache.getIfPresent('a')).toBe('old');
	});

	it('lets an explicit set win over a background refresh', async () => {
		let now = 0;
		const pending = deferred<string>();
		const load = vi
			.fn()
			.mockResolvedValueOnce('old')
			.mockImplementationOnce(() => pending.promise);
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		await cache.get('a');
		now = 11;
		expect(await cache.get('a')).toBe('old');
		cache.set('a', 'explicit');
		pending.resolve('background');
		await vi.waitFor(() => expect(cache.getIfPresent('a')).toBe('explicit'));

		expect(await cache.get('a')).toBe('explicit');
	});

	it('updates only present entries without resetting their age', async () => {
		let now = 0;
		const pending = deferred<number>();
		const load = vi
			.fn()
			.mockResolvedValueOnce(1)
			.mockImplementationOnce(() => pending.promise);
		const cache = new StaleWhileRevalidateCache<string, number>({
			load,
			maxSize: 2,
			now: () => now,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		expect(cache.update('missing', (value) => value + 1)).toBe(false);
		await cache.get('a');
		now = 9;
		expect(cache.update('a', (value) => value + 1)).toBe(true);
		expect(cache.getIfPresent('a')).toBe(2);

		now = 10;
		expect(await cache.get('a')).toBe(2);
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		pending.resolve(3);
		await vi.waitFor(() => expect(cache.getIfPresent('a')).toBe(3));
	});

	it('deletes entries and reloads them on demand', async () => {
		const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
		const cache = new StaleWhileRevalidateCache({
			load,
			maxSize: 2,
			ttl: () => ({ freshForMs: 10, staleForMs: 20 }),
		});

		await cache.get('a');
		expect(cache.delete('a')).toBe(true);
		expect(cache.delete('a')).toBe(false);
		expect(await cache.get('a')).toBe('second');
	});
});

describe('StaleWhileRevalidateCache per-call loaders', () => {
	it('uses the per-call loader on a miss and after expiry, and shares in-flight loads', async () => {
		let now = 1_000;
		const configured = vi.fn(async (key: string) => `configured:${key}`);
		const cache = new StaleWhileRevalidateCache<string, string>({
			load: configured,
			ttl: () => ({ freshForMs: 100, staleForMs: 0 }),
			maxSize: 4,
			now: () => now,
		});
		const first = deferred<string>();
		const perCall = vi.fn(() => first.promise);
		const a = cache.get('k', perCall);
		const b = cache.get('k', perCall);
		await Promise.resolve();
		expect(perCall).toHaveBeenCalledTimes(1);
		first.resolve('one');
		await expect(a).resolves.toBe('one');
		await expect(b).resolves.toBe('one');
		await expect(cache.get('k', perCall)).resolves.toBe('one');
		expect(perCall).toHaveBeenCalledTimes(1);
		now += 100;
		await expect(cache.get('k', async () => 'two')).resolves.toBe('two');
		expect(configured).not.toHaveBeenCalled();
	});

	it('refreshes stale entries in the background with the per-call loader', async () => {
		let now = 0;
		const cache = new StaleWhileRevalidateCache<string, number>({
			load: async () => -1,
			ttl: () => ({ freshForMs: 10, staleForMs: 100 }),
			maxSize: 4,
			now: () => now,
		});
		await expect(cache.get('k', async () => 1)).resolves.toBe(1);
		now = 20;
		const refresh = deferred<number>();
		await expect(cache.get('k', () => refresh.promise)).resolves.toBe(1);
		refresh.resolve(2);
		await refresh.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cache.getIfPresent('k')).toBe(2);
	});

	it('clears cached entries so the next get reloads', async () => {
		const cache = new StaleWhileRevalidateCache<string, number>({
			load: async () => 1,
			ttl: () => ({ freshForMs: 1_000, staleForMs: 0 }),
			maxSize: 4,
		});
		await expect(cache.get('k', async () => 5)).resolves.toBe(5);
		cache.clear();
		expect(cache.getIfPresent('k')).toBeUndefined();
		await expect(cache.get('k')).resolves.toBe(1);
	});
});

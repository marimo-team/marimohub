import { describe, expect, it, vi } from 'vitest';
import { LazyMap, StaleWhileRevalidateCache, ttlState } from './cache';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

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

	it('deletes cached values idempotently', () => {
		const map = new LazyMap<string, number>(async () => 0, { maxSize: 2 });
		map.set('a', 1);

		expect(map.delete('a')).toBe(true);
		expect(map.delete('a')).toBe(false);
		expect(map.size).toBe(0);
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

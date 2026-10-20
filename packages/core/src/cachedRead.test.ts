import { describe, expect, it, vi } from 'vitest';
import { cachedRead } from './async';

describe('cachedRead', () => {
	it('shares concurrent reads for a key but keeps independent keys separate', async () => {
		const cache = new Map<string, Promise<number>>();
		const pending = Promise.withResolvers<number>();
		const read = vi.fn(() => pending.promise);
		const first = cachedRead(cache, 'a', read);
		expect(cachedRead(cache, 'a', read)).toBe(first);
		expect(read).toHaveBeenCalledOnce();
		await expect(cachedRead(cache, 'b', async () => 2)).resolves.toBe(2);
		pending.resolve(1);
		await expect(first).resolves.toBe(1);
	});

	it('retains rejected promises and isolates caller-owned caches', async () => {
		const cache = new Map<string, Promise<number>>();
		const failure = new Error('read failed');
		const read = vi.fn(async () => {
			throw failure;
		});
		const first = cachedRead(cache, 'a', read);
		await expect(first).rejects.toBe(failure);
		expect(cachedRead(cache, 'a', read)).toBe(first);
		expect(read).toHaveBeenCalledOnce();
		await expect(cachedRead(new Map(), 'a', async () => 3)).resolves.toBe(3);
	});

	it('does not cache when no map is supplied or when a read throws synchronously', async () => {
		const read = vi.fn(async () => 1);
		await cachedRead(undefined, 'a', read);
		await cachedRead(undefined, 'a', read);
		expect(read).toHaveBeenCalledTimes(2);
		const cache = new Map<string, Promise<number>>();
		expect(() =>
			cachedRead(cache, 'a', () => {
				throw new Error('sync');
			}),
		).toThrow('sync');
		await expect(cachedRead(cache, 'a', read)).resolves.toBe(1);
	});
});

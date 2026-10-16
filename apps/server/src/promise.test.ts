import { afterEach, describe, expect, it, vi } from 'vitest';
import { onceAsync, settleAllWithin, settleEach } from './promise';

describe('onceAsync', () => {
	it('shares pending work and its result across calls', async () => {
		const pending = Promise.withResolvers<number>();
		const work = vi.fn(() => pending.promise);
		const run = onceAsync(work);
		const first = run();
		expect(run()).toBe(first);
		pending.resolve(42);
		await expect(first).resolves.toBe(42);
		expect(run()).toBe(first);
		expect(work).toHaveBeenCalledOnce();
	});

	it.each(['throw', 'reject'] as const)('caches a %s without retrying cleanup', async (failure) => {
		const error = new Error('cleanup failed');
		const work = vi.fn(() => {
			if (failure === 'throw') throw error;
			return Promise.reject(error);
		});
		const run = onceAsync(work);
		const first = run();
		await expect(first).rejects.toBe(error);
		expect(run()).toBe(first);
		await expect(run()).rejects.toBe(error);
		expect(work).toHaveBeenCalledOnce();
	});
});

describe('settleEach', () => {
	it('runs every function even when an earlier one throws synchronously', async () => {
		const error = new Error('sync');
		const later = vi.fn(async () => 'ok');
		const results = await settleEach([
			() => {
				throw error;
			},
			later,
		]);
		expect(later).toHaveBeenCalledOnce();
		expect(results).toEqual([
			{ status: 'rejected', reason: error },
			{ status: 'fulfilled', value: 'ok' },
		]);
	});
});

describe('settleAllWithin', () => {
	afterEach(() => vi.useRealTimers());

	it('finishes when every promise settles', async () => {
		await expect(
			settleAllWithin([Promise.resolve(), Promise.reject(new Error('ignored'))], 10_000),
		).resolves.toBe('settled');
	});

	it('finishes at the deadline when work remains pending', async () => {
		vi.useFakeTimers();
		const result = settleAllWithin([new Promise(() => {})], 5);
		await vi.advanceTimersByTimeAsync(5);
		await expect(result).resolves.toBe('timed-out');
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleAllWithin } from './promise';

describe('settleAllWithin', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('finishes when every promise settles and clears the deadline', async () => {
		await expect(
			settleAllWithin([Promise.resolve(), Promise.reject(new Error('ignored'))], 10_000),
		).resolves.toBe('settled');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('finishes at the deadline when work remains pending', async () => {
		const result = settleAllWithin([new Promise(() => {})], 10_000);
		const resolved = vi.fn();
		void result.then(resolved);

		await vi.advanceTimersByTimeAsync(9_999);
		expect(resolved).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe('timed-out');
		expect(vi.getTimerCount()).toBe(0);
	});
});

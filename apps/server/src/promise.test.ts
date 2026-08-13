import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleAllWithin } from './promise';

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

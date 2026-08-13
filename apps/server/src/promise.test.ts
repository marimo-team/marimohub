import { describe, expect, it } from 'vitest';
import { settleAllWithin } from './promise';

describe('settleAllWithin', () => {
	it('finishes when every promise settles', async () => {
		await expect(
			settleAllWithin([Promise.resolve(), Promise.reject(new Error('ignored'))], 10_000),
		).resolves.toBe('settled');
	});

	it('finishes at the deadline when work remains pending', async () => {
		await expect(settleAllWithin([new Promise(() => {})], 5)).resolves.toBe('timed-out');
	});
});

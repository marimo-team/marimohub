import { describe, expect, it, vi } from 'vitest';
import { withDeadline } from './async';

describe('withDeadline', () => {
	it('returns work that finishes before the deadline', async () => {
		await expect(
			withDeadline(Promise.resolve('done'), {
				timeoutMs: 100,
				timeoutError: () => new Error('late'),
			}),
		).resolves.toBe('done');
	});

	it('uses the caller-provided timeout error', async () => {
		vi.useFakeTimers();
		try {
			const result = withDeadline(new Promise(() => {}), {
				timeoutMs: 10,
				timeoutError: () => new RangeError('late'),
			});
			const expectation = expect(result).rejects.toThrow(new RangeError('late'));
			await vi.advanceTimersByTimeAsync(10);
			await expectation;
		} finally {
			vi.useRealTimers();
		}
	});
});

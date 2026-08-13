import { describe, expect, it } from 'vitest';
import { deadlineSignal, MAX_TIMER_DELAY_MS, withAbortSignal, withDeadline } from '../async';

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
		await expect(
			withDeadline(new Promise(() => {}), {
				timeoutMs: 5,
				timeoutError: () => new RangeError('late'),
			}),
		).rejects.toThrow(new RangeError('late'));
	});

	it('passes a signal that aborts at the deadline', async () => {
		let observed: AbortSignal | undefined;
		const result = withDeadline(
			async (signal) => {
				observed = signal;
				await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
				return 'late';
			},
			{ timeoutMs: 5, timeoutError: () => new Error('timed out') },
		);
		await expect(result).rejects.toThrow('timed out');
		expect(observed?.aborted).toBe(true);
	});

	it('distinguishes caller cancellation from its deadline', async () => {
		const controller = new AbortController();
		const result = withDeadline(new Promise(() => {}), {
			timeoutMs: 60_000,
			timeoutError: () => new Error('timed out'),
			signal: controller.signal,
			abortError: () => new Error('cancelled'),
		});
		controller.abort();
		await expect(result).rejects.toThrow('cancelled');
	});

	it('races a promise against an AbortSignal', async () => {
		const controller = new AbortController();
		const result = withAbortSignal(new Promise(() => {}), controller.signal);
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('rejects delays that overflow the platform timer', async () => {
		expect(() => deadlineSignal(MAX_TIMER_DELAY_MS + 1)).toThrow(RangeError);
		await expect(
			withDeadline(Promise.resolve(), {
				timeoutMs: MAX_TIMER_DELAY_MS + 1,
				timeoutError: () => new Error('late'),
			}),
		).rejects.toThrow(RangeError);
	});
});

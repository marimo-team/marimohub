import { MAX_TIMER_DELAY_MS } from './async';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Millis, Seconds, sleep } from './duration';

describe('Millis', () => {
	it('builds milliseconds from larger units', () => {
		expect(Millis.of(5)).toBe(5);
		expect(Millis.seconds(2)).toBe(2000);
		expect(Millis.minutes(5)).toBe(300_000);
		expect(Millis.hours(1)).toBe(3_600_000);
		expect(Millis.days(1)).toBe(86_400_000);
	});

	it('toSeconds floors, matching JWT epoch math', () => {
		expect(Millis.toSeconds(Millis.of(1999))).toBe(1);
		expect(Millis.toSeconds(Millis.seconds(2))).toBe(2);
	});
});

describe('Seconds', () => {
	it('builds seconds from larger units and converts to ms', () => {
		expect(Seconds.of(90)).toBe(90);
		expect(Seconds.minutes(2)).toBe(120);
		expect(Seconds.hours(1)).toBe(3600);
		expect(Seconds.toMillis(Seconds.of(2))).toBe(2000);
	});
});

describe('brands', () => {
	it('are assignable to number but not from it', () => {
		const asNumber: number = Millis.of(5);
		// @ts-expect-error a plain number is not Millis
		const notMs: Millis = 5;
		// @ts-expect-error Seconds is not Millis
		const cross: Millis = Seconds.of(5);
		expect([asNumber, notMs, cross]).toEqual([5, 5, 5]);
	});
});

describe('sleep', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('resolves after the requested delay', async () => {
		let done = false;
		void sleep(1000).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
	});

	it('clears the timer and abort listener when cancelled', async () => {
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
		const reason = new Error('cancelled');
		const pending = sleep(1000, controller.signal);
		const rejected = expect(pending).rejects.toBe(reason);
		controller.abort(reason);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
		expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('does not create a timer when already aborted', async () => {
		const reason = new Error('cancelled');
		await expect(sleep(1000, AbortSignal.abort(reason))).rejects.toBe(reason);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('removes its abort listener after completing', async () => {
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
		const pending = sleep(1000, controller.signal);
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		expect(vi.getTimerCount()).toBe(0);
		expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
	});
	it.each([0, MAX_TIMER_DELAY_MS])('accepts the timer boundary %s ms', async (delay) => {
		const pending = sleep(delay);
		await vi.advanceTimersByTimeAsync(delay);
		await expect(pending).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([-1, 0.5, MAX_TIMER_DELAY_MS + 1, Infinity, -Infinity, Number.NaN])(
		'rejects an unsupported delay of %s ms',
		async (delay) => {
			await expect(sleep(delay)).rejects.toThrow(
				new RangeError(`Timer delay must be an integer between 0 and ${MAX_TIMER_DELAY_MS} ms`),
			);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

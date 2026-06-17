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
});

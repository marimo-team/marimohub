import { afterEach, describe, expect, it, vi } from 'vitest';
import { jitteredBackoff } from './backoff';

describe('jitteredBackoff', () => {
	afterEach(() => vi.restoreAllMocks());

	it('doubles from the base delay up to the cap', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const options = { baseMs: 50, capMs: 1000, jitter: 1 };
		expect([0, 1, 2, 4, 5, 10].map((attempt) => jitteredBackoff(attempt, options))).toEqual([
			50, 100, 200, 800, 1000, 1000,
		]);
	});

	it('randomizes only the jitter fraction of the delay', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		expect(jitteredBackoff(2, { baseMs: 50, capMs: 200, jitter: 1 })).toBe(0);
		expect(jitteredBackoff(2, { baseMs: 50, capMs: 200, jitter: 0.5 })).toBe(100);
		expect(jitteredBackoff(2, { baseMs: 50, capMs: 200, jitter: 0 })).toBe(200);
	});

	it('rounds down to whole milliseconds', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.333);
		expect(jitteredBackoff(0, { baseMs: 250, capMs: 2000, jitter: 1 })).toBe(83);
	});
});

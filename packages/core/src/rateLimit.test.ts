import { describe, expect, it } from 'vitest';
import { createSlidingWindowBudget } from './rateLimit';

describe('createSlidingWindowBudget', () => {
	it('allows requests through the limit and rejects the next request', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 2, windowMs: 1_000 });
		expect(budget.consume('user')).toBe(true);
		expect(budget.consume('user')).toBe(true);
		expect(budget.consume('user')).toBe(false);
	});

	it('tracks each key independently', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 1, windowMs: 1_000 });
		expect(budget.consume('alice')).toBe(true);
		expect(budget.consume('alice')).toBe(false);
		expect(budget.consume('bob')).toBe(true);
		expect(budget.tracked()).toBe(2);
	});

	it('restores capacity exactly at the window boundary', () => {
		let now = 0;
		const budget = createSlidingWindowBudget<string>({
			limit: 1,
			windowMs: 1_000,
			now: () => now,
		});
		expect(budget.consume('user')).toBe(true);
		now = 999;
		expect(budget.consume('user')).toBe(false);
		now = 1_000;
		expect(budget.consume('user')).toBe(true);
	});

	it('forgets inactive keys during an amortized sweep', () => {
		let now = 0;
		const budget = createSlidingWindowBudget<string>({
			limit: 1,
			windowMs: 1_000,
			now: () => now,
		});
		budget.consume('expired');
		now = 1_000;
		budget.consume('active');
		expect(budget.tracked()).toBe(1);
	});

	it('resets stale entries when the clock moves backwards', () => {
		let now = 1_000;
		const budget = createSlidingWindowBudget<string>({
			limit: 1,
			windowMs: 1_000,
			now: () => now,
		});
		expect(budget.consume('user')).toBe(true);
		now = 0;
		expect(budget.consume('user')).toBe(true);
		expect(budget.tracked()).toBe(1);
	});

	it.each([
		{ limit: 0, windowMs: 1_000 },
		{ limit: 1.5, windowMs: 1_000 },
		{ limit: 1, windowMs: 0 },
		{ limit: 1, windowMs: Number.POSITIVE_INFINITY },
	])('rejects invalid options %#', (options) => {
		expect(() => createSlidingWindowBudget(options)).toThrow(RangeError);
	});
});

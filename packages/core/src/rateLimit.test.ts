import { describe, expect, it } from 'vitest';
import { createSlidingWindowBudget } from './rateLimit';

describe('createSlidingWindowBudget', () => {
	it('allows requests through the limit and rejects the next request', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 2, windowMs: 1_000 });
		expect(budget.consume('user')).toBe(true);
		expect(budget.consume('user')).toBe(true);
		expect(budget.consume('user')).toBe(false);
	});

	it('restores capacity when an admission is refunded', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 1, windowMs: 1_000 });
		const admission = budget.admit('user');
		expect(admission).not.toBeNull();
		expect(budget.consume('user')).toBe(false);

		admission?.refund();
		expect(budget.consume('user')).toBe(true);
		admission?.refund();
		expect(budget.consume('user')).toBe(false);
	});

	it('refunds only the admission that owns the token', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 2, windowMs: 1_000 });
		const first = budget.admit('user', 0);
		expect(first).not.toBeNull();
		expect(budget.admit('user', 500)).not.toBeNull();

		first?.refund();
		expect(budget.consume('user', 1_000)).toBe(true);
		expect(budget.consume('user', 1_000)).toBe(false);
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

	it('accepts an explicit observation time', () => {
		const budget = createSlidingWindowBudget<string>({
			limit: 1,
			windowMs: 1_000,
			now: () => 10_000,
		});
		expect(budget.consume('user', 0)).toBe(true);
		expect(budget.consume('user', 999)).toBe(false);
		expect(budget.consume('user', 1_000)).toBe(true);
	});

	it('does not treat an older timestamp for another key as a clock rollback', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 1, windowMs: 10_000 });
		expect(budget.consume('alice', 1_000)).toBe(true);
		expect(budget.consume('bob', 2_000)).toBe(true);
		expect(budget.consume('alice', 1_500)).toBe(false);
		expect(budget.consume('bob', 2_500)).toBe(false);
	});

	it('resets only the affected key when its clock moves backwards', () => {
		const budget = createSlidingWindowBudget<string>({ limit: 1, windowMs: 1_000 });
		expect(budget.consume('alice', 1_000)).toBe(true);
		expect(budget.consume('bob', 1_000)).toBe(true);
		expect(budget.consume('alice', 0)).toBe(true);
		expect(budget.consume('bob', 1_500)).toBe(false);
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

	it('detects a rollback that occurs between amortized sweeps', () => {
		let now = 1_000;
		const budget = createSlidingWindowBudget<string>({
			limit: 1,
			windowMs: 1_000,
			now: () => now,
		});
		expect(budget.consume('user')).toBe(true);
		now = 1_500;
		expect(budget.consume('user')).toBe(false);
		now = 1_250;
		expect(budget.consume('user')).toBe(true);
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

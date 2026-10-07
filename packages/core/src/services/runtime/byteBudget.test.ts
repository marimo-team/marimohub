import { describe, expect, it } from 'vitest';
import { ByteBudget } from './byteBudget';

describe('ByteBudget', () => {
	it('grants reservations up to capacity and returns bytes on dispose', () => {
		const budget = new ByteBudget(10);
		const first = budget.tryReserve(6);
		expect(first).toBeDefined();
		expect(budget.tryReserve(5)).toBeUndefined();
		const second = budget.tryReserve(4);
		expect(budget.available).toBe(0);
		first?.[Symbol.dispose]();
		expect(budget.available).toBe(6);
		second?.[Symbol.dispose]();
		expect(budget.available).toBe(10);
	});

	it('ignores a second dispose of the same reservation', () => {
		const budget = new ByteBudget(10);
		const reservation = budget.tryReserve(4);
		const other = budget.tryReserve(6);
		reservation?.[Symbol.dispose]();
		reservation?.[Symbol.dispose]();
		expect(budget.available).toBe(4);
		other?.[Symbol.dispose]();
	});

	it('releases at scope exit with using', () => {
		const budget = new ByteBudget(8);
		{
			using _reservation = budget.tryReserve(8);
			expect(budget.available).toBe(0);
		}
		expect(budget.available).toBe(8);
	});

	it('rejects invalid capacities and sizes', () => {
		expect(() => new ByteBudget(-1)).toThrow(RangeError);
		expect(() => new ByteBudget(1.5)).toThrow(RangeError);
		expect(() => new ByteBudget(4).tryReserve(-1)).toThrow(RangeError);
		expect(() => new ByteBudget(4).tryReserve(Number.NaN)).toThrow(RangeError);
	});
});

import { describe, expect, it } from 'vitest';
import { asRecord, assertPositiveInteger, assertPositiveIntegers, isRecord } from './validation';

describe('record guards', () => {
	it('accepts only non-array objects', () => {
		expect(isRecord({ value: 1 })).toBe(true);
		expect(asRecord({ value: 1 })).toEqual({ value: 1 });
		for (const value of [null, [], 'value', 1]) {
			expect(isRecord(value)).toBe(false);
			expect(asRecord(value)).toBeUndefined();
		}
	});
});

describe('positive integer assertions', () => {
	it('accepts positive integers and rejects other numbers', () => {
		expect(() => assertPositiveInteger('limit', 1)).not.toThrow();
		for (const value of [0, -1, 1.5, Number.NaN]) {
			expect(() => assertPositiveInteger('limit', value)).toThrow(
				'limit must be a positive integer',
			);
		}
	});

	it('validates every named value', () => {
		expect(() => assertPositiveIntegers({ first: 1, second: 2 })).not.toThrow();
		expect(() => assertPositiveIntegers({ first: 1, second: 0 })).toThrow('second');
	});
});

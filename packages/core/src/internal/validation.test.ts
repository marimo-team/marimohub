import { describe, expect, it } from 'vitest';
import { asRecord, assertPositiveInteger, isRecord } from './validation';

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

describe('assertPositiveInteger', () => {
	it('accepts positive integers and rejects other numbers', () => {
		expect(() => assertPositiveInteger('limit', 1)).not.toThrow();
		for (const value of [0, -1, 1.5, Number.NaN]) {
			expect(() => assertPositiveInteger('limit', value)).toThrow(
				'limit must be a positive integer',
			);
		}
	});
});

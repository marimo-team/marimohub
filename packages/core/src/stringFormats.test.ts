import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ulidString, utcTimestamp } from './stringFormats';

describe('UTC timestamps', () => {
	it.each([
		'2026-10-23T12:30Z',
		'2026-10-23T12:30:45Z',
		'2026-10-23T12:30:45.123456789Z',
		'2024-02-29T00:00Z',
		'2000-02-29T23:59:59Z',
		'0000-02-29T00:00Z',
	])('preserves supported precision and leap dates: %s', (value) => {
		expect(utcTimestamp().parse(value)).toBe(value);
	});

	it.each([
		'2026-02-29T00:00Z',
		'1900-02-29T00:00Z',
		'2100-02-29T00:00Z',
		'2026-04-31T00:00Z',
		'2026-13-01T00:00Z',
		'2026-01-00T00:00Z',
		'2026-10-23T24:00Z',
		'2026-10-23T12:60Z',
		'2026-10-23T12:30:60Z',
		'2026-10-23T12:30.1Z',
		'2026-10-23T12:30:45.Z',
		'2026-10-23T12:30',
		'2026-10-23T12:30:00+00:00',
		'2026-10-23t12:30z',
	])('rejects unsupported timestamps: %s', (value) => {
		expect(utcTimestamp().safeParse(value).success).toBe(false);
	});

	it('retains the JSON Schema date-time format and minute-precision pattern', () => {
		const schema = z.toJSONSchema(utcTimestamp());
		expect(schema).toMatchObject({ type: 'string', format: 'date-time' });
		const pattern = new RegExp(schema.pattern!);
		expect(pattern.test('2026-10-23T12:30Z')).toBe(true);
		expect(pattern.test('1900-02-29T12:30Z')).toBe(false);
	});

	it('preserves custom credential validation messages', () => {
		expect(() => utcTimestamp('Expected a UTC timestamp').parse('invalid')).toThrow(
			'Expected a UTC timestamp',
		);
	});
});

describe('ULID strings', () => {
	it.each([
		'01ARZ3NDEKTSV4RRFFQ69G5FAV',
		'Z1ARZ3NDEKTSV4RRFFQ69G5FAV',
		'z1arz3ndektsv4rrffq69g5fav',
	])('preserves the existing registration identifier alphabet: %s', (value) => {
		expect(ulidString().parse(value)).toBe(value);
	});

	it.each([
		'',
		'01ARZ3NDEKTSV4RRFFQ69G5FA',
		'01ARZ3NDEKTSV4RRFFQ69G5FAVV',
		'O1ARZ3NDEKTSV4RRFFQ69G5FAV',
		'U1ARZ3NDEKTSV4RRFFQ69G5FAV',
	])('rejects malformed registration identifiers: %s', (value) => {
		expect(ulidString().safeParse(value).success).toBe(false);
	});

	it('retains the published ULID format and pattern', () => {
		expect(z.toJSONSchema(ulidString())).toMatchObject({
			type: 'string',
			format: 'ulid',
			pattern: '^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$',
		});
	});
});

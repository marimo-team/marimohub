import { describe, expect, it } from 'vitest';
import { nextIsoTimestamp, parseIsoTimestamp, parseUtcDate } from './utcDate';

describe('parseUtcDate', () => {
	it('parses real ISO calendar dates at UTC midnight', () => {
		expect(parseUtcDate('2024-02-29')).toBe(Date.parse('2024-02-29T00:00:00.000Z'));
	});

	it.each(['2025-02-29', '2025-02-30', '2025-13-01', '2025-1-01', 'not-a-date'])(
		'rejects %s',
		(value) => {
			expect(parseUtcDate(value)).toBeNull();
		},
	);
});

describe('parseIsoTimestamp', () => {
	it.each(['2026-10-23T12:30Z', '2000-02-29T23:59Z'])(
		'accepts minute precision with zero seconds: %s',
		(value) => {
			expect(parseIsoTimestamp(value)).toBe(Date.parse(value.replace('Z', ':00.000Z')));
		},
	);

	it.each([
		'2026-02-29T12:30Z',
		'1900-02-29T12:30Z',
		'2026-04-31T12:30Z',
		'2026-10-23T24:00Z',
		'2026-10-23T12:60Z',
		'2026-10-23T12:30.1Z',
		'2026-10-23T12:30+00:00',
	])('rejects invalid minute timestamps: %s', (value) => {
		expect(parseIsoTimestamp(value)).toBeNull();
	});
});

describe('nextIsoTimestamp', () => {
	it('compares minute precision without extending it to the end of the minute', () => {
		expect(nextIsoTimestamp('2026-10-23T12:30Z', '2026-10-23T12:30:00.001Z')).toBe(
			'2026-10-23T12:30:00.001Z',
		);
		expect(nextIsoTimestamp('2026-10-23T12:30:00.001Z', '2026-10-23T12:30Z')).toBe(
			'2026-10-23T12:30:00.002Z',
		);
	});

	it('returns the candidate when it is newer', () => {
		expect(nextIsoTimestamp('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.100Z')).toBe(
			'2025-01-01T00:00:00.100Z',
		);
	});

	it.each(['2025-01-01T00:00:00.000Z', '2024-12-31T23:59:59.999Z'])(
		'advances one millisecond when %s is not newer',
		(candidate) => {
			expect(nextIsoTimestamp('2025-01-01T00:00:00.000Z', candidate)).toBe(
				'2025-01-01T00:00:00.001Z',
			);
		},
	);

	it('accepts an absent previous timestamp', () => {
		expect(nextIsoTimestamp(undefined, '2025-01-01T00:00:00.000Z')).toBe(
			'2025-01-01T00:00:00.000Z',
		);
	});

	it('accepts fractional precision used by stored ISO timestamps', () => {
		expect(nextIsoTimestamp(undefined, '2025-01-01T00:00:00.123456Z')).toBe(
			'2025-01-01T00:00:00.123456Z',
		);
		expect(nextIsoTimestamp('2025-01-01T00:00:00.123456Z', '2025-01-01T00:00:00.123457Z')).toBe(
			'2025-01-01T00:00:00.124Z',
		);
	});

	it.each([
		['invalid', '2025-01-01T00:00:00.000Z'],
		['2025-01-01T00:00:00.000Z', 'invalid'],
	])('rejects invalid timestamps', (previous, candidate) => {
		expect(() => nextIsoTimestamp(previous, candidate)).toThrow(RangeError);
	});

	it('rejects an invalid candidate without a previous timestamp', () => {
		expect(() => nextIsoTimestamp(undefined, 'invalid')).toThrow(RangeError);
	});

	it.each([
		'2025-01-01',
		'Wed, 01 Jan 2025 00:00:00 GMT',
		'2025-02-30T00:00:00.000Z',
		'2025-01-01T24:00:00.000Z',
		'2025-01-01T00:00:00.000+00:00',
	])('rejects parseable values that are not valid UTC ISO timestamps: %s', (value) => {
		expect(parseIsoTimestamp(value)).toBeNull();
		expect(() => nextIsoTimestamp(undefined, value)).toThrow(RangeError);
	});
});

import { describe, expect, it } from 'vitest';
import { nextIsoTimestamp, parseUtcDate } from './utcDate';

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

describe('nextIsoTimestamp', () => {
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

	it.each([
		['invalid', '2025-01-01T00:00:00.000Z'],
		['2025-01-01T00:00:00.000Z', 'invalid'],
	])('rejects invalid timestamps', (previous, candidate) => {
		expect(() => nextIsoTimestamp(previous, candidate)).toThrow(RangeError);
	});

	it('rejects an invalid candidate without a previous timestamp', () => {
		expect(() => nextIsoTimestamp(undefined, 'invalid')).toThrow(RangeError);
	});
});

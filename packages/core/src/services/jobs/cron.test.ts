import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
	isValidCron,
	isValidTimeZone,
	nextOccurrence,
	occurrenceKey,
	occurrenceKeyToInstant,
	parseCron,
	previousOccurrence,
} from './cron';

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The first `count` occurrences after `after`, as ISO strings. */
function occurrences(expression: string, timeZone: string, after: string, count: number): string[] {
	const schedule = parseCron(expression);
	const out: string[] = [];
	let cursor = at(after);
	for (let i = 0; i < count; i++) {
		const next = nextOccurrence(schedule, timeZone, cursor);
		if (next === null) break;
		out.push(new Date(next).toISOString());
		cursor = next;
	}
	return out;
}

describe('parseCron', () => {
	it('normalizes whitespace and keeps the five fields', () => {
		expect(parseCron('  */15   9-17 1,15 jan-mar mon-fri ').expression).toBe(
			'*/15 9-17 1,15 jan-mar mon-fri',
		);
	});

	it('expands steps, ranges, lists, and names', () => {
		expect(occurrences('*/15 9-17 1,15 jan-mar mon-fri', 'UTC', '2026-01-01T00:00:00Z', 3)).toEqual(
			['2026-01-01T09:00:00.000Z', '2026-01-01T09:15:00.000Z', '2026-01-01T09:30:00.000Z'],
		);
		expect(occurrences('0 9 * JAN,dec SUN', 'UTC', '2026-09-02T00:00:00Z', 1)).toEqual([
			'2026-12-06T09:00:00.000Z',
		]);
	});

	it('treats day-of-week 7 as Sunday', () => {
		expect(occurrences('0 0 * * 7', 'UTC', '2026-09-02T00:00:00Z', 1)).toEqual([
			'2026-09-06T00:00:00.000Z',
		]);
	});

	it('steps over the whole field for `*/n` and dedupes overlapping lists', () => {
		expect(occurrences('*/30 */12 * * *', 'UTC', '2026-09-02T00:00:00Z', 3)).toEqual([
			'2026-09-02T00:30:00.000Z',
			'2026-09-02T12:00:00.000Z',
			'2026-09-02T12:30:00.000Z',
		]);
		expect(occurrences('0,0,30-30 * * * *', 'UTC', '2026-09-02T00:00:00Z', 2)).toEqual([
			'2026-09-02T00:30:00.000Z',
			'2026-09-02T01:00:00.000Z',
		]);
	});

	it.each([
		['* * * *', 'expected 5 fields'],
		['0 0 0 * * *', 'expected 5 fields'],
		['@daily', 'expected 5 fields'],
		['60 * * * *', 'minute'],
		['* 24 * * *', 'hour'],
		['0 0 32 * *', 'day'],
		['0 0 * 13 *', 'month'],
		['0 0 * * 8', 'dayOfWeek'],
		['*/0 * * * *', 'stepping'],
		['5-1 * * * *', 'larger than'],
		['a * * * *', 'illegal characters'],
		['1,,2 * * * *', 'empty'],
		['1//2 * * * *', 'stepping'],
	])('rejects %s', (expression, detail) => {
		expect(() => parseCron(expression)).toThrow(ValidationError);
		expect(() => parseCron(expression)).toThrow(detail);
		expect(isValidCron(expression)).toBe(false);
	});
});

describe('isValidTimeZone', () => {
	it('accepts IANA names and rejects garbage or padding', () => {
		expect(isValidTimeZone('UTC')).toBe(true);
		expect(isValidTimeZone('Europe/Berlin')).toBe(true);
		expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
		expect(isValidTimeZone(' UTC')).toBe(false);
		expect(isValidTimeZone('')).toBe(false);
	});
});

describe('previousOccurrence', () => {
	const daily6 = parseCron('0 6 * * *');

	it('finds the latest occurrence at or before `at` within the window', () => {
		expect(previousOccurrence(daily6, 'Europe/Berlin', at('2026-09-02T04:30:00Z'), HOUR)).toBe(
			at('2026-09-02T04:00:00Z'),
		);
	});

	it('includes an occurrence exactly at `at` and exactly at the window floor', () => {
		expect(previousOccurrence(daily6, 'UTC', at('2026-09-02T06:00:00Z'), 10 * 60_000)).toBe(
			at('2026-09-02T06:00:00Z'),
		);
		expect(previousOccurrence(daily6, 'UTC', at('2026-09-02T06:10:00Z'), 10 * 60_000)).toBe(
			at('2026-09-02T06:00:00Z'),
		);
	});

	it('returns null when the latest occurrence is older than the window', () => {
		expect(
			previousOccurrence(daily6, 'Europe/Berlin', at('2026-09-02T04:30:00Z'), 10 * 60_000),
		).toBeNull();
		expect(previousOccurrence(daily6, 'UTC', at('2026-09-02T06:00:30Z'), 0)).toBeNull();
	});

	it('does not round a millisecond window floor down to the previous second', () => {
		expect(
			previousOccurrence(daily6, 'UTC', at('2026-09-02T06:10:00.500Z'), 10 * 60_000),
		).toBeNull();
	});

	it('fires a wall time lost to the spring-forward gap once the clock catches up', () => {
		// Berlin springs 02:00 → 03:00 on 2026-03-29; 02:30 CET does not exist and
		// runs at 03:30 CEST (01:30Z) instead of being dropped for the day.
		const halfPastTwo = parseCron('30 2 * * *');
		expect(previousOccurrence(halfPastTwo, 'Europe/Berlin', at('2026-03-29T02:00:00Z'), DAY)).toBe(
			at('2026-03-29T01:30:00Z'),
		);
	});

	it('resolves the repeated fall-back hour to one instant', () => {
		// Berlin repeats 02:00–03:00 on 2026-10-25; 02:30 local exists twice.
		const halfPastTwo = parseCron('30 2 * * *');
		expect(
			previousOccurrence(halfPastTwo, 'Europe/Berlin', at('2026-10-25T02:00:00Z'), 3 * HOUR),
		).toBe(at('2026-10-25T00:30:00Z'));
		expect(occurrences('30 2 * * *', 'Europe/Berlin', '2026-10-24T23:00:00Z', 2)).toEqual([
			'2026-10-25T00:30:00.000Z',
			'2026-10-26T01:30:00.000Z',
		]);
	});

	it('honors Vixie OR semantics when both day fields are restricted', () => {
		// The 13th (a Sunday) and any Friday.
		const schedule = parseCron('0 0 13 * fri');
		expect(previousOccurrence(schedule, 'UTC', at('2026-09-13T12:00:00Z'), DAY)).toBe(
			at('2026-09-13T00:00:00Z'),
		);
		expect(previousOccurrence(schedule, 'UTC', at('2026-09-11T12:00:00Z'), DAY)).toBe(
			at('2026-09-11T00:00:00Z'),
		);
		expect(previousOccurrence(schedule, 'UTC', at('2026-09-10T12:00:00Z'), DAY)).toBeNull();
	});

	it('fires at most the latest occurrence after a long gap', () => {
		const everyMinute = parseCron('* * * * *');
		expect(previousOccurrence(everyMinute, 'UTC', at('2026-09-05T10:00:30Z'), 3 * DAY)).toBe(
			at('2026-09-05T10:00:00Z'),
		);
	});

	it('evaluates the weekday in the schedule’s zone, not UTC', () => {
		// Tuesday 00:00 in Auckland (UTC+12) is Monday 12:00Z.
		const tuesdayMidnight = parseCron('0 0 * * tue');
		expect(
			previousOccurrence(tuesdayMidnight, 'Pacific/Auckland', at('2026-09-07T13:00:00Z'), 2 * HOUR),
		).toBe(at('2026-09-07T12:00:00Z'));
	});
});

describe('nextOccurrence', () => {
	it('finds the next matching weekday', () => {
		expect(nextOccurrence(parseCron('0 9 * * mon'), 'UTC', at('2026-09-02T10:00:00Z'))).toBe(
			at('2026-09-07T09:00:00Z'),
		);
	});

	it('is strictly after `after`', () => {
		expect(nextOccurrence(parseCron('0 6 * * *'), 'UTC', at('2026-09-02T06:00:00Z'))).toBe(
			at('2026-09-03T06:00:00Z'),
		);
	});

	it('rolls across a year boundary and only fires on a real leap day', () => {
		expect(nextOccurrence(parseCron('0 0 1 1 *'), 'UTC', at('2026-12-31T23:59:00Z'))).toBe(
			at('2027-01-01T00:00:00Z'),
		);
		expect(nextOccurrence(parseCron('0 0 29 2 *'), 'UTC', at('2026-03-01T00:00:00Z'))).toBe(
			at('2028-02-29T00:00:00Z'),
		);
	});

	it('returns null for a schedule that never matches', () => {
		expect(nextOccurrence(parseCron('0 0 31 2 *'), 'UTC', at('2026-09-02T06:00:00Z'))).toBeNull();
		expect(
			previousOccurrence(parseCron('0 0 31 2 *'), 'UTC', at('2026-09-02T06:00:00Z'), DAY),
		).toBeNull();
	});
});

describe('occurrenceKey', () => {
	it('is the UTC minute, truncates seconds, and round-trips', () => {
		const instant = at('2026-09-02T06:00:00Z');
		expect(occurrenceKey(instant)).toBe('20260902T0600Z');
		expect(occurrenceKey(at('2026-09-02T06:00:59.999Z'))).toBe('20260902T0600Z');
		expect(occurrenceKeyToInstant('20260902T0600Z')).toBe(instant);
	});

	it('rejects malformed keys', () => {
		expect(occurrenceKeyToInstant('nope')).toBeNull();
		expect(occurrenceKeyToInstant('20260902T06Z')).toBeNull();
		expect(occurrenceKeyToInstant('')).toBeNull();
	});

	it.each([
		'20260230T0600Z',
		'20261301T0600Z',
		'20260931T0600Z',
		'20260902T2400Z',
		'20260902T0660Z',
	])('rejects the impossible UTC minute %s', (key) => {
		expect(occurrenceKeyToInstant(key)).toBeNull();
	});
});

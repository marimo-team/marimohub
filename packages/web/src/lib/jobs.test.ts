import { describe, expect, it } from 'vitest';
import {
	describeSchedule,
	isTerminalRun,
	RUN_STATUS_LABELS,
	runDurationMs,
	runStatusClasses,
	TERMINAL_RUN_STATUSES,
} from './jobs';
import type { JobRunStatus } from '@/types';

const ALL_STATUSES: JobRunStatus[] = [
	'queued',
	'provisioning',
	'running',
	'succeeded',
	'failed',
	'timed_out',
	'cancelled',
	'skipped',
	'unknown',
];

describe('lib/jobs', () => {
	it('classifies terminal statuses, treating an unknown status as live', () => {
		for (const status of ALL_STATUSES) {
			expect(isTerminalRun({ status })).toBe(TERMINAL_RUN_STATUSES.includes(status));
		}
		expect(isTerminalRun({ status: 'unknown' })).toBe(false);
	});

	it('has a label and chip style for every status the server may send', () => {
		for (const status of ALL_STATUSES) {
			expect(RUN_STATUS_LABELS[status]).toBeTruthy();
			expect(runStatusClasses(status)).toContain('border');
		}
	});

	it('describes manual-only and scheduled jobs', () => {
		expect(describeSchedule({})).toBe('Manual only');
		expect(describeSchedule({ schedule: { cron: '0 6 * * *', timezone: 'UTC' } })).toBe(
			'0 6 * * * · UTC',
		);
	});

	it('measures a run against its end, or the live clock while running', () => {
		const now = Date.parse('2026-09-02T10:05:00Z');
		expect(runDurationMs({}, now)).toBeNull();
		expect(runDurationMs({ started_at: '2026-09-02T10:00:00Z' }, now)).toBe(5 * 60_000);
		expect(
			runDurationMs(
				{ started_at: '2026-09-02T10:00:00Z', finished_at: '2026-09-02T10:01:30Z' },
				now,
			),
		).toBe(90_000);
		// A clock that trails `started_at` never yields a negative duration.
		expect(runDurationMs({ started_at: '2026-09-02T10:10:00Z' }, now)).toBe(0);
		expect(runDurationMs({ started_at: 'not a date' }, now)).toBeNull();
	});
});

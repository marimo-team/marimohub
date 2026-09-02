/**
 * Five-field cron evaluation in an IANA time zone, on top of `croner` (zero
 * dependencies; a `Cron` built without a callback never starts a timer).
 * croner's defaults give standard cron semantics: Vixie OR when both day
 * fields are restricted, one fire for the repeated fall-back hour, and a
 * wall time lost to a spring-forward gap firing once the clock catches up.
 * Only the five-field form is admitted — croner would otherwise read a sixth
 * field as seconds — and nicknames such as `@daily` are rejected with it.
 */
import { Cron } from 'croner';
import { ValidationError } from '../../errors';

/** A validated five-field expression. */
export interface CronSchedule {
	readonly expression: string;
}

function invalid(expression: string, detail: string): ValidationError {
	return new ValidationError(`Invalid cron expression "${expression}": ${detail}`);
}

/** Parse a five-field cron expression; throws `ValidationError` on any problem. */
export function parseCron(expression: string): CronSchedule {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw invalid(
			expression,
			`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
		);
	}
	const normalized = fields.join(' ');
	try {
		new Cron(normalized, { timezone: 'UTC' });
	} catch (err) {
		throw invalid(
			expression,
			err instanceof Error ? err.message.replace(/^CronPattern: /, '') : 'unparseable',
		);
	}
	return { expression: normalized };
}

export function isValidCron(expression: string): boolean {
	try {
		parseCron(expression);
		return true;
	} catch {
		return false;
	}
}

export function isValidTimeZone(timeZone: string): boolean {
	if (timeZone.trim() !== timeZone || timeZone === '') return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return true;
	} catch {
		return false;
	}
}

function cronFor(schedule: CronSchedule, timeZone: string): Cron {
	return new Cron(schedule.expression, { timezone: timeZone });
}

/**
 * The most recent occurrence at or before `atMs` that is no older than
 * `windowMs`, or `null`. The scheduler's missed-tick policy: at most the latest
 * missed occurrence fires, never the whole gap. Walks forward from the window
 * floor (croner has no backward search), so the cost is one `nextRun` per
 * occurrence inside the window.
 */
export function previousOccurrence(
	schedule: CronSchedule,
	timeZone: string,
	atMs: number,
	windowMs: number,
): number | null {
	const cron = cronFor(schedule, timeZone);
	// `nextRun` is strictly after its argument; step back one second so an
	// occurrence exactly at the floor still counts.
	let cursor = new Date(atMs - windowMs - 1000);
	let latest: number | null = null;
	for (;;) {
		const next = cron.nextRun(cursor);
		if (next === null || next.getTime() > atMs) return latest;
		latest = next.getTime();
		cursor = next;
	}
}

/** The first occurrence strictly after `afterMs`, or `null` when the schedule never matches. */
export function nextOccurrence(
	schedule: CronSchedule,
	timeZone: string,
	afterMs: number,
): number | null {
	return cronFor(schedule, timeZone).nextRun(new Date(afterMs))?.getTime() ?? null;
}

/**
 * Deterministic occurrence key (`20260902T0600Z`): the UTC minute of the
 * instant, so replicas with skewed clocks still compute the same key for the
 * same fire and collide on the create-if-absent claim.
 */
export function occurrenceKey(instantMs: number): string {
	return `${new Date(instantMs).toISOString().slice(0, 16).replaceAll(/[-:]/g, '')}Z`;
}

export function occurrenceKeyToInstant(key: string): number | null {
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(key);
	if (!match) return null;
	const [, y, mo, d, h, mi] = match;
	return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

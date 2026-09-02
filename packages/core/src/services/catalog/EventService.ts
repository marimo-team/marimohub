import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { Millis } from '../../duration';
import { BadRequestError } from '../../errors';
import { createEventId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { EventSchema, readStored } from '../../schema';
import type { Event } from '../../schema';
import { parseUtcDate } from '../../utcDate';
import { putIfAbsent } from './cas';

export const MAX_EVENT_RANGE_DAYS = 30;
const DAY_MS = Millis.days(1);

export interface EventListOptions {
	from: string;
	to: string;
	limit: number;
	cursor?: string;
	event?: string;
	actor?: string;
	projectId?: string;
}

export interface EventPage {
	items: Event[];
	nextCursor: string | null;
}

interface EventCursor {
	date: string;
	id: string;
}

function encodeCursor(cursor: EventCursor): string {
	return btoa(JSON.stringify([cursor.date, cursor.id]));
}

function decodeCursor(value: string | undefined): EventCursor | null {
	if (!value) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(atob(value));
	} catch {
		throw new BadRequestError('Invalid event pagination cursor');
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		typeof parsed[0] !== 'string' ||
		parseUtcDate(parsed[0]) === null ||
		typeof parsed[1] !== 'string' ||
		parsed[1].length === 0
	) {
		throw new BadRequestError('Invalid event pagination cursor');
	}
	return { date: parsed[0], id: parsed[1] };
}

function previousDate(date: string): string {
	return new Date(Date.parse(`${date}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

function assertValidEventRange(from: string, to: string): void {
	const fromTime = parseUtcDate(from);
	if (fromTime === null) throw new BadRequestError(`Invalid UTC date: ${from}`);
	const toTime = parseUtcDate(to);
	if (toTime === null) throw new BadRequestError(`Invalid UTC date: ${to}`);
	if (fromTime > toTime) throw new BadRequestError('Event range start must not be after its end');
	if ((toTime - fromTime) / DAY_MS + 1 > MAX_EVENT_RANGE_DAYS) {
		throw new BadRequestError(`Event ranges cannot exceed ${MAX_EVENT_RANGE_DAYS} days`);
	}
}

function matches(event: Event, options: EventListOptions): boolean {
	if (options.event !== undefined && event.event !== options.event) return false;
	if (options.actor !== undefined && event.actor !== options.actor) return false;
	if (options.projectId !== undefined && event.project_id !== options.projectId) return false;
	return true;
}

export class EventService {
	constructor(private bucket: Bucket) {}

	async append(
		event: { event: string; actor: UserId } & Record<string, unknown>,
		options: { id?: string; timestamp?: string; onlyIfAbsent?: boolean } = {},
	): Promise<void> {
		const now = options.timestamp ? new Date(options.timestamp) : new Date();
		const date = now.toISOString().slice(0, 10);
		const id = options.id ?? createEventId();

		const fullEvent = {
			id,
			...event,
			schema_version: 1 as const,
			ts: now.toISOString(),
		};

		// One immutable object per event. Object stores have no atomic append, so a
		// shared per-day file would lose events under concurrent writers (a
		// read-modify-write race). Per-event objects are write-safe with no locking.
		const key = paths.event(date, id);
		if (options.onlyIfAbsent) {
			await putIfAbsent(this.bucket, key, JSON.stringify(fullEvent));
		} else {
			await this.bucket.put(key, JSON.stringify(fullEvent));
		}
	}

	async getEvents(date: string): Promise<Event[]> {
		const prefix = paths.eventsForDate(date);
		const events: Event[] = [];
		let cursor: string | undefined;

		// Keys are monotonic ULIDs, so prefix-listing returns events in append order.
		// Pages are sequential (cursor-driven), but the reads within a page run in
		// bounded-parallel; mapWithConcurrency preserves order, so append order holds.
		do {
			const result = await this.bucket.list({ prefix, cursor });
			const page = await mapWithConcurrency(
				result.objects,
				BUCKET_SCAN_CONCURRENCY,
				async (obj) => {
					const body = await this.bucket.get(obj.key);
					if (!body) return;
					// One corrupt/legacy event object must not make the whole day's audit
					// log unreadable — skip it (logged) rather than throwing.
					try {
						const event = await readStored(EventSchema, body, obj.key);
						const filename = obj.key.slice(prefix.length);
						return { ...event, id: filename.replace(/\.json$/, '') };
					} catch (err) {
						logOperationalError(
							'stored_object_skipped',
							{ operation: 'event.list', object: obj.key },
							err,
						);
						return;
					}
				},
			);
			for (const event of page) {
				if (event) events.push(event);
			}
			cursor = result.truncated ? result.cursor : undefined;
		} while (cursor);

		return events;
	}

	async listEvents(options: EventListOptions): Promise<EventPage> {
		if (!Number.isInteger(options.limit) || options.limit <= 0) {
			throw new BadRequestError('Event page limit must be a positive integer');
		}
		assertValidEventRange(options.from, options.to);
		const cursor = decodeCursor(options.cursor);
		if (cursor && (cursor.date < options.from || cursor.date > options.to)) {
			throw new BadRequestError('Event pagination cursor is outside the requested date range');
		}

		const found: { event: Event; date: string }[] = [];
		let date = cursor?.date ?? options.to;

		while (date >= options.from && found.length <= options.limit) {
			const events = await this.getEvents(date);
			for (let index = events.length - 1; index >= 0; index--) {
				const event = events[index];
				if (cursor?.date === date && event.id >= cursor.id) continue;
				if (!matches(event, options)) continue;
				found.push({ event, date });
				if (found.length > options.limit) break;
			}
			date = previousDate(date);
		}

		const page = found.slice(0, options.limit);
		const last = page[page.length - 1];
		return {
			items: page.map(({ event }) => event),
			nextCursor:
				found.length > options.limit && last
					? encodeCursor({ date: last.date, id: last.event.id })
					: null,
		};
	}
}

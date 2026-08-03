import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { createEventId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { EventSchema, readStored } from '../../schema';
import type { Event } from '../../schema';

export class EventService {
	constructor(private bucket: Bucket) {}

	async append(event: { event: string; actor: UserId } & Record<string, unknown>): Promise<void> {
		const now = new Date();
		const date = now.toISOString().slice(0, 10);
		const id = createEventId();

		const fullEvent = {
			id,
			...event,
			schema_version: 1 as const,
			ts: now.toISOString(),
		};

		// One immutable object per event. Object stores have no atomic append, so a
		// shared per-day file would lose events under concurrent writers (a
		// read-modify-write race). Per-event objects are write-safe with no locking.
		await this.bucket.put(paths.event(date, id), JSON.stringify(fullEvent));
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
						return await readStored(EventSchema, body, obj.key);
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
}

import type { Bucket } from '../ports/bucket';
import { createEventId } from '../ids';
import { paths } from '../paths';
import { EventSchema, type Event } from '../schema';

export class EventService {
	constructor(private bucket: Bucket) {}

	async append(event: { event: string; actor: string } & Record<string, unknown>): Promise<void> {
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
		do {
			const result = await this.bucket.list({ prefix, cursor });
			for (const obj of result.objects) {
				const body = await this.bucket.get(obj.key);
				if (body) events.push(EventSchema.parse(await body.json()));
			}
			cursor = result.truncated ? result.cursor : undefined;
		} while (cursor);

		return events;
	}
}

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryBucket, uid } from '../../testing';
import { paths } from '../../paths';
import { EventService } from './EventService';

describe('EventService', () => {
	let bucket: MemoryBucket;
	let events: EventService;

	beforeEach(() => {
		bucket = new MemoryBucket();
		events = new EventService(bucket);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2025-03-05T14:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('append', () => {
		it('records an event retrievable for the day', async () => {
			await events.append({
				event: 'notebook.create',
				actor: uid('user_1'),
				notebook_id: 'nb_123',
			});

			const evts = await events.getEvents('2025-03-05');
			expect(evts).toHaveLength(1);
			expect(evts[0].event).toBe('notebook.create');
			expect(evts[0].schema_version).toBe(1);
			expect(evts[0].ts).toBe('2025-03-05T14:00:00.000Z');
		});

		it('stores one object per event under the day prefix', async () => {
			await events.append({ event: 'a', actor: uid('x') });
			await events.append({ event: 'b', actor: uid('y') });

			const listed = await bucket.list({ prefix: paths.eventsForDate('2025-03-05') });
			expect(listed.objects).toHaveLength(2);
		});

		it('returns events in append order', async () => {
			await events.append({ event: 'first', actor: uid('a') });
			await events.append({ event: 'second', actor: uid('b') });

			const evts = await events.getEvents('2025-03-05');
			expect(evts).toHaveLength(2);
			expect(evts[0].event).toBe('first');
			expect(evts[1].event).toBe('second');
		});

		it('preserves extra fields via passthrough', async () => {
			await events.append({
				event: 'notebook.create',
				actor: uid('user_1'),
				project_id: 'proj_123',
				custom_field: 'value',
			});

			const evts = await events.getEvents('2025-03-05');
			expect(evts[0]).toHaveProperty('project_id', 'proj_123');
		});
	});

	describe('getEvents', () => {
		it('returns empty array for missing date', async () => {
			const evts = await events.getEvents('2025-01-01');
			expect(evts).toEqual([]);
		});

		it('parses all events for a day', async () => {
			await events.append({ event: 'a', actor: uid('x') });
			await events.append({ event: 'b', actor: uid('y') });
			await events.append({ event: 'c', actor: uid('z') });

			const evts = await events.getEvents('2025-03-05');
			expect(evts).toHaveLength(3);
			expect(evts.map((e) => e.event)).toEqual(['a', 'b', 'c']);
		});
	});

	describe('daily rollover', () => {
		it('writes to separate files for different days', async () => {
			vi.setSystemTime(new Date('2025-03-05T23:59:00.000Z'));
			await events.append({ event: 'day1', actor: uid('a') });

			vi.setSystemTime(new Date('2025-03-06T00:01:00.000Z'));
			await events.append({ event: 'day2', actor: uid('b') });

			const day1 = await events.getEvents('2025-03-05');
			const day2 = await events.getEvents('2025-03-06');
			expect(day1).toHaveLength(1);
			expect(day1[0].event).toBe('day1');
			expect(day2).toHaveLength(1);
			expect(day2[0].event).toBe('day2');
		});
	});
});

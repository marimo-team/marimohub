import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryBucket, uid } from '../../testing';
import type { BucketListOptions } from '../../ports/bucket';
import { paths } from '../../paths';
import { EventService } from './EventService';

/** Forces a tiny list page so getEvents' cursor loop spans multiple pages. */
class SmallPageBucket extends MemoryBucket {
	constructor(private readonly pageSize: number) {
		super();
	}
	override list(options?: BucketListOptions) {
		return super.list({ ...options, limit: options?.limit ?? this.pageSize });
	}
}

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

		it('does not duplicate an idempotent append', async () => {
			const actor = uid('x');
			await events.append(
				{ event: 'job.run.finish', actor, status: 'failed' },
				{ id: 'stable-run', onlyIfAbsent: true },
			);
			await events.append(
				{ event: 'job.run.finish', actor, status: 'succeeded' },
				{ id: 'stable-run', onlyIfAbsent: true },
			);
			const stored = await events.getEvents('2025-03-05');
			expect(stored).toHaveLength(1);
			expect(stored[0].status).toBe('failed');
		});

		it('orders idempotent events by append time rather than their stable key', async () => {
			await events.append({ event: 'first', actor: uid('a') }, { id: 'zzzz', onlyIfAbsent: true });
			await events.append({ event: 'second', actor: uid('b') }, { id: 'aaaa', onlyIfAbsent: true });

			expect((await events.getEvents('2025-03-05')).map((event) => event.event)).toEqual([
				'first',
				'second',
			]);
		});

		it('repairs an idempotent event whose payload write failed', async () => {
			const originalPut = bucket.put.bind(bucket);
			let failPayload = true;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (failPayload && !key.includes('/_idempotency/')) {
					failPayload = false;
					throw new Error('payload write failed');
				}
				return originalPut(key, value, options);
			});
			const event = { event: 'job.run.finish', actor: uid('x'), status: 'failed' };

			await expect(events.append(event, { id: 'stable-run', onlyIfAbsent: true })).rejects.toThrow(
				'payload write failed',
			);
			await events.append(event, { id: 'stable-run', onlyIfAbsent: true });

			expect(await events.getEvents('2025-03-05')).toMatchObject([
				{ event: 'job.run.finish', status: 'failed' },
			]);
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

		it('skips a corrupt event object rather than throwing', async () => {
			await events.append({ event: 'a', actor: uid('x') });
			await events.append({ event: 'b', actor: uid('y') });
			// A corrupt object under the same day prefix (sorts after the ULID keys).
			await bucket.put(paths.event('2025-03-05', 'zzz-corrupt'), 'not-json{');

			const evts = await events.getEvents('2025-03-05');
			expect(evts.map((e) => e.event).sort()).toEqual(['a', 'b']);
		});

		it('pages across multiple truncated list pages', async () => {
			const small = new SmallPageBucket(2);
			const svc = new EventService(small);
			for (let i = 0; i < 5; i++) {
				await svc.append({ event: `e${i}`, actor: uid('a') });
			}

			const evts = await svc.getEvents('2025-03-05');
			expect(evts).toHaveLength(5);
		});
	});

	describe('listEvents', () => {
		it('returns newest events first across days and pages without gaps', async () => {
			vi.setSystemTime(new Date('2025-03-04T12:00:00.000Z'));
			await events.append({ event: 'day-1', actor: uid('a') });
			vi.setSystemTime(new Date('2025-03-05T12:00:00.000Z'));
			await events.append({ event: 'day-2-first', actor: uid('a') });
			await events.append({ event: 'day-2-second', actor: uid('b') });

			const first = await events.listEvents({
				from: '2025-03-04',
				to: '2025-03-05',
				limit: 2,
			});
			expect(first.items.map((event) => event.event)).toEqual(['day-2-second', 'day-2-first']);
			expect(first.nextCursor).toBeTruthy();

			const second = await events.listEvents({
				from: '2025-03-04',
				to: '2025-03-05',
				limit: 2,
				cursor: first.nextCursor ?? undefined,
			});
			expect(second.items.map((event) => event.event)).toEqual(['day-1']);
			expect(second.nextCursor).toBeNull();
		});

		it('does not repeat a newer event appended between pages', async () => {
			await events.append({ event: 'first', actor: uid('a') });
			await events.append({ event: 'second', actor: uid('a') });
			const first = await events.listEvents({
				from: '2025-03-05',
				to: '2025-03-05',
				limit: 1,
			});

			await events.append({ event: 'newest', actor: uid('a') });
			const second = await events.listEvents({
				from: '2025-03-05',
				to: '2025-03-05',
				limit: 1,
				cursor: first.nextCursor ?? undefined,
			});
			expect(first.items.map((event) => event.event)).toEqual(['second']);
			expect(second.items.map((event) => event.event)).toEqual(['first']);
		});

		it('combines exact event, actor, and project filters', async () => {
			await events.append({
				event: 'notebook.update',
				actor: uid('ada'),
				project_id: 'proj-one',
				payload: { nested: ['kept'] },
			});
			await events.append({
				event: 'notebook.update',
				actor: uid('grace'),
				project_id: 'proj-one',
			});
			await events.append({
				event: 'notebook.create',
				actor: uid('ada'),
				project_id: 'proj-one',
			});

			const page = await events.listEvents({
				from: '2025-03-05',
				to: '2025-03-05',
				limit: 10,
				event: 'notebook.update',
				actor: 'ada',
				projectId: 'proj-one',
			});
			expect(page.items).toHaveLength(1);
			expect(page.items[0].payload).toEqual({ nested: ['kept'] });
		});

		it('rejects malformed and out-of-range cursors', async () => {
			await expect(
				events.listEvents({
					from: '2025-03-05',
					to: '2025-03-05',
					limit: 10,
					cursor: 'not-base64',
				}),
			).rejects.toThrow('Invalid event pagination cursor');

			const invalidDate = btoa(JSON.stringify(['2025-02-30', 'event-id']));
			await expect(
				events.listEvents({
					from: '2025-02-01',
					to: '2025-03-02',
					limit: 10,
					cursor: invalidDate,
				}),
			).rejects.toThrow('Invalid event pagination cursor');

			const outside = btoa(JSON.stringify(['2025-03-04', 'event-id']));
			await expect(
				events.listEvents({
					from: '2025-03-05',
					to: '2025-03-05',
					limit: 10,
					cursor: outside,
				}),
			).rejects.toThrow('outside the requested date range');
		});

		it.each([
			[{ from: 'invalid', to: '2025-03-05' }, 'Invalid UTC date: invalid'],
			[{ from: '2025-03-05', to: '2025-02-30' }, 'Invalid UTC date: 2025-02-30'],
			[{ from: '2025-03-06', to: '2025-03-05' }, 'Event range start must not be after its end'],
			[{ from: '2025-02-01', to: '2025-03-03' }, 'Event ranges cannot exceed 30 days'],
		])('rejects an invalid event range with a bad request: %o', async (range, message) => {
			await expect(events.listEvents({ ...range, limit: 10 })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
				status: 400,
				message,
			});
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

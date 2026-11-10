import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryBucket, makeSnapshot, makeCatalog, useFakeClock } from '../../testing';
import { createSnapshotId } from '../../ids';
import type { SnapshotId } from '../../ids';
import { paths } from '../../paths';
import type { BucketObjectBody } from '../../ports/bucket';
import { MaintenanceService } from './MaintenanceService';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('MaintenanceService', () => {
	let bucket: MemoryBucket;
	let maintenance: MaintenanceService;
	let clock: ReturnType<typeof useFakeClock>;

	beforeEach(() => {
		clock = useFakeClock();
		bucket = new MemoryBucket();
		maintenance = new MaintenanceService(bucket);
	});

	afterEach(() => {
		clock.restore();
	});

	async function putSnapshotAt(id: SnapshotId, whenMs: number): Promise<void> {
		clock.set(whenMs);
		await bucket.put(paths.snapshot(id), JSON.stringify(makeSnapshot({ snapshot_id: id })));
	}

	describe('expireSnapshots', () => {
		it.each([
			{ name: 'negative retention', options: { retentionMs: -1 } },
			{ name: 'NaN retention', options: { retentionMs: Number.NaN } },
			{ name: 'infinite retention', options: { retentionMs: Infinity } },
			{ name: 'negative floor', options: { keepLast: -1 } },
			{ name: 'fractional floor', options: { keepLast: 1.5 } },
			{ name: 'zero page size', options: { pageSize: 0 } },
			{ name: 'fractional page size', options: { pageSize: 1.5 } },
			{ name: 'zero page count', options: { maxPages: 0 } },
		])('rejects $name before accessing storage', async ({ options }) => {
			const get = vi.spyOn(bucket, 'get');
			const list = vi.spyOn(bucket, 'list');
			await expect(maintenance.expireSnapshots(options)).rejects.toThrow(RangeError);
			expect(get).not.toHaveBeenCalled();
			expect(list).not.toHaveBeenCalled();
		});

		it('retains the exact 90-day boundary and expires it on the next scan', async () => {
			const boundary = createSnapshotId();
			const current = createSnapshotId();
			await putSnapshotAt(boundary, 0);
			await putSnapshotAt(current, DAY_MS);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(current)));
			clock.set(90 * DAY_MS);
			expect(await maintenance.expireSnapshots({ keepLast: 0 })).toBe(0);
			clock.set(90 * DAY_MS + 1);
			expect(await maintenance.expireSnapshots({ keepLast: 0 })).toBe(1);
			expect(await bucket.head(paths.snapshot(boundary))).toBeNull();
			expect(await bucket.head(paths.snapshot(current))).not.toBeNull();
		});

		it('keeps the newest floor across timestamp ties and one-object pages', async () => {
			const ids = Array.from({ length: 8 }, () => createSnapshotId()).sort();
			for (const id of ids) await putSnapshotAt(id, 0);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[7])));
			clock.set(200 * DAY_MS);
			expect(await maintenance.expireSnapshots({ pageSize: 1, keepLast: 3 })).toBe(4);
			expect(
				(await bucket.list({ prefix: paths.snapshotsPrefix })).objects.map(({ key }) => key),
			).toEqual([ids[0], ids[1], ids[2], ids[7]].map(paths.snapshot));
		});

		it('resumes after deletion succeeds but its cursor checkpoint fails', async () => {
			const ids = Array.from({ length: 6 }, () => createSnapshotId()).sort();
			for (let i = 0; i < ids.length; i++) await putSnapshotAt(ids[i], i * DAY_MS);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[5])));
			clock.set(200 * DAY_MS);
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const options = { pageSize: 2, maxPages: 1, keepLast: 1 };
			await maintenance.expireSnapshots(options);
			const cursorKey = '_system/snapshot-expiry-cursor.json';
			const before = await (await bucket.get(cursorKey))!.text();
			const realPut = bucket.put.bind(bucket);
			const put = vi
				.spyOn(bucket, 'put')
				.mockImplementation((key, value, opts) =>
					key === cursorKey
						? Promise.reject(new Error('checkpoint unavailable'))
						: realPut(key, value, opts),
				);
			await expect(maintenance.expireSnapshots(options)).rejects.toThrow('checkpoint unavailable');
			expect(await (await bucket.get(cursorKey))!.text()).toBe(before);
			put.mockRestore();
			await new MaintenanceService(bucket, metrics).expireSnapshots({ ...options, maxPages: 10 });
			expect(
				(await bucket.list({ prefix: paths.snapshotsPrefix })).objects.map(({ key }) => key),
			).toEqual([paths.snapshot(ids[5])]);
			expect(metrics.gauge).toHaveBeenCalledWith('snapshots.count', 1);
			expect(metrics.gauge).toHaveBeenCalledWith(
				'snapshots.bytes',
				(await bucket.head(paths.snapshot(ids[5])))!.size,
			);
		});

		it('stops after losing a cursor CAS without overwriting the winner or emitting partial gauges', async () => {
			const ids = Array.from({ length: 4 }, () => createSnapshotId()).sort();
			for (const id of ids) await putSnapshotAt(id, 0);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[3])));
			clock.set(200 * DAY_MS);
			const cursorKey = '_system/snapshot-expiry-cursor.json';
			const realPut = bucket.put.bind(bucket);
			let winner = '';
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === cursorKey) {
					winner = String(value);
					await realPut(key, winner, { onlyIfNotExists: true });
				}
				return realPut(key, value, options);
			});
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const list = vi.spyOn(bucket, 'list');
			expect(
				await new MaintenanceService(bucket, metrics).expireSnapshots({ pageSize: 2, keepLast: 0 }),
			).toBe(2);
			expect(list).toHaveBeenCalledTimes(1);
			expect(await (await bucket.get(cursorKey))!.text()).toBe(winner);
			expect(metrics.gauge).not.toHaveBeenCalled();
		});

		it('keeps the original cutoff during a resumed scan and revisits new objects next time', async () => {
			const ids = Array.from({ length: 4 }, () => createSnapshotId()).sort();
			for (const id of [ids[0], ids[1], ids[3]]) await putSnapshotAt(id, 0);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[3])));
			clock.set(100 * DAY_MS);
			await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 0, pageSize: 1, maxPages: 1 });
			await putSnapshotAt(ids[2], 101 * DAY_MS);
			clock.set(102 * DAY_MS);
			await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 0 });
			expect(await bucket.head(paths.snapshot(ids[2]))).not.toBeNull();
			await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 0 });
			expect(await bucket.head(paths.snapshot(ids[2]))).toBeNull();
			expect(await bucket.head(paths.snapshot(ids[3]))).not.toBeNull();
		});

		it('restarts from the beginning when the retention policy changes', async () => {
			const ids = Array.from({ length: 4 }, () => createSnapshotId()).sort();
			for (let i = 0; i < ids.length; i++) await putSnapshotAt(ids[i], i * DAY_MS);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[3])));
			clock.set(50 * DAY_MS);
			await maintenance.expireSnapshots({ keepLast: 1, pageSize: 2, maxPages: 1 });
			const list = vi.spyOn(bucket, 'list');
			expect(await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 2 })).toBe(2);
			expect(list.mock.calls[0][0]?.startAfter).toBeUndefined();
			expect(
				(await bucket.list({ prefix: paths.snapshotsPrefix })).objects.map(({ key }) => key),
			).toEqual(ids.slice(2).map(paths.snapshot));
		});

		it.each(['invalid JSON', 'schema mismatch', 'foreign recent key', 'foreign after key'])(
			'restarts a cursor with %s and preserves unrelated objects',
			async (failure) => {
				const ids = Array.from({ length: 3 }, () => createSnapshotId()).sort();
				for (const id of ids) await putSnapshotAt(id, 0);
				await bucket.put(
					paths.catalog,
					JSON.stringify({
						...makeCatalog(ids[2]),
						previous_snapshot_id: ids[1],
					}),
				);
				const unrelated = '_system/identities/user.json';
				await bucket.put(unrelated, 'identity');
				clock.set(200 * DAY_MS);
				const cursorKey = '_system/snapshot-expiry-cursor.json';
				const cursor = {
					after: failure === 'foreign after key' ? 'zzz/outside' : paths.snapshot(ids[2]),
					cutoff: 110 * DAY_MS,
					retentionMs: 90 * DAY_MS,
					keepLast: 0,
					recent: [
						{
							key: failure === 'foreign recent key' ? unrelated : paths.snapshot(ids[0]),
							uploaded: 0,
							size: 8,
						},
					],
					count: 1,
					bytes: 8,
				};
				const invalid =
					failure === 'invalid JSON'
						? '{invalid'
						: failure === 'schema mismatch'
							? '{}'
							: JSON.stringify(cursor);
				const { etag } = await bucket.put(cursorKey, invalid);
				const list = vi.spyOn(bucket, 'list');
				const del = vi.spyOn(bucket, 'delete');
				const put = vi.spyOn(bucket, 'put');

				expect(await maintenance.expireSnapshots({ keepLast: 0 })).toBe(1);
				expect(list.mock.calls[0][0]?.startAfter).toBeUndefined();
				expect(del).toHaveBeenCalledExactlyOnceWith([paths.snapshot(ids[0])]);
				expect(put).toHaveBeenCalledExactlyOnceWith(cursorKey, expect.any(String), {
					onlyIfEtagMatches: etag,
				});
				expect(await (await bucket.get(unrelated))!.text()).toBe('identity');
				for (const id of ids.slice(1)) expect(await bucket.head(paths.snapshot(id))).not.toBeNull();
				await expect(new MaintenanceService(bucket).expireSnapshots({ keepLast: 0 })).resolves.toBe(
					0,
				);
			},
		);

		it.each(['get', 'body'])(
			'propagates cursor %s failures without restarting cleanup',
			async (failure) => {
				const cursorKey = '_system/snapshot-expiry-cursor.json';
				await bucket.put(cursorKey, '{}');
				const cursor = (await bucket.get(cursorKey))!;
				const error = new Error('storage unavailable');
				const get = vi.spyOn(bucket, 'get');
				if (failure === 'get') get.mockRejectedValueOnce(error);
				else
					get.mockResolvedValueOnce({
						...cursor,
						text: async () => {
							throw error;
						},
						json: async () => {
							throw error;
						},
					} satisfies BucketObjectBody);
				const list = vi.spyOn(bucket, 'list');
				const del = vi.spyOn(bucket, 'delete');
				const put = vi.spyOn(bucket, 'put');
				await expect(maintenance.expireSnapshots()).rejects.toThrow('storage unavailable');
				expect(list).not.toHaveBeenCalled();
				expect(del).not.toHaveBeenCalled();
				expect(put).not.toHaveBeenCalled();
			},
		);

		it('resumes bounded pages after restart, preserves the newest floor and reports complete gauges', async () => {
			const ids = Array.from({ length: 17 }, () => createSnapshotId()).sort();
			for (let i = 0; i < ids.length; i++)
				await putSnapshotAt(ids[i], ((i * 7) % ids.length) * DAY_MS);
			const current = ids[0];
			const previous = ids[1];
			await bucket.put(
				paths.catalog,
				JSON.stringify({ ...makeCatalog(current), previous_snapshot_id: previous }),
			);
			clock.set(200 * DAY_MS);
			const original = (await bucket.list({ prefix: paths.snapshotsPrefix })).objects;
			const newest = [...original]
				.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
				.slice(0, 3);
			const keep = new Set([
				paths.snapshot(current),
				paths.snapshot(previous),
				...newest.map((object) => object.key),
			]);
			const list = vi.spyOn(bucket, 'list');
			const del = vi.spyOn(bucket, 'delete');
			const gauge = vi.fn();
			const metrics = { increment: vi.fn(), gauge };
			let deleted = 0;
			for (let page = 0; page < 6; page++) {
				list.mockClear();
				deleted += await new MaintenanceService(bucket, metrics).expireSnapshots({
					pageSize: 3,
					maxPages: 1,
					keepLast: 3,
				});
				expect(list).toHaveBeenCalledTimes(1);
				expect(list.mock.calls[0][0]).toMatchObject({ limit: 3, prefix: paths.snapshotsPrefix });
				if (page > 0)
					expect(list.mock.calls[0][0]?.startAfter).toBe(paths.snapshot(ids[page * 3 - 1]));
				if (page < 5) expect(gauge).not.toHaveBeenCalled();
			}
			expect(deleted).toBe(ids.length - keep.size);
			expect(
				new Set(
					(await bucket.list({ prefix: paths.snapshotsPrefix })).objects.map(
						(object) => object.key,
					),
				),
			).toEqual(keep);
			expect(gauge).toHaveBeenCalledWith('snapshots.count', keep.size);
			expect(gauge).toHaveBeenCalledWith(
				'snapshots.bytes',
				original
					.filter((object) => keep.has(object.key))
					.reduce((sum, object) => sum + object.size, 0),
			);
			expect(del.mock.calls.every(([keys]) => Array.isArray(keys) && keys.length <= 3)).toBe(true);
		});

		it('rechecks the live pointer when a later page displaces a retained snapshot', async () => {
			const ids = Array.from({ length: 4 }, () => createSnapshotId()).sort();
			for (let i = 0; i < ids.length; i++) await putSnapshotAt(ids[i], i * DAY_MS);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[3])));
			clock.set(200 * DAY_MS);
			const options = { pageSize: 2, maxPages: 1, keepLast: 1 };
			await maintenance.expireSnapshots(options);
			await bucket.put(
				paths.catalog,
				JSON.stringify({ ...makeCatalog(ids[3]), previous_snapshot_id: ids[1] }),
			);
			await new MaintenanceService(bucket).expireSnapshots(options);
			expect(await bucket.head(paths.snapshot(ids[1]))).not.toBeNull();
			expect(await bucket.head(paths.snapshot(ids[3]))).not.toBeNull();
			expect(await bucket.head(paths.snapshot(ids[2]))).toBeNull();
		});

		it('retries a failed page without skipping its expired objects', async () => {
			const ids = Array.from({ length: 5 }, () => createSnapshotId()).sort();
			for (const id of ids) await putSnapshotAt(id, 0);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[4])));
			clock.set(200 * DAY_MS);
			const options = { pageSize: 2, maxPages: 1, keepLast: 0 };
			await maintenance.expireSnapshots(options);
			vi.spyOn(bucket, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));
			await expect(maintenance.expireSnapshots(options)).rejects.toThrow('storage unavailable');
			expect(await maintenance.expireSnapshots(options)).toBe(2);
			expect(await maintenance.expireSnapshots(options)).toBe(0);
			expect(
				(await bucket.list({ prefix: paths.snapshotsPrefix })).objects.map((object) => object.key),
			).toEqual([paths.snapshot(ids[4])]);
		});

		it('returns 0 on an uninitialized bucket', async () => {
			expect(await maintenance.expireSnapshots()).toBe(0);
		});

		it('never deletes the current or previous snapshot, even past retention', async () => {
			const current = createSnapshotId();
			const previous = createSnapshotId();
			const old1 = createSnapshotId();
			const old2 = createSnapshotId();

			for (const id of [old1, old2, previous, current]) await putSnapshotAt(id, 0);
			await bucket.put(
				paths.catalog,
				JSON.stringify({ ...makeCatalog(current), previous_snapshot_id: previous }),
			);

			clock.set(200 * DAY_MS);
			const deleted = await maintenance.expireSnapshots({ retentionMs: 90 * DAY_MS, keepLast: 0 });

			expect(deleted).toBe(2);
			expect(await bucket.get(paths.snapshot(current))).not.toBeNull();
			expect(await bucket.get(paths.snapshot(previous))).not.toBeNull();
			expect(await bucket.get(paths.snapshot(old1))).toBeNull();
			expect(await bucket.get(paths.snapshot(old2))).toBeNull();
		});

		it('keeps the keepLast most recent snapshots regardless of age', async () => {
			// Five snapshots at distinct times; catalog points current at the OLDEST so
			// the floor (keepLast) and the protected pointer are exercised separately.
			const ids = [
				createSnapshotId(),
				createSnapshotId(),
				createSnapshotId(),
				createSnapshotId(),
				createSnapshotId(),
			];
			for (let i = 0; i < ids.length; i++) await putSnapshotAt(ids[i], i * DAY_MS);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(ids[0]))); // current = oldest

			clock.set(200 * DAY_MS);
			// retentionMs 0 → everything is old enough; only the floor + current protect.
			const deleted = await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 2 });

			// Kept: ids[4], ids[3] (floor) + ids[0] (current). Deleted: ids[1], ids[2].
			expect(deleted).toBe(2);
			expect(await bucket.get(paths.snapshot(ids[0]))).not.toBeNull();
			expect(await bucket.get(paths.snapshot(ids[1]))).toBeNull();
			expect(await bucket.get(paths.snapshot(ids[2]))).toBeNull();
			expect(await bucket.get(paths.snapshot(ids[3]))).not.toBeNull();
			expect(await bucket.get(paths.snapshot(ids[4]))).not.toBeNull();
		});

		it('prunes nothing when the snapshot count is within keepLast', async () => {
			const a = createSnapshotId();
			const b = createSnapshotId();
			await putSnapshotAt(a, 0);
			await putSnapshotAt(b, DAY_MS);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(b)));

			clock.set(500 * DAY_MS);
			expect(await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 20 })).toBe(0);
		});

		it('does not delete anything when catalog.json is corrupt', async () => {
			const old1 = createSnapshotId();
			const old2 = createSnapshotId();
			await putSnapshotAt(old1, 0);
			await putSnapshotAt(old2, 0);
			await bucket.put(paths.catalog, JSON.stringify({ not: 'a catalog' }));
			const delSpy = vi.spyOn(bucket, 'delete');

			clock.set(500 * DAY_MS);
			// The corrupt catalog means current/previous can't be identified, so
			// nothing may be deleted (else the live pointer could be orphaned).
			await maintenance.expireSnapshots({ retentionMs: 0, keepLast: 0 }).catch(() => {});

			expect(delSpy).not.toHaveBeenCalled();
			expect(await bucket.get(paths.snapshot(old1))).not.toBeNull();
			expect(await bucket.get(paths.snapshot(old2))).not.toBeNull();
		});

		it('protects current/previous even when outside keepLast AND older than retention', async () => {
			const previous = createSnapshotId();
			const current = createSnapshotId();
			const newer1 = createSnapshotId();
			const newer2 = createSnapshotId();
			// current/previous are the OLDEST — outside a keepLast floor and past retention.
			await putSnapshotAt(previous, 0);
			await putSnapshotAt(current, 1 * DAY_MS);
			await putSnapshotAt(newer1, 10 * DAY_MS);
			await putSnapshotAt(newer2, 11 * DAY_MS);
			await bucket.put(
				paths.catalog,
				JSON.stringify({ ...makeCatalog(current), previous_snapshot_id: previous }),
			);

			clock.set(500 * DAY_MS);
			await maintenance.expireSnapshots({ retentionMs: 90 * DAY_MS, keepLast: 2 });

			expect(await bucket.get(paths.snapshot(current))).not.toBeNull();
			expect(await bucket.get(paths.snapshot(previous))).not.toBeNull();
		});

		it('emits snapshot count/size gauges', async () => {
			const gauge = vi.fn();
			const svc = new MaintenanceService(bucket, { increment: vi.fn(), gauge });
			const current = createSnapshotId();
			await putSnapshotAt(current, 0);
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(current)));

			await svc.expireSnapshots();

			expect(gauge).toHaveBeenCalledWith('snapshots.count', 1);
			expect(gauge.mock.calls.some(([name]) => name === 'snapshots.bytes')).toBe(true);
		});
	});

	describe('pruneEvents', () => {
		it('deletes old day folders across every listing page', async () => {
			clock.set(Date.parse('2025-06-17T00:00:00.000Z'));
			for (let day = 1; day <= 5; day++) {
				await bucket.put(paths.event(`2020-01-0${day}`, 'e1'), '{}');
			}
			const originalList = bucket.list.bind(bucket);
			bucket.list = (options) => originalList({ ...options, limit: 2 });

			const deleted = await maintenance.pruneEvents({ retentionMs: 90 * DAY_MS });

			expect(deleted).toBe(5);
			for (let day = 1; day <= 5; day++) {
				expect(await bucket.get(paths.event(`2020-01-0${day}`, 'e1'))).toBeNull();
			}
		});

		it('deletes day folders past retention and keeps recent ones', async () => {
			clock.set(Date.parse('2025-06-17T00:00:00.000Z'));
			await bucket.put(paths.event('2020-01-01', 'e1'), '{}');
			await bucket.put(paths.event('2020-01-01', 'e2'), '{}');
			await bucket.put(paths.event('2025-06-16', 'e3'), '{}');

			const deleted = await maintenance.pruneEvents({ retentionMs: 90 * DAY_MS });

			expect(deleted).toBe(2);
			expect(await bucket.get(paths.event('2020-01-01', 'e1'))).toBeNull();
			expect(await bucket.get(paths.event('2020-01-01', 'e2'))).toBeNull();
			expect(await bucket.get(paths.event('2025-06-16', 'e3'))).not.toBeNull();
		});

		it('returns 0 when there are no events', async () => {
			expect(await maintenance.pruneEvents()).toBe(0);
		});

		it('skips a non-date folder under the events prefix', async () => {
			clock.set(Date.parse('2025-06-17T00:00:00.000Z'));
			await bucket.put(paths.event('2020-01-01', 'e1'), '{}'); // old day → pruned
			await bucket.put('_system/events/not-a-date/x.json', '{}'); // not a date folder

			const deleted = await maintenance.pruneEvents({ retentionMs: 90 * DAY_MS });

			expect(deleted).toBe(1); // only the old day folder
			expect(await bucket.get('_system/events/not-a-date/x.json')).not.toBeNull();
		});

		it('keeps a day folder whose end is exactly at the retention boundary', async () => {
			// Choose `now` so cutoff (now - retention) lands exactly on the day's end.
			// The documented rule keeps a day "until the end predates the cutoff"; at
			// end === cutoff the end does not predate, so the folder must survive.
			const retentionMs = 90 * DAY_MS;
			const dayEnd = Date.parse('2020-01-02T00:00:00.000Z');
			clock.set(dayEnd + retentionMs); // cutoff === dayEnd
			await bucket.put(paths.event('2020-01-01', 'e1'), '{}');

			const deleted = await maintenance.pruneEvents({ retentionMs });

			expect(deleted).toBe(0);
			expect(await bucket.get(paths.event('2020-01-01', 'e1'))).not.toBeNull();
		});
	});
});

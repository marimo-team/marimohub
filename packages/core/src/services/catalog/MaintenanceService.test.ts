import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryBucket, makeSnapshot, makeCatalog, useFakeClock } from '../../testing';
import { createSnapshotId } from '../../ids';
import type { SnapshotId } from '../../ids';
import { paths } from '../../paths';
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

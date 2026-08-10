import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { CatalogSchema, readStored } from '../../schema';
import { listAllObjects, listAllPrefixes } from './storage';

// Every commit writes a new catalog snapshot; at ~20 writes/day that is
// thousands of accumulating objects per year. The event log grows the same way
// (one immutable object per event). Both need their own expiry — the analogue of
// Iceberg's snapshot-expiry maintenance — or the bucket grows without bound and
// every prefix scan gets slower. Session reaping lives in SessionService; this
// service owns the snapshot and event side.

const DAY_MS = Millis.days(1);
const DEFAULT_SNAPSHOT_RETENTION_MS = Millis.days(90);
const DEFAULT_EVENT_RETENTION_MS = Millis.days(90);
/**
 * Floor: always keep at least the N most-recently-written snapshots regardless
 * of age, so a quiet period never prunes the recent history a rollback needs.
 */
const DEFAULT_KEEP_LAST = 20;

export interface ExpireSnapshotsOptions {
	retentionMs?: number;
	keepLast?: number;
}

export interface PruneEventsOptions {
	retentionMs?: number;
}

export class MaintenanceService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	/**
	 * Delete immutable index snapshots older than the retention window, keeping a
	 * floor of the most recent `keepLast`.
	 *
	 * INVARIANT (corruption safety): the snapshot named by `catalog.json`
	 * (current) and its `previous_snapshot_id` are NEVER candidates for deletion,
	 * so retention can never orphan the live pointer. Snapshot IDs are random
	 * (`snap-…`), not time-sortable, so recency is taken from each object's
	 * `uploaded` timestamp — never from key ordering.
	 */
	async expireSnapshots(opts?: ExpireSnapshotsOptions): Promise<number> {
		const retentionMs = opts?.retentionMs ?? DEFAULT_SNAPSHOT_RETENTION_MS;
		const keepLast = opts?.keepLast ?? DEFAULT_KEEP_LAST;

		const catalogObj = await this.bucket.get(paths.catalog);
		if (!catalogObj) return 0; // uninitialized — nothing to prune

		const catalog = await readStored(CatalogSchema, catalogObj, paths.catalog);
		const protectedKeys = new Set<string>([paths.snapshot(catalog.current_snapshot_id)]);
		if (catalog.previous_snapshot_id) {
			protectedKeys.add(paths.snapshot(catalog.previous_snapshot_id));
		}

		const objects = await listAllObjects(this.bucket, paths.snapshotsPrefix);
		// Newest first so the keepLast floor protects the most recent snapshots.
		const byRecency = [...objects].sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());

		const now = Date.now();
		const toDelete: string[] = [];
		byRecency.forEach((obj, index) => {
			if (index < keepLast) return; // within the keep-last floor
			if (protectedKeys.has(obj.key)) return; // current/previous — never delete
			if (now - obj.uploaded.getTime() > retentionMs) toDelete.push(obj.key);
		});

		if (toDelete.length > 0) {
			await this.bucket.delete(toDelete);
			this.metrics.increment('maintenance.snapshots_pruned', toDelete.length);
		}

		// Gauge the post-prune state so an operator can watch growth over time.
		const remaining = objects.length - toDelete.length;
		const deleted = new Set(toDelete);
		const remainingBytes = byRecency
			.filter((o) => !deleted.has(o.key))
			.reduce((sum, o) => sum + o.size, 0);
		this.metrics.gauge('snapshots.count', remaining);
		this.metrics.gauge('snapshots.bytes', remainingBytes);

		return toDelete.length;
	}

	/**
	 * Delete whole event-day folders older than the retention window. Events are
	 * immutable, keyed under a per-day prefix (`_system/events/YYYY-MM-DD/`), so a
	 * day folder is pruned in one shot once its calendar day predates the cutoff.
	 */
	async pruneEvents(opts?: PruneEventsOptions): Promise<number> {
		const retentionMs = opts?.retentionMs ?? DEFAULT_EVENT_RETENTION_MS;
		const cutoff = Date.now() - retentionMs;

		const delimitedPrefixes = await listAllPrefixes(this.bucket, paths.eventsPrefix);

		let deleted = 0;
		for (const dayPrefix of delimitedPrefixes) {
			// dayPrefix is `_system/events/YYYY-MM-DD/`.
			const dateStr = dayPrefix.slice(paths.eventsPrefix.length).replace(/\/$/, '');
			const dayStart = Date.parse(`${dateStr}T00:00:00.000Z`);
			if (Number.isNaN(dayStart)) continue; // not a date folder — leave it alone
			// Keep the whole day until the end of that day predates the cutoff. "Predates"
			// is strictly-before, so a day whose end lands exactly on the cutoff is kept.
			if (dayStart + DAY_MS >= cutoff) continue;

			const dayObjects = await listAllObjects(this.bucket, dayPrefix);
			if (dayObjects.length === 0) continue;
			await this.bucket.delete(dayObjects.map((o) => o.key));
			deleted += dayObjects.length;
		}

		if (deleted > 0) this.metrics.increment('maintenance.events_pruned', deleted);
		return deleted;
	}
}

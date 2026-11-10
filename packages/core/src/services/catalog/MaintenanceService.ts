import { z } from 'zod';
import { PreconditionFailedError } from '../../errors';
import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { CatalogSchema, readStored } from '../../schema';
import { listAllObjects, listAllPrefixes } from './storage';

const DAY_MS = Millis.days(1);
const DEFAULT_SNAPSHOT_RETENTION_MS = Millis.days(90);
const DEFAULT_EVENT_RETENTION_MS = Millis.days(90);
/**
 * Floor: always keep at least the N most-recently-written snapshots regardless
 * of age, so a quiet period never prunes the recent history a rollback needs.
 */
const DEFAULT_KEEP_LAST = 20;

const SNAPSHOT_CURSOR_KEY = '_system/snapshot-expiry-cursor.json';
const SnapshotExpiryCursorSchema = z.object({
	after: z.string().optional(),
	cutoff: z.number(),
	retentionMs: z.number().nonnegative(),
	keepLast: z.number().int().nonnegative(),
	recent: z.array(z.object({ key: z.string(), uploaded: z.number(), size: z.number() })),
	count: z.number().int().nonnegative(),
	bytes: z.number().nonnegative(),
});

export interface ExpireSnapshotsOptions {
	pageSize?: number;
	maxPages?: number;
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
		const pageSize = opts?.pageSize ?? 500;
		const maxPages = opts?.maxPages ?? 10;
		if (
			!Number.isFinite(retentionMs) ||
			retentionMs < 0 ||
			!Number.isInteger(keepLast) ||
			keepLast < 0
		)
			throw new RangeError('Snapshot retention and keepLast must be nonnegative');
		if (![pageSize, maxPages].every((value) => Number.isInteger(value) && value > 0))
			throw new RangeError('Snapshot pageSize and maxPages must be positive integers');

		const cursorObject = await this.bucket.get(SNAPSHOT_CURSOR_KEY);
		let cursorEtag = cursorObject?.etag;
		let cursor: z.infer<typeof SnapshotExpiryCursorSchema> | undefined = cursorObject
			? await readStored(SnapshotExpiryCursorSchema, cursorObject, SNAPSHOT_CURSOR_KEY)
			: undefined;
		if (!cursor?.after || cursor.retentionMs !== retentionMs || cursor.keepLast !== keepLast) {
			cursor = {
				cutoff: Date.now() - retentionMs,
				retentionMs,
				keepLast,
				recent: [],
				count: 0,
				bytes: 0,
			};
		}

		let deleted = 0;
		for (let page = 0; page < maxPages; page++) {
			const catalogObj = await this.bucket.get(paths.catalog);
			if (!catalogObj) return deleted;
			const catalog = await readStored(CatalogSchema, catalogObj, paths.catalog);
			const protectedKeys = new Set([paths.snapshot(catalog.current_snapshot_id)]);
			if (catalog.previous_snapshot_id)
				protectedKeys.add(paths.snapshot(catalog.previous_snapshot_id));
			const listing = await this.bucket.list({
				prefix: paths.snapshotsPrefix,
				startAfter: cursor.after,
				limit: pageSize,
			});
			const objects = listing.objects.map((object) => ({
				key: object.key,
				uploaded: object.uploaded.getTime(),
				size: object.size,
			}));
			const candidates = [...cursor.recent, ...objects].sort(
				(a, b) => b.uploaded - a.uploaded || a.key.localeCompare(b.key),
			);
			// Anything displaced from this prefix's newest N cannot be in the full scan's newest N.
			const cutoff: number = cursor.cutoff;
			const expired = candidates
				.slice(keepLast)
				.filter((object) => object.uploaded < cutoff && !protectedKeys.has(object.key));
			if (expired.length > 0) {
				await this.bucket.delete(expired.map((object) => object.key));
				deleted += expired.length;
				this.metrics.increment('maintenance.snapshots_pruned', expired.length);
			}
			cursor = {
				...cursor,
				after: listing.truncated ? objects.at(-1)!.key : undefined,
				recent: candidates.slice(0, keepLast),
				count: cursor.count + objects.length - expired.length,
				bytes:
					cursor.bytes +
					objects.reduce((sum, object) => sum + object.size, 0) -
					expired.reduce((sum, object) => sum + object.size, 0),
			};
			try {
				const written = await this.bucket.put(
					SNAPSHOT_CURSOR_KEY,
					JSON.stringify(cursor),
					cursorEtag ? { onlyIfEtagMatches: cursorEtag } : { onlyIfNotExists: true },
				);
				cursorEtag = written.etag;
			} catch (error) {
				if (error instanceof PreconditionFailedError) return deleted;
				throw error;
			}
			if (!listing.truncated) {
				// A completed scan is an estimate when writers are active; partial scans are never gauges.
				this.metrics.gauge('snapshots.count', cursor.count);
				this.metrics.gauge('snapshots.bytes', cursor.bytes);
				break;
			}
		}
		return deleted;
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

import os from 'node:os';
import type { ApiDeps } from '@marimo-hub/api';
import { MaintenanceLock, ReconciliationService } from '@marimo-hub/core';
import { logEvent } from './log';
import type { WideEventMetrics } from './metrics';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Node-side maintenance loop — the replacement for the Cloudflare Workers
 * `scheduled()` cron. Each run, in order:
 *  1. `expireStale()`     — flip sessions with stale heartbeats to `expired`.
 *  2. `reconcile()`       — cross-check records against the compute provider:
 *     tear down sandboxes left running by terminal records (the billing leak),
 *     mark records whose sandbox has vanished as terminated, reap orphans.
 *  3. `reapTerminated()`  — delete terminal records past their retention window.
 *  4. `expireSnapshots()` — prune catalog snapshots past retention (keeping
 *     current/previous + a recent floor) so the bucket doesn't grow unbounded.
 *  5. `pruneEvents()`     — drop event-day folders past retention.
 *
 * All operations are idempotent. The deployment runs this on a single replica
 * (a dedicated `replicas: 1` Deployment, gated by MARIMOHUB_RUN_MAINTENANCE),
 * and the bucket-CAS advisory lease below is defense-in-depth: if two replicas
 * ever run it, only the lease holder sweeps, so deletes never race. Each cycle
 * emits one wide event (`maintenance_cycle`) carrying this-cycle counts plus the
 * cumulative metric totals/gauges an operator needs.
 */
export function startMaintenance(deps: ApiDeps, metrics: WideEventMetrics): () => void {
	const { sessions, maintenance } = deps.services;
	const reconciler = new ReconciliationService(sessions, deps.compute, deps.bucket);
	const lock = new MaintenanceLock(deps.bucket);
	const holder = `${os.hostname()}:${process.pid}`;

	const run = async () => {
		// Defense-in-depth: only the lease holder sweeps. Skip quietly otherwise.
		if (!(await lock.acquire(holder).catch(() => false))) {
			logEvent({ level: 'debug', event: 'maintenance_skipped_not_leader', holder });
			return;
		}
		try {
			const sessionsExpired = await sessions.expireStale();
			const reconcile = await reconciler.reconcile();
			if (!reconcile.skipped && reconcile.orphanSandboxIds.length > 0) {
				logEvent({
					level: 'warn',
					event: 'orphan_sandboxes_reaped',
					count: reconcile.orphansReaped,
					sandbox_ids: reconcile.orphanSandboxIds.join(','),
				});
			}
			const sessionsReaped = await sessions.reapTerminated();
			const snapshotsPruned = await maintenance.expireSnapshots();
			const eventsPruned = await maintenance.pruneEvents();

			logEvent({
				level: 'info',
				event: 'maintenance_cycle',
				holder,
				sessions_expired: sessionsExpired,
				sessions_reaped: sessionsReaped,
				snapshots_pruned: snapshotsPruned,
				events_pruned: eventsPruned,
				orphans_reaped: reconcile.skipped ? null : reconcile.orphansReaped,
				...metrics.collect(),
			});
		} catch (err) {
			logEvent({
				level: 'error',
				event: 'maintenance_failed',
				error: err instanceof Error ? err.message : String(err),
				name: err instanceof Error ? err.name : undefined,
			});
		} finally {
			await lock.release(holder).catch(() => { });
		}
	};
	void run();
	const handle = setInterval(() => void run(), FIVE_MINUTES_MS);
	return () => clearInterval(handle);
}

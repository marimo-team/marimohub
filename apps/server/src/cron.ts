import os from 'node:os';
import { scheduleProjectAlert } from '@marimo-hub/api';
import type { ApiDeps } from '@marimo-hub/api';
import {
	MaintenanceLock,
	Millis,
	notificationRouter,
	paths,
	reapFilesystemSnapshots,
	ReconciliationService,
	sessionModePolicy,
	SessionLifecycleService,
} from '@marimo-hub/core';
import { logEvent } from './log';
import type { WideEventMetrics } from './metrics';

const FIVE_MINUTES_MS = Millis.minutes(5);

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
 *  6. `sweepDeletedProjects()` / `sweepDeletedNotebooks()` — purge the storage of
 *     soft-deleted projects/notebooks past their grace period. Projects first, so
 *     a deleted project's notebooks are reclaimed by the project subtree wipe.
 *
 * All operations are idempotent. The deployment runs this on a single replica
 * (a dedicated `replicas: 1` Deployment, gated by MARIMOHUB_RUN_MAINTENANCE),
 * and the bucket-CAS advisory lease below is defense-in-depth: if two replicas
 * ever run it, only the lease holder sweeps, so deletes never race. Each cycle
 * emits one wide event (`maintenance_cycle`) carrying this-cycle counts plus the
 * cumulative metric totals/gauges an operator needs.
 */
export function startMaintenance(deps: ApiDeps, metrics: WideEventMetrics): () => void {
	const { sessions, maintenance, projects, notebooks, idempotency } = deps.services;
	const reconciler = new ReconciliationService(
		sessions,
		notebooks,
		deps.compute,
		deps.bucket,
		deps.sandbox.persistWorkspace,
		deps.sandbox.workdir,
	);
	const lock = new MaintenanceLock(deps.bucket);
	const holder = `${os.hostname()}:${process.pid}`;

	// In-flight guard (same hazard as startSessionLifecycle): a cycle that outlives
	// the 5-minute interval must not overlap the next tick — the lease would happily
	// renew for the same holder, and the first finisher's release would drop it
	// mid-run for the second.
	let running = false;
	const run = async () => {
		if (running) {
			logEvent({ level: 'debug', event: 'maintenance_cycle_overlap_skipped', holder });
			return;
		}
		running = true;
		try {
			// Defense-in-depth: only the lease holder sweeps. Skip quietly otherwise.
			if (!(await lock.acquire(holder).catch(() => false))) {
				logEvent({ level: 'debug', event: 'maintenance_skipped_not_leader', holder });
				return;
			}
			try {
				const sessionsExpired = await sessions.expireStale();
				const reconcile = await reconciler.reconcile();
				for (const session of reconcile.markedDeadSessions) {
					if (session.status !== 'running' || !sessionModePolicy(session).singleton) continue;
					const [project, notebook] = await Promise.all([
						projects.getProject(session.project_id).catch(() => null),
						notebooks.getNotebook(session.project_id, session.notebook_id).catch(() => null),
					]);
					if (!project || !notebook) continue;
					scheduleProjectAlert(
						deps,
						session.project_id,
						'app.unavailable',
						{
							project_id: session.project_id,
							notebook_id: session.notebook_id,
							session_id: session.session_id,
						},
						() =>
							notificationRouter.render({
								kind: 'app.unavailable',
								project,
								notebookId: session.notebook_id,
								notebookTitle: notebook.meta.title,
								sessionId: session.session_id,
								startedByUserId: session.user_id,
								errorCode: 'SANDBOX_DISAPPEARED',
								baseUrl: deps.sandbox.appBaseUrl,
							}),
					);
				}
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
				const idempotencyPruned = await idempotency.prune();
				// Projects before notebooks: a swept project wipes its whole subtree, so
				// its soft-deleted notebooks are reclaimed without per-notebook work.
				const projectsSwept = await projects.sweepDeletedProjects();
				const notebooksSwept = await notebooks.sweepDeletedNotebooks();

				// The purged notebooks' snapshot ids live in CoreWeave, not the bucket, so
				// the subtree wipe above can't free them — reclaim them here.
				const snapshotsReaped = await reapFilesystemSnapshots(
					deps.compute,
					notebooksSwept.orphanedSnapshots,
				);

				logEvent({
					level: 'info',
					event: 'maintenance_cycle',
					holder,
					sessions_expired: sessionsExpired,
					sessions_reaped: sessionsReaped,
					snapshots_pruned: snapshotsPruned,
					events_pruned: eventsPruned,
					idempotency_pruned: idempotencyPruned,
					projects_swept: projectsSwept,
					notebooks_swept: notebooksSwept.purged,
					snapshots_reaped: snapshotsReaped,
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
				await lock.release(holder).catch(() => {});
			}
		} finally {
			running = false;
		}
	};
	void run();
	const handle = setInterval(() => void run(), FIVE_MINUTES_MS);
	return () => clearInterval(handle);
}

/**
 * Session-lifecycle sweep — a second, faster loop beside `startMaintenance`
 * (same replica, gated by MARIMOHUB_RUN_MAINTENANCE) so the snapshot cadence is
 * not coupled to the heavy 5-minute prune cycle. Each run: gracefully tear down
 * sessions past `expires_at` or idle (extending instead when editors are still
 * connected), reclaim lingering sandboxes of already-`expired` records, and save
 * live notebooks on the periodic snapshot interval. Leader-gated by its own
 * bucket-CAS lease (a separate key from the maintenance lease, so the two loops
 * never release each other's hold).
 */
export function startSessionLifecycle(deps: ApiDeps): (() => void) | undefined {
	const lifetime = deps.sandbox.sessionLifetime;
	if (!lifetime) return undefined;

	const { sessions, notebooks } = deps.services;
	const svc = new SessionLifecycleService(sessions, notebooks, deps.compute, deps.bucket, {
		...lifetime,
		persistWorkspace: deps.sandbox.persistWorkspace,
		workdir: deps.sandbox.workdir,
	});
	const lock = new MaintenanceLock(deps.bucket, paths.sessionLifecycleLock);
	const holder = `${os.hostname()}:${process.pid}`;

	// In-flight guard: a sweep that outlives the interval must not overlap the next
	// tick — the lease would happily renew for the same holder, and the first
	// finisher's release would drop it mid-run for the second.
	let running = false;
	const run = async () => {
		if (running) return;
		running = true;
		try {
			if (!(await lock.acquire(holder).catch(() => false))) return; // not leader
			try {
				const r = await svc.sweep();
				if (Object.values(r).some((n) => n > 0)) {
					logEvent({ level: 'info', event: 'session_lifecycle_sweep', holder, ...r });
				}
			} catch (err) {
				logEvent({
					level: 'error',
					event: 'session_lifecycle_failed',
					error: err instanceof Error ? err.message : String(err),
					name: err instanceof Error ? err.name : undefined,
				});
			} finally {
				await lock.release(holder).catch(() => {});
			}
		} finally {
			running = false;
		}
	};
	void run();
	const handle = setInterval(() => void run(), lifetime.sweepIntervalMs);
	return () => clearInterval(handle);
}

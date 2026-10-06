import {
	resolveJobSandboxEnv,
	scheduleProjectAlert,
	sweepAppPools,
	sweepPreviews,
	preparePreviews,
} from '@marimo-hub/api';
import type { ApiDeps, JobsConfig } from '@marimo-hub/api';
import {
	MaintenanceLock,
	Millis,
	mapWithConcurrency,
	notificationRouter,
	paths,
	reapFilesystemSnapshots,
	ReconciliationService,
	sessionModePolicy,
	SessionLifecycleService,
} from '@marimo-hub/core';
import { JobRunner, JobScheduler } from '@marimo-hub/core/jobs';
import { logEvent } from './log';
import { BackgroundLoops } from './backgroundLoops';
import type { WideEventMetrics } from './metrics';

const FIVE_MINUTES_MS = Millis.minutes(5);
const APP_ALERT_CONTEXT_CONCURRENCY = 8;

async function retryMetadataRead<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch {
		return read();
	}
}

async function scheduleUnavailableAppAlerts(
	deps: ApiDeps,
	sessions: Awaited<ReturnType<ReconciliationService['reconcile']>>['markedDeadSessions'],
): Promise<void> {
	await mapWithConcurrency(sessions, APP_ALERT_CONTEXT_CONCURRENCY, async (session) => {
		if (session.status !== 'running' || !sessionModePolicy(session).sharedApp) return;
		try {
			const [project, notebook] = await Promise.all([
				retryMetadataRead(() => deps.services.projects.getProject(session.project_id)),
				retryMetadataRead(() =>
					deps.services.notebooks.getNotebook(session.project_id, session.notebook_id),
				),
			]);
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
		} catch (error) {
			logEvent({
				level: 'error',
				event: 'app_unavailable_alert_context_failed',
				project_id: session.project_id,
				notebook_id: session.notebook_id,
				session_id: session.session_id,
				name: error instanceof Error ? error.name : undefined,
			});
		}
	});
}

/**
 * Node-side maintenance loop — the replacement for the Cloudflare Workers
 * `scheduled()` cron. Each run, in order:
 *  1. `sweepAppPools()` — reconcile app assignments and retire idle pool members.
 *  2. `sweepPreviews()` — expire previews and reclaim revisions.
 *  3. `expireStale()` — flip sessions with stale heartbeats to `expired`.
 *  4. `reconcile()` — cross-check records against the compute provider:
 *     tear down sandboxes left running by terminal records (the billing leak),
 *     mark records whose sandbox has vanished as terminated, reap orphans.
 *  5. `reapTerminated()` — delete terminal records past their retention window.
 *  6. `expireSnapshots()` — prune catalog snapshots past retention (keeping
 *     current/previous + a recent floor) so the bucket doesn't grow unbounded.
 *  7. `pruneEvents()` / `idempotency.prune()` — drop expired events and request records.
 *  8. `pruneExpiredPayloads()` — delete expired proposal change bytes while
 *     retaining proposal and publication metadata.
 *  9. `claimPendingInvites()` — replace resolvable email invites with user ids.
 * 10. `sweepDeletedProjects()` / `sweepDeletedNotebooks()` — purge the storage of
 *     soft-deleted projects/notebooks past their grace period. Projects first, so
 *     a deleted project's notebooks are reclaimed by the project subtree wipe.
 * 11. `jobs.prune()` — prune retained job runs and their maintenance markers.
 * 12. `reapFilesystemSnapshots()` — reclaim snapshots orphaned by notebook deletion.
 *
 * All operations are idempotent. The deployment runs this on a single replica
 * (a dedicated `replicas: 1` Deployment, gated by MARIMOHUB_RUN_MAINTENANCE),
 * and the bucket-CAS advisory lease below is defense-in-depth: if two replicas
 * ever run it, only the lease holder sweeps, so deletes never race. Each cycle
 * emits one wide event (`maintenance_cycle`) carrying this-cycle counts plus the
 * cumulative metric totals/gauges an operator needs.
 */
export function startMaintenance(
	deps: ApiDeps,
	metrics: WideEventMetrics,
	loops = new BackgroundLoops(),
): () => void {
	const { sessions, maintenance, projects, notebooks, proposals, idempotency } = deps.services;
	const reconciler = new ReconciliationService(
		sessions,
		notebooks,
		deps.compute,
		deps.bucket,
		deps.sandbox.persistWorkspace,
		deps.sandbox.workdir,
		// Job sandboxes have no session record; without this Rule 3 would reap them.
		deps.services.jobRuns,
		{
			automaticThumbnails: deps.sandbox.automaticThumbnails,
			thumbnailDeadline: deps.sandbox.thumbnailDeadline,
		},
	);
	const jobs = deps.jobs ? createJobScheduler(deps, metrics, deps.jobs) : undefined;
	const lock = new MaintenanceLock(deps.bucket);
	return loops.start({
		name: 'maintenance',
		intervalMs: FIVE_MINUTES_MS,
		lock,
		overlapEvent: 'maintenance_cycle_overlap_skipped',
		notLeaderEvent: 'maintenance_skipped_not_leader',
		run: async ({ holder, step }) => {
			await step(() => sweepAppPools(deps));
			await step(() => sweepPreviews(deps));
			const sessionsExpired = await step(() => sessions.expireStale());
			const reconcile = await step(() => reconciler.reconcile());
			await step(() => scheduleUnavailableAppAlerts(deps, reconcile.markedDeadSessions));
			if (!reconcile.skipped && reconcile.orphanSandboxIds.length > 0) {
				logEvent({
					level: 'warn',
					event: 'orphan_sandboxes_reaped',
					count: reconcile.orphansReaped,
					sandbox_ids: reconcile.orphanSandboxIds.join(','),
				});
			}
			const sessionsReaped = await step(() => sessions.reapTerminated());
			const snapshotsPruned = await step(() => maintenance.expireSnapshots());
			const eventsPruned = await step(() => maintenance.pruneEvents());
			const idempotencyPruned = await step(() => idempotency.prune());
			const proposalPayloadsPruned = await step(() => proposals.pruneExpiredPayloads());
			const inviteRowsClaimed = await step(() => projects.claimPendingInvites());
			// Projects before notebooks: a swept project wipes its whole subtree, so
			// its soft-deleted notebooks are reclaimed without per-notebook work.
			const projectsSwept = await step(() => projects.sweepDeletedProjects());
			const notebooksSwept = await step(() => notebooks.sweepDeletedNotebooks());
			const jobsPruned = jobs
				? await step(() => jobs.prune(deps.jobs!.runRetentionMs))
				: { runsPruned: 0, markersPruned: 0 };

			// The purged notebooks' snapshot ids live in CoreWeave, not the bucket, so
			// the subtree wipe above can't free them — reclaim them here.
			const snapshotsReaped = await step(() =>
				reapFilesystemSnapshots(deps.compute, notebooksSwept.orphanedSnapshots),
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
				proposal_payloads_pruned: proposalPayloadsPruned,
				invite_rows_claimed: inviteRowsClaimed,
				projects_swept: projectsSwept,
				notebooks_swept: notebooksSwept.purged,
				job_runs_pruned: jobsPruned.runsPruned,
				job_run_markers_pruned: jobsPruned.markersPruned,
				snapshots_reaped: snapshotsReaped,
				orphans_reaped: reconcile.skipped ? null : reconcile.orphansReaped,
				...metrics.collect(),
				...loops.collect(),
			});
		},
	}).stop;
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
export function startSessionLifecycle(
	deps: ApiDeps,
	loops = new BackgroundLoops(),
): (() => void) | undefined {
	const lifetime = deps.sandbox.sessionLifetime;
	if (!lifetime) return undefined;

	const { sessions, notebooks } = deps.services;
	const svc = new SessionLifecycleService(sessions, notebooks, deps.compute, deps.bucket, {
		...lifetime,
		persistWorkspace: deps.sandbox.persistWorkspace,
		automaticThumbnails: deps.sandbox.automaticThumbnails,
		thumbnailDeadline: deps.sandbox.thumbnailDeadline,
		workdir: deps.sandbox.workdir,
	});
	const lock = new MaintenanceLock(deps.bucket, paths.sessionLifecycleLock);
	return loops.start({
		name: 'session_lifecycle',
		intervalMs: lifetime.sweepIntervalMs,
		lock,
		run: async ({ holder, step }) => {
			await step(() => sweepAppPools(deps));
			const r = await step(() => svc.sweep());
			if (Object.values(r).some((n) => n > 0)) {
				logEvent({ level: 'info', event: 'session_lifecycle_sweep', holder, ...r });
			}
		},
	}).stop;
}

function createJobScheduler(
	deps: ApiDeps,
	metrics: WideEventMetrics,
	config: JobsConfig,
): JobScheduler {
	const runner = new JobRunner({
		bucket: deps.bucket,
		compute: deps.compute,
		notebooks: deps.services.notebooks,
		projects: deps.services.projects,
		jobs: deps.services.jobs,
		runs: deps.services.jobRuns,
		sandbox: {
			bucket: deps.sandbox.bucket,
			workdir: deps.sandbox.workdir,
			startupTimeoutMs: deps.sandbox.startupTimeoutMs,
			images: deps.sandbox.images,
			resources: deps.sandbox.resources,
			computeProfile: deps.sandbox.computeProfile,
			computeProfiles: deps.sandbox.computeProfiles,
			computeProfileOverride: deps.sandbox.computeProfileOverride,
		},
		resolveSessionEnv: (context) => resolveJobSandboxEnv(deps, context),
		metrics,
	});
	return new JobScheduler({
		catalog: deps.services.catalog,
		jobs: deps.services.jobs,
		runs: deps.services.jobRuns,
		runner,
		compute: deps.compute,
		notebooks: deps.services.notebooks,
		projects: deps.services.projects,
		events: deps.services.events,
		projectAlerts: deps.projectAlerts?.dispatcher,
		appBaseUrl: deps.sandbox.appBaseUrl,
		config: {
			catchupWindowMs: config.catchupWindowMs,
			maxConcurrentRuns: config.maxConcurrentRuns,
			maxConcurrentRunsPerProject: config.maxConcurrentRunsPerProject,
			defaultTimeoutMs: config.defaultTimeoutMs,
			maxTimeoutMs: config.maxTimeoutMs,
		},
		metrics,
	});
}

export interface JobSchedulerHandle {
	/** Cancel future ticks. */
	stop(): void;
	/** Await the current tick, then every run this process started. */
	drain(): Promise<void>;
}

/**
 * Job scheduler tick — a third loop beside `startMaintenance` and
 * `startSessionLifecycle` (same replica, same gate), on its own interval
 * (MARIMOHUB_JOBS_TICK_SECONDS) and its own lease key. Each tick fires due
 * occurrences, dispatches queued runs under the concurrency caps, and reclaims
 * runs past their deadline; the executions themselves run in this process
 * between ticks. Without a maintenance replica jobs are accepted but never
 * dispatched — see docs/jobs.md.
 */
export function startJobScheduler(
	deps: ApiDeps,
	metrics: WideEventMetrics,
	loops = new BackgroundLoops(),
): JobSchedulerHandle {
	if (!deps.jobs) throw new Error('startJobScheduler: notebook jobs are off (MARIMOHUB_JOBS)');
	const scheduler = createJobScheduler(deps, metrics, deps.jobs);
	const tickMs = deps.jobs.tickMs;
	const lock = new MaintenanceLock(deps.bucket, paths.jobSchedulerLock);
	const loop = loops.start({
		name: 'job_scheduler',
		intervalMs: tickMs,
		lock,
		run: async ({ holder, step }) => {
			const r = await step(() => scheduler.tick());
			if (Object.values(r).some((n) => n > 0) || scheduler.inFlightCount > 0) {
				logEvent({
					level: 'info',
					event: 'job_scheduler_tick',
					holder,
					...r,
					in_flight: scheduler.inFlightCount,
				});
			}
		},
	});
	return {
		stop: loop.stop,
		drain: async () => {
			await loop.drain();
			await scheduler.drain();
		},
	};
}

export function startWarmPools(
	deps: ApiDeps,
	loops = new BackgroundLoops(),
): JobSchedulerHandle | undefined {
	const service = deps.warmPool;
	if (!service) return;
	return loops.start({
		name: 'warm_pool',
		failureEvent: 'warm_pool_sweep_failed',
		// Late creates can publish cleanup records after an empty disabled sweep.
		intervalMs: service.config.enabled ? 5_000 : FIVE_MINUTES_MS,
		lock: new MaintenanceLock(deps.bucket, paths.warmPoolLock),
		shouldRun: async () =>
			service.config.enabled || (await service.store.ownedSandboxIds()).size > 0,
		run: async ({ step }) => {
			await step(() => service.sweep());
		},
	});
}

export function startPreviewPreparation(
	deps: ApiDeps,
	loops = new BackgroundLoops(),
): (() => void) | undefined {
	if (!deps.sourceControl) return;
	return loops.start({
		name: 'preview_preparation',
		abortOnStop: true,
		intervalMs: 15_000,
		run: async ({ signal }) => {
			await preparePreviews(deps, signal);
		},
	}).stop;
}

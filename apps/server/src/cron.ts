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
	traced,
} from '@marimo-hub/core';
import { JobRunner, JobScheduler } from '@marimo-hub/core/jobs';
import { logEvent } from './log';
import { BackgroundLoops } from './backgroundLoops';
import type { WideEventMetrics } from './metrics';

const FIVE_MINUTES_MS = Millis.minutes(5);
const APP_ALERT_CONTEXT_CONCURRENCY = 8;

function maintenanceLock(deps: ApiDeps, key: string = paths.maintenanceLock): MaintenanceLock {
	const attributes = () => ({ 'marimohub.lock.key': key });
	return traced('MaintenanceLock', new MaintenanceLock(deps.bucket, key), {
		acquire: attributes,
		release: attributes,
	});
}

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
 * Run on the dedicated maintenance replica; the bucket lease guards against
 * accidental duplicate replicas. Each cycle emits counts and loop heartbeats.
 */
export function startMaintenance(
	deps: ApiDeps,
	metrics: WideEventMetrics,
	loops = new BackgroundLoops(),
): () => void {
	const maintenanceSteps = traced('Maintenance', { sweepAppPools });
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
	const lock = maintenanceLock(deps);
	return loops.start({
		name: 'maintenance',
		intervalMs: FIVE_MINUTES_MS,
		lock,
		overlapEvent: 'maintenance_cycle_overlap_skipped',
		notLeaderEvent: 'maintenance_skipped_not_leader',
		run: async ({ holder, step }) => {
			await step(() => maintenanceSteps.sweepAppPools(deps));
			await step(() => sweepPreviews(deps));
			const sessionsExpired = await step(() => sessions.expireStale());
			const reconcile = await step(() => reconciler.reconcile());
			const domainMetrics = deps.metrics ?? metrics;
			domainMetrics.gauge('sessions.unreclaimed_terminal', reconcile.unreclaimedTerminal);
			domainMetrics.gauge(
				'sessions.unreclaimed_terminal.oldest_age_ms',
				reconcile.oldestUnreclaimedAgeMs ?? 0,
			);
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

			return {
				holder,
				sessions_expired: sessionsExpired,
				sessions_reaped: sessionsReaped,
				sessions_reclaimed: reconcile.reclaimed,
				unreclaimed_terminal_sessions: reconcile.unreclaimedTerminal,
				oldest_unreclaimed_session_age_ms: reconcile.oldestUnreclaimedAgeMs,
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
			};
		},
		onSuccess: (counts) => {
			logEvent({
				level: 'info',
				event: 'maintenance_cycle',
				...counts,
				...metrics.collect(),
				...loops.collect(),
			});
		},
	}).stop;
}

/**
 * Keep session teardown and snapshot cadence independent of the heavier prune
 * cycle. A separate lease lets both loops run on the maintenance replica.
 */
export function startSessionLifecycle(
	deps: ApiDeps,
	loops = new BackgroundLoops(),
): (() => void) | undefined {
	const lifetime = deps.sandbox.sessionLifetime;
	if (!lifetime) return undefined;

	const maintenanceSteps = traced('Maintenance', { sweepAppPools });
	const { sessions, notebooks } = deps.services;
	const svc = new SessionLifecycleService(sessions, notebooks, deps.compute, deps.bucket, {
		...lifetime,
		persistWorkspace: deps.sandbox.persistWorkspace,
		automaticThumbnails: deps.sandbox.automaticThumbnails,
		thumbnailDeadline: deps.sandbox.thumbnailDeadline,
		workdir: deps.sandbox.workdir,
	});
	const lock = maintenanceLock(deps, paths.sessionLifecycleLock);
	return loops.start({
		name: 'session_lifecycle',
		intervalMs: lifetime.sweepIntervalMs,
		lock,
		run: async ({ holder, step }) => {
			await step(() => maintenanceSteps.sweepAppPools(deps));
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
 * Job executions continue between ticks. Shutdown drains the current tick before
 * those executions so it also waits for jobs dispatched by that tick.
 */
export function startJobScheduler(
	deps: ApiDeps,
	metrics: WideEventMetrics,
	loops = new BackgroundLoops(),
): JobSchedulerHandle {
	if (!deps.jobs) throw new Error('startJobScheduler: notebook jobs are off (MARIMOHUB_JOBS)');
	const scheduler = createJobScheduler(deps, metrics, deps.jobs);
	const tickMs = deps.jobs.tickMs;
	const lock = maintenanceLock(deps, paths.jobSchedulerLock);
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
		lock: maintenanceLock(deps, paths.warmPoolLock),
		shouldRun: async () =>
			service.config.enabled || (await service.store.ownedSandboxIds()).size > 0,
		run: () => service.sweep(),
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
		run: ({ signal }) => preparePreviews(deps, signal),
	}).stop;
}

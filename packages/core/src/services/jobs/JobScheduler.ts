import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import type { ProjectAlertDispatcher } from '../../ports/projectAlerts';
import type { SandboxProvider } from '../../ports/sandbox';
import { InFlightWork } from '../../concurrency';
import { Millis } from '../../duration';
import { NotFoundError } from '../../errors';
import { createRunId, SandboxId, SYSTEM_ACTOR } from '../../ids';
import type { ProjectId, RunId, VersionId } from '../../ids';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import { notificationRouter } from '../../notifications';
import type { JobDefinition, JobRun } from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import type { EventService } from '../catalog/EventService';
import type { NotebookService } from '../content/NotebookService';
import type { ProjectService } from '../content/ProjectService';
import { occurrenceKey, parseCron, previousOccurrence } from './cron';
import { indexedJobs } from './JobsService';
import type { JobsService } from './JobsService';
import type { JobRunService } from './JobRunService';
import { isActiveRunStatus, isTerminalRunStatus } from './runState';

export interface JobSchedulerConfig {
	/** How stale an occurrence may be and still fire (once). */
	catchupWindowMs: number;
	/** Deployment-wide cap on runs holding a sandbox. */
	maxConcurrentRuns: number;
	/** Per-project slice of the above. */
	maxConcurrentRunsPerProject: number;
	/** Run deadline when the job sets none. */
	defaultTimeoutMs: Millis;
	/** Ceiling on a job's own `timeout_seconds`. */
	maxTimeoutMs: Millis;
	/** Extra time past `deadline_at` before the watchdog reclaims a run. */
	watchdogGraceMs?: number;
}

export interface JobSchedulerDeps {
	catalog: CatalogService;
	jobs: JobsService;
	runs: JobRunService;
	runner: { execute(run: JobRun): Promise<JobRun> };
	compute: SandboxProvider;
	notebooks: NotebookService;
	projects: ProjectService;
	/** Audit sink for `job.run.finish`; absent = no audit events. */
	events?: EventService;
	/** Delivers `job.run.*` project alerts; absent = no notifications. */
	projectAlerts?: ProjectAlertDispatcher;
	/** Public URL for the links inside notifications. */
	appBaseUrl?: string;
	config: JobSchedulerConfig;
	metrics?: Metrics;
	now?: () => number;
}

export interface TickResult {
	/** Scheduled occurrences claimed and enqueued by this tick. */
	fired: number;
	/** Occurrences whose run record a prior crash never wrote, rewritten. */
	repaired: number;
	/** Fires declined by a job's `forbid` concurrency policy. */
	skipped: number;
	/** Queued runs handed to the runner. */
	dispatched: number;
	/** Active runs past their deadline, reclaimed. */
	timedOut: number;
	/** Active-run markers dropped as stale. */
	markersPruned: number;
	/** Per-job failures that did not stop the tick. */
	errors: number;
}

const DEFAULT_WATCHDOG_GRACE_MS = Millis.minutes(2);

/** How long a marker may outlive its record before it is considered dangling. */
const DANGLING_GRACE_MS = Millis.minutes(10);

interface LocalExecution {
	finalizedExternally: boolean;
}

export function jobRunFinishEvent(run: JobRun) {
	const started = run.started_at ? Date.parse(run.started_at) : Number.NaN;
	const finished = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
	return {
		event: 'job.run.finish',
		actor: run.triggered_by ?? SYSTEM_ACTOR,
		project_id: run.project_id,
		notebook_id: run.notebook_id,
		job_id: run.job_id,
		run_id: run.run_id,
		status: run.status,
		trigger: run.trigger,
		attempt: run.attempt,
		...(run.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
		...(run.error ? { error_code: run.error.code } : {}),
		...(Number.isFinite(started) && Number.isFinite(finished)
			? { duration_seconds: Math.max(0, Math.round((finished - started) / 1000)) }
			: {}),
	};
}

export function appendJobRunFinishEvent(events: EventService, run: JobRun): Promise<void> {
	return events.append(jobRunFinishEvent(run), {
		id: run.run_id.slice(4),
		timestamp: run.finished_at ?? run.queued_at,
		onlyIfAbsent: true,
	});
}

/**
 * Which queued runs may start now: oldest-eligible first, bounded by the global
 * and per-project caps with `running` already counted against them. Pure, so
 * the cap arithmetic is testable apart from the tick.
 */
export function admit(
	queued: readonly JobRun[],
	running: readonly JobRun[],
	caps: Pick<JobSchedulerConfig, 'maxConcurrentRuns' | 'maxConcurrentRunsPerProject'>,
): JobRun[] {
	const ordered = [...queued].sort(
		(a, b) =>
			(a.eligible_at ?? a.queued_at).localeCompare(b.eligible_at ?? b.queued_at) ||
			a.run_id.localeCompare(b.run_id),
	);
	const perProject = new Map<ProjectId, number>();
	for (const run of running) {
		perProject.set(run.project_id, (perProject.get(run.project_id) ?? 0) + 1);
	}
	const admitted: JobRun[] = [];
	let total = running.length;
	for (const run of ordered) {
		if (total >= caps.maxConcurrentRuns) break;
		const projectActive = perProject.get(run.project_id) ?? 0;
		if (projectActive >= caps.maxConcurrentRunsPerProject) continue;
		total++;
		perProject.set(run.project_id, projectActive + 1);
		admitted.push(run);
	}
	return admitted;
}

/**
 * The scheduler tick: fire due occurrences (claiming each exactly once across
 * replicas), dispatch queued runs under the concurrency caps, enforce run
 * deadlines, and enqueue retries. Runs only on the lease-holding maintenance
 * replica, so admission is single-threaded and needs no rank-after-create
 * dance. Executions are tracked in-process; a run that outlives the process is
 * recovered by the watchdog on a later tick.
 */
export class JobScheduler {
	private readonly inFlight = new InFlightWork();
	private readonly executing = new Map<RunId, LocalExecution>();
	private readonly metrics: Metrics;
	private readonly now: () => number;

	constructor(private deps: JobSchedulerDeps) {
		this.metrics = deps.metrics ?? noopMetrics;
		this.now = deps.now ?? (() => Date.now());
	}

	get inFlightCount(): number {
		return this.executing.size;
	}

	/** Await every execution this process started (for a graceful shutdown). */
	drain(): Promise<void> {
		return this.inFlight.drain();
	}

	async tick(): Promise<TickResult> {
		const result: TickResult = {
			fired: 0,
			repaired: 0,
			skipped: 0,
			dispatched: 0,
			timedOut: 0,
			markersPruned: 0,
			errors: 0,
		};
		const now = this.now();
		const snapshot = await this.deps.catalog.getCurrentSnapshot();
		for (const { projectId, notebookId, entry } of indexedJobs(snapshot)) {
			if (!entry.enabled || !entry.schedule) continue;
			try {
				const fired = await this.fire(projectId, notebookId, entry.id, now);
				if (fired === 'fired') result.fired++;
				else if (fired === 'repaired') result.repaired++;
				else if (fired === 'skipped') result.skipped++;
			} catch (err) {
				result.errors++;
				logOperationalError(
					'job_fire_failed',
					{
						operation: 'job.scheduler.fire',
						project_id: projectId,
						notebook_id: notebookId,
						job_id: entry.id,
					},
					err,
				);
			}
		}

		const active = await this.deps.runs.listActive();

		const queued: JobRun[] = [];
		const running: JobRun[] = [];
		for (const { marker, run } of active) {
			if (!run) {
				if (now - Date.parse(marker.created_at) > DANGLING_GRACE_MS) {
					await this.deps.runs.deleteMarker(marker);
					result.markersPruned++;
				}
				continue;
			}
			if (isTerminalRunStatus(run.status)) {
				try {
					await this.finalize(run, marker.continuation_run_id);
					result.markersPruned++;
				} catch (err) {
					result.errors++;
					logOperationalError(
						'job_finalization_failed',
						{ operation: 'job.scheduler.finalize', run_id: run.run_id },
						err,
					);
				}
				continue;
			}
			if (run.status === 'queued') {
				if (this.executing.has(run.run_id)) {
					running.push(run);
					continue;
				}
				if (!run.eligible_at || Date.parse(run.eligible_at) <= now) queued.push(run);
				continue;
			}
			if (await this.watchdog(run, now)) {
				result.timedOut++;
				continue;
			}
			running.push(run);
		}

		const admitted = admit(queued, running, this.deps.config);
		for (const run of admitted) this.dispatch(run);
		result.dispatched = admitted.length;
		this.metrics.gauge?.('jobs.runs.active', running.length + admitted.length);
		return result;
	}

	private async fire(
		projectId: ProjectId,
		notebookId: JobRun['notebook_id'],
		jobId: JobRun['job_id'],
		now: number,
	): Promise<'fired' | 'repaired' | 'skipped' | 'none'> {
		const jobRef = { project_id: projectId, notebook_id: notebookId, id: jobId };
		return this.deps.runs.withJobMutation(jobRef, async () => {
			if (await this.deps.runs.isJobDeleting(jobRef)) return 'none';
			const job = await this.loadJob(projectId, notebookId, jobId);
			if (!job?.enabled || !job.schedule) return 'none';
			let cron;
			try {
				cron = parseCron(job.schedule.cron);
			} catch (err) {
				logOperationalError(
					'job_schedule_invalid',
					{
						operation: 'job.scheduler.parse',
						project_id: projectId,
						notebook_id: notebookId,
						job_id: jobId,
					},
					err,
				);
				return 'none';
			}
			const occurrence = previousOccurrence(
				cron,
				job.schedule.timezone,
				now,
				this.deps.config.catchupWindowMs,
			);
			if (occurrence === null) return 'none';
			const scheduledFor = new Date(occurrence).toISOString();
			const active = await this.deps.runs.listActive();
			const hasActive = active.some(
				({ marker, run }) =>
					marker.project_id === projectId &&
					marker.job_id === jobId &&
					!!run &&
					!isTerminalRunStatus(run.status),
			);
			const outcome = job.concurrency_policy === 'forbid' && hasActive ? 'skip' : 'run';
			const runId = createRunId();
			const claim = await this.deps.runs.claimOccurrence(
				jobRef,
				occurrenceKey(occurrence),
				runId,
				new Date(now).toISOString(),
				outcome,
			);
			const claimedRunId = claim.claimed ? runId : claim.existing?.run_id;
			if (!claimedRunId) return 'none';
			if (
				!claim.claimed &&
				(await this.deps.runs.runExists(projectId, notebookId, jobId, claimedRunId))
			) {
				return 'none';
			}
			const claimedOutcome = claim.claimed ? outcome : (claim.existing?.outcome ?? 'run');
			if (claimedOutcome === 'skip') {
				const skipped = await this.deps.runs.writeSkipped({
					job,
					runId: claimedRunId,
					scheduledFor,
					sourceVersionId: await this.sourceVersionId(job),
					timeoutSeconds: this.timeoutSeconds(job),
					reason: {
						code: 'CONCURRENCY_FORBIDDEN',
						message: 'Skipped: the previous run of this job was still active',
					},
				});
				await this.finalize(skipped);
				return claim.claimed ? 'skipped' : 'repaired';
			}
			await this.enqueueScheduled(job, claimedRunId, scheduledFor);
			return claim.claimed ? 'fired' : 'repaired';
		});
	}

	private async loadJob(
		projectId: ProjectId,
		notebookId: JobRun['notebook_id'],
		jobId: JobRun['job_id'],
	): Promise<JobDefinition | null> {
		try {
			return await this.deps.jobs.getJob(projectId, notebookId, jobId);
		} catch (err) {
			// The index outlived the definition (delete crashed before the index
			// write); nothing to fire.
			if (err instanceof NotFoundError) return null;
			throw err;
		}
	}

	private async enqueueScheduled(job: JobDefinition, runId: RunId, scheduledFor: string) {
		await this.deps.runs.enqueue({
			job,
			runId,
			trigger: 'schedule',
			scheduledFor,
			parameters: job.parameters,
			sourceVersionId: await this.sourceVersionId(job),
			timeoutSeconds: this.timeoutSeconds(job),
		});
		this.metrics.increment('jobs.fired');
	}

	private async sourceVersionId(job: JobDefinition): Promise<VersionId | undefined> {
		try {
			const { source } = await this.deps.notebooks.getNotebook(job.project_id, job.notebook_id);
			if (source.current_version_id) return source.current_version_id;
		} catch {
			// Provenance is best-effort; the run still executes against the live copy.
		}
	}

	/** The run deadline for a job, in seconds, under the deployment ceiling. */
	timeoutSeconds(job: Pick<JobDefinition, 'timeout_seconds'>): number {
		const { defaultTimeoutMs, maxTimeoutMs } = this.deps.config;
		const requested =
			job.timeout_seconds !== undefined ? job.timeout_seconds * 1000 : defaultTimeoutMs;
		return Math.floor(Math.min(requested, maxTimeoutMs) / 1000);
	}

	/**
	 * Reclaim an active run past its deadline (plus grace): destroy the sandbox
	 * first — the authoritative bound, since exec RPC limits vary by adapter — then
	 * CAS `timed_out`. Also covers a scheduler process that died mid-execution.
	 */
	private async watchdog(run: JobRun, now: number): Promise<boolean> {
		if (!isActiveRunStatus(run.status)) return false;
		const grace = this.deps.config.watchdogGraceMs ?? DEFAULT_WATCHDOG_GRACE_MS;
		const deadline = run.deadline_at
			? Date.parse(run.deadline_at)
			: Date.parse(run.queued_at) + this.deps.config.maxTimeoutMs;
		if (now < deadline + grace) return false;
		if (run.sandbox_id) {
			try {
				await this.deps.compute.create(SandboxId.parse(run.sandbox_id)).destroy();
			} catch (err) {
				logOperationalError(
					'job_watchdog_destroy_failed',
					{ operation: 'job.scheduler.watchdog', run_id: run.run_id, sandbox_id: run.sandbox_id },
					err,
				);
			}
		}
		const { run: reclaimed, transitioned } = await this.deps.runs.transition(
			run,
			'timeout',
			() => ({
				finished_at: new Date(now).toISOString(),
				error: {
					code: 'RUN_TIMED_OUT',
					message: `The run exceeded its ${run.timeout_seconds}s timeout and was reclaimed`,
				},
			}),
		);
		if (transitioned) {
			const local = this.executing.get(run.run_id);
			if (local) {
				local.finalizedExternally = true;
				this.executing.delete(run.run_id);
			}
			this.metrics.increment('jobs.runs.watchdog_timeout');
			logEvent({
				level: 'warn',
				event: 'job_run_watchdog_timeout',
				project_id: run.project_id,
				notebook_id: run.notebook_id,
				job_id: run.job_id,
				run_id: run.run_id,
				sandbox_id: run.sandbox_id ?? null,
			});
			await this.finalize(reclaimed);
		}
		return transitioned;
	}

	private dispatch(run: JobRun): void {
		const local: LocalExecution = { finalizedExternally: false };
		this.executing.set(run.run_id, local);
		const execution = this.deps.runner
			.execute(run)
			.then((finished) => (local.finalizedExternally ? undefined : this.finalize(finished)))
			.catch((err: unknown) => {
				logOperationalError(
					'job_dispatch_failed',
					{ operation: 'job.scheduler.dispatch', run_id: run.run_id },
					err,
				);
			})
			.finally(() => {
				if (this.executing.get(run.run_id) === local) this.executing.delete(run.run_id);
			});
		void this.inFlight.track(execution);
	}

	private async finalize(finished: JobRun, continuationRunId?: RunId): Promise<void> {
		if (!isTerminalRunStatus(finished.status)) return;
		const marker = continuationRunId ? null : await this.deps.runs.getMarker(finished);
		await this.afterRun(
			finished,
			continuationRunId ?? marker?.continuation_run_id ?? createRunId(),
		);
		await this.deps.runs.deleteMarker(finished);
	}

	/** Post-run policy: audit the outcome, schedule a retry, or notify on the final outcome. */
	private async afterRun(finished: JobRun, continuationRunId: RunId): Promise<void> {
		if (!isTerminalRunStatus(finished.status)) return;
		await this.audit(finished);
		if (finished.status === 'cancelled') return;
		const job = await this.loadJob(finished.project_id, finished.notebook_id, finished.job_id);
		if (!job) return;
		const failed = finished.status === 'failed' || finished.status === 'timed_out';
		const retry = job.retry;
		if (failed && retry && finished.attempt <= retry.max_retries) {
			await this.deps.runs.withJobMutation(job, async () => {
				if (await this.deps.runs.isJobDeleting(job)) return;
				const current = await this.loadJob(job.project_id, job.notebook_id, job.id);
				if (!current) return;
				await this.deps.runs.enqueue({
					job: current,
					runId: continuationRunId,
					trigger: finished.trigger,
					triggeredBy: finished.triggered_by,
					scheduledFor: finished.scheduled_for,
					parameters: finished.parameters,
					sourceVersionId: finished.source_version_id,
					timeoutSeconds: finished.timeout_seconds,
					attempt: finished.attempt + 1,
					retryOf: finished.run_id,
					eligibleAt: new Date(this.now() + retry.backoff_seconds * 1000).toISOString(),
				});
			});
			this.metrics.increment('jobs.runs.retried');
			return;
		}
		await this.notify(job, finished);
	}

	/** A failed append leaves the finalization marker in place for a later tick. */
	private async audit(run: JobRun): Promise<void> {
		if (!this.deps.events) return;
		try {
			await appendJobRunFinishEvent(this.deps.events, run);
		} catch (err) {
			this.metrics.increment('events.append_failed');
			logOperationalError(
				'audit_append_failed',
				{ operation: 'job.scheduler.audit', run_id: run.run_id },
				err,
			);
			throw err;
		}
	}

	private async notify(job: JobDefinition, run: JobRun): Promise<void> {
		const dispatcher = this.deps.projectAlerts;
		if (!dispatcher || !job.notifications) return;
		const failed = run.status === 'failed' || run.status === 'timed_out';
		const wanted = failed
			? job.notifications.on.includes('failure')
			: run.status === 'succeeded' && job.notifications.on.includes('success');
		if (!wanted) return;
		const kind = failed ? 'job.run.failed' : 'job.run.succeeded';
		try {
			const [project, notebook] = await Promise.all([
				this.deps.projects.getProject(run.project_id),
				this.deps.notebooks.getNotebook(run.project_id, run.notebook_id),
			]);
			const [notification] = notificationRouter.render({
				kind,
				project,
				notebookId: run.notebook_id,
				notebookTitle: notebook.meta.title,
				job,
				run,
				baseUrl: this.deps.appBaseUrl,
			});
			const outcome = await dispatcher.deliver(run.project_id, kind, notification);
			if (outcome === 'partial') {
				logEvent({
					level: 'warn',
					event: 'project_alert_delivery_partial',
					notification_kind: kind,
					project_id: run.project_id,
					run_id: run.run_id,
				});
			}
		} catch (err) {
			logOperationalError(
				'project_alert_delivery_failed',
				{
					operation: 'job.scheduler.notify',
					notification_kind: kind,
					project_id: run.project_id,
					run_id: run.run_id,
				},
				err,
			);
			throw err;
		}
	}

	/**
	 * Retention, folded into the slow maintenance cycle: prune every indexed job's
	 * terminal runs and occurrence claims past `retentionMs`, plus stale markers.
	 */
	async prune(retentionMs: number): Promise<{ runsPruned: number; markersPruned: number }> {
		const now = this.now();
		const snapshot = await this.deps.catalog.getCurrentSnapshot();
		let runsPruned = 0;
		for (const { projectId, notebookId, entry } of indexedJobs(snapshot)) {
			try {
				runsPruned += await this.deps.runs.pruneJob(
					{ project_id: projectId, notebook_id: notebookId, id: entry.id },
					retentionMs,
					now,
				);
			} catch (err) {
				logOperationalError(
					'job_prune_failed',
					{
						operation: 'job.scheduler.prune',
						project_id: projectId,
						notebook_id: notebookId,
						job_id: entry.id,
					},
					err,
				);
			}
		}
		const markersPruned = await this.deps.runs.pruneStaleMarkers(now);
		return { runsPruned, markersPruned };
	}
}

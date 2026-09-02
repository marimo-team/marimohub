import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { Millis, sleep } from '../../duration';
import { NotFoundError, UnavailableError } from '../../errors';
import { createRunId, RunId } from '../../ids';
import type { JobId, NotebookId, ProjectId, UserId, VersionId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import {
	CURRENT_JOB_RUN_VERSION,
	JobOccurrenceSchema,
	JobRunMarkerSchema,
	JobRunSchema,
	parseStoredJobRun,
	readStored,
	readStoredJobRun,
} from '../../schema';
import type {
	JobDefinition,
	JobOccurrence,
	JobParameters,
	JobRun,
	JobRunMarker,
	RunError,
	RunTrigger,
} from '../../schema';
import {
	acquireSingletonClaim,
	mutateObjectWithOutcome,
	putIfAbsent,
	releaseSingletonClaim,
} from '../catalog/cas';
import { deleteByPrefix, listAllKeys } from '../catalog/storage';
import { occurrenceKeyToInstant } from './cron';
import { isTerminalRunStatus, nextRunStatus } from './runState';
import type { RunEvent } from './runState';

export interface EnqueueRunInput {
	job: JobDefinition;
	trigger: RunTrigger;
	triggeredBy?: UserId;
	scheduledFor?: string;
	parameters?: JobParameters;
	sourceVersionId?: VersionId;
	timeoutSeconds: number;
	attempt?: number;
	retryOf?: RunId;
	eligibleAt?: string;
	/** Reuse a pre-assigned id (the occurrence claim names the run before it exists). */
	runId?: RunId;
}

export interface ActiveRun {
	marker: JobRunMarker;
	/** Null when the marker outlived (or preceded) its record. */
	run: JobRun | null;
}

export interface RunOutputs {
	html?: string;
	logs?: string;
}

export interface CancelledRuns {
	runs: JobRun[];
	sandboxIds: string[];
}

export interface RunPage {
	items: JobRun[];
	nextRunId: RunId | null;
}

/**
 * How long a marker may exist without its run record before it is treated as
 * a crashed enqueue and dropped: the marker is written first, so a fresh
 * marker's record may still be on its way.
 */
export const DANGLING_MARKER_GRACE_MS = Millis.minutes(10);
const JOB_OPERATION_TTL_MS = Millis.seconds(30);
const JOB_OPERATION_WAIT_ATTEMPTS = 200;
const JOB_OPERATION_WAIT_MS = 25;

/**
 * Owner of every run record (`runs/{rid}/run.json`, ETag CAS), occurrence
 * claim, immutable history entry, and active marker. Terminal runs are never
 * rewritten.
 */
export class JobRunService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	private runPaths(run: Pick<JobRun, 'project_id' | 'notebook_id' | 'job_id' | 'run_id'>) {
		return paths.project(run.project_id).notebook(run.notebook_id).job(run.job_id).run(run.run_id);
	}

	async withJobMutation<T>(
		job: Pick<JobDefinition, 'project_id' | 'notebook_id' | 'id'>,
		work: () => Promise<T>,
	): Promise<T> {
		const key = paths.jobOperationClaim(job.project_id, job.notebook_id, job.id);
		const holder = `${Date.now() + JOB_OPERATION_TTL_MS}:${createRunId()}`;
		const claim = {
			bucket: this.bucket,
			key,
			serialize: (value: string | null) => JSON.stringify({ holder: value }),
			parseHolder: (raw: unknown): string | null => {
				if (!raw || typeof raw !== 'object' || !('holder' in raw)) {
					throw new Error('Invalid job operation claim');
				}
				const value = raw.holder;
				if (value !== null && typeof value !== 'string') {
					throw new Error('Invalid job operation claim holder');
				}
				return value;
			},
			isHolderLive: async (value: string) => {
				const expires = Number(value.slice(0, value.indexOf(':')));
				return Number.isFinite(expires) && expires > Date.now();
			},
		};
		for (let attempt = 0; attempt < JOB_OPERATION_WAIT_ATTEMPTS; attempt++) {
			const acquired = await acquireSingletonClaim(claim, holder);
			if (acquired.acquired) {
				try {
					return await work();
				} finally {
					await releaseSingletonClaim(claim, holder);
				}
			}
			await sleep(JOB_OPERATION_WAIT_MS);
		}
		throw new UnavailableError('Job is busy; retry the operation');
	}

	/**
	 * Write a `queued` run. The marker lands first, then the record — both
	 * create-if-absent, so a repeated enqueue for the same id (an occurrence repair
	 * after a crash) converges on the record that exists.
	 */
	async enqueue(input: EnqueueRunInput): Promise<JobRun> {
		const runId = input.runId ?? createRunId();
		const now = new Date().toISOString();
		const { job } = input;
		const run = JobRunSchema.parse({
			schema_version: CURRENT_JOB_RUN_VERSION,
			run_id: runId,
			job_id: job.id,
			notebook_id: job.notebook_id,
			project_id: job.project_id,
			status: 'queued',
			trigger: input.trigger,
			...(input.triggeredBy ? { triggered_by: input.triggeredBy } : {}),
			...(input.scheduledFor ? { scheduled_for: input.scheduledFor } : {}),
			...(input.sourceVersionId ? { source_version_id: input.sourceVersionId } : {}),
			...(input.parameters && Object.keys(input.parameters).length > 0
				? { parameters: input.parameters }
				: {}),
			attempt: input.attempt ?? 1,
			...(input.retryOf ? { retry_of: input.retryOf } : {}),
			timeout_seconds: input.timeoutSeconds,
			queued_at: now,
			...(input.eligibleAt ? { eligible_at: input.eligibleAt } : {}),
		});
		const marker: JobRunMarker = {
			run_id: runId,
			continuation_run_id: createRunId(),
			job_id: job.id,
			notebook_id: job.notebook_id,
			project_id: job.project_id,
			created_at: now,
		};
		await putIfAbsent(
			this.bucket,
			paths.jobRunMarker(job.project_id, runId),
			JSON.stringify(marker),
		);
		const jobPaths = paths.project(job.project_id).notebook(job.notebook_id).job(job.id);
		await putIfAbsent(this.bucket, jobPaths.runIndex(runId), '');
		const key = this.runPaths(run).record;
		const created = await putIfAbsent(this.bucket, key, JSON.stringify(run));
		if (created) {
			this.metrics.increment('jobs.runs.enqueued', 1, { trigger: input.trigger });
			return run;
		}
		return this.getRun(job.project_id, job.notebook_id, job.id, runId);
	}

	/** A terminal-at-birth record for a scheduled fire the concurrency policy declined. */
	async writeSkipped(
		input: Omit<EnqueueRunInput, 'trigger' | 'triggeredBy'> & { reason: RunError },
	): Promise<JobRun> {
		const runId = input.runId ?? createRunId();
		const now = new Date().toISOString();
		const { job } = input;
		const run = JobRunSchema.parse({
			schema_version: CURRENT_JOB_RUN_VERSION,
			run_id: runId,
			job_id: job.id,
			notebook_id: job.notebook_id,
			project_id: job.project_id,
			status: 'skipped',
			trigger: 'schedule',
			...(input.scheduledFor ? { scheduled_for: input.scheduledFor } : {}),
			...(input.sourceVersionId ? { source_version_id: input.sourceVersionId } : {}),
			attempt: 1,
			timeout_seconds: input.timeoutSeconds,
			queued_at: now,
			finished_at: now,
			error: input.reason,
		});
		const marker: JobRunMarker = {
			run_id: runId,
			continuation_run_id: createRunId(),
			job_id: job.id,
			notebook_id: job.notebook_id,
			project_id: job.project_id,
			created_at: now,
		};
		await putIfAbsent(
			this.bucket,
			paths.jobRunMarker(job.project_id, runId),
			JSON.stringify(marker),
		);
		const jobPaths = paths.project(job.project_id).notebook(job.notebook_id).job(job.id);
		await putIfAbsent(this.bucket, jobPaths.runIndex(runId), '');
		const created = await putIfAbsent(this.bucket, this.runPaths(run).record, JSON.stringify(run));
		if (!created) return this.getRun(job.project_id, job.notebook_id, job.id, runId);
		this.metrics.increment('jobs.runs.skipped');
		return run;
	}

	async getRun(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		runId: RunId,
	): Promise<JobRun> {
		const key = paths.project(projectId).notebook(notebookId).job(jobId).run(runId).record;
		const obj = await this.bucket.get(key);
		if (!obj) throw new NotFoundError(`Run ${runId} not found`);
		return readStoredJobRun(obj, key);
	}

	async runExists(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		runId: RunId,
	): Promise<boolean> {
		const key = paths.project(projectId).notebook(notebookId).job(jobId).run(runId).record;
		return (await this.bucket.head(key)) !== null;
	}

	/** Every run of a job, newest first. Intended for retention and internal maintenance. */
	async listRuns(projectId: ProjectId, notebookId: NotebookId, jobId: JobId): Promise<JobRun[]> {
		const runs: JobRun[] = [];
		let afterRunId: RunId | undefined;
		do {
			const page = await this.listRunsPage(projectId, notebookId, jobId, 500, afterRunId);
			runs.push(...page.items);
			afterRunId = page.nextRunId ?? undefined;
		} while (afterRunId);
		return runs;
	}

	/** Read one newest-first history page without fetching records outside that page. */
	async listRunsPage(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		limit: number,
		afterRunId?: RunId,
	): Promise<RunPage> {
		const job = paths.project(projectId).notebook(notebookId).job(jobId);
		const items: JobRun[] = [];
		let startAfter = afterRunId ? job.runIndex(afterRunId) : undefined;
		let hasMore = false;
		while (items.length <= limit) {
			const listed = await this.bucket.list({
				prefix: job.runIndexPrefix,
				...(startAfter ? { startAfter } : {}),
				limit: limit + 1 - items.length,
			});
			if (listed.objects.length === 0) break;
			startAfter = listed.objects[listed.objects.length - 1]?.key;
			const page = await mapWithConcurrency(
				listed.objects,
				BUCKET_SCAN_CONCURRENCY,
				async (index) => {
					const runId = this.runIdFromIndex(job.runIndexPrefix, index.key);
					if (!runId) return;
					const recordKey = job.run(runId).record;
					const record = await this.bucket.get(recordKey);
					if (!record) return;
					try {
						return await readStoredJobRun(record, recordKey);
					} catch (err) {
						logOperationalError(
							'stored_object_skipped',
							{ operation: 'job.run.list', object: recordKey },
							err,
						);
					}
				},
			);
			for (const run of page) {
				if (run) items.push(run);
				if (items.length > limit) break;
			}
			hasMore = items.length > limit || listed.truncated;
			if (items.length > limit || !listed.truncated) break;
		}
		if (items.length > limit) items.pop();
		return {
			items,
			nextRunId: hasMore && items.length > 0 ? items[items.length - 1].run_id : null,
		};
	}

	private runIdFromIndex(prefix: string, key: string): RunId | null {
		const reversed = key.slice(prefix.length).replace(/\.json$/, '');
		if (reversed.length !== 26) return null;
		const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
		const body = Array.from(reversed, (char) => alphabet[31 - alphabet.indexOf(char)]).join('');
		const candidate = `run_${body}`;
		return RunId.is(candidate) ? candidate : null;
	}

	/**
	 * Apply one FSM event as an ETag CAS. `transitioned: false` means the edge was
	 * illegal against the fresh record (e.g. a cancel already landed); the caller
	 * then acts on the returned record. Terminal transitions retain the marker
	 * until finalization finishes.
	 */
	async transition(
		ref: Pick<JobRun, 'project_id' | 'notebook_id' | 'job_id' | 'run_id'>,
		event: RunEvent,
		patch: (run: JobRun) => Partial<JobRun> = () => ({}),
	): Promise<{ run: JobRun; transitioned: boolean }> {
		const key = this.runPaths(ref).record;
		const outcome = await mutateObjectWithOutcome(
			this.bucket,
			key,
			(raw) => parseStoredJobRun(raw, key),
			(current) => {
				const status = nextRunStatus(current.status, event);
				if (status === null) return null;
				return JobRunSchema.parse({ ...current, ...patch(current), status });
			},
			{
				notFound: () => new NotFoundError(`Run ${ref.run_id} not found`),
				onConflict: () => this.metrics.increment('jobs.runs.cas.conflict'),
				onExhausted: () => this.metrics.increment('jobs.runs.cas.exhausted'),
			},
		);
		if (outcome.written) {
			this.metrics.increment('jobs.runs.transition', 1, { event, status: outcome.value.status });
		}
		return { run: outcome.value, transitioned: outcome.written };
	}

	async cancel(
		ref: Pick<JobRun, 'project_id' | 'notebook_id' | 'job_id' | 'run_id'>,
		by: UserId,
	): Promise<{ run: JobRun; transitioned: boolean }> {
		return this.transition(ref, 'cancel', () => ({
			finished_at: new Date().toISOString(),
			cancelled_by: by,
		}));
	}

	/**
	 * Claim a scheduled occurrence. Exactly one concurrent claimer wins the
	 * create-if-absent PUT; losers get the standing claim (or null when it vanished
	 * underneath them), so they can repair a run record a crash never wrote.
	 */
	async claimOccurrence(
		job: Pick<JobDefinition, 'project_id' | 'notebook_id' | 'id'>,
		occurrenceKey: string,
		runId: RunId,
		firedAt: string,
		outcome: JobOccurrence['outcome'] = 'run',
	): Promise<{ claimed: true } | { claimed: false; existing: JobOccurrence | null }> {
		const key = paths
			.project(job.project_id)
			.notebook(job.notebook_id)
			.job(job.id)
			.occurrence(occurrenceKey);
		const occurrence: JobOccurrence = { run_id: runId, fired_at: firedAt, outcome };
		if (await putIfAbsent(this.bucket, key, JSON.stringify(occurrence))) return { claimed: true };
		const existing = await this.bucket.get(key);
		if (!existing) return { claimed: false, existing: null };
		try {
			return { claimed: false, existing: await readStored(JobOccurrenceSchema, existing, key) };
		} catch (err) {
			logOperationalError(
				'corrupt_job_occurrence_ignored',
				{ operation: 'job.occurrence.read', object: key },
				err,
			);
			return { claimed: false, existing: null };
		}
	}

	/** Every run awaiting execution or finalization, with its record when readable. */
	async listActive(): Promise<ActiveRun[]> {
		const keys = await listAllKeys(this.bucket, paths.jobRunMarkersPrefix);
		const active = await mapWithConcurrency(keys, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const markerObj = await this.bucket.get(key);
			if (!markerObj) return;
			let marker: JobRunMarker;
			try {
				marker = await readStored(JobRunMarkerSchema, markerObj, key);
			} catch (err) {
				logOperationalError(
					'corrupt_job_run_marker_removed',
					{ operation: 'job.run.marker.read', object: key },
					err,
				);
				await this.bucket.delete(key).catch(() => {});
				return;
			}
			const recordKey = this.runPaths(marker).record;
			const recordObj = await this.bucket.get(recordKey);
			if (!recordObj) return { marker, run: null };
			try {
				return { marker, run: await readStoredJobRun(recordObj, recordKey) };
			} catch (err) {
				logOperationalError(
					'stored_object_skipped',
					{ operation: 'job.run.active', object: recordKey },
					err,
				);
				return { marker, run: null };
			}
		});
		return active.filter((entry) => entry !== undefined);
	}

	/** Sandbox ids held by active runs — the reconciler's second accounting source. */
	async activeSandboxIds(): Promise<string[]> {
		const active = await this.listActive();
		return active.flatMap(({ run }) =>
			run?.sandbox_id && !isTerminalRunStatus(run.status) ? [run.sandbox_id] : [],
		);
	}

	async deleteMarker(run: Pick<JobRun, 'project_id' | 'run_id'>): Promise<void> {
		await this.bucket.delete(paths.jobRunMarker(run.project_id, run.run_id)).catch((err) => {
			logOperationalError(
				'job_run_marker_delete_failed',
				{
					operation: 'job.run.marker.delete',
					object: paths.jobRunMarker(run.project_id, run.run_id),
				},
				err,
			);
		});
	}

	async getMarker(run: Pick<JobRun, 'project_id' | 'run_id'>): Promise<JobRunMarker | null> {
		const key = paths.jobRunMarker(run.project_id, run.run_id);
		const obj = await this.bucket.get(key);
		return obj ? readStored(JobRunMarkerSchema, obj, key) : null;
	}

	/** Write-once captured outputs; returns the byte counts to stamp on the record. */
	async putOutputs(run: JobRun, outputs: RunOutputs): Promise<NonNullable<JobRun['output']>> {
		const p = this.runPaths(run);
		const encoder = new TextEncoder();
		const output: NonNullable<JobRun['output']> = { html_bytes: 0 };
		if (outputs.html !== undefined) {
			const bytes = encoder.encode(outputs.html);
			output.html_bytes = await this.putOutput(p.html, bytes, 'text/html');
		}
		if (outputs.logs !== undefined) {
			const bytes = encoder.encode(outputs.logs);
			output.logs_bytes = await this.putOutput(p.logs, bytes, 'text/plain');
		}
		return output;
	}

	private async putOutput(key: string, bytes: Uint8Array, contentType: string): Promise<number> {
		if (await putIfAbsent(this.bucket, key, bytes, { httpMetadata: { contentType } })) {
			return bytes.byteLength;
		}
		const existing = await this.bucket.head(key);
		if (existing) return existing.size;
		throw new UnavailableError('Run output disappeared while it was being captured');
	}

	async readHtml(run: JobRun): Promise<string | null> {
		const obj = await this.bucket.get(this.runPaths(run).html);
		return obj ? obj.text() : null;
	}

	async readLogs(run: JobRun): Promise<string | null> {
		const obj = await this.bucket.get(this.runPaths(run).logs);
		return obj ? obj.text() : null;
	}

	/**
	 * Cancel every non-terminal run of a job (so a delete leaves no sandbox
	 * behind), returning the sandbox ids the caller must destroy.
	 */
	cancelRunsOfJob(
		job: Pick<JobDefinition, 'project_id' | 'notebook_id' | 'id'>,
		by: UserId,
	): Promise<CancelledRuns> {
		return this.cancelRunsWhere(
			(marker) => marker.project_id === job.project_id && marker.job_id === job.id,
			by,
		);
	}

	/** Cancel every non-terminal run of a notebook (a soft-delete must not leave it computing). */
	cancelRunsOfNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		by: UserId,
	): Promise<CancelledRuns> {
		return this.cancelRunsWhere(
			(marker) => marker.project_id === projectId && marker.notebook_id === notebookId,
			by,
		);
	}

	cancelRunsOfProject(projectId: ProjectId, by: UserId): Promise<CancelledRuns> {
		return this.cancelRunsWhere((marker) => marker.project_id === projectId, by);
	}

	private async cancelRunsWhere(
		matches: (marker: JobRunMarker) => boolean,
		by: UserId,
	): Promise<CancelledRuns> {
		const active = (await this.listActive()).filter(({ marker }) => matches(marker));
		const sandboxIds: string[] = [];
		const runs: JobRun[] = [];
		for (const { marker, run } of active) {
			if (!run) {
				await this.deleteMarker(marker);
				continue;
			}
			const { run: cancelled, transitioned } = await this.cancel(run, by);
			if (transitioned) {
				runs.push(cancelled);
				if (cancelled.sandbox_id) sandboxIds.push(cancelled.sandbox_id);
			}
		}
		return { runs, sandboxIds };
	}

	/**
	 * Retention: delete terminal runs (whole `runs/{rid}/` prefixes) and occurrence
	 * claims older than `retentionMs`. Returns the number of runs removed.
	 */
	async pruneJob(
		job: Pick<JobDefinition, 'project_id' | 'notebook_id' | 'id'>,
		retentionMs: number,
		now: number = Date.now(),
	): Promise<number> {
		const cutoff = now - retentionMs;
		const jobPaths = paths.project(job.project_id).notebook(job.notebook_id).job(job.id);
		const runs = await this.listRuns(job.project_id, job.notebook_id, job.id);
		let pruned = 0;
		for (const run of runs) {
			if (!isTerminalRunStatus(run.status)) continue;
			const endedAt = Date.parse(run.finished_at ?? run.queued_at);
			if (!(endedAt < cutoff)) continue;
			await deleteByPrefix(this.bucket, jobPaths.run(run.run_id).base);
			await this.bucket.delete(jobPaths.runIndex(run.run_id));
			pruned++;
		}
		const occurrenceKeys = await listAllKeys(this.bucket, jobPaths.occurrencesPrefix);
		const staleOccurrences = occurrenceKeys.filter((key) => {
			const name = key.slice(jobPaths.occurrencesPrefix.length).replace(/\.json$/, '');
			const instant = occurrenceKeyToInstant(name);
			return instant !== null && instant < cutoff;
		});
		if (staleOccurrences.length > 0) await this.bucket.delete(staleOccurrences);
		if (pruned > 0) this.metrics.increment('jobs.runs.pruned', pruned);
		return pruned;
	}

	/**
	 * Drop markers missing past the dangling grace (a crash between marker and
	 * record on an enqueue). Terminal markers remain until finalization completes.
	 */
	async pruneStaleMarkers(now: number = Date.now()): Promise<number> {
		let pruned = 0;
		for (const { marker, run } of await this.listActive()) {
			const stale = !run && now - Date.parse(marker.created_at) > DANGLING_MARKER_GRACE_MS;
			if (!stale) continue;
			await this.bucket
				.delete(paths.jobRunMarker(marker.project_id, marker.run_id))
				.catch(() => {});
			if (!run) {
				const index = paths
					.project(marker.project_id)
					.notebook(marker.notebook_id)
					.job(marker.job_id)
					.runIndex(marker.run_id);
				await this.bucket.delete(index).catch(() => {});
			}
			pruned++;
		}
		return pruned;
	}
}

export { RunId };

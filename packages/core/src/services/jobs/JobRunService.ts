import { createRunCredential, hashRunCredential, parseRunCredential } from './runCredential';
import { readRetentionCursor, writeRetentionCursor } from '../catalog/retentionCursor';
import type { RetentionCursor } from '../catalog/retentionCursor';
import { encodeTime } from 'ulidx';
import { copyMovePrefix, moveJson } from '../content/moveObjects';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { forEachConcurrentUntilFailure } from '../../async';
import { Millis, sleep } from '../../duration';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
} from '../../errors';
import { createRunId, JobId, NotebookId, RunId } from '../../ids';
import type { ProjectId, UserId, VersionId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import type { JobPaths } from '../../paths';
import {
	CURRENT_JOB_RUN_VERSION,
	JobOccurrenceSchema,
	JobRunMarkerSchema,
	JobRunSchema,
	RunMetadataSchema,
	RunMetadataPatchSchema,
	RunStopBodySchema,
	ProjectRunIndexSchema,
	parseStoredJobRun,
	readStored,
	readStoredJobRun,
	StoredObjectError,
} from '../../schema';
import type {
	ProjectRunIndex,
	JobDefinition,
	JobOccurrence,
	JobParameters,
	JobRun,
	JobRunMarker,
	RunError,
	RunTrigger,
	RunTags,
} from '../../schema';
import {
	acquireSingletonClaim,
	mutateObjectWithOutcome,
	putIfAbsent,
	releaseSingletonClaim,
	withCasRetry,
} from '../catalog/cas';
import {
	deleteByPrefix,
	iterateBucketPages,
	listAllKeys,
	listAllPrefixes,
} from '../catalog/storage';
import { occurrenceKeyToInstant } from './cron';
import { isTerminalRunStatus, nextRunStatus } from './runState';
import type { RunEvent } from './runState';

export interface EnqueueRunInput {
	job: JobDefinition;
	trigger: RunTrigger;
	triggeredBy?: UserId;
	scheduledFor?: string;
	parameters?: JobParameters;
	tags?: RunTags;
	metadata?: JobRun['metadata'];
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

export interface ActiveRunSnapshot {
	entries: ActiveRun[];
	complete: boolean;
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

function parseOperationHolder(raw: unknown): string | null {
	if (!raw || typeof raw !== 'object' || !('holder' in raw)) {
		throw new Error('Invalid job operation claim');
	}
	const value = raw.holder;
	if (value !== null && typeof value !== 'string') {
		throw new Error('Invalid job operation claim holder');
	}
	return value;
}

function isOperationHolderLive(holder: string): boolean {
	const expires = Number(holder.slice(0, holder.indexOf(':')));
	return Number.isFinite(expires) && expires > Date.now();
}

function operationHolderToken(holder: string): string {
	return holder.slice(holder.indexOf(':') + 1);
}

/**
 * Owner of every run record (`runs/{rid}/run.json`, ETag CAS), occurrence
 * claim, immutable history entry, and active marker. Terminal runs are never
 * rewritten.
 */
export class JobRunService {
	async copyForMove(source: ProjectId, destination: ProjectId, nid: NotebookId): Promise<void> {
		await copyMovePrefix(
			this.bucket,
			paths.project(source).notebook(nid).jobsPrefix,
			paths.project(destination).notebook(nid).jobsPrefix,
			{
				include: (key) => !key.endsWith('/job.json'),
				transform: (key, bytes) =>
					key.endsWith('/run.json')
						? moveJson(bytes, (run) => ({ ...run, project_id: destination }))
						: bytes,
			},
		);
		const locators = await this.listProjectRunIndexs(destination, nid);
		await mapWithConcurrency(locators, BUCKET_SCAN_CONCURRENCY, (locator) =>
			this.putLocator(destination, locator),
		);
	}

	/**
	 * Drops the source's released or expired operation claims once a moved notebook has left it.
	 * A live claim stays with its holder: deleting it would admit a second holder for the job.
	 */
	async finishMove(source: ProjectId, nid: NotebookId): Promise<void> {
		const idle: string[] = [];
		for (const key of await listAllKeys(
			this.bucket,
			paths.jobOperationClaimsForNotebook(source, nid),
		)) {
			const object = await this.bucket.get(key);
			if (!object) continue;
			let holder: string | null = null;
			try {
				holder = parseOperationHolder(await object.json());
			} catch {
				// A corrupt claim is stale; acquisition replaces it the same way.
			}
			if (!holder || !isOperationHolderLive(holder)) idle.push(key);
		}
		if (idle.length > 0) await this.bucket.delete(idle);
		await this.deleteProjectLocators(source, nid);
	}

	/** Must run before the per-job run index it derives from is deleted. */
	async deleteProjectLocators(pid: ProjectId, nid: NotebookId, jid?: JobId): Promise<void> {
		const locators = await this.listProjectRunIndexs(pid, nid, jid);
		if (locators.length > 0)
			await this.bucket.delete(
				locators.map((locator) => paths.project(pid).runIndex(locator.run_id)),
			);
	}

	/** Project locators share their file names with per-job history entries, so no record is read. */
	private async listProjectRunIndexs(
		pid: ProjectId,
		nid: NotebookId,
		jid?: JobId,
	): Promise<ProjectRunIndex[]> {
		const notebook = paths.project(pid).notebook(nid);
		const jobIds = jid
			? [jid]
			: (await listAllPrefixes(this.bucket, notebook.jobsPrefix))
					.map((prefix) => prefix.slice(notebook.jobsPrefix.length).replace(/\/$/, ''))
					.filter((id) => JobId.is(id));
		const locators: ProjectRunIndex[] = [];
		for (const job_id of jobIds) {
			const prefix = notebook.job(job_id).runIndexPrefix;
			for (const key of await listAllKeys(this.bucket, prefix)) {
				const run_id = this.runIdFromIndex(prefix, key);
				if (run_id) locators.push({ notebook_id: nid, job_id, run_id });
			}
		}
		return locators;
	}

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
		const token = createRunId();
		let holder = `${Date.now() + JOB_OPERATION_TTL_MS}:${token}`;
		const claim = {
			bucket: this.bucket,
			key,
			serialize: (value: string | null) => JSON.stringify({ holder: value }),
			parseHolder: parseOperationHolder,
			isHolderLive: async (value: string) => isOperationHolderLive(value),
		};
		for (let attempt = 0; attempt < JOB_OPERATION_WAIT_ATTEMPTS; attempt++) {
			const acquired = await acquireSingletonClaim(claim, holder);
			if (acquired.acquired) {
				let renewalInFlight: Promise<void> | undefined;
				let leaseLost = false;
				const renew = () => {
					if (renewalInFlight) return renewalInFlight;
					const pending = this.renewJobMutationClaim(key, token)
						.then((renewed) => {
							if (renewed) holder = renewed;
							else leaseLost = true;
						})
						.catch((err) => {
							leaseLost = true;
							logOperationalError(
								'job_operation_renew_failed',
								{ operation: 'job.operation.renew', object: key },
								err,
							);
						});
					const tracked = pending.finally(() => {
						if (renewalInFlight === tracked) renewalInFlight = undefined;
					});
					renewalInFlight = tracked;
					return tracked;
				};
				const renewalTimer = setInterval(() => {
					void renew();
				}, JOB_OPERATION_TTL_MS / 3);
				try {
					const result = await work();
					if (leaseLost) throw new UnavailableError('Job mutation lease was lost');
					return result;
				} finally {
					clearInterval(renewalTimer);
					await renewalInFlight;
					await releaseSingletonClaim(claim, holder);
				}
			}
			await sleep(JOB_OPERATION_WAIT_MS);
		}
		throw new UnavailableError('Job is busy; retry the operation');
	}

	private async renewJobMutationClaim(key: string, token: string): Promise<string | null> {
		return withCasRetry(this.bucket, async (cas) => {
			const existing = await this.bucket.get(key);
			if (!existing) return null;
			const current = parseOperationHolder(await existing.json());
			if (!current || operationHolderToken(current) !== token) return null;
			const renewed = `${Date.now() + JOB_OPERATION_TTL_MS}:${token}`;
			await cas.put(key, JSON.stringify({ holder: renewed }), {
				onlyIfEtagMatches: existing.etag,
			});
			return renewed;
		});
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
			tags: input.tags,
			metadata: input.metadata,
			initial_metadata: input.metadata,
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
		const result = await this.createRun(run);
		if (result.created) this.metrics.increment('jobs.runs.enqueued', 1, { trigger: input.trigger });
		return result.run;
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
		const result = await this.createRun(run);
		if (result.created) this.metrics.increment('jobs.runs.skipped');
		return result.run;
	}

	private async createRun(run: JobRun): Promise<{ run: JobRun; created: boolean }> {
		const { project_id: pid, notebook_id: nid, job_id: jid, run_id: rid } = run;
		const marker: JobRunMarker = {
			project_id: pid,
			notebook_id: nid,
			job_id: jid,
			run_id: rid,
			continuation_run_id: createRunId(),
			created_at: run.queued_at,
		};
		await putIfAbsent(this.bucket, paths.jobRunMarker(pid, rid), JSON.stringify(marker));
		const job = paths.project(pid).notebook(nid).job(jid);
		await putIfAbsent(this.bucket, job.runIndex(rid), '');
		const created = await putIfAbsent(this.bucket, job.run(rid).record, JSON.stringify(run));
		const persisted = created ? run : await this.getRun(pid, nid, jid, rid);
		// Acceptance is durable already; the marker keeps failed indexing retryable.
		try {
			await this.publishProjectRun(persisted);
		} catch (error) {
			logOperationalError(
				'job_run_index_publish_failed',
				{ operation: 'job.run.index', run_id: rid },
				error,
			);
		}
		return { run: persisted, created };
	}

	async migrateProjectRunIndexEntry(key: string, signal?: AbortSignal): Promise<void> {
		if (!/^projects\/[^/]+\/notebooks\/[^/]+\/jobs\/[^/]+\/runs\/[^/]+\/run\.json$/.test(key))
			return;
		signal?.throwIfAborted();
		const object = await this.bucket.get(key);
		if (!object) return;
		let run: JobRun;
		try {
			run = await readStoredJobRun(object, key);
		} catch (error) {
			if (!(error instanceof StoredObjectError)) throw error;
			// A deterministic failure would otherwise wedge the one-time migration on this batch.
			this.skipStoredObject('job.run.index.migrate', key, error);
			return;
		}
		if (this.runPaths(run).record !== key) {
			this.skipStoredObject(
				'job.run.index.migrate',
				key,
				new Error('Run attribution does not match its storage key'),
			);
			return;
		}
		signal?.throwIfAborted();
		await this.publishProjectRun(run);
	}

	async publishProjectRun(run: JobRun): Promise<void> {
		await this.putLocator(run.project_id, ProjectRunIndexSchema.parse(run));
	}

	private async putLocator(pid: ProjectId, locator: ProjectRunIndex): Promise<void> {
		await putIfAbsent(
			this.bucket,
			paths.project(pid).runIndex(locator.run_id),
			JSON.stringify(locator),
		);
	}

	private skipStoredObject(operation: string, key: string, error: unknown): null {
		logOperationalError('stored_object_skipped', { operation, object: key }, error);
		return null;
	}

	async listProjectRunsPage(
		pid: ProjectId,
		limit: number,
		after?: RunId,
		tag?: { key: string; value: string },
	): Promise<RunPage> {
		const project = paths.project(pid);
		const page = await this.readHistoryPage(
			project.runIndexPrefix,
			limit,
			after ? project.runIndex(after) : undefined,
			async (key, rid) => {
				const object = await this.bucket.get(key);
				if (!object) return null;
				// One bad locator must not fail the page for every reader of the project.
				let ref: ProjectRunIndex;
				try {
					ref = await readStored(ProjectRunIndexSchema, object, key);
				} catch (error) {
					if (!(error instanceof StoredObjectError)) throw error;
					return this.skipStoredObject('job.run.list', key, error);
				}
				if (ref.run_id !== rid)
					return this.skipStoredObject(
						'job.run.list',
						key,
						new Error('Invalid project run locator'),
					);
				return this.readHistoryRun({ ...ref, project_id: pid }, { skipMismatch: true });
			},
		);
		return {
			...page,
			items: tag
				? page.items.filter(
						(run) =>
							run.tags && Object.hasOwn(run.tags, tag.key) && run.tags[tag.key] === tag.value,
					)
				: page.items,
		};
	}

	async backfillProjectRuns(job: JobDefinition, limit: number, after?: RunId): Promise<RunPage> {
		const source = paths.project(job.project_id).notebook(job.notebook_id).job(job.id);
		const page = await this.readHistoryPage(
			source.runIndexPrefix,
			limit,
			after ? source.runIndex(after) : undefined,
			(_key, rid) =>
				this.readHistoryRun({
					project_id: job.project_id,
					notebook_id: job.notebook_id,
					job_id: job.id,
					run_id: rid,
				}),
		);
		await mapWithConcurrency(page.items, BUCKET_SCAN_CONCURRENCY, (run) =>
			this.publishProjectRun(run),
		);
		return page;
	}

	private async readHistoryRun(
		ref: Pick<JobRun, 'project_id' | 'notebook_id' | 'job_id' | 'run_id'>,
		{ skipMismatch = false }: { skipMismatch?: boolean } = {},
	): Promise<JobRun | null> {
		const key = this.runPaths(ref).record;
		const object = await this.bucket.get(key);
		if (!object) return null;
		let run: JobRun;
		try {
			run = await readStoredJobRun(object, key);
		} catch (error) {
			return this.skipStoredObject('job.run.list', key, error);
		}
		if (
			run.project_id !== ref.project_id ||
			run.notebook_id !== ref.notebook_id ||
			run.job_id !== ref.job_id ||
			run.run_id !== ref.run_id
		) {
			const error = new Error('Run attribution does not match its history locator');
			if (!skipMismatch) throw error;
			return this.skipStoredObject('job.run.list', key, error);
		}
		return run;
	}

	private async readHistoryPage(
		prefix: string,
		limit: number,
		startAfter: string | undefined,
		read: (key: string, rid: RunId) => Promise<JobRun | null>,
	): Promise<RunPage> {
		const listed = await this.bucket.list({
			prefix,
			limit: Math.max(1, Math.min(500, limit)),
			...(startAfter ? { startAfter } : {}),
		});
		const ids = listed.objects.map(({ key }) => {
			const rid = this.runIdFromIndex(prefix, key);
			if (!rid) throw new Error('Invalid run history index');
			return rid;
		});
		const runs = await mapWithConcurrency(listed.objects, BUCKET_SCAN_CONCURRENCY, (entry, index) =>
			read(entry.key, ids[index]),
		);
		return {
			items: runs.filter((run) => run !== null),
			nextRunId: listed.truncated && ids.length > 0 ? ids[ids.length - 1] : null,
		};
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

	async listRuns(projectId: ProjectId, notebookId: NotebookId, jobId: JobId): Promise<JobRun[]> {
		const runs: JobRun[] = [];
		for await (const run of this.iterateRuns(projectId, notebookId, jobId)) runs.push(run);
		return runs;
	}

	private async *iterateRuns(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		afterRunId?: RunId,
	): AsyncGenerator<JobRun> {
		let cursor = afterRunId;
		do {
			const page = await this.listRunsPage(projectId, notebookId, jobId, 500, cursor);
			yield* page.items;
			cursor = page.nextRunId ?? undefined;
		} while (cursor);
	}

	/** Scan at most limit index entries. Empty pages can carry a continuation. */
	async scanRunsPage(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		limit: number,
		afterRunId?: RunId,
	): Promise<RunPage> {
		const job = paths.project(projectId).notebook(notebookId).job(jobId);
		return this.readHistoryPage(
			job.runIndexPrefix,
			limit,
			afterRunId ? job.runIndex(afterRunId) : undefined,
			(_key, run_id) =>
				this.readHistoryRun({
					project_id: projectId,
					notebook_id: notebookId,
					job_id: jobId,
					run_id,
				}),
		);
	}

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
		const outcome = await this.updateRun(ref, (current) => {
			const next = nextRunStatus(current.status, event);
			if (next === null) return null;
			const status = current.stop_request && isTerminalRunStatus(next) ? 'cancelled' : next;
			const update = patch(current);
			if (Object.hasOwn(update, 'tags')) throw new Error('Run tags are immutable');
			if (Object.hasOwn(update, 'metadata') || Object.hasOwn(update, 'initial_metadata'))
				throw new Error('Use the metadata update operation');
			return {
				...current,
				...update,
				status,
				...(status === 'cancelled' && current.stop_request && event !== 'cancel'
					? { cancelled_by: current.stop_request.requested_by }
					: {}),
			};
		});
		if (outcome.transitioned) {
			this.metrics.increment('jobs.runs.transition', 1, { event, status: outcome.run.status });
		}
		return outcome;
	}

	private async updateRun(
		ref: Pick<JobRun, 'project_id' | 'notebook_id' | 'job_id' | 'run_id'>,
		update: (current: JobRun) => JobRun | null,
	) {
		const key = this.runPaths(ref).record;
		const result = await mutateObjectWithOutcome(
			this.bucket,
			key,
			(raw) => parseStoredJobRun(raw, key),
			(current) => {
				const value = update(current);
				return value ? JobRunSchema.parse(value) : null;
			},
			{
				notFound: () => new NotFoundError(`Run ${ref.run_id} not found`),
				onConflict: () => this.metrics.increment('jobs.runs.cas.conflict'),
				onExhausted: () => this.metrics.increment('jobs.runs.cas.exhausted'),
			},
		);
		return { run: result.value, transitioned: result.written };
	}

	async patchMetadata(ref: JobRun, patch: unknown): Promise<JobRun> {
		const parsed = RunMetadataPatchSchema.safeParse(patch);
		if (!parsed.success) throw new BadRequestError('Invalid metadata patch');
		const { run } = await this.updateRun(ref, (current) => {
			const now = Date.now();
			if (
				isTerminalRunStatus(current.status) ||
				(current.deadline_at && Date.parse(current.deadline_at) <= now) ||
				(current.stop_request && Date.parse(current.stop_request.deadline_at) <= now)
			)
				throw new ConflictError('Run no longer accepts metadata');
			const metadata = { ...current.metadata, ...parsed.data };
			for (const key of Object.keys(metadata)) {
				if (metadata[key] === null) delete metadata[key];
			}
			const bounded = RunMetadataSchema.safeParse(metadata);
			if (!bounded.success) throw new BadRequestError('Metadata exceeds its bounds');
			return { ...current, metadata: bounded.data };
		});
		return run;
	}

	async requestStop(ref: JobRun, by: UserId, graceSeconds?: number) {
		if (!RunStopBodySchema.safeParse({ grace_seconds: graceSeconds }).success)
			throw new BadRequestError('Grace must be an integer from 1 to 300 seconds');
		if (graceSeconds === undefined) return this.cancel(ref, by);
		return this.updateRun(ref, (current) => {
			if (isTerminalRunStatus(current.status) || current.stop_request) return null;
			const now = Date.now();
			if (current.status !== 'running')
				return {
					...current,
					status: 'cancelled',
					cancelled_by: by,
					finished_at: new Date(now).toISOString(),
				};

			const deadline = Math.min(
				now + graceSeconds * 1000,
				current.deadline_at ? Date.parse(current.deadline_at) : Infinity,
			);
			return {
				...current,
				stop_request: {
					requested_by: by,
					requested_at: new Date(now).toISOString(),
					deadline_at: new Date(deadline).toISOString(),
				},
			};
		});
	}

	async acknowledgeStop(ref: JobRun): Promise<JobRun> {
		const { run } = await this.updateRun(ref, (current) => {
			if (isTerminalRunStatus(current.status)) return null;
			if (!current.stop_request) throw new ConflictError('No stop was requested');
			const now = Date.now();
			const finishedAt = new Date(now).toISOString();
			const stopRequest = { ...current.stop_request };
			if (now < Date.parse(stopRequest.deadline_at)) stopRequest.acknowledged_at = finishedAt;
			return {
				...current,
				status: 'cancelled',
				cancelled_by: stopRequest.requested_by,
				finished_at: finishedAt,
				stop_request: stopRequest,
			};
		});
		return run;
	}

	async issueExecutionCredential(ref: JobRun): Promise<string> {
		const token = createRunCredential(ref);
		const hash = await hashRunCredential(token);
		await this.updateRun(ref, (current) => {
			if (current.status !== 'provisioning' || current.execution_credential_hash)
				throw new ConflictError('Run credential already issued or execution ended');
			return { ...current, execution_credential_hash: hash };
		});
		return token;
	}

	async authenticateExecution(token: string): Promise<JobRun> {
		const claims = parseRunCredential(token);
		if (!claims) throw new ForbiddenError('Invalid run credential');
		const run = await this.getRun(
			claims.project_id,
			claims.notebook_id,
			claims.job_id,
			claims.run_id,
		);
		if (
			run.attempt !== claims.attempt ||
			run.execution_credential_hash !== (await hashRunCredential(token)) ||
			!run.deadline_at ||
			Date.parse(run.deadline_at) <= Date.now()
		)
			throw new ForbiddenError('Invalid or expired run credential');
		return run;
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
		if (
			!(await this.bucket.head(key)) &&
			(await putIfAbsent(this.bucket, key, JSON.stringify(occurrence)))
		)
			return { claimed: true };
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

	async listActiveSnapshot(projectId?: ProjectId): Promise<ActiveRunSnapshot> {
		const keys = await listAllKeys(
			this.bucket,
			projectId ? paths.jobRunMarkersForProject(projectId) : paths.jobRunMarkersPrefix,
		);
		let complete = true;
		const active = await mapWithConcurrency(keys, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const markerObj = await this.bucket.get(key);
			if (!markerObj) return;
			let marker: JobRunMarker;
			try {
				marker = await readStored(JobRunMarkerSchema, markerObj, key);
			} catch (err) {
				complete = false;
				logOperationalError(
					'corrupt_job_run_marker_preserved',
					{ operation: 'job.run.marker.read', object: key },
					err,
				);
				return;
			}
			const recordKey = this.runPaths(marker).record;
			const recordObj = await this.bucket.get(recordKey);
			if (!recordObj) return { marker, run: null };
			try {
				return { marker, run: await readStoredJobRun(recordObj, recordKey) };
			} catch (err) {
				complete = false;
				logOperationalError(
					'stored_object_skipped',
					{ operation: 'job.run.active', object: recordKey },
					err,
				);
				return { marker, run: null };
			}
		});
		return { entries: active.filter((entry) => entry !== undefined), complete };
	}

	async listActive(projectId?: ProjectId): Promise<ActiveRun[]> {
		return (await this.listActiveSnapshot(projectId)).entries;
	}

	/** Sandbox ids held by active runs — the reconciler's second accounting source. */
	async activeSandboxIds(): Promise<string[]> {
		const active = await this.listActive();
		return active.flatMap(({ run }) =>
			run?.sandbox_id && !isTerminalRunStatus(run.status) ? [run.sandbox_id] : [],
		);
	}

	async deleteMarker(run: Pick<JobRun, 'project_id' | 'run_id'>): Promise<void> {
		const marker = await this.getMarker(run);
		if (marker) {
			const source = await this.bucket.get(this.runPaths(marker).record);
			if (source)
				await this.publishProjectRun(await readStoredJobRun(source, this.runPaths(marker).record));
		}
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
	async cancelRunsOfNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		by: UserId,
	): Promise<CancelledRuns> {
		await this.waitForJobMutations(projectId, notebookId);
		return this.cancelRunsWhere(
			(marker) => marker.project_id === projectId && marker.notebook_id === notebookId,
			by,
		);
	}

	async cancelRunsOfProject(projectId: ProjectId, by: UserId): Promise<CancelledRuns> {
		await this.waitForJobMutations(projectId);
		return this.cancelRunsWhere((marker) => marker.project_id === projectId, by);
	}

	/**
	 * Waits out operations admitted before the notebook or project stopped accepting them.
	 * `strict` rejects when a claim cannot be listed or drained instead of logging and moving on,
	 * for callers that must not proceed while an operation may still write.
	 */
	async waitForJobMutations(
		projectId: ProjectId,
		notebookId?: NotebookId,
		{ strict = false }: { strict?: boolean } = {},
	): Promise<void> {
		// Deletion marks the parent first. Earlier fires hold these claims before
		// checking its status; later fires see the deletion and cannot enqueue.
		const projectPrefix = paths.jobOperationClaimsForProject(projectId);
		const prefix = notebookId
			? paths.jobOperationClaimsForNotebook(projectId, notebookId)
			: projectPrefix;
		let keys: string[];
		try {
			keys = await listAllKeys(this.bucket, prefix);
		} catch (err) {
			if (strict) throw err;
			logOperationalError(
				'job_operation_wait_failed',
				{ operation: 'job.operation.wait', object: prefix },
				err,
			);
			return;
		}
		await forEachConcurrentUntilFailure({
			items: keys,
			concurrency: BUCKET_SCAN_CONCURRENCY,
			run: async (key) => {
				try {
					const [notebook, job] = key.slice(projectPrefix.length).split('/');
					await this.withJobMutation(
						{
							project_id: projectId,
							notebook_id: NotebookId.parse(notebook),
							id: JobId.parse(job.replace(/\.json$/, '')),
						},
						async () => {},
					);
				} catch (err) {
					if (strict) throw err;
					logOperationalError(
						'job_operation_wait_failed',
						{ operation: 'job.operation.wait', object: key },
						err,
					);
				}
			},
		});
	}

	private async cancelRunsWhere(
		matches: (marker: JobRunMarker) => boolean,
		by: UserId,
	): Promise<CancelledRuns> {
		const active = (await this.listActive()).filter(({ marker }) => matches(marker));
		const sandboxIds: string[] = [];
		const runs: JobRun[] = [];
		for (const { run } of active) {
			if (!run) continue;
			const { run: cancelled, transitioned } = await this.cancel(run, by);
			if (cancelled.sandbox_id) sandboxIds.push(cancelled.sandbox_id);
			if (transitioned) {
				runs.push(cancelled);
			}
		}
		return { runs, sandboxIds };
	}

	readPruneCursor(): Promise<RetentionCursor> {
		return readRetentionCursor(this.bucket, '_system/job-prune-cursor.json');
	}

	writePruneCursor(after: string, previous: RetentionCursor): Promise<void> {
		return writeRetentionCursor(this.bucket, '_system/job-prune-cursor.json', after, previous);
	}

	/**
	 * Keep runs and occurrence claims through both retention windows so catch-up
	 * cannot recreate a completed run. A finite `maxRecords` sets the page size;
	 * pages continue until `deadline`, so by default one page is listed.
	 */
	async pruneJob(
		job: Pick<JobDefinition, 'project_id' | 'notebook_id' | 'id'>,
		retentionMs: number,
		now: number = Date.now(),
		occurrenceRetentionMs: number = retentionMs,
		maxRecords = Infinity,
		deadline = 0,
	): Promise<number> {
		if (maxRecords <= 0) return 0;
		const cutoff = now - Math.max(retentionMs, occurrenceRetentionMs);
		const jobPaths = paths.project(job.project_id).notebook(job.notebook_id).job(job.id);
		// An all-zero suffix excludes the cutoff millisecond in the reversed index.
		// Older IDs still need a finish-time check to protect long-running jobs.
		const cutoffRunId = RunId.parse(
			`run_${encodeTime(Math.max(0, Math.ceil(cutoff)), 10)}${'0'.repeat(16)}`,
		);
		if (Number.isFinite(maxRecords))
			return this.pruneJobBatch(
				job.project_id,
				jobPaths,
				cutoff,
				cutoffRunId,
				maxRecords,
				deadline,
			);
		let pruned = 0;
		for await (const run of this.iterateRuns(
			job.project_id,
			job.notebook_id,
			job.id,
			cutoffRunId,
		)) {
			if (await this.pruneRun(run, cutoff, jobPaths)) pruned++;
		}
		for await (const page of iterateBucketPages(this.bucket, {
			prefix: jobPaths.occurrencesPrefix,
			limit: 100,
		})) {
			const stale = page.objects.filter(({ key }) => {
				const instant = occurrenceKeyToInstant(
					key.slice(jobPaths.occurrencesPrefix.length).replace(/\.json$/, ''),
				);
				return instant !== null && instant < cutoff;
			});
			if (stale.length > 0) await this.bucket.delete(stale.map(({ key }) => key));
		}
		if (pruned > 0) this.metrics.increment('jobs.runs.pruned', pruned);
		return pruned;
	}

	private async pruneJobBatch(
		projectId: ProjectId,
		jobPaths: JobPaths,
		cutoff: number,
		cutoffRunId: RunId,
		limit: number,
		deadline: number,
	): Promise<number> {
		const runsKey = `${jobPaths.base}/prune-runs.json`;
		const cursor = await readRetentionCursor(this.bucket, runsKey);
		const cutoffKey = jobPaths.runIndex(cutoffRunId);
		let startAfter =
			cursor.after.startsWith(jobPaths.runIndexPrefix) && cursor.after > cutoffKey
				? cursor.after
				: cutoffKey;
		let after = '';
		let pruned = 0;
		for (;;) {
			const page = await this.bucket.list({ prefix: jobPaths.runIndexPrefix, limit, startAfter });
			for (const item of page.objects) {
				const id = this.runIdFromIndex(jobPaths.runIndexPrefix, item.key);
				if (!id) continue;
				const key = jobPaths.run(id).record;
				try {
					const object = await this.bucket.get(key);
					if (!object) {
						if (await this.bucket.head(paths.jobRunMarker(projectId, id))) continue;
						await this.bucket.delete(paths.project(projectId).runIndex(id));
						await this.bucket.delete(item.key);
						continue;
					}
					const run = await readStoredJobRun(object, key);
					if (await this.pruneRun(run, cutoff, jobPaths, item.key)) pruned++;
				} catch (error) {
					if (error instanceof Error && error.name === 'AbortError') throw error;
					logOperationalError(
						error instanceof StoredObjectError ? 'stored_object_skipped' : 'job_run_prune_failed',
						{ operation: 'job.run.prune', object: key },
						error,
					);
				}
			}
			after = page.truncated ? (page.objects.at(-1)?.key ?? '') : '';
			if (!after || Date.now() >= deadline) break;
			startAfter = after;
		}
		await writeRetentionCursor(this.bucket, runsKey, after, cursor);
		const occurrencesKey = `${jobPaths.base}/prune-occurrences.json`;
		const occurrenceCursor = await readRetentionCursor(this.bucket, occurrencesKey);
		let occurrenceAfter = occurrenceCursor.after.startsWith(jobPaths.occurrencesPrefix)
			? occurrenceCursor.after
			: '';
		for (;;) {
			const occurrences = await this.bucket.list({
				prefix: jobPaths.occurrencesPrefix,
				limit,
				startAfter: occurrenceAfter || undefined,
			});
			let live = false;
			const expired = occurrences.objects.filter(({ key }) => {
				const instant = occurrenceKeyToInstant(
					key.slice(jobPaths.occurrencesPrefix.length).replace(/\.json$/, ''),
				);
				if (instant !== null && instant >= cutoff) live = true;
				return instant !== null && instant < cutoff;
			});
			if (expired.length > 0) await this.bucket.delete(expired.map(({ key }) => key));
			// Keys sort chronologically, so everything after a live key is live too.
			occurrenceAfter =
				occurrences.truncated && !live ? (occurrences.objects.at(-1)?.key ?? '') : '';
			if (!occurrenceAfter || Date.now() >= deadline) break;
		}
		await writeRetentionCursor(this.bucket, occurrencesKey, occurrenceAfter, occurrenceCursor);
		if (pruned > 0) this.metrics.increment('jobs.runs.pruned', pruned);
		return pruned;
	}

	private async pruneRun(
		run: JobRun,
		cutoff: number,
		jobPaths: JobPaths,
		indexKey = jobPaths.runIndex(run.run_id),
	): Promise<boolean> {
		if (
			!isTerminalRunStatus(run.status) ||
			!(Date.parse(run.finished_at ?? run.queued_at) < cutoff)
		)
			return false;
		if (await this.bucket.head(paths.jobRunMarker(run.project_id, run.run_id))) return false;
		await deleteByPrefix(this.bucket, jobPaths.run(run.run_id).base);
		// Keep the job index until project cleanup succeeds so bounded pruning can retry.
		await this.bucket.delete(paths.project(run.project_id).runIndex(run.run_id));
		await this.bucket.delete(indexKey);
		return true;
	}

	async pruneDanglingMarker(marker: JobRunMarker): Promise<void> {
		const index = paths
			.project(marker.project_id)
			.notebook(marker.notebook_id)
			.job(marker.job_id)
			.runIndex(marker.run_id);
		await this.bucket.delete(paths.project(marker.project_id).runIndex(marker.run_id));
		await this.bucket.delete(index);
		await this.deleteMarker(marker);
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
			try {
				// An unreadable record still needs its sandbox ownership marker.
				if (
					await this.runExists(marker.project_id, marker.notebook_id, marker.job_id, marker.run_id)
				) {
					continue;
				}
				await this.pruneDanglingMarker(marker);
				pruned++;
			} catch (err) {
				logOperationalError(
					'job_run_marker_prune_failed',
					{ operation: 'job.runs.prune_marker', run_id: marker.run_id },
					err,
				);
			}
		}
		return pruned;
	}
}

export { RunId };

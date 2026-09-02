import type { Bucket } from '../../ports/bucket';
import {
	NotFoundError,
	ResourceExhaustedError,
	ValidationError,
	assertVersionMatch,
} from '../../errors';
import { createJobId } from '../../ids';
import type { JobId, NotebookId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { CURRENT_JOB_VERSION, JobDefinitionSchema, parseStored, readStored } from '../../schema';
import type {
	JobDefinition,
	JobNotifications,
	JobParameters,
	JobRetryPolicy,
	JobSchedule,
	JobConcurrencyPolicy,
	Snapshot,
	SnapshotJobEntry,
} from '../../schema';
import { nextIsoTimestamp } from '../../utcDate';
import { mutateObject } from '../catalog/cas';
import { deleteByPrefix, listAllPrefixes, readStoredObjects } from '../catalog/storage';
import type { CatalogService } from '../catalog/CatalogService';
import { isValidTimeZone, parseCron } from './cron';

export interface CreateJobInput {
	name: string;
	enabled?: boolean;
	schedule?: JobSchedule;
	parameters?: JobParameters;
	retry?: JobRetryPolicy;
	timeout_seconds?: number;
	concurrency_policy?: JobConcurrencyPolicy;
	notifications?: JobNotifications;
}

/** `null` clears an optional field; `undefined` leaves it untouched. */
export interface UpdateJobInput {
	name?: string;
	enabled?: boolean;
	schedule?: JobSchedule | null;
	parameters?: JobParameters | null;
	retry?: JobRetryPolicy | null;
	timeout_seconds?: number | null;
	concurrency_policy?: JobConcurrencyPolicy;
	notifications?: JobNotifications | null;
}

export interface JobLimits {
	/** Definition cap per notebook; undefined = unlimited. */
	maxPerNotebook?: number;
	/** Ceiling on `timeout_seconds`; undefined = uncapped. */
	maxTimeoutSeconds?: number;
}

export interface IndexedJob {
	projectId: ProjectId;
	notebookId: NotebookId;
	entry: SnapshotJobEntry;
}

export function validateJobSchedule(schedule: JobSchedule): void {
	parseCron(schedule.cron);
	if (!isValidTimeZone(schedule.timezone)) {
		throw new ValidationError(
			`Unknown time zone "${schedule.timezone}"; use an IANA name such as UTC or Europe/Berlin`,
		);
	}
}

function validateTimeout(timeoutSeconds: number | undefined, limits: JobLimits): void {
	if (
		timeoutSeconds !== undefined &&
		limits.maxTimeoutSeconds !== undefined &&
		timeoutSeconds > limits.maxTimeoutSeconds
	) {
		throw new ValidationError(
			`timeout_seconds may not exceed ${limits.maxTimeoutSeconds} (MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS)`,
		);
	}
}

function toIndexEntry(job: JobDefinition): SnapshotJobEntry {
	return {
		id: job.id,
		enabled: job.enabled,
		...(job.schedule ? { schedule: job.schedule } : {}),
	};
}

/** Every job the snapshot indexes, skipping soft-deleted projects and notebooks. */
export function indexedJobs(snapshot: Snapshot): IndexedJob[] {
	const jobs: IndexedJob[] = [];
	for (const project of snapshot.projects) {
		if (project.status === 'deleted') continue;
		for (const notebook of project.notebooks) {
			if (notebook.status === 'deleted') continue;
			for (const entry of notebook.jobs ?? []) {
				jobs.push({ projectId: project.id, notebookId: notebook.id, entry });
			}
		}
	}
	return jobs;
}

/**
 * Owner of every `job.json` head (ETag CAS) and of the snapshot's per-notebook
 * job index. Runs are owned by `JobRunService`.
 */
export class JobsService {
	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
	) {}

	async listJobs(projectId: ProjectId, notebookId: NotebookId): Promise<JobDefinition[]> {
		const nb = paths.project(projectId).notebook(notebookId);
		const prefixes = await listAllPrefixes(this.bucket, nb.jobsPrefix);
		const jobs = await readStoredObjects(
			this.bucket,
			prefixes.map((prefix) => `${prefix}job.json`),
			JobDefinitionSchema,
			'job.list',
		);
		return jobs.sort(
			(a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
		);
	}

	async getJob(projectId: ProjectId, notebookId: NotebookId, jobId: JobId): Promise<JobDefinition> {
		const key = paths.project(projectId).notebook(notebookId).job(jobId).head;
		const obj = await this.bucket.get(key);
		if (!obj) throw new NotFoundError(`Job ${jobId} not found`);
		return readStored(JobDefinitionSchema, obj, key);
	}

	async createJob(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: CreateJobInput,
		actor: UserId,
		limits: JobLimits = {},
	): Promise<JobDefinition> {
		if (input.schedule) validateJobSchedule(input.schedule);
		validateTimeout(input.timeout_seconds, limits);
		if (limits.maxPerNotebook !== undefined) {
			const existing = await this.listJobs(projectId, notebookId);
			if (existing.length >= limits.maxPerNotebook) {
				throw new ResourceExhaustedError(
					`Job limit reached for this notebook (${limits.maxPerNotebook}). Delete a job before creating another.`,
				);
			}
		}
		const now = new Date().toISOString();
		const job = JobDefinitionSchema.parse({
			schema_version: CURRENT_JOB_VERSION,
			id: createJobId(),
			notebook_id: notebookId,
			project_id: projectId,
			name: input.name,
			enabled: input.enabled ?? true,
			...(input.schedule ? { schedule: input.schedule } : {}),
			...(input.parameters ? { parameters: input.parameters } : {}),
			...(input.retry ? { retry: input.retry } : {}),
			...(input.timeout_seconds !== undefined ? { timeout_seconds: input.timeout_seconds } : {}),
			concurrency_policy: input.concurrency_policy ?? 'forbid',
			...(input.notifications ? { notifications: input.notifications } : {}),
			created_by: actor,
			created_at: now,
			updated_at: now,
		});
		const key = paths.project(projectId).notebook(notebookId).job(job.id).head;
		await this.bucket.put(key, JSON.stringify(job), { onlyIfNotExists: true });
		await this.syncIndex('job.create', actor, job, toIndexEntry(job));
		return job;
	}

	async updateJob(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		input: UpdateJobInput,
		actor: UserId,
		expectedVersion?: string,
		limits: JobLimits = {},
	): Promise<JobDefinition> {
		if (input.schedule) validateJobSchedule(input.schedule);
		validateTimeout(input.timeout_seconds ?? undefined, limits);
		const key = paths.project(projectId).notebook(notebookId).job(jobId).head;
		const updated = await mutateObject(
			this.bucket,
			key,
			(raw) => parseStored(JobDefinitionSchema, raw, key),
			(current) => {
				assertVersionMatch(current.updated_at, expectedVersion);
				const next: JobDefinition = { ...current };
				if (input.name !== undefined) next.name = input.name;
				if (input.enabled !== undefined) next.enabled = input.enabled;
				if (input.concurrency_policy !== undefined)
					next.concurrency_policy = input.concurrency_policy;
				applyOptional(next, 'schedule', input.schedule);
				applyOptional(next, 'parameters', input.parameters);
				applyOptional(next, 'retry', input.retry);
				applyOptional(next, 'timeout_seconds', input.timeout_seconds);
				applyOptional(next, 'notifications', input.notifications);
				next.updated_at = nextIsoTimestamp(current.updated_at, new Date().toISOString());
				return JobDefinitionSchema.parse(next);
			},
			{ notFound: () => new NotFoundError(`Job ${jobId} not found`) },
		);
		await this.syncIndex('job.update', actor, updated, toIndexEntry(updated));
		return updated;
	}

	/**
	 * Delete the definition and everything beneath it (occurrences, runs,
	 * outputs). Callers cancel active runs first so no sandbox outlives its record.
	 */
	async deleteJob(
		projectId: ProjectId,
		notebookId: NotebookId,
		jobId: JobId,
		actor: UserId,
	): Promise<void> {
		const job = await this.getJob(projectId, notebookId, jobId);
		await deleteByPrefix(
			this.bucket,
			paths.project(projectId).notebook(notebookId).job(jobId).base,
		);
		await this.syncIndex('job.delete', actor, job, null);
	}

	private async syncIndex(
		operation: string,
		actor: UserId,
		job: JobDefinition,
		entry: SnapshotJobEntry | null,
	): Promise<void> {
		await this.catalog.updateNotebookEntry(
			operation,
			actor,
			job.project_id,
			job.notebook_id,
			(notebook) => {
				const others = (notebook.jobs ?? []).filter((candidate) => candidate.id !== job.id);
				return { jobs: entry ? [...others, entry] : others };
			},
			undefined,
			{ project_id: job.project_id, notebook_id: job.notebook_id, job_id: job.id },
		);
	}
}

function applyOptional<
	K extends 'schedule' | 'parameters' | 'retry' | 'timeout_seconds' | 'notifications',
>(target: JobDefinition, key: K, value: JobDefinition[K] | null | undefined): void {
	if (value === undefined) return;
	if (value === null) delete target[key];
	else target[key] = value;
}

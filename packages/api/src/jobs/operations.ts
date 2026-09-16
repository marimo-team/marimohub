import {
	BadRequestError,
	JobId,
	MAX_QUEUED_RUNS_PER_JOB,
	Millis,
	NotFoundError,
	ResourceExhaustedError,
	toPublicJobDefinition,
	withAbortSignal,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	JobDefinition,
	JobRun,
	NotebookId,
	ProjectId,
	RunId,
} from '@marimo-hub/core';
import type { z } from 'zod';
import type { ApiDeps, JobsConfig } from '../context';
import { idempotentOperation } from '../idempotency';
import { appendAudit } from '../log';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor, MAX_PAGE_SIZE } from '../pagination';
import { assertProjectRole, loadAuthorizedNotebook, loadVisibleProject } from '../shared';
import type { CreateJobBody, TriggerRunBody, UpdateJobBody } from './schemas';

export function requireJobs(deps: ApiDeps): JobsConfig {
	if (!deps.jobs) throw new NotFoundError('Notebook jobs are not enabled on this deployment');
	return deps.jobs;
}

function jobLimits(deps: ApiDeps) {
	const config = requireJobs(deps);
	return {
		maxPerNotebook: config.maxPerNotebook,
		maxTimeoutSeconds: Millis.toSeconds(config.maxTimeoutMs),
	};
}

export async function authorizeJobNotebook(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
	action: 'project.read' | 'notebook.write',
) {
	requireJobs(deps);
	const project =
		action === 'notebook.write'
			? await assertProjectRole(deps.services.projects, pid, user, action, deps)
			: await loadVisibleProject(deps.services.projects, pid, user, deps);
	const notebook = await loadAuthorizedNotebook(deps, project, nid, user, action);
	return { project, notebook, user };
}

export type AuthorizedNotebook = Awaited<ReturnType<typeof authorizeJobNotebook>>;

export async function listNotebookJobs(
	deps: ApiDeps,
	pid: ProjectId,
	nid: NotebookId,
	query: { limit?: number; cursor?: string },
) {
	const cursor = decodeCursor(query.cursor);
	let after: { createdAt: string; jobId: JobId } | undefined;
	if (cursor) {
		if (!Number.isFinite(Date.parse(cursor[0])) || !JobId.is(cursor[1])) {
			throw new BadRequestError('Invalid pagination cursor');
		}
		after = { createdAt: cursor[0], jobId: JobId.parse(cursor[1]) };
	}
	const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const page = await deps.services.jobs.listJobsPage(pid, nid, limit, after);
	return {
		items: page.items.map(toPublicJobDefinition),
		next_cursor: page.next ? encodeCursor(page.next.createdAt, page.next.jobId) : null,
	};
}

export function createNotebookJob(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	body: z.infer<typeof CreateJobBody>,
) {
	return deps.services.jobs.createJob(
		target.project.id,
		target.notebook.meta.id,
		body,
		target.user.id,
		jobLimits(deps),
	);
}

export function updateNotebookJob(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
	body: z.infer<typeof UpdateJobBody>,
	expectedUpdatedAt?: string,
	signal?: AbortSignal,
) {
	return deps.services.jobRuns.withJobMutation(job, async () => {
		if (await deps.services.jobs.isDeleting(job))
			throw new NotFoundError(`Job ${job.id} not found`);
		signal?.throwIfAborted();
		return deps.services.jobs.updateJob(
			target.project.id,
			target.notebook.meta.id,
			job.id,
			body,
			target.user.id,
			expectedUpdatedAt,
			jobLimits(deps),
		);
	});
}

export async function triggerJobRun(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
	body: z.infer<typeof TriggerRunBody> | undefined,
	request: { requestId?: string; method: string; path: string },
	signal?: AbortSignal,
	replay?: { scope: string; key?: string },
) {
	const { project, notebook, user } = target;
	return deps.services.jobRuns.withJobMutation(job, async () => {
		if (await deps.services.jobs.isDeleting(job))
			throw new NotFoundError(`Job ${job.id} not found`);
		signal?.throwIfAborted();
		const enqueue = async () => {
			const current = await deps.services.jobs.getJob(project.id, notebook.meta.id, job.id);
			const queued = (await deps.services.jobRuns.listActive()).filter(
				({ marker, run }) => marker.job_id === job.id && run?.status === 'queued',
			);
			if (queued.length >= MAX_QUEUED_RUNS_PER_JOB) {
				throw new ResourceExhaustedError(
					`Too many queued runs for this job (${MAX_QUEUED_RUNS_PER_JOB}); wait for the queue to drain.`,
				);
			}
			const config = requireJobs(deps);
			const requestedMs =
				current.timeout_seconds !== undefined
					? current.timeout_seconds * 1000
					: config.defaultTimeoutMs;
			signal?.throwIfAborted();
			const run = await deps.services.jobRuns.enqueue({
				job: current,
				trigger: 'manual',
				triggeredBy: user.id,
				parameters: body?.parameters ?? current.parameters,
				sourceVersionId: notebook.source.current_version_id ?? undefined,
				timeoutSeconds: Math.floor(Math.min(requestedMs, config.maxTimeoutMs) / 1000),
			});
			await appendAudit({ ...request, userId: user.id }, 'job.run.trigger', () =>
				deps.services.events.append({
					event: 'job.run.trigger',
					actor: user.id,
					project_id: project.id,
					notebook_id: notebook.meta.id,
					job_id: job.id,
					run_id: run.run_id,
				}),
			);
			return run;
		};
		if (!replay?.key) return enqueue();
		// Keep lookup, enqueue, and recording under the same distributed job claim.
		let created: JobRun | undefined;
		const runId = await idempotentOperation(deps, replay.scope, replay.key, async () => {
			created = await enqueue();
			return created.run_id;
		});
		return created ?? withAbortSignal(loadJobRun(deps, job, runId), signal);
	});
}

export async function loadJobRun(deps: ApiDeps, job: JobDefinition, rid: RunId) {
	const run = await deps.services.jobRuns.getRun(job.project_id, job.notebook_id, job.id, rid);
	if (run.job_id !== job.id) throw new NotFoundError(`Run ${rid} not found`);
	return run;
}

import { jobCapabilities, toSharedJobRunSummary } from '@marimo-hub/core/jobs';
import type { JobCapabilities } from '@marimo-hub/core/jobs';
import {
	BadRequestError,
	ForbiddenError,
	toPublicJobRun,
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
import {
	authorizationService,
	assertProjectRole,
	loadAuthorizedNotebookMeta,
	loadSessionProject,
} from '../shared';
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
			: await loadSessionProject(deps.services.projects, pid, user, deps);
	const notebook = await loadAuthorizedNotebookMeta(
		deps,
		project,
		nid,
		user,
		action === 'project.read' ? authorizationService(deps).appReadAction(user, project) : action,
	);
	return { project, notebook, user };
}

export type JobNotebookAction = 'project.read' | 'notebook.write';
export type JobAction = JobNotebookAction | 'job.trigger';

export async function resolveJobAccess<T>(
	action: JobAction,
	resolve: (action: JobNotebookAction) => Promise<T>,
): Promise<{ target: T; action: JobNotebookAction }> {
	if (action !== 'job.trigger') return { target: await resolve(action), action };
	// Write-only credentials must keep working without a separate read grant.
	try {
		return { target: await resolve('notebook.write'), action: 'notebook.write' };
	} catch (error) {
		if (!(error instanceof ForbiddenError || error instanceof NotFoundError)) throw error;
		return { target: await resolve('project.read'), action: 'project.read' };
	}
}

export async function loadAuthorizedJob(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
	jid: JobId,
	action: JobNotebookAction = 'project.read',
) {
	const target = await authorizeJobNotebook(deps, user, pid, nid, action);
	return { ...target, job: await deps.services.jobs.getJob(pid, nid, jid) };
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
		target.notebook.id,
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
			target.notebook.id,
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
		const current = await deps.services.jobs.getJob(project.id, notebook.id, job.id);
		await authorizeJobTrigger(deps, target, current);
		const enqueue = async () => {
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
				tags: body?.tags,
				sourceVersionId:
					(await deps.services.notebooks.getNotebookSource(project.id, notebook.id))
						.current_version_id ?? undefined,
				timeoutSeconds: Math.floor(Math.min(requestedMs, config.maxTimeoutMs) / 1000),
			});
			await appendAudit(deps, { ...request, userId: user.id }, 'job.run.trigger', () =>
				deps.services.events.append({
					event: 'job.run.trigger',
					actor: user.id,
					project_id: project.id,
					notebook_id: notebook.id,
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

export async function getJobCapabilities(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
	run?: JobRun,
): Promise<JobCapabilities> {
	const authz = authorizationService(deps);
	const resource = {
		kind: 'project' as const,
		project: target.project,
		notebookLabels: target.notebook.security_labels ?? null,
	};
	const editor = await authz.authorize(target.user, 'notebook.write', resource);
	const trigger = await authz.authorize(target.user, 'job.trigger', resource);
	return jobCapabilities({
		job,
		run,
		userId: target.user.id,
		editor: editor.allowed,
		triggerAllowed: trigger.allowed,
	});
}

export async function authorizeJobTrigger(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
) {
	if (!(await getJobCapabilities(deps, target, job)).canTrigger)
		throw new ForbiddenError('This job does not permit execution by this caller');
}

export function projectJobRun(run: JobRun, capabilities: JobCapabilities) {
	switch (capabilities.history) {
		case 'full':
			return toPublicJobRun(run);
		case 'summary':
			return toSharedJobRunSummary(run);
		case 'none':
			return null;
	}
}

export async function visibleJobRun(
	deps: ApiDeps,
	target: AuthorizedNotebook,
	job: JobDefinition,
	run: JobRun,
) {
	return projectJobRun(run, await getJobCapabilities(deps, target, job, run));
}

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
	JOB_CONCURRENCY_POLICIES,
	JOB_NOTIFICATION_EVENTS,
	JOB_PARAMETER_KEY_PATTERN,
	appendJobRunFinishEvent,
	isTerminalRunStatus,
	JobId,
	MAX_JOB_NAME_LENGTH,
	MAX_JOB_PARAMETER_VALUE_LENGTH,
	MAX_JOB_PARAMETERS,
	MAX_JOB_RETRIES,
	MAX_JOB_RETRY_BACKOFF_SECONDS,
	MIN_JOB_TIMEOUT_SECONDS,
	Millis,
	nextOccurrence,
	BadRequestError,
	NotFoundError,
	parseCron,
	ResourceExhaustedError,
	RUN_STATUSES,
	RUN_TRIGGERS,
	RunId,
	toPublicJobDefinition,
	toPublicJobRun,
} from '@marimo-hub/core';
import type { JobDefinition, JobRun, PublicJobDefinition } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv, JobsConfig } from '../context';
import { idempotentCreate } from '../idempotency';
import { appendAudit } from '../log';
import {
	decodeCursor,
	DEFAULT_PAGE_SIZE,
	encodeCursor,
	MAX_PAGE_SIZE,
	pageSchema,
	PaginationQuery,
} from '../pagination';
import {
	assertProjectRole,
	commonErrors,
	ComputeResourcesResponseSchema,
	createApp,
	destroySandboxes,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	extensibleResponseEnum,
	fail,
	IdempotencyKeyHeader,
	ifMatchToken,
	IfMatchHeader,
	jsonBody,
	jsonContent,
	loadAuthorizedNotebook,
	loadVisibleProject,
	NotebookIdParam,
	SuccessResponseSchema,
} from '../shared';

/** Manual triggers only enqueue; this bounds how far a client can stack them. */
const MAX_QUEUED_RUNS_PER_JOB = 20;

// --- Params ---

export const JobIdParam = NotebookIdParam.extend({
	jid: z
		.string()
		.regex(JobId.regex)
		.refine(JobId.is)
		.openapi({ param: { name: 'jid', in: 'path' }, example: 'job-7h2k9qm4xz7rp3w8' }),
});

export const RunIdParam = JobIdParam.extend({
	rid: z
		.string()
		.regex(RunId.regex)
		.refine(RunId.is)
		.openapi({ param: { name: 'rid', in: 'path' }, example: 'run_01HXYZ33333RSTUVWXYZABCDEF' }),
});

// --- Body + response schemas ---

const JobScheduleShape = z.object({
	cron: z.string().min(1).max(100).openapi({
		description: 'Five-field cron expression (minute hour day-of-month month day-of-week).',
		example: '0 6 * * 1-5',
	}),
	timezone: z.string().min(1).max(64).openapi({
		description: 'IANA time zone the cron fields are evaluated in.',
		example: 'Europe/Berlin',
	}),
});
const JobScheduleSchema = JobScheduleShape.openapi('JobSchedule');

const JobRetryPolicyShape = z.object({
	max_retries: z.number().int().min(0).max(MAX_JOB_RETRIES),
	backoff_seconds: z.number().int().min(0).max(MAX_JOB_RETRY_BACKOFF_SECONDS).default(60),
});
const JobRetryPolicySchema = JobRetryPolicyShape.openapi('JobRetryPolicy');

const JobParametersShape = z
	.record(
		z.string().regex(JOB_PARAMETER_KEY_PATTERN),
		z.string().max(MAX_JOB_PARAMETER_VALUE_LENGTH),
	)
	.refine((parameters) => Object.keys(parameters).length <= MAX_JOB_PARAMETERS, {
		message: `At most ${MAX_JOB_PARAMETERS} parameters are allowed`,
	});
const JobParametersSchema = JobParametersShape.openapi('JobParameters', {
	description:
		'String parameters passed to the notebook as `--key value` after `--`, readable via `mo.cli_args()`.',
	example: { region: 'eu-west-1' },
});

const JobNotificationsShape = z.object({
	on: z
		.array(z.enum(JOB_NOTIFICATION_EVENTS))
		.min(1)
		.refine((events) => new Set(events).size === events.length, {
			message: 'Notification events must be unique',
		}),
});
const JobNotificationsSchema = JobNotificationsShape.openapi('JobNotifications', {
	description:
		'Deliver `job.run.failed` / `job.run.succeeded` project alerts for this job. Failures notify once retries are exhausted.',
});

const TimeoutSchema = z.number().int().min(MIN_JOB_TIMEOUT_SECONDS).openapi({
	description: 'Run deadline in seconds; capped by MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS.',
	example: 1800,
});

const CreateJobBody = z
	.strictObject({
		name: z.string().min(1).max(MAX_JOB_NAME_LENGTH).openapi({ example: 'Nightly refresh' }),
		enabled: z.boolean().optional(),
		/** Absent = manual-trigger only. */
		schedule: JobScheduleSchema.optional(),
		parameters: JobParametersSchema.optional(),
		retry: JobRetryPolicySchema.optional(),
		timeout_seconds: TimeoutSchema.optional(),
		concurrency_policy: z.enum(JOB_CONCURRENCY_POLICIES).optional(),
		notifications: JobNotificationsSchema.optional(),
	})
	.openapi('JobCreateBody');

const UpdateJobBody = z
	.strictObject({
		name: z.string().min(1).max(MAX_JOB_NAME_LENGTH).optional(),
		enabled: z.boolean().optional(),
		// Inline (unnamed) shapes: a nullable `$ref` renders as an `allOf` the
		// generated client cannot assign `null` to.
		schedule: JobScheduleShape.nullable().optional(),
		parameters: JobParametersShape.nullable().optional(),
		retry: JobRetryPolicyShape.nullable().optional(),
		timeout_seconds: TimeoutSchema.nullable().optional(),
		concurrency_policy: z.enum(JOB_CONCURRENCY_POLICIES).optional(),
		notifications: JobNotificationsShape.nullable().optional(),
	})
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: 'At least one field is required.',
	})
	.openapi('JobUpdateBody');

const TriggerRunBody = z
	.strictObject({
		/** Overrides the job's stored parameters for this run only. */
		parameters: JobParametersSchema.optional(),
	})
	.openapi('JobRunTriggerBody');

const JobResponseSchema = z
	.object({
		id: z.string().regex(JobId.regex),
		notebook_id: z.string(),
		project_id: z.string(),
		name: z.string(),
		enabled: z.boolean(),
		schedule: JobScheduleSchema.optional(),
		parameters: JobParametersSchema.optional(),
		retry: JobRetryPolicySchema.optional(),
		timeout_seconds: z.number().int().optional(),
		concurrency_policy: extensibleResponseEnum(JOB_CONCURRENCY_POLICIES, 'forbid'),
		notifications: JobNotificationsSchema.optional(),
		created_by: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		/** The next scheduled fire, or null when disabled or manual-only. */
		next_run_at: z.iso.datetime().nullable(),
	})
	.openapi('Job');

const RunErrorSchema = z.object({ code: z.string(), message: z.string() });

const JobRunResponseSchema = z
	.object({
		run_id: z.string().regex(RunId.regex),
		job_id: z.string(),
		notebook_id: z.string(),
		project_id: z.string(),
		status: extensibleResponseEnum(RUN_STATUSES, 'queued'),
		trigger: extensibleResponseEnum(RUN_TRIGGERS, 'manual'),
		triggered_by: z.string().optional(),
		scheduled_for: z.iso.datetime().optional(),
		source_version_id: z.string().optional(),
		parameters: JobParametersSchema.optional(),
		attempt: z.number().int(),
		retry_of: z.string().optional(),
		/** Provenance of the sandbox the run provisioned with, as on session records. */
		image: z.string().optional(),
		compute_profile: z.string().optional(),
		compute_resources: ComputeResourcesResponseSchema.optional(),
		timeout_seconds: z.number().int(),
		queued_at: z.iso.datetime(),
		eligible_at: z.iso.datetime().optional(),
		started_at: z.iso.datetime().optional(),
		finished_at: z.iso.datetime().optional(),
		deadline_at: z.iso.datetime().optional(),
		exit_code: z.number().int().optional(),
		error: RunErrorSchema.optional(),
		output: z
			.object({
				html_bytes: z.number().int(),
				session_bytes: z.number().int().optional(),
				logs_bytes: z.number().int().optional(),
			})
			.optional(),
		cancelled_by: z.string().optional(),
	})
	.openapi('JobRun');

// --- Route definitions ---

const listJobs = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/jobs',
	operationId: 'jobs.list',
	tags: ['Jobs'],
	summary: 'List a notebook’s jobs',
	request: { params: NotebookIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: pageSchema(JobResponseSchema, 'JobPage') }),
			'Job definitions, oldest first',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const createJob = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/jobs',
	operationId: 'jobs.create',
	tags: ['Jobs'],
	summary: 'Create a job',
	description:
		'A job runs the notebook headlessly with `marimo export html` — on a cron schedule, or on demand via `jobs.runs.trigger`. Runs execute with the project’s resolved integration secrets and federated credentials, so this requires the editor role like starting a session.',
	request: {
		params: NotebookIdParam,
		headers: IdempotencyKeyHeader,
		body: jsonBody(CreateJobBody),
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: JobResponseSchema }),
			'Job created',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 422, 429),
	},
});

const getJob = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}',
	operationId: 'jobs.get',
	tags: ['Jobs'],
	summary: 'Get a job',
	request: { params: JobIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: JobResponseSchema }),
			'Job',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const updateJob = createRoute({
	method: 'patch',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}',
	operationId: 'jobs.update',
	tags: ['Jobs'],
	summary: 'Update a job',
	description:
		'Partial update. `null` clears an optional field (schedule, parameters, retry, timeout, notifications).',
	request: { params: JobIdParam, headers: IfMatchHeader, body: jsonBody(UpdateJobBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: JobResponseSchema }),
			'Job updated',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412, 422),
	},
});

const deleteJob = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}',
	operationId: 'jobs.delete',
	'x-cli-destructive': true,
	tags: ['Jobs'],
	summary: 'Delete a job and its run history',
	description: 'Active runs are cancelled and their sandboxes destroyed first.',
	request: { params: JobIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Job deleted'),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const triggerRun = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/runs',
	operationId: 'jobs.runs.trigger',
	tags: ['Jobs'],
	summary: 'Run a job now',
	description:
		'Enqueues a run; the scheduler on the maintenance replica dispatches it within one tick. Returns the queued run — poll `jobs.runs.get` for progress.',
	request: {
		params: JobIdParam,
		headers: IdempotencyKeyHeader,
		body: { content: { 'application/json': { schema: TriggerRunBody } }, required: false },
	},
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: JobRunResponseSchema }),
			'Run queued',
		),
		...commonErrors(),
		...errorResponses(403, 404, 422, 429),
	},
});

const listRuns = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/runs',
	operationId: 'jobs.runs.list',
	tags: ['Jobs'],
	summary: 'List a job’s runs',
	request: { params: JobIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: pageSchema(JobRunResponseSchema, 'JobRunPage') }),
			'Runs, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 404),
	},
});

const getRun = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/runs/{rid}',
	operationId: 'jobs.runs.get',
	tags: ['Jobs'],
	summary: 'Get a run',
	request: { params: RunIdParam },
	responses: {
		200: jsonContent(z.object({ success: z.literal(true), data: JobRunResponseSchema }), 'Run'),
		...commonErrors(),
		...errorResponses(404),
	},
});

const cancelRun = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/runs/{rid}/cancel',
	operationId: 'jobs.runs.cancel',
	'x-cli-destructive': true,
	tags: ['Jobs'],
	summary: 'Cancel a run',
	description:
		'Marks the run cancelled and destroys its sandbox when one exists. Runs are history and are never deleted individually.',
	request: { params: RunIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: JobRunResponseSchema }),
			'Run cancelled (or already terminal)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const getRunHtml = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/runs/{rid}/html',
	operationId: 'jobs.runs.html',
	tags: ['Jobs'],
	summary: 'Rendered notebook output of a run',
	description:
		'Serves the HTML the run exported, raw. 404 with code `NO_RUN_OUTPUT` when the run captured none (still running, cancelled, or failed before exporting).',
	request: { params: RunIdParam },
	responses: {
		200: {
			content: { 'text/html': { schema: z.string() } },
			description: 'The rendered output, served sandboxed (CSP forces an opaque origin)',
		},
		...commonErrors(),
		...errorResponses(404),
	},
});

const getRunLogs = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/runs/{rid}/logs',
	operationId: 'jobs.runs.logs',
	tags: ['Jobs'],
	summary: 'stdout/stderr of a run',
	description:
		'Raw text, editor-only: logs can echo environment values and tracebacks the viewer role cannot otherwise read. 404 with code `NO_RUN_OUTPUT` when none were captured.',
	request: { params: RunIdParam },
	responses: {
		200: { content: { 'text/plain': { schema: z.string() } }, description: 'Captured logs' },
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

// --- Helpers ---

function requireJobs(deps: ApiDeps): JobsConfig {
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

function nextRunAt(job: JobDefinition, now = Date.now()): string | null {
	if (!job.enabled || !job.schedule) return null;
	try {
		const next = nextOccurrence(parseCron(job.schedule.cron), job.schedule.timezone, now);
		return next === null ? null : new Date(next).toISOString();
	} catch {
		return null;
	}
}

function toJobResponse(job: JobDefinition): PublicJobDefinition & { next_run_at: string | null } {
	return { ...toPublicJobDefinition(job), next_run_at: nextRunAt(job) };
}

/** Viewer read gate: visible project + authorized notebook, then the job. */
async function loadReadableJob(
	c: Context<HonoEnv>,
	pid: JobRun['project_id'],
	nid: JobRun['notebook_id'],
	jid: JobDefinition['id'],
) {
	const deps = c.get('deps');
	const user = c.get('user');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
	return { project, job: await deps.services.jobs.getJob(pid, nid, jid) };
}

/** Editor mutation gate: `notebook.write`, then the job. */
async function loadWritableJob(
	c: Context<HonoEnv>,
	pid: JobRun['project_id'],
	nid: JobRun['notebook_id'],
	jid: JobDefinition['id'],
) {
	const deps = c.get('deps');
	const user = c.get('user');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'notebook.write',
		deps,
	);
	const notebook = await loadAuthorizedNotebook(deps, project, nid, user);
	return { project, notebook, job: await deps.services.jobs.getJob(pid, nid, jid) };
}

async function loadRunOf(
	deps: ApiDeps,
	job: JobDefinition,
	rid: JobRun['run_id'],
): Promise<JobRun> {
	const run = await deps.services.jobRuns.getRun(job.project_id, job.notebook_id, job.id, rid);
	if (run.job_id !== job.id) throw new NotFoundError(`Run ${rid} not found`);
	return run;
}

function rawOutputHeaders(c: Context<HonoEnv>, run: JobRun): void {
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('Cache-Control', 'private, no-store');
	c.header('X-Marimohub-Run-Id', run.run_id);
	if (run.finished_at) c.header('X-Marimohub-Captured-At', run.finished_at);
}

// --- App ---

const app = createApp();

// One gate for the whole surface, ahead of every handler, so an off deployment
// answers 404 before touching a project.
app.use('/projects/:pid/notebooks/:nid/jobs', async (c, next) => {
	requireJobs(c.get('deps'));
	await next();
});
app.use('/projects/:pid/notebooks/:nid/jobs/*', async (c, next) => {
	requireJobs(c.get('deps'));
	await next();
});

app.openapi(listJobs, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user);
	const query = c.req.valid('query');
	const cursor = decodeCursor(query.cursor);
	let after: { createdAt: string; jobId: JobDefinition['id'] } | undefined;
	if (cursor) {
		if (!Number.isFinite(Date.parse(cursor[0])) || !JobId.is(cursor[1])) {
			throw new BadRequestError('Invalid pagination cursor');
		}
		after = { createdAt: cursor[0], jobId: JobId.parse(cursor[1]) };
	}
	const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const page = await deps.services.jobs.listJobsPage(pid, nid, limit, after);
	return c.json(
		{
			success: true,
			data: {
				items: page.items.map(toJobResponse),
				next_cursor: page.next ? encodeCursor(page.next.createdAt, page.next.jobId) : null,
			},
		},
		200,
	);
});

app.openapi(createJob, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'notebook.write',
		deps,
	);
	await loadAuthorizedNotebook(deps, project, nid, user);
	const body = c.req.valid('json');
	const data = await idempotentCreate(c, 'POST /projects/{pid}/notebooks/{nid}/jobs', async () => {
		const job = await deps.services.jobs.createJob(pid, nid, body, user.id, jobLimits(deps));
		return toJobResponse(job);
	});
	c.header('ETag', etagFor(data.updated_at));
	return c.json({ success: true, data }, 201);
});

app.openapi(getJob, async (c) => {
	const { pid, nid, jid } = c.req.valid('param');
	const { job } = await loadReadableJob(c, pid, nid, jid);
	c.header('ETag', etagFor(job.updated_at));
	return c.json({ success: true, data: toJobResponse(job) }, 200);
});

app.openapi(updateJob, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, jid } = c.req.valid('param');
	await loadWritableJob(c, pid, nid, jid);
	const body = c.req.valid('json');
	const job = await deps.services.jobRuns.withJobMutation(
		{ project_id: pid, notebook_id: nid, id: jid },
		async () => {
			if (
				await deps.services.jobRuns.isJobDeleting({ project_id: pid, notebook_id: nid, id: jid })
			) {
				throw new NotFoundError(`Job ${jid} not found`);
			}
			return deps.services.jobs.updateJob(
				pid,
				nid,
				jid,
				body,
				user.id,
				ifMatchToken(c),
				jobLimits(deps),
			);
		},
	);
	c.header('ETag', etagFor(job.updated_at));
	return c.json({ success: true, data: toJobResponse(job) }, 200);
});

app.openapi(deleteJob, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, jid } = c.req.valid('param');
	const { job } = await loadWritableJob(c, pid, nid, jid);
	const cancelled = await deps.services.jobRuns.withJobMutation(job, async () => {
		await deps.services.jobRuns.markJobDeleting(job);
		const result = await deps.services.jobRuns.cancelRunsOfJob(job, user.id);
		const cancelledIds = new Set(result.runs.map((run) => run.run_id));
		const terminal = (await deps.services.jobRuns.listActive()).flatMap(({ marker, run }) =>
			marker.project_id === pid &&
			marker.job_id === jid &&
			run &&
			isTerminalRunStatus(run.status) &&
			!cancelledIds.has(run.run_id)
				? [run]
				: [],
		);
		return { ...result, runs: [...result.runs, ...terminal] };
	});
	for (const run of cancelled.runs) {
		await appendJobRunFinishEvent(deps.services.events, run);
		await deps.services.jobRuns.deleteMarker(run);
	}
	await destroySandboxes(deps, cancelled.sandboxIds, {
		project_id: pid,
		notebook_id: nid,
		job_id: jid,
	});
	await deps.services.jobs.deleteJob(pid, nid, jid, user.id);
	return c.json({ success: true }, 200);
});

app.openapi(triggerRun, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, jid } = c.req.valid('param');
	const { job, notebook } = await loadWritableJob(c, pid, nid, jid);
	const body = c.req.valid('json');
	const data = await idempotentCreate(
		c,
		'POST /projects/{pid}/notebooks/{nid}/jobs/{jid}/runs',
		async () => {
			const run = await deps.services.jobRuns.withJobMutation(job, async () => {
				if (await deps.services.jobRuns.isJobDeleting(job)) {
					throw new NotFoundError(`Job ${jid} not found`);
				}
				const current = await deps.services.jobs.getJob(pid, nid, jid);
				const queued = (await deps.services.jobRuns.listActive()).filter(
					({ marker, run }) => marker.job_id === jid && run?.status === 'queued',
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
				return deps.services.jobRuns.enqueue({
					job: current,
					trigger: 'manual',
					triggeredBy: user.id,
					parameters: body?.parameters ?? current.parameters,
					sourceVersionId: notebook.source.current_version_id ?? undefined,
					timeoutSeconds: Math.floor(Math.min(requestedMs, config.maxTimeoutMs) / 1000),
				});
			});
			await appendAudit(
				{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
				'job.run.trigger',
				() =>
					deps.services.events.append({
						event: 'job.run.trigger',
						actor: user.id,
						project_id: pid,
						notebook_id: nid,
						job_id: jid,
						run_id: run.run_id,
					}),
			);
			return toPublicJobRun(run);
		},
	);
	return c.json({ success: true, data }, 201);
});

app.openapi(listRuns, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid } = c.req.valid('param');
	const { job } = await loadReadableJob(c, pid, nid, jid);
	const query = c.req.valid('query');
	const cursor = decodeCursor(query.cursor);
	let afterRunId: RunId | undefined;
	if (cursor && (cursor[0] !== cursor[1] || !RunId.is(cursor[0]))) {
		throw new BadRequestError('Invalid pagination cursor');
	}
	if (cursor) afterRunId = RunId.parse(cursor[0]);
	const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const page = await deps.services.jobRuns.listRunsPage(pid, nid, job.id, limit, afterRunId);
	return c.json(
		{
			success: true,
			data: {
				items: page.items.map(toPublicJobRun),
				next_cursor: page.nextRunId ? encodeCursor(page.nextRunId, page.nextRunId) : null,
			},
		},
		200,
	);
});

app.openapi(getRun, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid, rid } = c.req.valid('param');
	const { job } = await loadReadableJob(c, pid, nid, jid);
	const run = await loadRunOf(deps, job, rid);
	return c.json({ success: true, data: toPublicJobRun(run) }, 200);
});

app.openapi(cancelRun, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, jid, rid } = c.req.valid('param');
	const { job } = await loadWritableJob(c, pid, nid, jid);
	const existing = await loadRunOf(deps, job, rid);
	const { run, transitioned } = await deps.services.jobRuns.cancel(existing, user.id);
	if (transitioned) {
		if (run.sandbox_id) {
			await destroySandboxes(deps, [run.sandbox_id], {
				project_id: pid,
				notebook_id: nid,
				job_id: jid,
				run_id: rid,
			});
		}
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'job.run.cancel',
			() =>
				deps.services.events.append({
					event: 'job.run.cancel',
					actor: user.id,
					project_id: pid,
					notebook_id: nid,
					job_id: jid,
					run_id: rid,
				}),
		);
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'job.run.finish',
			() => appendJobRunFinishEvent(deps.services.events, run),
		);
	}
	return c.json({ success: true, data: toPublicJobRun(run) }, 200);
});

app.openapi(getRunHtml, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid, rid } = c.req.valid('param');
	const { job } = await loadReadableJob(c, pid, nid, jid);
	const run = await loadRunOf(deps, job, rid);
	const html = await deps.services.jobRuns.readHtml(run);
	if (html === null) return fail(c, 'NO_RUN_OUTPUT', 'This run captured no output', 404);
	rawOutputHeaders(c, run);
	// Notebook-authored HTML (marimo's export embeds scripts) must never run
	// same-origin with the app — the same containment as the version snapshots.
	c.header('Content-Security-Policy', 'sandbox allow-scripts');
	return c.html(html, 200);
});

// Registered for the OpenAPI document but served by a plain handler: a raw
// text/plain body does not fit the typed-response envelope (the same shape as
// the workspace file routes in notebooks.ts).
app.openAPIRegistry.registerPath(getRunLogs);
app.get('/projects/:pid/notebooks/:nid/jobs/:jid/runs/:rid/logs', async (c) => {
	const deps = c.get('deps');
	const params = RunIdParam.safeParse(c.req.param());
	if (!params.success) throw new NotFoundError('Run not found');
	const { pid, nid, jid, rid } = params.data;
	const { job } = await loadWritableJob(c, pid, nid, jid);
	const run = await loadRunOf(deps, job, rid);
	const logs = await deps.services.jobRuns.readLogs(run);
	if (logs === null) return fail(c, 'NO_RUN_OUTPUT', 'This run captured no logs', 404);
	rawOutputHeaders(c, run);
	return c.text(logs, 200);
});

export default app;

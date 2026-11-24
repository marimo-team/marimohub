import {
	RunListQuery,
	prepareRunListQuery,
	matchesRunFilter,
	RUN_LIST_DESCRIPTION,
} from '../jobs/runQuery';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
	JobId,
	ForbiddenError,
	NotFoundError,
	RunId,
	RunStopBodySchema,
	toPublicJobDefinition,
	toPublicJobRun,
} from '@marimo-hub/core';
import { appendJobRunFinishEvent, isTerminalRunStatus } from '@marimo-hub/core/jobs';
import type { JobRun } from '@marimo-hub/core';
import type { HonoEnv } from '../context';
import {
	CreateJobBody,
	UpdateJobBody,
	TriggerRunBody,
	JobResponseSchema,
	JobRunResponseSchema,
} from '../jobs/schemas';
import {
	requireJobs,
	resolveJobAccess,
	visibleJobRun,
	getJobCapabilities,
	loadAuthorizedJob,
	authorizeJobNotebook,
	listNotebookJobs,
	loadJobRun,
	createNotebookJob,
	updateNotebookJob,
	triggerJobRun,
	requestJobRunStop,
} from '../jobs/operations';
import { idempotentCreate } from '../idempotency';
import { appendAudit, describeError, logEvent } from '../log';
import { pageSchema, PaginationQuery } from '../pagination';
import {
	commonErrors,
	createApp,
	destroySandboxes,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	fail,
	IdempotencyKeyHeader,
	ifMatchToken,
	IfMatchHeader,
	jsonBody,
	jsonContent,
	NotebookIdParam,
	RequiredIfMatchHeader,
	SuccessResponseSchema,
} from '../shared';

const DELETE_FINISH_AUDIT_ATTEMPTS = 3;

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
	request: { params: JobIdParam, headers: RequiredIfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Job deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
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
	description: RUN_LIST_DESCRIPTION,
	request: { params: JobIdParam, query: RunListQuery },
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
		'Stops a run. Optional grace_seconds requests cooperative stopping for up to 300 seconds. Cancellation does not imply results were saved.',
	request: {
		params: RunIdParam,
		body: { required: false, content: { 'application/json': { schema: RunStopBodySchema } } },
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: JobRunResponseSchema }),
			'Stop requested, cancelled, or already terminal',
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
	await authorizeJobNotebook(deps, user, pid, nid, 'project.read');
	const data = await listNotebookJobs(deps, pid, nid, c.req.valid('query'));
	return c.json({ success: true, data }, 200);
});

app.openapi(createJob, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const target = await authorizeJobNotebook(deps, user, pid, nid, 'notebook.write');
	const body = c.req.valid('json');
	const data = await idempotentCreate(c, 'POST /projects/{pid}/notebooks/{nid}/jobs', async () => {
		const job = await createNotebookJob(deps, target, body);
		return toPublicJobDefinition(job);
	});
	c.header('ETag', etagFor(data.updated_at));
	return c.json({ success: true, data }, 201);
});

app.openapi(getJob, async (c) => {
	const { pid, nid, jid } = c.req.valid('param');
	const { job } = await loadAuthorizedJob(c.get('deps'), c.get('user'), pid, nid, jid);
	c.header('ETag', etagFor(job.updated_at));
	return c.json({ success: true, data: toPublicJobDefinition(job) }, 200);
});

app.openapi(updateJob, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid } = c.req.valid('param');
	const target = await loadAuthorizedJob(
		c.get('deps'),
		c.get('user'),
		pid,
		nid,
		jid,
		'notebook.write',
	);
	const job = await updateNotebookJob(
		deps,
		target,
		target.job,
		c.req.valid('json'),
		ifMatchToken(c),
	);
	c.header('ETag', etagFor(job.updated_at));
	return c.json({ success: true, data: toPublicJobDefinition(job) }, 200);
});

app.openapi(deleteJob, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, jid } = c.req.valid('param');
	const { job: loaded } = await loadAuthorizedJob(
		c.get('deps'),
		c.get('user'),
		pid,
		nid,
		jid,
		'notebook.write',
	);
	const cancelled = await deps.services.jobRuns.withJobMutation(loaded, async () => {
		const job = await deps.services.jobs.beginDelete(pid, nid, jid, user.id, ifMatchToken(c));
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
		let auditError: unknown;
		for (let attempt = 0; attempt < DELETE_FINISH_AUDIT_ATTEMPTS; attempt++) {
			try {
				await appendJobRunFinishEvent(deps.services.events, run);
				auditError = undefined;
				break;
			} catch (err) {
				auditError = err;
			}
		}
		if (auditError !== undefined) {
			logEvent({
				level: 'error',
				event: 'job_delete_finish_audit_failed',
				project_id: run.project_id,
				notebook_id: run.notebook_id,
				job_id: run.job_id,
				run_id: run.run_id,
				attempts: DELETE_FINISH_AUDIT_ATTEMPTS,
				error: describeError(auditError),
			});
		}
		await deps.services.jobRuns.deleteMarker(run);
	}
	await destroySandboxes(deps, cancelled.sandboxIds, {
		project_id: pid,
		notebook_id: nid,
		job_id: jid,
	});
	// After the marker loop, which republishes locators, and before finishDelete removes the
	// per-job index the locators are derived from.
	await deps.services.jobRuns.deleteProjectLocators(pid, nid, jid);
	await deps.services.jobs.finishDelete(pid, nid, jid);
	return c.json({ success: true }, 200);
});

app.openapi(triggerRun, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid } = c.req.valid('param');
	const { target } = await resolveJobAccess('job.trigger', (action) =>
		loadAuthorizedJob(c.get('deps'), c.get('user'), pid, nid, jid, action),
	);
	const body = c.req.valid('json');
	const data = toPublicJobRun(
		await triggerJobRun(
			deps,
			target,
			target.job,
			body,
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
			undefined,
			(enqueue) =>
				idempotentCreate(c, 'POST /projects/{pid}/notebooks/{nid}/jobs/{jid}/runs', enqueue),
		),
	);
	return c.json({ success: true, data }, 201);
});

app.openapi(listRuns, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid } = c.req.valid('param');
	const target = await loadAuthorizedJob(c.get('deps'), c.get('user'), pid, nid, jid);
	const { job } = target;
	const query = c.req.valid('query');
	const { filter, filtered, limit, afterRunId, nextCursor } = prepareRunListQuery(
		query,
		c.get('user').id,
		[pid, nid, job.id],
		{ legacyJobCursor: true },
	);
	const page = filtered
		? await deps.services.jobRuns.scanRunsPage(pid, nid, job.id, limit, afterRunId)
		: await deps.services.jobRuns.listRunsPage(pid, nid, job.id, limit, afterRunId);
	return c.json(
		{
			success: true,
			data: {
				items: (await Promise.all(page.items.map((run) => visibleJobRun(deps, target, job, run))))
					.filter((run) => run !== null)
					.filter((run) => matchesRunFilter(run, filter)),
				next_cursor: nextCursor(page.nextRunId),
			},
		},
		200,
	);
});

app.openapi(getRun, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, jid, rid } = c.req.valid('param');
	const target = await loadAuthorizedJob(c.get('deps'), c.get('user'), pid, nid, jid);
	const { job } = target;
	const run = await loadJobRun(deps, job, rid);
	const data = await visibleJobRun(deps, target, job, run);
	if (!data) throw new NotFoundError('Run not found');
	return c.json({ success: true, data }, 200);
});

app.openapi(cancelRun, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, jid, rid } = c.req.valid('param');
	const { target } = await resolveJobAccess('job.trigger', (action) =>
		loadAuthorizedJob(deps, user, pid, nid, jid, action),
	);
	const existing = await loadJobRun(deps, target.job, rid);
	const { run, transitioned } = await requestJobRunStop(
		deps,
		target,
		existing,
		c.req.valid('json')?.grace_seconds,
	);
	if (transitioned && isTerminalRunStatus(run.status)) {
		if (run.sandbox_id) {
			await destroySandboxes(deps, [run.sandbox_id], {
				project_id: pid,
				notebook_id: nid,
				job_id: jid,
				run_id: rid,
			});
		}
		await appendAudit(
			deps,
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
			deps,
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
	const target = await loadAuthorizedJob(c.get('deps'), c.get('user'), pid, nid, jid);
	const { job } = target;
	const run = await loadJobRun(deps, job, rid);
	if (!(await getJobCapabilities(deps, target, job, run)).canReadHtml)
		throw new NotFoundError('Run output not found');
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
	const target = await loadAuthorizedJob(
		c.get('deps'),
		c.get('user'),
		pid,
		nid,
		jid,
		'notebook.write',
	);
	const { job } = target;
	const run = await loadJobRun(deps, job, rid);
	if (!(await getJobCapabilities(deps, target, job, run)).canReadLogs)
		throw new ForbiddenError('Run logs require edit access');
	const logs = await deps.services.jobRuns.readLogs(run);
	if (logs === null) return fail(c, 'NO_RUN_OUTPUT', 'This run captured no logs', 404);
	rawOutputHeaders(c, run);
	return c.text(logs, 200);
});

export default app;

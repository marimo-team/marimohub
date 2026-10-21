import { jobTimeoutSeconds } from '@marimo-hub/core/jobs';
import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import {
	BadRequestError,
	JobId,
	JobRunParametersSchema,
	MAX_JOB_EVENT_BYTES,
	MAX_QUEUED_RUNS_PER_JOB,
	NotFoundError,
	ResourceExhaustedError,
	UnavailableError,
	createRunId,
} from '@marimo-hub/core';
import { sha256Hex } from '@marimo-hub/core/sha256';
import { commonErrors, createApp, errorResponses, fail, jsonContent } from '../shared';
import { authorizeJobNotebook, requireJobs } from '../jobs/operations';
import { WebhookTriggerBody } from '../jobs/schemas';
import { canonicalJson, idempotentOperation } from '../idempotency';
import { JobIdParam } from './jobs';

const app = createApp();
app.use(
	'/projects/:pid/notebooks/:nid/jobs/:jid/trigger',
	bodyLimit({
		maxSize: 600 * 1024,
		onError: (c) => fail(c, 'PAYLOAD_TOO_LARGE', 'Trigger body is too large', 413),
	}),
);
const trigger = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/trigger',
	operationId: 'jobs.trigger',
	tags: ['Jobs'],
	summary: 'Trigger a job from an event',
	description:
		'Requires job.trigger. Enqueues a webhook run with optional event data and a caller-scoped idempotency key.',
	request: {
		params: JobIdParam,
		body: { content: { 'application/json': { schema: WebhookTriggerBody } }, required: false },
	},
	responses: {
		202: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ run_id: z.string(), queued: z.literal(true) }),
			}),
			'Run queued',
		),
		...commonErrors(),
		...errorResponses(403, 404, 413, 422, 429, 503),
	},
});
app.openapi(trigger, async (c) => {
	const deps = c.get('deps');
	const config = requireJobs(deps);
	const user = c.get('user');
	const { pid, nid, jid } = c.req.valid('param');
	const jobId = JobId.parse(jid);
	await authorizeJobNotebook(deps, user, pid, nid, 'job.trigger');
	// Parse even without Content-Type so a nonempty invalid body cannot silently become an empty event.
	const raw = await c.req.text();
	let json: unknown;
	try {
		json = raw.trim() ? JSON.parse(raw) : {};
	} catch {
		throw new BadRequestError('Invalid JSON body');
	}
	const parsed = WebhookTriggerBody.safeParse(json);
	if (!parsed.success) throw new BadRequestError(parsed.error.message);
	const body = parsed.data;
	const event = body.event === undefined ? undefined : JSON.stringify(body.event);
	if (event && new TextEncoder().encode(event).byteLength > MAX_JOB_EVENT_BYTES)
		throw new BadRequestError('event exceeds 16 KiB');
	const ref = { project_id: pid, notebook_id: nid, id: jobId };
	const result = await deps.services.jobRuns.withJobMutation(ref, async () => {
		const target = await authorizeJobNotebook(deps, user, pid, nid, 'job.trigger');
		const current = await deps.services.jobs.getJob(pid, nid, jobId);
		if (!current.enabled || (await deps.services.jobs.isDeleting(current)))
			throw new NotFoundError('Job is not enabled');

		const parameters = JobRunParametersSchema.safeParse({
			...(body.parameters ?? current.parameters),
			...(event === undefined ? {} : { event }),
		});
		if (!parameters.success) throw new BadRequestError(parameters.error.message);
		let capacityChecked = false;
		const checkQueueCapacity = async () => {
			if (capacityChecked) return;
			const active = await deps.services.jobRuns.listActiveSnapshot();
			if (!active.complete) throw new UnavailableError('Cannot determine active runs');
			const queued = active.entries.filter(
				({ run }) => run?.job_id === jobId && run.status === 'queued',
			);
			if (queued.length >= MAX_QUEUED_RUNS_PER_JOB)
				throw new ResourceExhaustedError('Too many queued runs for this job');
			// The job claim prevents other requests from adding runs before this enqueue.
			capacityChecked = true;
		};
		// Reserve the run id before enqueueing so a crash after the write can replay safely.
		const runId = await idempotentOperation(
			deps,
			`job.webhook:${user.id}:${pid}:${nid}:${jobId}`,
			body.idempotency_key,
			async () => {
				await checkQueueCapacity();
				await deps.services.jobs.consumeWebhookBudget(current);
				return createRunId();
			},
			{ fingerprint: await sha256Hex(canonicalJson(JSON.stringify(body))) },
		);
		if (await deps.services.jobRuns.runExists(pid, nid, jobId, runId))
			return { run_id: runId, queued: true as const };
		await checkQueueCapacity();

		const run = await deps.services.jobRuns.enqueue({
			job: current,
			runId,
			trigger: 'webhook',
			triggeredBy: user.id,
			triggerSource: { kind: 'webhook', idempotency_key: body.idempotency_key },
			parameters: parameters.data,
			sourceVersionId: target.notebook.source.current_version_id ?? undefined,
			timeoutSeconds: jobTimeoutSeconds(current, config),
		});
		return { run_id: run.run_id, queued: true as const };
	});
	c.header('Cache-Control', 'no-store');
	return c.json({ success: true, data: result }, 202);
});
export default app;

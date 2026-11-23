import { APP_JOBS_PATH, appJobsEndpoint } from './appJobsEndpoint';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import {
	AppPoolService,
	bearerToken,
	JobId,
	ProxyExposure,
	RunId,
	SessionId,
	verifyProxyToken,
	verifyAppJobCredential,
	signAppJobCredential,
	sessionMode,
	toPublicJobRun,
	ForbiddenError,
} from '@marimo-hub/core';
import { isTerminalRunStatus } from '@marimo-hub/core/jobs';
import type { ApiDeps, HonoEnv } from '../context';
import { authorizeProxyRequest } from '../sandboxProxy';
import { fail } from '../shared';
import { authorizeJobNotebook, loadAuthorizedJob, loadJobRun, triggerJobRun } from './operations';
import { TriggerRunBody } from './schemas';

const jobBody = z.strictObject({ job_id: z.string().regex(JobId.regex).transform(JobId.parse) });
const jobRequest = z.discriminatedUnion('operation', [
	z.object({
		operation: z.literal('trigger'),
		body: jobBody.extend({ input: TriggerRunBody.optional() }),
	}),
	z.object({
		operation: z.literal('get_run'),
		body: jobBody.extend({ run_id: z.string().regex(RunId.regex).transform(RunId.parse) }),
	}),
	z.object({ operation: z.literal('list_active_runs'), body: jobBody }),
]);

export function createAppJobsApp(deps: ApiDeps) {
	const app = new Hono<HonoEnv>();
	app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
	app.post('/:operation', async (c) => {
		c.header('Cache-Control', 'no-store');
		const exposure = deps.sandbox.exposure;
		const token = bearerToken(c.req.raw);
		const operation = c.req.param('operation');
		if (!(exposure instanceof ProxyExposure) || !token)
			return fail(c, 'UNAUTHORIZED', 'App authentication required', 401);
		const claims = await verifyAppJobCredential(
			token,
			exposure.signingSecret,
			appJobsEndpoint(deps, c.req.raw),
			{ purpose: operation === 'refresh' ? 'refresh' : 'access' },
		);
		if (!claims)
			return fail(c, 'UNAUTHORIZED', 'App credential expired or invalid. Reopen the app.', 401);
		const routing = await verifyProxyToken(claims.routingToken, exposure.signingSecret);
		if (!routing) return fail(c, 'UNAUTHORIZED', 'Invalid app credential', 401);
		const admission = await authorizeProxyRequest(
			new Request(`${new URL(c.req.url).origin}/proxy/${claims.routingToken}/`),
			{
				...deps,
				authenticator: { authenticate: async () => claims.principal },
			},
			false,
		);
		if (admission.kind === 'reject')
			return fail(c, admission.code, admission.message, admission.status);
		if (admission.kind !== 'forward') return fail(c, 'FORBIDDEN', 'App access has ended', 403);
		const session = await deps.services.sessions.getSession(
			routing.projectId,
			SessionId.parse(admission.sessionId),
		);
		if (sessionMode(session) !== 'app' || session.preview)
			throw new ForbiddenError('App jobs require a published app');
		const pid = routing.projectId;
		const nid = session.notebook_id;
		const user = claims.principal;
		const pool = await new AppPoolService(
			deps.bucket,
			deps.services.sessions,
			deps.policy.appPool,
		).view(pid, nid);
		if (
			!pool
				.activeAssignmentGenerations(user.id, session.session_id)
				.some((generation) => claims.assignmentGenerations.includes(generation))
		)
			throw new ForbiddenError('App visit has ended');
		if (operation === 'refresh') {
			await authorizeJobNotebook(deps, user, pid, nid, 'project.read');
			return c.json({
				success: true,
				data: { credential: await signAppJobCredential(claims, exposure.signingSecret) },
			});
		}
		if (!['trigger', 'get_run', 'list_active_runs'].includes(operation))
			return fail(c, 'NOT_FOUND', 'Unknown app job operation', 404);
		const parsed = jobRequest.safeParse({ operation, body: await c.req.json().catch(() => null) });
		if (!parsed.success) return fail(c, 'BAD_REQUEST', 'Invalid app job request', 400);
		const request = parsed.data;
		const jid = request.body.job_id;
		const target = await loadAuthorizedJob(deps, user, pid, nid, jid);
		if (request.operation === 'trigger') {
			const run = await triggerJobRun(deps, target, target.job, request.body.input, {
				method: 'POST',
				path: APP_JOBS_PATH,
			});
			return c.json({ success: true, data: toPublicJobRun(run) });
		}
		if (request.operation === 'get_run') {
			const run = await loadJobRun(deps, target.job, request.body.run_id);
			if (run.triggered_by !== user.id) throw new ForbiddenError('Run belongs to another user');
			return c.json({ success: true, data: toPublicJobRun(run) });
		}
		const runs = await deps.services.jobRuns.listActive();
		return c.json({
			success: true,
			data: runs.flatMap(({ run }) =>
				run?.project_id === pid &&
				run.notebook_id === nid &&
				run.job_id === jid &&
				run.triggered_by === user.id &&
				!isTerminalRunStatus(run.status)
					? [toPublicJobRun(run)]
					: [],
			),
		});
	});
	return app;
}

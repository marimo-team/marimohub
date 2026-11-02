import { createRoute, z } from '@hono/zod-openapi';
import {
	ForbiddenError,
	NotFoundError,
	UnavailableError,
	notificationRouter,
	sessionResourceNotebookId,
} from '@marimo-hub/core';
import {
	SupportContextSchema,
	SupportDiagnosticsSchema,
	SupportRequestSchema,
	supportPageUrl,
} from '@marimo-hub/core/support';
import type { SupportContext, SupportDiagnostics } from '@marimo-hub/core/support';
import type { Context } from 'hono';
import type { HonoEnv } from '../context';
import {
	assertDeploymentAction,
	assertSessionAccess,
	assertSessionNotebookVisible,
	authorizationService,
	createApp,
	errorResponses,
	jsonContent,
	loadSessionProject,
	ok,
} from '../shared';
import { assertNotificationMutationAllowed } from '../notifications';
import { appendAudit } from '../log';

const app = createApp();

async function diagnostics(
	c: Context<HonoEnv>,
	input: SupportContext,
): Promise<SupportDiagnostics> {
	const deps = c.get('deps');
	const user = c.get('user');
	await assertDeploymentAction(user, 'support.request', deps, 'Not authorized to request support');
	let session: SupportDiagnostics['session'];
	if (input.session) {
		const { project_id: pid, notebook_id: nid, id: sid } = input.session;
		const project = await loadSessionProject(deps.services.projects, pid, user, deps);
		const stored = await deps.services.sessions.getSession(pid, sid);
		if (sessionResourceNotebookId(stored) !== nid) throw new NotFoundError('Session not found');
		const labels = await assertSessionNotebookVisible(deps, project, stored, user, {
			requireActivePreview: false,
		});
		if (authorizationService(deps).role(user, project) === 'app-user') {
			await assertSessionAccess(project, stored, user, deps, labels);
		}
		session = {
			id: stored.session_id,
			project_id: pid,
			notebook_id: nid,
			source_version_id: stored.source_version_id,
			sandbox_id: stored.sandbox_id,
			runtime: stored.runtime,
			compute_profile: stored.compute_profile,
			error: stored.error,
		};
	}
	return SupportDiagnosticsSchema.parse({
		reporter: { id: user.id, email: user.email },
		page_url: supportPageUrl(input.page_url),
		hub_version: deps.version?.version ?? 'dev',
		client: input.client,
		session,
		timestamp: new Date().toISOString(),
	});
}

app.openapi(
	createRoute({
		method: 'post',
		path: '/support/diagnostics',
		operationId: 'support.diagnostics',
		tags: ['System'],
		summary: 'Preview support diagnostics for the signed-in user',
		request: { body: jsonContent(SupportContextSchema, 'Page and optional session identifiers') },
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: SupportDiagnosticsSchema }),
				'Support diagnostics',
			),
			...errorResponses(400, 401, 403, 404, 422),
		},
	}),
	async (c) => {
		c.header('Cache-Control', 'no-store');
		return ok(c, await diagnostics(c, c.req.valid('json')));
	},
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/support/requests',
		operationId: 'support.request',
		tags: ['System'],
		summary: 'Send a support request to the deployment notifier',
		request: { body: jsonContent(SupportRequestSchema, 'Report and page context') },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: z.object({
						request_id: z.string(),
						delivery: z.enum(['delivered', 'partial']),
					}),
				}),
				'Support request delivered',
			),
			...errorResponses(400, 401, 403, 404, 422, 429, 503),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		if (deps.supportMode !== 'notifier' || !deps.notifier) {
			throw new ForbiddenError('Support notification delivery is disabled');
		}
		const input = c.req.valid('json');
		const report = await diagnostics(c, input);
		assertNotificationMutationAllowed(deps, c.get('user').id, {
			delivery: 'notifier',
			recipient: 'support',
		});
		const requestId = crypto.randomUUID();
		const [notification] = notificationRouter.render({
			kind: 'support.request',
			diagnostics: report,
			message: input.message,
			requestId,
		});
		let delivery;
		try {
			delivery = await deps.notifier.deliver(notification);
		} catch {
			throw new UnavailableError('Support delivery failed. Copy diagnostics or try again later.');
		}
		if (delivery === 'skipped')
			throw new UnavailableError('No support destination accepted the report');
		await appendAudit(
			{
				requestId: c.get('requestId'),
				method: c.req.method,
				path: c.req.path,
				userId: c.get('user').id,
			},
			'support.request',
			() =>
				deps.services.events.append({
					event: 'support.request',
					actor: c.get('user').id,
					support_request_id: requestId,
					delivery,
				}),
		);
		return ok(c, { request_id: requestId, delivery });
	},
);

export default app;

import { createRoute, z } from '@hono/zod-openapi';
import {
	NotFoundError,
	ResourceExhaustedError,
	UnavailableError,
	notificationRouter,
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
	createApp,
	errorResponses,
	jsonContent,
	ok,
	sessionGrantsFor,
} from '../shared';
import { assertNotificationMutationAllowed } from '../notifications';
import { appendAudit } from '../log';
import { loadAuthorizedSession, presentSession } from './sessions';

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
		const {
			project,
			session: stored,
			labels,
		} = await loadAuthorizedSession(deps, user, { pid, nid, sid });
		const grants = await sessionGrantsFor(project, user, stored, deps, labels);
		const visible = await presentSession(deps, user, stored, grants);
		session = {
			id: stored.session_id,
			project_id: pid,
			notebook_id: nid,
			source_version_id: visible.source_version_id,
			sandbox_id: visible.sandbox_url && !grants.appReadOnly ? stored.sandbox_id : undefined,
			runtime: stored.runtime,
			compute_profile: visible.compute_profile,
			// Pool and preview denials clear `can.attach` but keep `error`, which can name the host.
			error: visible.can.attach ? visible.error : undefined,
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
		operationId: 'support.diagnostics.preview',
		'x-cli-hidden': true,
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
		operationId: 'support.requests.create',
		'x-cli-hidden': true,
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
		if (!deps.supportReports || !deps.notifier) {
			throw new NotFoundError('Support reports are not enabled on this deployment');
		}
		const input = c.req.valid('json');
		const report = await diagnostics(c, input);
		try {
			assertNotificationMutationAllowed(deps, c.get('user').id, {
				delivery: 'notifier',
				recipient: 'support',
				consumeActor: false,
			});
		} catch (err) {
			if (err instanceof ResourceExhaustedError) {
				throw new ResourceExhaustedError('Too many support reports. Try again in a few minutes.');
			}
			throw err;
		}
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

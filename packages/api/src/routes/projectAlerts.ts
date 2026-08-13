import { createRoute, z } from '@hono/zod-openapi';
import {
	AlertDestinationId,
	notificationRouter,
	NotFoundError,
	PROJECT_ALERT_KINDS,
	ProjectAlertKindSchema,
	ResourceExhaustedError,
	createSlidingWindowBudget,
} from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import type { UserId } from '@marimo-hub/core';
import { appendAudit } from '../log';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	extensibleResponseEnum,
	ifMatchToken,
	IfMatchHeader,
	jsonBody,
	jsonContent,
	ProjectIdParam,
	SuccessResponseSchema,
} from '../shared';
import { pageSchema } from '../pagination';

const AlertDestinationIdParam = ProjectIdParam.extend({
	aid: z
		.string()
		.regex(AlertDestinationId.regex)
		.refine(AlertDestinationId.is)
		.openapi({ param: { name: 'aid', in: 'path' }, example: 'alert-7h2k9qm4xz7rp3w8' }),
});

const DestinationCommonSchema = z.object({
	id: z.string().regex(AlertDestinationId.regex),
	name: z.string(),
	kinds: z.array(extensibleResponseEnum(PROJECT_ALERT_KINDS, PROJECT_ALERT_KINDS[0])),
	enabled: z.boolean(),
	verified_at: z.iso.datetime().nullable(),
	endpoint_host: z.string(),
	created_by: z.string(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
});

const AlertDestinationResponseSchema = z
	.discriminatedUnion('type', [
		DestinationCommonSchema.extend({
			type: z.literal('slack'),
			webhook_url_set: z.literal(true),
		}),
		DestinationCommonSchema.extend({
			type: z.literal('webhook'),
			url_set: z.literal(true),
			signing_secret_set: z.literal(true),
		}),
	])
	.openapi('ProjectAlertDestination');

const DestinationInputCommonSchema = z.object({
	name: z.string().min(1).max(100),
	kinds: z.array(ProjectAlertKindSchema).min(1).optional(),
});

const CreateDestinationBody = z.discriminatedUnion('type', [
	DestinationInputCommonSchema.extend({
		type: z.literal('slack'),
		webhook_url: z.url(),
	}),
	DestinationInputCommonSchema.extend({
		type: z.literal('webhook'),
		url: z.url(),
		signing_secret: z.string().min(1),
	}),
]);

const UpdateDestinationBody = DestinationInputCommonSchema.partial()
	.extend({
		enabled: z.boolean().optional(),
		webhook_url: z.url().optional(),
		url: z.url().optional(),
		signing_secret: z.string().min(1).optional(),
	})
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: 'At least one destination field is required.',
	});

const listDestinations = createRoute({
	method: 'get',
	path: '/projects/{pid}/alert-destinations',
	tags: ['Alerts'],
	summary: 'List project alert destinations',
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(AlertDestinationResponseSchema, 'ProjectAlertDestinationPage'),
			}),
			'Project alert destinations with secret material redacted',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const createDestination = createRoute({
	method: 'post',
	path: '/projects/{pid}/alert-destinations',
	tags: ['Alerts'],
	summary: 'Create a project alert destination',
	description: `New destinations subscribe to all ${PROJECT_ALERT_KINDS.length} project alert kinds when kinds is omitted. They remain disabled until a successful test.`,
	request: { params: ProjectIdParam, body: jsonBody(CreateDestinationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: AlertDestinationResponseSchema }),
			'Alert destination created',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 422, 429),
	},
});

const updateDestination = createRoute({
	method: 'patch',
	path: '/projects/{pid}/alert-destinations/{aid}',
	tags: ['Alerts'],
	summary: 'Update a project alert destination',
	request: {
		params: AlertDestinationIdParam,
		headers: IfMatchHeader,
		body: jsonBody(UpdateDestinationBody),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: AlertDestinationResponseSchema }),
			'Alert destination updated',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 412, 422),
	},
});

const deleteDestination = createRoute({
	method: 'delete',
	path: '/projects/{pid}/alert-destinations/{aid}',
	tags: ['Alerts'],
	summary: 'Delete a project alert destination',
	request: { params: AlertDestinationIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Alert destination deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 409, 412),
	},
});

const testDestination = createRoute({
	method: 'post',
	path: '/projects/{pid}/alert-destinations/{aid}/test',
	tags: ['Alerts'],
	summary: 'Send a test project alert',
	request: { params: AlertDestinationIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: AlertDestinationResponseSchema }),
			'Test delivered and destination verified',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 412, 429),
	},
});

function requireProjectAlerts(deps: ApiDeps): NonNullable<ApiDeps['projectAlerts']> {
	if (!deps.projectAlerts) throw new NotFoundError('Project alerts are not available');
	return deps.projectAlerts;
}

const testBudget = createSlidingWindowBudget<string>({ limit: 10, windowMs: 60_000 });

function assertTestBudget(userId: string): void {
	if (!testBudget.consume(userId)) {
		throw new ResourceExhaustedError('Too many alert tests; try again in a minute');
	}
}

function audit(
	deps: ApiDeps,
	c: Omit<Parameters<typeof appendAudit>[0], 'userId'> & { userId: UserId },
	event: string,
	data: Record<string, unknown>,
) {
	return appendAudit(c, event, () =>
		deps.services.events.append({ event, actor: c.userId, ...data }),
	);
}

const app = createApp();

app.openapi(listDestinations, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const alerts = requireProjectAlerts(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	return c.json(
		{ success: true, data: { items: await alerts.store.list(pid), next_cursor: null } },
		200,
	);
});

app.openapi(createDestination, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const alerts = requireProjectAlerts(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	const destination = await alerts.store.create(pid, c.req.valid('json'), user.id);
	c.header('ETag', etagFor(destination.updated_at));
	await audit(
		deps,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'project_alert.create',
		{
			project_id: pid,
			alert_destination_id: destination.id,
			alert_destination_type: destination.type,
			alert_destination_name: destination.name,
		},
	);
	return c.json({ success: true, data: destination }, 201);
});

app.openapi(updateDestination, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, aid } = c.req.valid('param');
	const alerts = requireProjectAlerts(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	const body = c.req.valid('json');
	const destination = await alerts.store.update(pid, aid, body, ifMatchToken(c));
	c.header('ETag', etagFor(destination.updated_at));
	await audit(
		deps,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'project_alert.update',
		{
			project_id: pid,
			alert_destination_id: aid,
			alert_destination_type: destination.type,
			endpoint_changed:
				body.webhook_url !== undefined ||
				body.url !== undefined ||
				body.signing_secret !== undefined,
		},
	);
	return c.json({ success: true, data: destination }, 200);
});

app.openapi(deleteDestination, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, aid } = c.req.valid('param');
	const alerts = requireProjectAlerts(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'manager', deps.policy);
	await alerts.store.remove(pid, aid, ifMatchToken(c));
	await audit(
		deps,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'project_alert.delete',
		{ project_id: pid, alert_destination_id: aid },
	);
	return c.json({ success: true }, 200);
});

app.openapi(testDestination, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, aid } = c.req.valid('param');
	const alerts = requireProjectAlerts(deps);
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'manager',
		deps.policy,
	);
	assertTestBudget(user.id);
	const [notification] = notificationRouter.render({
		kind: 'alert.test',
		project,
		destinationId: aid,
		actor: user,
		testId: c.get('requestId'),
	});
	if (!notification) throw new Error('Test alert renderer returned no notification');
	try {
		const destination = await alerts.dispatcher.test(pid, aid, ifMatchToken(c), notification);
		c.header('ETag', etagFor(destination.updated_at));
		await audit(
			deps,
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'project_alert.test',
			{ project_id: pid, alert_destination_id: aid, outcome: 'success' },
		);
		return c.json({ success: true, data: destination }, 200);
	} catch (error) {
		await audit(
			deps,
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'project_alert.test',
			{ project_id: pid, alert_destination_id: aid, outcome: 'failure' },
		);
		throw error;
	}
});

export default app;

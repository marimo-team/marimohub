import { createRoute, z } from '@hono/zod-openapi';
import { NotFoundError } from '@marimo-hub/core';
import {
	assertProjectRole,
	AuditEventResponseSchema,
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	ProjectIdParam,
} from '../shared';

const listEvents = createRoute({
	method: 'get',
	path: '/projects/{pid}/events',
	tags: ['Projects'],
	summary: "List a project's audit events for one day",
	description:
		'Catalog mutation audit trail (project/notebook lifecycle, membership changes), ' +
		'one UTC day at a time. Admin-only: events may record member management and deletions.',
	request: {
		params: ProjectIdParam,
		query: z.object({
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional()
				.openapi({ example: '2026-07-01', description: 'UTC day (defaults to today)' }),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(AuditEventResponseSchema) }),
			"The day's audit events for this project, in append order",
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const app = createApp();

app.openapi(listEvents, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const { date } = c.req.valid('query');

	// Unlike other reads (open by v1 policy), the audit trail is admin-only.
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'admin',
		deps.policy.defaultRole,
	);
	if (project.status === 'deleted') {
		throw new NotFoundError(`Project ${pid} not found`);
	}

	const day = date ?? new Date().toISOString().slice(0, 10);
	const events = await deps.services.events.getEvents(day);
	const data = events.filter((e) => e.project_id === pid);
	return c.json({ success: true, data }, 200);
});

export default app;

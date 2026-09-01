import { createRoute, z } from '@hono/zod-openapi';
import {
	MAX_EVENT_RANGE_DAYS,
	Millis,
	parseUtcDate,
	UTC_DATE_PATTERN,
	ValidationError,
} from '@marimo-hub/core';
import type { Event } from '@marimo-hub/core';
import {
	assertProjectRole,
	assertSuperAdmin,
	AuditEventResponseSchema,
	AuditLogEntryResponseSchema,
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	ProjectIdParam,
} from '../shared';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageSchema, PaginationQuery } from '../pagination';

const DAY_MS = Millis.days(1);
const DateQuery = z
	.string()
	.regex(UTC_DATE_PATTERN)
	.refine((value) => parseUtcDate(value) !== null, { message: 'Invalid UTC date' })
	.openapi({ example: '2026-07-01', description: 'UTC calendar date' });

const GlobalEventQuery = PaginationQuery.extend({
	from: DateQuery.optional(),
	to: DateQuery.optional(),
	event: z.string().min(1).optional(),
	actor: z.string().min(1).optional(),
	project_id: z.string().min(1).optional(),
});

function eventRange(
	from: string | undefined,
	to: string | undefined,
): { from: string; to: string } {
	if ((from === undefined) !== (to === undefined)) {
		throw new ValidationError('from and to must be supplied together');
	}
	if (from === undefined || to === undefined) {
		const end = new Date();
		const endDate = end.toISOString().slice(0, 10);
		return {
			from: new Date(Date.parse(`${endDate}T00:00:00.000Z`) - (MAX_EVENT_RANGE_DAYS - 1) * DAY_MS)
				.toISOString()
				.slice(0, 10),
			to: endDate,
		};
	}
	const fromTime = parseUtcDate(from);
	const toTime = parseUtcDate(to);
	if (fromTime === null) throw new ValidationError(`Invalid UTC date: ${from}`);
	if (toTime === null) throw new ValidationError(`Invalid UTC date: ${to}`);
	if (fromTime > toTime) throw new ValidationError('from must not be after to');
	if ((toTime - fromTime) / DAY_MS + 1 > MAX_EVENT_RANGE_DAYS) {
		throw new ValidationError(`Audit event ranges cannot exceed ${MAX_EVENT_RANGE_DAYS} days`);
	}
	return { from, to };
}

function auditLogEntry(event: Event) {
	const { id, schema_version, ts, event: type, actor, ...metadata } = event;
	return { id, schema_version, ts, event: type, actor, metadata };
}

const listGlobalEvents = createRoute({
	method: 'get',
	path: '/events',
	operationId: 'audit.list',
	tags: ['Audit'],
	summary: 'List deployment audit events',
	description:
		'Deployment-wide audit trail, newest first. Super-admin only. Date ranges are inclusive ' +
		'and limited to 30 UTC days.',
	request: { query: GlobalEventQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(AuditLogEntryResponseSchema, 'AuditLogPage'),
			}),
			'Deployment audit events, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 403),
	},
});

const listEvents = createRoute({
	method: 'get',
	path: '/projects/{pid}/events',
	operationId: 'projects.audit.list',
	tags: ['Projects'],
	summary: "List a project's audit events for one day",
	description:
		'Catalog mutation audit trail (project/notebook lifecycle, membership changes), ' +
		'one UTC day at a time. Manager-only: events may record member management and deletions.',
	request: {
		params: ProjectIdParam,
		query: z.object({
			date: DateQuery.optional().openapi({
				example: '2026-07-01',
				description: 'UTC day (defaults to today)',
			}),
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

app.openapi(listGlobalEvents, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	await assertSuperAdmin(user, deps.policy);
	const query = c.req.valid('query');
	const range = eventRange(query.from, query.to);
	const page = await deps.services.events.listEvents({
		...range,
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		cursor: query.cursor,
		event: query.event,
		actor: query.actor,
		projectId: query.project_id,
	});
	return c.json(
		{
			success: true,
			data: { items: page.items.map(auditLogEntry), next_cursor: page.nextCursor },
		},
		200,
	);
});

app.openapi(listEvents, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const { date } = c.req.valid('query');

	// Unlike other reads (open by v1 policy), the audit trail is manager-only.
	// assertProjectRole also 404s a soft-deleted project (its own lifecycle guard).
	await assertProjectRole(deps.services.projects, pid, user, 'project.events.read', deps.policy);

	const day = date ?? new Date().toISOString().slice(0, 10);
	const events = await deps.services.events.getEvents(day);
	const data = events.filter((e) => e.project_id === pid);
	return c.json({ success: true, data }, 200);
});

export default app;

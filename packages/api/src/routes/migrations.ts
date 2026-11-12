import { createRoute, z } from '@hono/zod-openapi';
import { ConflictError, UnavailableError, MigrationInspectionSchema } from '@marimo-hub/core';
import {
	assertSessionAuthenticated,
	assertSuperAdmin,
	commonErrors,
	errorResponses,
	createApp,
	jsonContent,
	SESSION_ONLY_SECURITY,
} from '../shared';
import { logEvent } from '../log';

const DashboardSchema = MigrationInspectionSchema.extend({
	actions_available: z.boolean(),
}).openapi('MigrationDashboard');
const ResultSchema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.enum(['requested', 'already_complete']) }),
});
const app = createApp();

app.openapi(
	createRoute({
		method: 'get',
		path: '/admin/migrations',
		operationId: 'admin.migrations.list',
		tags: ['Admin'],
		summary: 'Inspect automatic migrations',
		security: SESSION_ONLY_SECURITY,
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: DashboardSchema }),
				'Saved migration progress',
			),
			...commonErrors(),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		assertSessionAuthenticated(c, 'inspect migrations');
		await assertSuperAdmin(c.get('user'), deps);
		c.header('Cache-Control', 'no-store');
		const snapshot = await deps.services.migrations.inspect();
		return c.json(
			{
				success: true as const,
				data: { ...snapshot, actions_available: !!deps.requestMigrationTick },
			},
			200,
		);
	},
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/admin/migrations/run',
		operationId: 'admin.migrations.run',
		tags: ['Admin'],
		summary: 'Request a bounded migration attempt',
		security: SESSION_ONLY_SECURITY,
		description:
			'Registers one best-effort attempt with the host. Dependencies, leases and retry backoff remain in effect. Automatic continuation requires the host scheduler. Registration is not durable delivery.',
		request: {
			body: { required: true, content: { 'application/json': { schema: z.object({}).strict() } } },
		},
		responses: {
			200: jsonContent(ResultSchema, 'Already complete'),
			202: jsonContent(ResultSchema, 'Attempt registered'),
			...errorResponses(409),
			...commonErrors(),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		assertSessionAuthenticated(c, 'request migration attempt');
		await assertSuperAdmin(c.get('user'), deps);
		if (!deps.requestMigrationTick)
			throw new UnavailableError('Migration attempts are unavailable on this host');
		const snapshot = await deps.services.migrations.inspect();
		if (snapshot.action === 'already_complete')
			return c.json({ success: true as const, data: { status: 'already_complete' as const } }, 200);
		if (snapshot.action === 'blocked')
			throw new ConflictError('Invalid checkpoints block remaining migrations');
		if (snapshot.action === 'unavailable')
			throw new UnavailableError('Migration status is unavailable');
		try {
			await deps.requestMigrationTick();
		} catch {
			throw new UnavailableError('The host could not register a migration attempt');
		}
		logEvent({
			level: 'info',
			event: 'migration_attempt_requested',
			user_id: c.get('user').id,
			request_id: c.get('requestId'),
		});
		return c.json({ success: true as const, data: { status: 'requested' as const } }, 202);
	},
);
export default app;

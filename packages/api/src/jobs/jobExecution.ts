import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bearerToken, toPublicJobRun } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from '../context';
import { fail } from '../shared';

export function createJobExecutionApp(deps: ApiDeps) {
	const app = new Hono<HonoEnv>();
	app.use('*', bodyLimit({ maxSize: 16 * 1024 }));
	app.post('/:operation', async (c) => {
		c.header('Cache-Control', 'no-store');
		const token = bearerToken(c.req.raw);
		if (!token) return fail(c, 'UNAUTHORIZED', 'Run credential required', 401);
		const run = await deps.services.jobRuns.authenticateExecution(token);
		switch (c.req.param('operation')) {
			case 'get_run':
				return c.json({ success: true, data: toPublicJobRun(run) });
			case 'patch_metadata': {
				const patch = await c.req.json().catch(() => null);
				const updated = await deps.services.jobRuns.patchMetadata(run, patch);
				return c.json({ success: true, data: toPublicJobRun(updated) });
			}
			case 'acknowledge_stop': {
				const stopped = await deps.services.jobRuns.acknowledgeStop(run);
				return c.json({ success: true, data: toPublicJobRun(stopped) });
			}
			default:
				return fail(c, 'NOT_FOUND', 'Unknown run operation', 404);
		}
	});
	return app;
}

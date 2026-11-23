import { createRoute, z } from '@hono/zod-openapi';
import { ProjectRunListQuery, listProjectRuns } from '../jobs/projectRuns';
import { RUN_LIST_DESCRIPTION } from '../jobs/runQuery';
import { JobRunResponseSchema } from '../jobs/schemas';
import { pageSchema } from '../pagination';
import { commonErrors, createApp, errorResponses, jsonContent, ProjectIdParam } from '../shared';

const app = createApp();
app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/runs',
		operationId: 'projects.runs.list',
		tags: ['Jobs'],
		summary: 'List project runs by status, triggering user, or submission tag',
		description: RUN_LIST_DESCRIPTION,
		request: { params: ProjectIdParam, query: ProjectRunListQuery },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: pageSchema(JobRunResponseSchema, 'ProjectRunPage'),
				}),
				'Authorized run history',
			),
			...commonErrors(),
			...errorResponses(400, 403, 404),
		},
	}),
	async (c) => {
		const data = await listProjectRuns(
			c.get('deps'),
			c.get('user'),
			c.req.valid('param').pid,
			c.req.valid('query'),
		);
		return c.json({ success: true as const, data }, 200);
	},
);

export default app;

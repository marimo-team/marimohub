import { createRoute, z } from '@hono/zod-openapi';
import { SearchRequestSchema, SearchResponseSchema } from '@marimo-hub/core/search';
import { commonErrors, createApp, errorResponses, jsonContent } from '../shared';
import { searchWorkspace } from '../search/operations';

const app = createApp();
app.openapi(
	createRoute({
		method: 'get',
		path: '/search',
		operationId: 'search.workspace',
		tags: ['Search'],
		summary: 'Search accessible projects and resources',
		request: {
			query: SearchRequestSchema.extend({
				limit: z.coerce.number().int().min(1).max(50).default(20),
				kinds: z
					.string()
					.transform((s, ctx) => {
						const result = SearchRequestSchema.shape.kinds.safeParse(s.split(','));
						if (!result.success) {
							ctx.addIssue({ code: 'custom', message: 'Invalid search kinds' });
							return z.NEVER;
						}
						return result.data;
					})
					.optional(),
			}),
		},
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: SearchResponseSchema }),
				'Search results and source coverage',
			),
			...commonErrors(),
			...errorResponses(404, 422),
		},
	}),
	async (c) => {
		c.header('Cache-Control', 'no-store');
		const data = await searchWorkspace(
			c.get('deps'),
			c.get('user'),
			c.req.valid('query'),
			c.req.raw.signal,
		);
		return c.json({ success: true as const, data }, 200);
	},
);
export default app;

import { createRoute, z } from '@hono/zod-openapi';
import {
	SEARCH_COVERAGE_STATUSES,
	SEARCH_KINDS,
	SearchHitSchema,
	SearchRequestSchema,
	SearchResponseSchema,
} from '@marimo-hub/core/search';
import {
	commonErrors,
	createApp,
	errorResponses,
	extensibleResponseEnum,
	jsonContent,
} from '../shared';
import { searchWorkspace } from '../search/operations';

// Core schemas are built before zod is extended, so they lack `.openapi()`; re-wrap the shape.
// The array bounds mirror `SearchResponseSchema` in core.
// Kinds and coverage statuses grow over time, so clients must tolerate unknown values.
const SearchResponse = z
	.object({
		...SearchResponseSchema.shape,
		items: z
			.array(
				z.object({
					...SearchHitSchema.shape,
					kind: extensibleResponseEnum(SEARCH_KINDS, 'notebook'),
				}),
			)
			.max(50),
		coverage: z
			.array(
				z.object({
					...SearchResponseSchema.shape.coverage.element.shape,
					status: extensibleResponseEnum(SEARCH_COVERAGE_STATUSES, 'complete'),
				}),
			)
			.max(100),
	})
	.openapi('SearchResponse');

const app = createApp();
app.openapi(
	createRoute({
		method: 'get',
		path: '/search',
		operationId: 'search.query',
		tags: ['Search'],
		summary: 'Search accessible projects and resources',
		request: {
			query: SearchRequestSchema.extend({
				limit: z.coerce.number().int().min(1).max(50).default(20),
				kinds: z
					.string()
					.openapi({
						description: `Comma-separated result kinds to include. Values: ${SEARCH_KINDS.join(', ')}.`,
						example: 'notebook,code',
					})
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
				z.object({ success: z.literal(true), data: SearchResponse }),
				'Search results and source coverage',
			),
			...commonErrors(),
			...errorResponses(404, 422, 429),
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

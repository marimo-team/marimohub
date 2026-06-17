import { createRoute, z } from '@hono/zod-openapi';
import { UserId } from '@marimo-hub/core';
import { createApp, errorResponses, jsonContent, UserResponseSchema } from '../shared';

// --- Route definitions ---

const resolveUsers = createRoute({
	method: 'get',
	path: '/users',
	tags: ['Users'],
	summary: 'Resolve user ids to display identities',
	description:
		'Batch-resolve opaque user ids (the auth `sub` stored as a notebook `author` ' +
		'or session `user_id`) into `{ id, email, name }`. Ids with no recorded ' +
		'identity are omitted from the result map.',
	request: {
		query: z.object({
			ids: z
				.string()
				.optional()
				.openapi({
					param: { name: 'ids', in: 'query' },
					description: 'Comma-separated user ids.',
					example: 'user,sub-abc123',
				}),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.record(z.string(), UserResponseSchema) }),
			'Map of user id → resolved identity (unknown ids omitted)',
		),
		...errorResponses(401),
	},
});

// --- App ---

const app = createApp();

app.openapi(resolveUsers, async (c) => {
	const { identities } = c.get('deps').services;
	const { ids } = c.req.valid('query');

	const requested = (ids ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => UserId.parse(s));

	const resolved = requested.length > 0 ? await identities.getMany(requested) : [];

	const data: Record<string, { id: string; email: string; name: string }> = {};
	for (const u of resolved) {
		data[u.id] = { id: u.id, email: u.email, name: u.name };
	}

	return c.json({ success: true, data }, 200);
});

export default app;

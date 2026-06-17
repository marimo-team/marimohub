import { createRoute, z } from '@hono/zod-openapi';
import { ForbiddenError, UserId } from '@marimo-hub/core';
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

const searchUsers = createRoute({
	method: 'get',
	path: '/users/search',
	tags: ['Users'],
	summary: 'Search the user directory',
	description:
		'Case-insensitive substring search over email, name, and id, for the add-member ' +
		'picker. Only users who have signed in at least once are in the directory. ' +
		'Under MARIMOHUB_DEFAULT_ROLE=none the caller must own or belong to at least ' +
		'one project — a signed-in account with no involvement cannot enumerate the ' +
		'directory; with a default role set, every authenticated user may search.',
	request: {
		query: z.object({
			q: z
				.string()
				.min(1)
				.max(200)
				.openapi({ param: { name: 'q', in: 'query' }, example: 'ada' }),
			limit: z.coerce.number().int().min(1).max(25).default(10),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(UserResponseSchema) }),
			'Matching users, name-sorted',
		),
		...errorResponses(401, 403, 422),
	},
});

// --- App ---

const app = createApp();

app.openapi(searchUsers, async (c) => {
	const deps = c.get('deps');
	const { identities, catalog } = deps.services;
	const user = c.get('user');
	const { q, limit } = c.req.valid('query');

	// The directory holds emails and names, so searching needs some standing.
	// With a default role every authenticated user is already a collaborator on
	// every project; under members-only, require at least one project involvement
	// (decided from the catalog snapshot — no per-project loads) so a drive-by
	// account cannot harvest the directory by substring.
	if (deps.policy.defaultRole == null) {
		const snapshot = await catalog.getCurrentSnapshot();
		const email = user.email.toLowerCase();
		const involved = snapshot.projects.some(
			(p) =>
				p.status !== 'deleted' &&
				(p.owner === user.id ||
					(p.member_ids ?? []).includes(user.id) ||
					(p.member_emails ?? []).includes(email)),
		);
		if (!involved) {
			throw new ForbiddenError('User search requires membership in at least one project');
		}
	}

	const matches = await identities.search(q, limit);
	const data = matches.map(({ id, email, name }) => ({ id, email, name }));
	return c.json({ success: true, data }, 200);
});

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

import { createRoute, z } from '@hono/zod-openapi';
import { ForbiddenError, NotFoundError, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { MAX_RESOLVED_USERS } from '@marimo-hub/core/constants';
import {
	authorizationService,
	createApp,
	errorResponses,
	jsonContent,
	UserResponseSchema,
} from '../shared';
import type { ApiDeps } from '../context';

function parseUserIds(value = ''): string[] {
	return value
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
}

// --- Route definitions ---

const resolveUsers = createRoute({
	method: 'get',
	path: '/users',
	operationId: 'users.resolve',
	tags: ['Users'],
	summary: 'Resolve user ids to display identities',
	description:
		'Batch-resolve opaque user ids (the auth `sub` stored as a notebook `author` ' +
		'or session `user_id`) into `{ id, email, name, picture_url }`. Ids with no recorded ' +
		'identity are omitted from the result map. Resolving other users requires the same ' +
		'directory authority as user search; authenticated callers may resolve themselves.',
	request: {
		query: z.object({
			ids: z
				.string()
				.refine(
					(value) => parseUserIds(value).length <= MAX_RESOLVED_USERS,
					`At most ${MAX_RESOLVED_USERS} user ids may be resolved at once`,
				)
				.optional()
				.openapi({
					param: { name: 'ids', in: 'query' },
					description: `Comma-separated user ids. At most ${MAX_RESOLVED_USERS} non-empty ids; whitespace and empty entries are ignored.`,
					example: 'user,sub-abc123',
				}),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.record(z.string(), UserResponseSchema) }),
			'Map of user id → resolved identity (unknown ids omitted)',
		),
		...errorResponses(401, 403, 404, 422),
	},
});

const searchUsers = createRoute({
	method: 'get',
	path: '/users/search',
	operationId: 'users.search',
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
		...errorResponses(401, 403, 404, 422),
	},
});

async function authorizeDirectory(deps: ApiDeps, user: AuthenticatedPrincipal): Promise<void> {
	const { catalog } = deps.services;
	const authz = authorizationService(deps);
	const credentialDecision = authz.credentialDecision(user, 'directory.search', {
		kind: 'deployment',
	});
	if (!credentialDecision.allowed) {
		if (credentialDecision.category === 'credential-resource') {
			throw new NotFoundError('Directory search is not available');
		}
		throw new ForbiddenError('Token grant does not permit user search');
	}

	// Check the grant separately: project involvement must never broaden a token's authority.
	const { credential: _credential, ...directorySubject } = user;
	const directoryDecision = await authz.authorize(directorySubject, 'directory.search', {
		kind: 'deployment',
	});
	if (!directoryDecision.allowed) {
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
}

// --- App ---

const app = createApp();

app.openapi(searchUsers, async (c) => {
	const deps = c.get('deps');
	const { identities } = deps.services;
	const user = c.get('user');
	const { q, limit } = c.req.valid('query');
	await authorizeDirectory(deps, user);

	const matches = await identities.search(q, limit);
	const data = matches.map(({ id, email, name, picture_url }) => ({
		id,
		email,
		name,
		picture_url: picture_url ?? null,
	}));
	return c.json({ success: true, data }, 200);
});

app.openapi(resolveUsers, async (c) => {
	const deps = c.get('deps');
	const { identities } = deps.services;
	const user = c.get('user');
	const { ids } = c.req.valid('query');

	const requested = parseUserIds(ids).map((id) => UserId.parse(id));

	if (requested.some((id) => id !== user.id)) await authorizeDirectory(deps, user);

	const resolved = requested.length > 0 ? await identities.getMany(requested) : [];

	const data: Record<
		string,
		{ id: string; email: string; name: string; picture_url: string | null }
	> = {};
	for (const u of resolved) {
		data[u.id] = {
			id: u.id,
			email: u.email,
			name: u.name,
			picture_url: u.picture_url ?? null,
		};
	}

	return c.json({ success: true, data }, 200);
});

export default app;

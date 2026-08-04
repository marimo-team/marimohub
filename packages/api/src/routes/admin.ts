import { createRoute, z } from '@hono/zod-openapi';
import { isSuperAdmin } from '@marimo-hub/core';
import {
	AdminUserResponseSchema,
	assertSessionAuthenticated,
	assertSuperAdmin,
	commonErrors,
	createApp,
	DeploymentConfigResponseSchema,
	errorResponses,
	jsonContent,
	SESSION_ONLY_SECURITY,
} from '../shared';
import { pageSchema } from '../pagination';

const listUsers = createRoute({
	method: 'get',
	path: '/admin/users',
	tags: ['Admin'],
	summary: 'List all users in the identity directory',
	description:
		'Every user who has signed in at least once, name-sorted. Currently a single page ' +
		'(`next_cursor` is always null). Super-admin only, and session-only: a PAT — even a ' +
		'super admin’s — is rejected with 403.',
	security: SESSION_ONLY_SECURITY,
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(AdminUserResponseSchema, 'AdminUserPage'),
			}),
			'The user directory, name-sorted',
		),
		...commonErrors(),
		...errorResponses(403),
	},
});

const getConfig = createRoute({
	method: 'get',
	path: '/admin/config',
	tags: ['Admin'],
	summary: "Describe the deployment's configuration",
	description:
		'Read-only view of every configuration group (storage, compute, auth, …) as resolved from ' +
		"the serving replica's environment at boot; secret values are never included, only whether " +
		'they are set. Super-admin only, session-only.',
	security: SESSION_ONLY_SECURITY,
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: DeploymentConfigResponseSchema }),
			'The deployment configuration, secrets redacted',
		),
		...commonErrors(),
		...errorResponses(403),
	},
});

const app = createApp();

app.openapi(listUsers, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'access admin endpoints');
	assertSuperAdmin(user, deps.policy);

	const all = await deps.services.identities.list();
	const items = all
		.map((u) => ({
			id: u.id,
			email: u.email,
			name: u.name,
			updated_at: u.updated_at,
			is_super_admin: isSuperAdmin({ id: u.id, email: u.email }, deps.policy.superAdmins),
		}))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	// The directory is served whole (same O(low-thousands) bound as user
	// search); the page envelope reserves room for a real cursor later.
	return c.json({ success: true, data: { items, next_cursor: null } }, 200);
});

app.openapi(getConfig, (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'access admin endpoints');
	assertSuperAdmin(user, deps.policy);

	const v = deps.version;
	return c.json(
		{
			success: true,
			data: {
				deployment: v
					? {
							version: v.version,
							image: v.image ?? null,
							sandbox_image: v.sandboxImage ?? null,
							started_at: v.startedAt ?? null,
							replica: v.replica ?? null,
							node: v.node ?? null,
							backends: v.backends ?? null,
						}
					: null,
				groups: (deps.configSummary?.groups ?? []).map((group) => ({
					...group,
					// Belt-and-braces: the summary builder already withholds secret
					// values, but never trust a future source to have done so.
					settings: group.settings.map((s) => ({ ...s, value: s.secret ? null : s.value })),
				})),
				policy: {
					default_role: deps.policy.defaultRole ?? null,
					super_admins: deps.policy.superAdmins ?? [],
				},
			},
		},
		200,
	);
});

export default app;

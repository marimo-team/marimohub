import { createRoute, z } from '@hono/zod-openapi';
import { ForbiddenError, isSuperAdmin, UserId } from '@marimo-hub/core';
import type { Identity } from '@marimo-hub/core';
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
import { appendAudit } from '../log';
import { pageSchema } from '../pagination';

const UserSuspensionParam = z.object({
	id: z
		.string()
		.min(1)
		.openapi({
			param: { name: 'id', in: 'path', description: "The user's identity-provider subject id" },
			example: 'user_01HXY00000000000000000000',
		}),
});

function adminUser(identity: Identity, superAdmins?: readonly string[]) {
	return {
		id: identity.id,
		email: identity.email,
		name: identity.name,
		updated_at: identity.updated_at,
		suspended_at: identity.suspended_at ?? null,
		is_super_admin: isSuperAdmin(identity, superAdmins),
	};
}

const listUsers = createRoute({
	method: 'get',
	path: '/admin/users',
	operationId: 'admin.users.list',
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
	operationId: 'admin.config.get',
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

const suspendUser = createRoute({
	method: 'put',
	path: '/users/{id}/suspension',
	tags: ['Users', 'Admin'],
	summary: 'Suspend a user',
	description:
		'Blocks the user at authentication time, including personal access tokens. Super-admin ' +
		'only and session-only. A super admin cannot suspend their own account.',
	security: SESSION_ONLY_SECURITY,
	request: { params: UserSuspensionParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: AdminUserResponseSchema }),
			'The suspended user',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const unsuspendUser = createRoute({
	method: 'delete',
	path: '/users/{id}/suspension',
	tags: ['Users', 'Admin'],
	summary: 'Reactivate a suspended user',
	description: 'Restores authentication for a known user. Super-admin only and session-only.',
	security: SESSION_ONLY_SECURITY,
	request: { params: UserSuspensionParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: AdminUserResponseSchema }),
			'The reactivated user',
		),
		...commonErrors(),
		...errorResponses(404),
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
		.map((identity) => adminUser(identity, deps.policy.superAdmins))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	// The directory is served whole (same O(low-thousands) bound as user
	// search); the page envelope reserves room for a real cursor later.
	return c.json({ success: true, data: { items, next_cursor: null } }, 200);
});

app.openapi(suspendUser, async (c) => {
	const deps = c.get('deps');
	const actor = c.get('user');
	assertSessionAuthenticated(c, 'suspend users');
	assertSuperAdmin(actor, deps.policy);
	const targetId = UserId.parse(c.req.valid('param').id);
	if (targetId === actor.id) throw new ForbiddenError('You cannot suspend your own account');

	const identity = await deps.services.identities.setSuspension(targetId, true);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: actor.id },
		'user.suspended',
		() =>
			deps.services.events.append({
				event: 'user.suspended',
				actor: actor.id,
				target_user_id: targetId,
			}),
	);
	return c.json({ success: true, data: adminUser(identity, deps.policy.superAdmins) }, 200);
});

app.openapi(unsuspendUser, async (c) => {
	const deps = c.get('deps');
	const actor = c.get('user');
	assertSessionAuthenticated(c, 'reactivate users');
	assertSuperAdmin(actor, deps.policy);
	const targetId = UserId.parse(c.req.valid('param').id);

	const identity = await deps.services.identities.setSuspension(targetId, false);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: actor.id },
		'user.unsuspended',
		() =>
			deps.services.events.append({
				event: 'user.unsuspended',
				actor: actor.id,
				target_user_id: targetId,
			}),
	);
	return c.json({ success: true, data: adminUser(identity, deps.policy.superAdmins) }, 200);
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

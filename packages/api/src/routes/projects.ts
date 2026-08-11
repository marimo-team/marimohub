import { createRoute, z } from '@hono/zod-openapi';
import {
	ASSIGNABLE_ROLES,
	effectiveRole,
	notificationRouter,
	resolveMemberRecipient,
	roleAtLeast,
	toPublicProject,
	UserId,
} from '@marimo-hub/core';
import type {
	AuthSubject,
	AuthzPolicy,
	Identity,
	Project,
	ProjectMember,
	Role,
} from '@marimo-hub/core';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	ifMatchToken,
	IfMatchHeader,
	IdempotencyKeyHeader,
	jsonBody,
	jsonContent,
	loadVisibleProject,
	ProjectIdParam,
	ProjectMemberResponseSchema,
	ProjectResponseSchema,
	retireLiveApps,
	SnapshotProjectEntrySchema,
	SuccessResponseSchema,
} from '../shared';
import { idempotentCreate } from '../idempotency';
import { pageSchema, paginate, PaginationQuery } from '../pagination';
import { scheduleNotification } from '../notifications';

// --- Request body schemas ---

// Per-project workload-identity federation opt-in (see ProjectFederationSchema in
// @marimo-hub/core). `enabled` is "when"; `target` is "for what" (which
// deployment-registered federation target). Inert unless the deployment configures WIF.
const FederationBody = z
	.object({
		enabled: z.boolean().openapi({ example: true }),
		target: z.string().optional().openapi({ example: 'default' }),
	})
	.openapi('ProjectFederationInput');

const CreateProjectBody = z.object({
	name: z.string().min(1).openapi({ example: 'Data Science' }),
	description: z.string().openapi({ example: 'Exploratory analysis notebooks' }),
	tags: z
		.array(z.string())
		.optional()
		.openapi({ example: ['analytics'] }),
	federation: FederationBody.optional(),
});

const UpdateProjectBody = z.object({
	name: z.string().min(1).optional().openapi({ example: 'ML Pipeline' }),
	description: z.string().optional(),
	tags: z.array(z.string()).optional(),
	federation: FederationBody.optional(),
});

const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES).openapi('AssignableRole');

// A member is identified by user id (preferred — the search picker resolves to
// one) or by email. A known email is resolved to its user id server-side; an
// unknown one is stored as a pending invite that activates on first login.
const AddMemberBody = z
	.object({
		user_id: z.string().min(1).optional().openapi({ example: 'user_01HXY00000000000000000000' }),
		email: z.email().optional().openapi({ example: 'teammate@example.com' }),
		role: AssignableRoleSchema.openapi({ example: 'editor' }),
	})
	.refine((b) => (b.user_id === undefined) !== (b.email === undefined), {
		message: 'Provide exactly one of user_id or email',
	});

const UpdateMemberRoleBody = z.object({
	role: AssignableRoleSchema.openapi({ example: 'manager' }),
});

const MemberIdParam = ProjectIdParam.extend({
	uid: z
		.string()
		.min(1)
		.openapi({
			param: {
				name: 'uid',
				in: 'path',
				description: "The member's user id, or the (URL-encoded) email of a pending invite",
			},
			example: 'user_01HXY00000000000000000000',
		}),
});

// --- Response projection ---

/**
 * Pending-invite rows carry raw email addresses (PII of people who never signed
 * in). Only managers and admins manage membership, so only they get the full roster;
 * everyone else sees the id rows plus — so invitees can find themselves — any
 * invite row matching their own login email.
 */
function visibleMembers(
	members: ProjectMember[],
	role: Role | null,
	subject: AuthSubject,
): ProjectMember[] {
	if (roleAtLeast(role, 'manager')) return members;
	const email = subject.email.toLowerCase();
	return members.filter((m) => m.user_id !== undefined || m.email === email);
}

/** Project detail + the requesting user's effective role, with internal fields stripped. */
function projectResponse(project: Project, subject: AuthSubject, policy?: AuthzPolicy) {
	const role = effectiveRole(project, subject, policy);
	const pub = toPublicProject(project);
	return { ...pub, members: visibleMembers(pub.members, role, subject), your_role: role };
}

// --- Route definitions ---

const listProjects = createRoute({
	method: 'get',
	path: '/projects',
	tags: ['Projects'],
	summary: 'List all projects',
	request: { query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(SnapshotProjectEntrySchema, 'ProjectPage'),
			}),
			'List of projects with notebook summaries, newest first',
		),
		...commonErrors(),
		...errorResponses(400),
	},
});

const createProject = createRoute({
	method: 'post',
	path: '/projects',
	tags: ['Projects'],
	summary: 'Create a project',
	request: { headers: IdempotencyKeyHeader, body: jsonBody(CreateProjectBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Project created',
		),
		...commonErrors(),
	},
});

const getProject = createRoute({
	method: 'get',
	path: '/projects/{pid}',
	tags: ['Projects'],
	summary: 'Get a project',
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Project details',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const updateProject = createRoute({
	method: 'patch',
	path: '/projects/{pid}',
	tags: ['Projects'],
	summary: 'Update a project',
	request: { params: ProjectIdParam, headers: IfMatchHeader, body: jsonBody(UpdateProjectBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Project updated',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const deleteProject = createRoute({
	method: 'delete',
	path: '/projects/{pid}',
	tags: ['Projects'],
	summary: 'Delete a project',
	request: { params: ProjectIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Project deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listMembers = createRoute({
	method: 'get',
	path: '/projects/{pid}/members',
	tags: ['Projects'],
	summary: 'List project members',
	description:
		'Pending email invites are visible only to project managers (plus the invitee ' +
		'themself); other callers see the id-keyed rows only.',
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(ProjectMemberResponseSchema) }),
			'Project members',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const addMember = createRoute({
	method: 'post',
	path: '/projects/{pid}/members',
	tags: ['Projects'],
	summary: 'Add a project member',
	description:
		'Add a member by user id or email. A known email resolves to its user id; an unknown ' +
		'email becomes a pending invite that grants access when that person first signs in.',
	request: { params: ProjectIdParam, body: jsonBody(AddMemberBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Member added',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409),
	},
});

const updateMember = createRoute({
	method: 'put',
	path: '/projects/{pid}/members/{uid}',
	tags: ['Projects'],
	summary: "Change a member's role",
	request: { params: MemberIdParam, body: jsonBody(UpdateMemberRoleBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Member role updated',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409),
	},
});

const removeMember = createRoute({
	method: 'delete',
	path: '/projects/{pid}/members/{uid}',
	tags: ['Projects'],
	summary: 'Remove a project member',
	request: { params: MemberIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Member removed'),
		...commonErrors(),
		...errorResponses(403, 404, 409),
	},
});

// --- App ---

const app = createApp();

app.openapi(listProjects, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const all = await deps.services.projects.listProjects({
		subject: user,
		policy: deps.policy,
	});
	const data = paginate(all, c.req.valid('query'), {
		key: (p) => p.created_at,
		tiebreak: (p) => p.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createProject, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const body = c.req.valid('json');
	const data = await idempotentCreate(c, 'POST /projects', async () => {
		const project = await deps.services.projects.createProject(body, user.id);
		return projectResponse(project, user, deps.policy);
	});
	return c.json({ success: true, data }, 201);
});

app.openapi(getProject, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	// 404s a project the caller can't see (MARIMOHUB_DEFAULT_ROLE=none, non-member)
	// or one that is soft-deleted.
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps.policy);
	c.header('ETag', etagFor(project.updated_at));
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 200);
});

app.openapi(updateProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'manager', deps.policy);
	const body = c.req.valid('json');
	const project = await projects.updateProject(pid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(project.updated_at));
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 200);
});

app.openapi(deleteProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'manager', deps.policy);
	await projects.deleteProject(pid, user.id, ifMatchToken(c));
	await retireLiveApps(deps, pid);
	return c.json({ success: true }, 200);
});

app.openapi(listMembers, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps.policy);
	const role = effectiveRole(project, user, deps.policy);
	return c.json({ success: true, data: visibleMembers(project.members, role, user) }, 200);
});

app.openapi(addMember, async (c) => {
	const deps = c.get('deps');
	const { projects, identities } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'manager', deps.policy);
	const body = c.req.valid('json');
	// Both identifiers are passed to the service whenever both are known, so the
	// duplicate check spans a person's id row AND any pending invite row — one
	// human must never hold two rows (revoking one would silently leave the other).
	let member: { user_id: UserId; email?: string } | { email: string };
	let memberIdentity: Identity | null = null;
	if (body.email !== undefined) {
		const email = body.email.toLowerCase();
		// A known email is canonicalized to its user id; an unknown one is stored
		// as a pending invite that matches by email at auth time.
		const known = await identities.getByEmail(email);
		memberIdentity = known;
		member = known ? { user_id: known.id, email } : { email };
	} else {
		// The body refine guarantees user_id is set when email is not.
		const userId = UserId.parse(body.user_id ?? '');
		memberIdentity = await identities.get(userId);
		member = { user_id: userId, email: memberIdentity?.email };
	}
	const { project, mutationId } = await projects.addMemberWithMutation(
		pid,
		member,
		body.role,
		user.id,
	);
	const notificationMember: ProjectMember =
		'user_id' in member
			? { user_id: member.user_id, role: body.role }
			: { email: member.email, role: body.role };
	const recipient = resolveMemberRecipient(notificationMember, memberIdentity);
	const kind = notificationMember.email ? 'member.invited' : 'member.added';
	scheduleNotification(deps, kind, { project_id: pid, user: user.id }, () =>
		notificationRouter.render({
			kind,
			project,
			member: notificationMember,
			recipient,
			actor: user,
			mutationId,
			baseUrl: deps.sandbox.appBaseUrl,
		}),
	);
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 201);
});

app.openapi(updateMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, uid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'manager', deps.policy);
	const body = c.req.valid('json');
	const project = await projects.updateMemberRole(pid, uid, body.role, user.id);
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 200);
});

app.openapi(removeMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, uid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'manager', deps.policy);
	await projects.removeMember(pid, uid, user.id);
	return c.json({ success: true }, 200);
});

export default app;

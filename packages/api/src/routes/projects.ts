import { createRoute, z } from '@hono/zod-openapi';
import {
	ASSIGNABLE_ROLES,
	effectiveRole,
	isMonotonicRestrictionIncrease,
	notificationRouter,
	ProjectId,
	resolveMemberRecipient,
	roleAtLeast,
	toPublicProject,
	UserId,
	ValidationError,
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
	assertDeploymentAction,
	assertProjectActionOn,
	assertProjectRole,
	assertSessionAuthenticated,
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
	cancelJobRuns,
	SecurityLabelsBodySchema,
	SESSION_ONLY_SECURITY,
	SnapshotProjectEntrySchema,
	SuccessResponseSchema,
} from '../shared';
import { idempotentCreate } from '../idempotency';
import { pageSchema, paginate, ProjectListQuery } from '../pagination';
import {
	assertNotificationMutationAllowed,
	scheduleNotification,
	scheduleProjectAlert,
} from '../notifications';

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
	operationId: 'projects.list',
	tags: ['Projects'],
	summary: 'List all projects',
	description: 'When paging a filtered list, send the same filters with each cursor.',
	request: { query: ProjectListQuery },
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
	operationId: 'projects.create',
	tags: ['Projects'],
	summary: 'Create a project',
	request: { headers: IdempotencyKeyHeader, body: jsonBody(CreateProjectBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Project created',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const getProject = createRoute({
	method: 'get',
	path: '/projects/{pid}',
	operationId: 'projects.get',
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
	operationId: 'projects.update',
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
	operationId: 'projects.delete',
	tags: ['Projects'],
	summary: 'Delete a project',
	request: { params: ProjectIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Project deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412, 429),
	},
});

const setSecurityLabels = createRoute({
	method: 'put',
	path: '/projects/{pid}/security-labels',
	operationId: 'projects.securityLabels.set',
	tags: ['Projects'],
	summary: 'Set project security labels',
	description:
		'Sets the project classification and required compartments. Requires super-admin standing ' +
		'— no project role grants label authority — and the deployment must have resource security ' +
		'configured. Labels only add restrictions on top of role checks.',
	security: SESSION_ONLY_SECURITY,
	request: {
		params: ProjectIdParam,
		headers: IfMatchHeader,
		body: jsonBody(SecurityLabelsBodySchema),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Security labels updated',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const clearSecurityLabels = createRoute({
	method: 'delete',
	path: '/projects/{pid}/security-labels',
	operationId: 'projects.securityLabels.clear',
	tags: ['Projects'],
	summary: 'Remove project security labels',
	security: SESSION_ONLY_SECURITY,
	request: { params: ProjectIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Security labels removed',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listMembers = createRoute({
	method: 'get',
	path: '/projects/{pid}/members',
	operationId: 'projects.members.list',
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
	operationId: 'projects.members.add',
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
		...errorResponses(403, 404, 409, 429),
	},
});

const updateMember = createRoute({
	method: 'put',
	path: '/projects/{pid}/members/{uid}',
	operationId: 'projects.members.update',
	tags: ['Projects'],
	summary: "Change a member's role",
	request: { params: MemberIdParam, body: jsonBody(UpdateMemberRoleBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Member role updated',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 429),
	},
});

const removeMember = createRoute({
	method: 'delete',
	path: '/projects/{pid}/members/{uid}',
	operationId: 'projects.members.remove',
	tags: ['Projects'],
	summary: 'Remove a project member',
	request: { params: MemberIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Member removed'),
		...commonErrors(),
		...errorResponses(403, 404, 409, 429),
	},
});

// --- App ---

const app = createApp();

app.openapi(listProjects, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const query = c.req.valid('query');
	const all = await deps.services.projects.listProjects({
		subject: user,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
		status: query.status,
		tag: query.tag,
		q: query.q,
	});
	const data = paginate(all, query, {
		key: (p) => p.created_at,
		tiebreak: (p) => p.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createProject, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	await assertDeploymentAction(
		user,
		'project.create',
		deps,
		'Project creation is restricted to authorized users',
	);
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
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	c.header('ETag', etagFor(project.updated_at));
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 200);
});

app.openapi(updateProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'project.update', deps);
	const body = c.req.valid('json');
	const project = await projects.updateProject(pid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(project.updated_at));
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 200);
});

/**
 * Shared handler body for the two label mutations. The action is chosen from
 * the actual transition: adding labels or a provable compartment-superset
 * increase is a raise; anything else — removal, a classification change, a
 * dropped compartment — needs the stricter lowering permission (core cannot
 * order classifications; the constraint adapter owns the lattice).
 */
async function mutateSecurityLabels(
	c: Parameters<Parameters<typeof app.openapi>[1]>[0],
	labels: { classification: string; compartments: string[] } | undefined,
) {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const pid = ProjectId.parse(c.req.param('pid') ?? '');
	assertSessionAuthenticated(c, 'change security labels');
	if (labels !== undefined && deps.resourceSecurity === undefined) {
		throw new ValidationError(
			'Security labels require resource security to be configured (MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER); ' +
				'labels without an evaluator would lock the project for everyone.',
		);
	}
	const project = await projects.getProject(pid);
	const previous = project.security_labels;
	const action =
		previous === undefined
			? 'security-labels.raise'
			: labels !== undefined && isMonotonicRestrictionIncrease(previous, labels)
				? 'security-labels.raise'
				: 'security-labels.lower';
	await assertProjectActionOn(project, user, action, deps);
	// The raise/lower decision was made against `project`; without a client
	// precondition, pin the write to that version so a concurrent label change
	// yields 412 instead of being overwritten by a decision on stale labels.
	const updated = await projects.setSecurityLabels(
		pid,
		labels,
		user.id,
		ifMatchToken(c) ?? project.updated_at,
	);
	c.header('ETag', etagFor(updated.updated_at));
	return c.json({ success: true, data: projectResponse(updated, user, deps.policy) }, 200);
}

app.openapi(setSecurityLabels, async (c) => mutateSecurityLabels(c, c.req.valid('json')));

app.openapi(clearSecurityLabels, async (c) => mutateSecurityLabels(c, undefined));

app.openapi(deleteProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'project.delete', deps);
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const deleted = await projects.deleteProjectWithMutation(pid, user.id, ifMatchToken(c));
	if (deleted) {
		scheduleProjectAlert(deps, pid, 'project.deleted', { project_id: pid, user: user.id }, () =>
			notificationRouter.render({
				kind: 'project.deleted',
				project: deleted.project,
				actor: user,
				mutationId: deleted.mutationId,
			}),
		);
	}
	await retireLiveApps(deps, pid);
	await cancelJobRuns(deps, pid, user.id);
	return c.json({ success: true }, 200);
});

app.openapi(listMembers, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	const role = effectiveRole(project, user, deps.policy);
	return c.json({ success: true, data: visibleMembers(project.members, role, user) }, 200);
});

app.openapi(addMember, async (c) => {
	const deps = c.get('deps');
	const { projects, identities } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'project.members.manage', deps);
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
	assertNotificationMutationAllowed(deps, user.id, {
		recipient: memberIdentity?.email ?? ('user_id' in member ? member.user_id : member.email),
		recipientScope: pid,
	});
	const { project, mutationId } = await projects.addMemberWithMutation(
		pid,
		member,
		body.role,
		user.id,
	);
	if ('user_id' in member) {
		const notificationMember = { user_id: member.user_id, role: body.role };
		const render = () =>
			notificationRouter.render({
				kind: 'member.added',
				project,
				member: notificationMember,
				recipient: resolveMemberRecipient(notificationMember, memberIdentity),
				actor: user,
				mutationId,
				baseUrl: deps.sandbox.appBaseUrl,
			});
		scheduleNotification(deps, 'member.added', { project_id: pid, user: user.id }, () =>
			render().filter((notification) => notification.audience === 'personal'),
		);
		scheduleProjectAlert(deps, pid, 'member.added', { project_id: pid, user: user.id }, render);
	} else {
		const notificationMember = { email: member.email, role: body.role };
		const render = () =>
			notificationRouter.render({
				kind: 'member.invited',
				project,
				member: notificationMember,
				recipient: resolveMemberRecipient(notificationMember, memberIdentity),
				actor: user,
				mutationId,
				baseUrl: deps.sandbox.appBaseUrl,
			});
		scheduleNotification(deps, 'member.invited', { project_id: pid, user: user.id }, () =>
			render().filter((notification) => notification.audience === 'personal'),
		);
		scheduleProjectAlert(deps, pid, 'member.invited', { project_id: pid, user: user.id }, render);
	}
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 201);
});

app.openapi(updateMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, uid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'project.members.manage', deps);
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const body = c.req.valid('json');
	const result = await projects.updateMemberRoleWithMutation(pid, uid, body.role, user.id);
	const member = result.member;
	if (member && member.role !== result.previousMember.role) {
		scheduleProjectAlert(deps, pid, 'member.role_changed', { project_id: pid, user: user.id }, () =>
			notificationRouter.render({
				kind: 'member.role_changed',
				project: result.project,
				member,
				oldRole: result.previousMember.role,
				actor: user,
				mutationId: result.mutationId,
				baseUrl: deps.sandbox.appBaseUrl,
			}),
		);
	}
	const project = result.project;
	return c.json({ success: true, data: projectResponse(project, user, deps.policy) }, 200);
});

app.openapi(removeMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, uid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user, 'project.members.manage', deps);
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const result = await projects.removeMemberWithMutation(pid, uid, user.id);
	scheduleProjectAlert(deps, pid, 'member.removed', { project_id: pid, user: user.id }, () =>
		notificationRouter.render({
			kind: 'member.removed',
			project: result.project,
			member: result.previousMember,
			actor: user,
			mutationId: result.mutationId,
			baseUrl: deps.sandbox.appBaseUrl,
		}),
	);
	return c.json({ success: true }, 200);
});

export default app;

import { retireNotebookPreviews } from '../previews';
import { TagsBodySchema } from '../tagNamespace';
import { createRoute, z } from '@hono/zod-openapi';
import {
	ASSIGNABLE_ROLES,
	MemberGroupSchema,
	withMemberIdentityRules,
	effectiveRole,
	isMonotonicRestrictionIncrease,
	notificationRouter,
	ProjectId,
	ProjectDefaultRoleSchema,
	resolveMemberRecipient,
	roleAtLeast,
	toPublicProject,
	UserId,
	ValidationError,
} from '@marimo-hub/core';
import type {
	AssignableRole,
	AuthSubject,
	Identity,
	MemberSelector,
	NewMember,
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
import type { ApiDeps } from '../context';
import { idempotentCreate } from '../idempotency';
import { effectiveFederation } from '../federation';
import { pageSchema, paginate, ProjectListQuery } from '../pagination';
import {
	assertNotificationMutationAllowed,
	scheduleNotification,
	scheduleProjectAlert,
} from '../notifications';

// --- Request body schemas ---

// Per-project workload-identity federation override (see ProjectFederationSchema in
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
	tags: TagsBodySchema.optional().openapi({ example: ['analytics'] }),
	federation: FederationBody.optional(),
});

const UpdateProjectBody = z.object({
	default_role: ProjectDefaultRoleSchema.optional().openapi({
		description:
			'Non-member access. inherit uses deployment and OIDC defaults. none grants no default access. Requires manager or higher.',
	}),
	name: z.string().min(1).optional().openapi({ example: 'ML Pipeline' }),
	description: z.string().optional(),
	tags: TagsBodySchema.optional(),
	// A union rather than `.nullable()`: the latter inlines the ProjectFederationInput ref.
	federation: z.union([FederationBody, z.null()]).optional().openapi({
		description: '`null` clears the project override so the deployment default applies.',
	}),
});

const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES).openapi('AssignableRole');

// Known emails resolve to user ids; unknown emails remain pending invites.
const AddMemberBody = withMemberIdentityRules(
	z.object({
		user_id: z.string().min(1).optional().openapi({ example: 'user_01HXY00000000000000000000' }),
		email: z.email().optional().openapi({ example: 'teammate@example.com' }),
		role: AssignableRoleSchema.openapi({ example: 'editor' }),
	}),
	{ identities: 'user_id or email' },
);

// Group ids stay in their own namespace and never resolve through the directory.
const AddGroupMemberBody = z.object({
	group: MemberGroupSchema.clone().openapi({ example: '/teams/data-science' }),
	role: AssignableRoleSchema.openapi({ example: 'editor' }),
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

const GroupMemberQuery = z.object({
	group: MemberGroupSchema.clone().openapi({
		param: { name: 'group', in: 'query' },
		example: '/teams/data-science',
	}),
});

// --- Response projection ---

/**
 * Pending-invite rows carry raw email addresses (PII of people who never signed
 * in). Only managers and admins manage membership, so only they get the full roster;
 * everyone else sees user and group rows plus — so invitees can find themselves — any
 * invite row matching their own login email.
 */
function visibleMembers(members: ProjectMember[], role: Role | null, subject: AuthSubject) {
	const email = subject.email.toLowerCase();
	return members
		.filter(
			(m) =>
				roleAtLeast(role, 'manager') ||
				m.user_id !== undefined ||
				m.group !== undefined ||
				m.email === email,
		)
		.map((member) => ProjectMemberResponseSchema.parse(member));
}

/** Project detail + the requesting user's effective role, with internal fields stripped. */
function projectResponse(
	project: Project,
	subject: AuthSubject,
	deps: Pick<ApiDeps, 'policy' | 'wif'>,
) {
	const role = effectiveRole(project, subject, deps.policy);
	const pub = toPublicProject(project);
	return {
		...pub,
		default_role: pub.default_role ?? 'inherit',
		members: visibleMembers(pub.members, role, subject),
		your_role: role,
		federation_effective: effectiveFederation(project, deps.wif),
	};
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
		'themself); other callers see user and group rows.',
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
		...errorResponses(403, 404, 409, 422, 429),
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

const addGroupMember = createRoute({
	method: 'post',
	path: '/projects/{pid}/group-members',
	operationId: 'projects.members.groups.add',
	tags: ['Projects'],
	summary: 'Add a project group member',
	description:
		'Grant an exact IdP group id a project role. Groups cannot hold admin. Requires a deployment ' +
		'whose sessions carry IdP groups (see `project_groups` in capabilities).',
	request: { params: ProjectIdParam, body: jsonBody(AddGroupMemberBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Group added',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 422, 429),
	},
});

const updateGroupMember = createRoute({
	method: 'put',
	path: '/projects/{pid}/group-members',
	operationId: 'projects.members.groups.update',
	tags: ['Projects'],
	summary: "Change a group's project role",
	request: {
		params: ProjectIdParam,
		query: GroupMemberQuery,
		body: jsonBody(UpdateMemberRoleBody),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Group role updated',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 429),
	},
});

const removeGroupMember = createRoute({
	method: 'delete',
	path: '/projects/{pid}/group-members',
	operationId: 'projects.members.groups.remove',
	tags: ['Projects'],
	summary: 'Remove a project group member',
	request: { params: ProjectIdParam, query: GroupMemberQuery },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Group removed'),
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
		tagNamespace: query.tag_namespace,
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
		return projectResponse(project, user, deps);
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
	return c.json({ success: true, data: projectResponse(project, user, deps) }, 200);
});

app.openapi(updateProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const current = await assertProjectRole(projects, pid, user, 'project.update', deps);
	const body = c.req.valid('json');
	const oldDefaultRole = current.default_role ?? 'inherit';
	const defaultAccessChanged =
		body.default_role !== undefined && body.default_role !== oldDefaultRole;
	if (defaultAccessChanged)
		assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const project = await projects.updateProject(pid, body, user.id, ifMatchToken(c));
	const newDefaultRole = project.default_role ?? 'inherit';
	if (defaultAccessChanged && newDefaultRole !== oldDefaultRole) {
		scheduleProjectAlert(
			deps,
			pid,
			'project.default_access_changed',
			{ project_id: pid, user: user.id },
			() =>
				notificationRouter.render({
					kind: 'project.default_access_changed',
					project,
					oldDefaultRole,
					newDefaultRole,
					actor: user,
					// Each write advances updated_at, so it identifies this mutation.
					mutationId: project.updated_at,
					baseUrl: deps.sandbox.appBaseUrl,
				}),
		);
	}
	c.header('ETag', etagFor(project.updated_at));
	return c.json({ success: true, data: projectResponse(project, user, deps) }, 200);
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
	return c.json({ success: true, data: projectResponse(updated, user, deps) }, 200);
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
	await retireNotebookPreviews(deps, pid);
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

type MemberAddedAlert =
	| { kind: 'member.added'; member: { user_id: UserId; role: AssignableRole } }
	| { kind: 'member.invited'; member: { email: string; role: AssignableRole } }
	| { kind: 'member.group_added'; member: { group: string; role: AssignableRole } };

async function addProjectMember(
	deps: ApiDeps,
	user: AuthSubject,
	pid: ProjectId,
	member: NewMember,
	role: AssignableRole,
	memberIdentity: Identity | null,
) {
	const { project, mutationId } = await deps.services.projects.addMemberWithMutation(
		pid,
		member,
		role,
		user.id,
	);
	const notification: MemberAddedAlert =
		'group' in member
			? { kind: 'member.group_added', member: { group: member.group, role } }
			: 'user_id' in member
				? { kind: 'member.added', member: { user_id: member.user_id, role } }
				: { kind: 'member.invited', member: { email: member.email, role } };
	const render = () =>
		notificationRouter.render({
			...notification,
			project,
			recipient: resolveMemberRecipient(notification.member, memberIdentity),
			actor: user,
			mutationId,
			baseUrl: deps.sandbox.appBaseUrl,
		});
	const fields = { project_id: pid, user: user.id };
	scheduleNotification(deps, notification.kind, fields, () =>
		render().filter((notification) => notification.audience === 'personal'),
	);
	scheduleProjectAlert(deps, pid, notification.kind, fields, render);
	return projectResponse(project, user, deps);
}

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
	const data = await addProjectMember(deps, user, pid, member, body.role, memberIdentity);
	return c.json({ success: true, data }, 201);
});

app.openapi(addGroupMember, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(deps.services.projects, pid, user, 'project.members.manage', deps);
	if (!deps.policy.groupsCarried)
		throw new ValidationError('IdP group membership is not enabled for this deployment');
	const { group, role } = c.req.valid('json');
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const data = await addProjectMember(deps, user, pid, { group }, role, null);
	return c.json({ success: true, data }, 201);
});

async function changeMemberRole(
	deps: ApiDeps,
	user: AuthSubject,
	pid: ProjectId,
	selector: MemberSelector,
	role: AssignableRole,
) {
	const { projects } = deps.services;
	await assertProjectRole(projects, pid, user, 'project.members.manage', deps);
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const result = await projects.updateMemberRoleWithMutation(pid, selector, role, user.id);
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
	return projectResponse(result.project, user, deps);
}

async function deleteMember(
	deps: ApiDeps,
	user: AuthSubject,
	pid: ProjectId,
	selector: MemberSelector,
) {
	const { projects } = deps.services;
	await assertProjectRole(projects, pid, user, 'project.members.manage', deps);
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const result = await projects.removeMemberWithMutation(pid, selector, user.id);
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
}

app.openapi(updateMember, async (c) => {
	const { pid, uid } = c.req.valid('param');
	const data = await changeMemberRole(
		c.get('deps'),
		c.get('user'),
		pid,
		uid,
		c.req.valid('json').role,
	);
	return c.json({ success: true, data }, 200);
});
app.openapi(updateGroupMember, async (c) => {
	const { pid } = c.req.valid('param');
	const data = await changeMemberRole(
		c.get('deps'),
		c.get('user'),
		pid,
		c.req.valid('query'),
		c.req.valid('json').role,
	);
	return c.json({ success: true, data }, 200);
});
app.openapi(removeMember, async (c) => {
	const { pid, uid } = c.req.valid('param');
	await deleteMember(c.get('deps'), c.get('user'), pid, uid);
	return c.json({ success: true }, 200);
});
app.openapi(removeGroupMember, async (c) => {
	const { pid } = c.req.valid('param');
	await deleteMember(c.get('deps'), c.get('user'), pid, c.req.valid('query'));
	return c.json({ success: true }, 200);
});

export default app;

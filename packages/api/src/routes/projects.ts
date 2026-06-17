import { createRoute, z } from '@hono/zod-openapi';
import { effectiveRole, NotFoundError, ROLES, toPublicProject, UserId } from '@marimo-hub/core';
import type { Project, Role } from '@marimo-hub/core';
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
	SnapshotProjectEntrySchema,
	SuccessResponseSchema,
} from '../shared';
import { idempotentCreate } from '../idempotency';
import { pageSchema, paginate, PaginationQuery } from '../pagination';

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

const AddMemberBody = z.object({
	user_id: z.string().min(1).openapi({ example: 'user_01HXY00000000000000000000' }),
	role: z.enum(ROLES).openapi({ example: 'editor' }),
});

const UpdateMemberRoleBody = z.object({
	role: z.enum(ROLES).openapi({ example: 'admin' }),
});

const MemberIdParam = ProjectIdParam.extend({
	uid: z
		.string()
		.min(1)
		.openapi({ param: { name: 'uid', in: 'path' }, example: 'user_01HXY00000000000000000000' }),
});

// --- Response projection ---

/** Project detail + the requesting user's effective role, with internal fields stripped. */
function projectResponse(project: Project, userId: UserId, defaultRole?: Role) {
	return { ...toPublicProject(project), your_role: effectiveRole(project, userId, defaultRole) };
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
		userId: user.id,
		defaultRole: deps.policy.defaultRole,
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
		return projectResponse(project, user.id, deps.policy.defaultRole);
	});
	return c.json({ success: true, data }, 201);
});

app.openapi(getProject, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	// 404s a project the caller can't see (MARIMOHUB_DEFAULT_ROLE=none, non-member).
	const project = await loadVisibleProject(
		deps.services.projects,
		pid,
		user.id,
		deps.policy.defaultRole,
	);
	// A soft-deleted project reads as gone to clients (the bytes linger only until
	// the GC sweep). `getProject` itself stays raw so the sweep can still read it.
	if (project.status === 'deleted') {
		throw new NotFoundError(`Project ${pid} not found`);
	}
	c.header('ETag', etagFor(project.updated_at));
	return c.json(
		{ success: true, data: projectResponse(project, user.id, deps.policy.defaultRole) },
		200,
	);
});

app.openapi(updateProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user.id, 'admin', deps.policy.defaultRole);
	const body = c.req.valid('json');
	const project = await projects.updateProject(pid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(project.updated_at));
	return c.json(
		{ success: true, data: projectResponse(project, user.id, deps.policy.defaultRole) },
		200,
	);
});

app.openapi(deleteProject, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user.id, 'admin', deps.policy.defaultRole);
	await projects.deleteProject(pid, user.id, ifMatchToken(c));
	return c.json({ success: true }, 200);
});

app.openapi(listMembers, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const project = await loadVisibleProject(
		deps.services.projects,
		pid,
		user.id,
		deps.policy.defaultRole,
	);
	return c.json({ success: true, data: project.members }, 200);
});

app.openapi(addMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user.id, 'admin', deps.policy.defaultRole);
	const body = c.req.valid('json');
	const project = await projects.addMember(pid, UserId.parse(body.user_id), body.role, user.id);
	return c.json(
		{ success: true, data: projectResponse(project, user.id, deps.policy.defaultRole) },
		201,
	);
});

app.openapi(updateMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, uid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user.id, 'admin', deps.policy.defaultRole);
	const body = c.req.valid('json');
	const project = await projects.updateMemberRole(pid, UserId.parse(uid), body.role, user.id);
	return c.json(
		{ success: true, data: projectResponse(project, user.id, deps.policy.defaultRole) },
		200,
	);
});

app.openapi(removeMember, async (c) => {
	const deps = c.get('deps');
	const { projects } = deps.services;
	const user = c.get('user');
	const { pid, uid } = c.req.valid('param');
	await assertProjectRole(projects, pid, user.id, 'admin', deps.policy.defaultRole);
	await projects.removeMember(pid, UserId.parse(uid), user.id);
	return c.json({ success: true }, 200);
});

export default app;

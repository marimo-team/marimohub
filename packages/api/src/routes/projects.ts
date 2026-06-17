import { createRoute, z } from '@hono/zod-openapi';
import type { ProjectId } from '@marimo-hub/core';
import {
	assertProjectRole,
	createApp,
	ErrorResponseSchema,
	jsonBody,
	jsonContent,
	ProjectIdParam,
	ProjectResponseSchema,
	SnapshotProjectEntrySchema,
	SuccessResponseSchema,
} from '../shared';

// --- Request body schemas ---

const CreateProjectBody = z.object({
	name: z.string().min(1).openapi({ example: 'Data Science' }),
	description: z.string().openapi({ example: 'Exploratory analysis notebooks' }),
	tags: z
		.array(z.string())
		.optional()
		.openapi({ example: ['analytics'] }),
});

const UpdateProjectBody = z.object({
	name: z.string().min(1).optional().openapi({ example: 'ML Pipeline' }),
	description: z.string().optional(),
	tags: z.array(z.string()).optional(),
});

// --- Route definitions ---

const listProjects = createRoute({
	method: 'get',
	path: '/projects',
	tags: ['Projects'],
	summary: 'List all projects',
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(SnapshotProjectEntrySchema) }),
			'List of projects with notebook summaries',
		),
	},
});

const createProject = createRoute({
	method: 'post',
	path: '/projects',
	tags: ['Projects'],
	summary: 'Create a project',
	request: { body: jsonBody(CreateProjectBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Project created',
		),
		422: jsonContent(ErrorResponseSchema, 'Validation error'),
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
		),
		404: jsonContent(ErrorResponseSchema, 'Project not found'),
	},
});

const updateProject = createRoute({
	method: 'put',
	path: '/projects/{pid}',
	tags: ['Projects'],
	summary: 'Update a project',
	request: { params: ProjectIdParam, body: jsonBody(UpdateProjectBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: ProjectResponseSchema }),
			'Project updated',
		),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Project not found'),
		422: jsonContent(ErrorResponseSchema, 'Validation error'),
	},
});

const deleteProject = createRoute({
	method: 'delete',
	path: '/projects/{pid}',
	tags: ['Projects'],
	summary: 'Delete a project',
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Project deleted'),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Project not found'),
	},
});

// --- App ---

const app = createApp();

app.openapi(listProjects, async (c) => {
	const { projects } = c.get('deps').services;
	const data = await projects.listProjects();
	return c.json({ success: true, data }, 200);
});

app.openapi(createProject, async (c) => {
	const { projects } = c.get('deps').services;
	const user = c.get('user');
	const body = c.req.valid('json');
	const data = await projects.createProject(body, user.id);
	return c.json({ success: true, data }, 201);
});

app.openapi(getProject, async (c) => {
	const { projects } = c.get('deps').services;
	const { pid } = c.req.valid('param');
	const data = await projects.getProject(pid as ProjectId);
	return c.json({ success: true, data }, 200);
});

app.openapi(updateProject, async (c) => {
	const { projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid as ProjectId, user.id, 'admin');
	const body = c.req.valid('json');
	const data = await projects.updateProject(pid as ProjectId, body, user.id);
	return c.json({ success: true, data }, 200);
});

app.openapi(deleteProject, async (c) => {
	const { projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid as ProjectId, user.id, 'admin');
	await projects.deleteProject(pid as ProjectId, user.id);
	return c.json({ success: true }, 200);
});

export default app;

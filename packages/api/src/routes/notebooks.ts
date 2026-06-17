import { createRoute, z } from '@hono/zod-openapi';
import type { NotebookId, ProjectId } from '@marimo-hub/core';
import {
	assertProjectRole,
	createApp,
	ErrorResponseSchema,
	jsonBody,
	jsonContent,
	NotebookDetailResponseSchema,
	NotebookIdParam,
	NotebookMetaResponseSchema,
	ProjectIdParam,
	RuntimeResponseSchema,
	SnapshotNotebookEntrySchema,
	SuccessResponseSchema,
	VersionResponseSchema,
} from '../shared';

// --- Request body schemas ---

const CreateNotebookBody = z.object({
	title: z.string().min(1).openapi({ example: 'Revenue Analysis' }),
	description: z.string().openapi({ example: 'Monthly revenue breakdown' }),
	code: z.string().openapi({ example: 'import marimo as mo' }),
	tags: z
		.array(z.string())
		.optional()
		.openapi({ example: ['finance'] }),
	readme: z.string().optional(),
	deps: z.string().optional(),
	runtime: RuntimeResponseSchema.optional(),
});

const UpdateNotebookBody = z.object({
	title: z.string().min(1).optional(),
	description: z.string().optional(),
	code: z.string().optional(),
	tags: z.array(z.string()).optional(),
	readme: z.string().optional(),
	deps: z.string().optional(),
	message: z.string().optional().openapi({ example: 'Add regional breakdown' }),
});

// --- Route definitions ---

const listNotebooks = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks',
	tags: ['Notebooks'],
	summary: 'List notebooks in a project',
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.array(SnapshotNotebookEntrySchema),
			}),
			'List of notebooks',
		),
		404: jsonContent(ErrorResponseSchema, 'Project not found'),
	},
});

const createNotebook = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks',
	tags: ['Notebooks'],
	summary: 'Create a notebook',
	request: { params: ProjectIdParam, body: jsonBody(CreateNotebookBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Notebook created',
		),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Project not found'),
		422: jsonContent(ErrorResponseSchema, 'Validation error'),
	},
});

const getNotebook = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}',
	tags: ['Notebooks'],
	summary: 'Get notebook metadata',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookDetailResponseSchema }),
			'Notebook detail',
		),
		404: jsonContent(ErrorResponseSchema, 'Notebook not found'),
	},
});

const getNotebookContent = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/content',
	tags: ['Notebooks'],
	summary: 'Get notebook code',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ code: z.string() }),
			}),
			'Notebook source code',
		),
		404: jsonContent(ErrorResponseSchema, 'Notebook not found'),
	},
});

const updateNotebook = createRoute({
	method: 'put',
	path: '/projects/{pid}/notebooks/{nid}',
	tags: ['Notebooks'],
	summary: 'Update a notebook',
	request: { params: NotebookIdParam, body: jsonBody(UpdateNotebookBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Notebook updated',
		),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Notebook not found'),
		422: jsonContent(ErrorResponseSchema, 'Validation error'),
	},
});

const deleteNotebook = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}',
	tags: ['Notebooks'],
	summary: 'Delete a notebook (soft-delete)',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Notebook deleted'),
		403: jsonContent(ErrorResponseSchema, 'Insufficient role'),
		404: jsonContent(ErrorResponseSchema, 'Notebook not found'),
	},
});

const listVersions = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/versions',
	tags: ['Notebooks'],
	summary: 'List notebook versions',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.array(VersionResponseSchema),
			}),
			'List of versions',
		),
		404: jsonContent(ErrorResponseSchema, 'Notebook not found'),
	},
});

const getVersion = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/versions/{vid}',
	tags: ['Notebooks'],
	summary: 'Get a specific version',
	request: {
		params: NotebookIdParam.extend({
			vid: z
				.string()
				.regex(/^ver_[0-9A-Z]{26}$/)
				.openapi({
					param: { name: 'vid', in: 'path' },
					example: 'ver_01HXYZ33333RSTUVWXYZAB',
				}),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ version: VersionResponseSchema, code: z.string() }),
			}),
			'Version details with code',
		),
		404: jsonContent(ErrorResponseSchema, 'Version not found'),
	},
});

// --- App ---

const app = createApp();

app.openapi(listNotebooks, async (c) => {
	const { notebooks } = c.get('deps').services;
	const { pid } = c.req.valid('param');
	const data = await notebooks.listNotebooks(pid as ProjectId);
	return c.json({ success: true, data }, 200);
});

app.openapi(createNotebook, async (c) => {
	const { notebooks, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');
	const body = c.req.valid('json');
	const data = await notebooks.createNotebook(pid as ProjectId, body, user.id);
	return c.json({ success: true, data }, 201);
});

app.openapi(getNotebook, async (c) => {
	const { notebooks } = c.get('deps').services;
	const { pid, nid } = c.req.valid('param');
	const data = await notebooks.getNotebook(pid as ProjectId, nid as NotebookId);
	return c.json({ success: true, data }, 200);
});

app.openapi(getNotebookContent, async (c) => {
	const { notebooks } = c.get('deps').services;
	const { pid, nid } = c.req.valid('param');
	const code = await notebooks.getNotebookContent(pid as ProjectId, nid as NotebookId);
	return c.json({ success: true, data: { code } }, 200);
});

app.openapi(updateNotebook, async (c) => {
	const { notebooks, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');
	const body = c.req.valid('json');
	const data = await notebooks.updateNotebook(pid as ProjectId, nid as NotebookId, body, user.id);
	return c.json({ success: true, data }, 200);
});

app.openapi(deleteNotebook, async (c) => {
	const { notebooks, projects } = c.get('deps').services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await assertProjectRole(projects, pid as ProjectId, user.id, 'editor');
	await notebooks.deleteNotebook(pid as ProjectId, nid as NotebookId, user.id);
	return c.json({ success: true }, 200);
});

app.openapi(listVersions, async (c) => {
	const { notebooks } = c.get('deps').services;
	const { pid, nid } = c.req.valid('param');
	const data = await notebooks.listVersions(pid as ProjectId, nid as NotebookId);
	return c.json({ success: true, data }, 200);
});

app.openapi(getVersion, async (c) => {
	const { notebooks } = c.get('deps').services;
	const { pid, nid, vid } = c.req.valid('param');
	const data = await notebooks.getVersion(pid as ProjectId, nid as NotebookId, vid);
	return c.json({ success: true, data }, 200);
});

export default app;

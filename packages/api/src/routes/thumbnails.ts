import { bodyLimit } from 'hono/body-limit';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
	ThumbnailMetadataSchema,
	THUMBNAIL_MAX_BYTES,
	NotFoundError,
	ValidationError,
} from '@marimo-hub/core';
import type { ProjectId, NotebookId } from '@marimo-hub/core';
import type { HonoEnv } from '../context';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	fail,
	jsonContent,
	loadAuthorizedNotebook,
	loadVisibleProject,
	NotebookIdParam,
} from '../shared';

const app = createApp();

const thumbnailPath = '/projects/{pid}/notebooks/{nid}/thumbnail';
const thumbnailResponse = jsonContent(
	z.object({ success: z.literal(true), data: ThumbnailMetadataSchema }),
	'Thumbnail metadata',
);
const thumbnailErrors = { ...commonErrors(), ...errorResponses(404, 413) };

async function authorizeThumbnail(
	c: Context<HonoEnv>,
	pid: ProjectId,
	nid: NotebookId,
	write = false,
) {
	const deps = c.get('deps');
	const user = c.get('user');
	const project = write
		? await assertProjectRole(deps.services.projects, pid, user, 'notebook.write', deps)
		: await loadVisibleProject(deps.services.projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user, write ? 'notebook.write' : 'project.read');
	return deps.services.notebooks.thumbnails;
}

app.openapi(
	createRoute({
		method: 'get',
		path: thumbnailPath,
		operationId: 'notebooks.thumbnail',
		tags: ['Notebooks'],
		summary: 'Get thumbnail metadata',
		request: { params: NotebookIdParam },
		responses: { 200: thumbnailResponse, ...thumbnailErrors },
	}),
	async (c) => {
		const { pid, nid } = c.req.valid('param');
		const thumbnails = await authorizeThumbnail(c, pid, nid);
		return c.json({ success: true as const, data: await thumbnails.metadata(pid, nid) }, 200);
	},
);
app.openapi(
	createRoute({
		method: 'get',
		path: `${thumbnailPath}/image`,
		operationId: 'notebooks.thumbnail.image',
		tags: ['Notebooks'],
		summary: 'Read the selected thumbnail',
		request: { params: NotebookIdParam },
		responses: {
			200: {
				description: 'PNG thumbnail',
				content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } },
			},
			304: { description: 'Not modified' },
			...thumbnailErrors,
		},
	}),
	async (c) => {
		const { pid, nid } = c.req.valid('param');
		const thumbnails = await authorizeThumbnail(c, pid, nid);
		const image = await thumbnails.image(pid, nid);
		if (!image) throw new NotFoundError('No thumbnail');
		const etag = etagFor(image.etag);
		c.header('Cache-Control', 'private, no-cache');
		c.header('ETag', etag);
		c.header('X-Content-Type-Options', 'nosniff');
		if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
		c.header('Content-Type', 'image/png');
		return c.body(new Uint8Array(await image.bytes()), 200);
	},
);
app.openapi(
	createRoute({
		method: 'put',
		path: thumbnailPath,
		operationId: 'notebooks.thumbnail.set',
		tags: ['Notebooks'],
		summary: 'Upload a custom cropped thumbnail',
		middleware: [
			bodyLimit({
				maxSize: THUMBNAIL_MAX_BYTES,
				onError: (c) => fail(c, 'VALIDATION_ERROR', 'Thumbnail exceeds 3 MB', 413),
			}),
		] as const,
		request: {
			params: NotebookIdParam,
			body: {
				required: true,
				content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } },
			},
		},
		responses: { 200: thumbnailResponse, ...thumbnailErrors },
	}),
	async (c) => {
		const { pid, nid } = c.req.valid('param');
		const thumbnails = await authorizeThumbnail(c, pid, nid, true);
		if (c.req.header('Content-Type')?.split(';')[0] !== 'image/png')
			throw new ValidationError('Upload a PNG image');
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		return c.json(
			{ success: true as const, data: await thumbnails.setCustom(pid, nid, bytes) },
			200,
		);
	},
);
app.openapi(
	createRoute({
		method: 'delete',
		path: thumbnailPath,
		operationId: 'notebooks.thumbnail.remove',
		tags: ['Notebooks'],
		summary: 'Remove the custom thumbnail',
		request: { params: NotebookIdParam },
		responses: { 200: thumbnailResponse, ...thumbnailErrors },
	}),
	async (c) => {
		const { pid, nid } = c.req.valid('param');
		const thumbnails = await authorizeThumbnail(c, pid, nid, true);
		return c.json({ success: true as const, data: await thumbnails.removeCustom(pid, nid) }, 200);
	},
);

export default app;

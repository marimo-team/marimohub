import {
	BadRequestError,
	NotebookId,
	NotFoundError,
	ProjectId,
	toPublicNotebookMeta,
} from '@marimo-hub/core';
import { parseWorkspaceArchive } from '../integrations/archive';
import { createApp, fail } from '../shared';

const app = createApp();

function header(c: { req: { header(name: string): string | undefined } }, name: string): string {
	const value = c.req.header(name)?.trim();
	if (!value) throw new BadRequestError(`${name} header is required`);
	return value;
}

app.use('/projects/:pid/notebooks/:nid', async (c, next) => {
	const authorization = c.req.header('authorization');
	if (!authorization) {
		c.header('WWW-Authenticate', 'Bearer');
		return fail(c, 'UNAUTHORIZED', 'Missing sync token', 401);
	}
	const match = /^Bearer\s+(\S+)$/i.exec(authorization);
	if (!match) return fail(c, 'BAD_REQUEST', 'Malformed authorization header', 400);
	const pidRaw = c.req.param('pid');
	const nidRaw = c.req.param('nid');
	const valid =
		ProjectId.is(pidRaw) &&
		NotebookId.is(nidRaw) &&
		(await c.get('deps').services.notebooks.synced.verifyToken(pidRaw, nidRaw, match[1]));
	if (!valid) {
		c.header('WWW-Authenticate', 'Bearer');
		return fail(c, 'UNAUTHORIZED', 'Invalid sync token', 401);
	}
	return next();
});

app.post('/projects/:pid/notebooks/:nid', async (c) => {
	const deps = c.get('deps');
	const pidRaw = c.req.param('pid');
	const nidRaw = c.req.param('nid');
	if (!ProjectId.is(pidRaw) || !NotebookId.is(nidRaw)) {
		throw new NotFoundError('Notebook not found');
	}

	const bytes = new Uint8Array(await c.req.arrayBuffer());
	const files = parseWorkspaceArchive(
		bytes,
		c.req.header('x-marimohub-archive-format'),
		c.req.header('content-type'),
	);
	const meta = await deps.services.notebooks.synced.sync(pidRaw, nidRaw, {
		repo: header(c, 'x-marimohub-repo'),
		branch: header(c, 'x-marimohub-branch'),
		root_path: c.req.header('x-marimohub-root-path')?.trim() ?? '',
		commit: header(c, 'x-marimohub-commit'),
		files,
	});

	return c.json({ success: true, data: { notebook: toPublicNotebookMeta(meta) } }, 200);
});

export default app;

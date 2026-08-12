import {
	BadRequestError,
	DomainError,
	NotebookId,
	NotFoundError,
	notificationRouter,
	ProjectId,
	toPublicNotebookMeta,
} from '@marimo-hub/core';
import { parseWorkspaceArchive } from '../integrations/archive';
import { createApp, fail } from '../shared';
import { scheduleProjectAlert } from '../notifications';

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

	const [project, notebook] = await Promise.all([
		deps.services.projects.getProject(pidRaw),
		deps.services.notebooks.getNotebook(pidRaw, nidRaw),
	]);
	const commit = c.req.header('x-marimohub-commit')?.trim() || 'unknown';
	try {
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
	} catch (error) {
		scheduleProjectAlert(
			deps,
			pidRaw,
			'sync.failed',
			{ project_id: pidRaw, notebook_id: nidRaw },
			() =>
				notificationRouter.render({
					kind: 'sync.failed',
					project,
					notebookId: nidRaw,
					notebookTitle: notebook.meta.title,
					commit,
					errorCode: error instanceof DomainError ? error.code : 'SYNC_FAILED',
					baseUrl: deps.sandbox.appBaseUrl,
				}),
		);
		throw error;
	}
});

export default app;

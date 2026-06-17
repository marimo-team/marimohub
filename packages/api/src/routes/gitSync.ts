import { bearerAuth } from 'hono/bearer-auth';
import {
	BadRequestError,
	NotebookId,
	NotFoundError,
	ProjectId,
	toPublicNotebookMeta,
} from '@marimo-hub/core';
import { parseWorkspaceArchive } from '../integrations/archive';
import { createApp } from '../shared';
import type { HonoEnv } from '../context';

const app = createApp();

function header(c: { req: { header(name: string): string | undefined } }, name: string): string {
	const value = c.req.header(name)?.trim();
	if (!value) throw new BadRequestError(`${name} header is required`);
	return value;
}

function authError(code: string, message: string) {
	return { success: false as const, error: { code, message } };
}

app.use(
	'/projects/:pid/notebooks/:nid',
	bearerAuth<HonoEnv>({
		verifyToken: async (token, c) => {
			const pidRaw = c.req.param('pid');
			const nidRaw = c.req.param('nid');
			if (!ProjectId.is(pidRaw) || !NotebookId.is(nidRaw)) return false;
			return c.get('deps').services.notebooks.synced.verifyToken(pidRaw, nidRaw, token);
		},
		noAuthenticationHeader: {
			message: () => authError('UNAUTHORIZED', 'Missing sync token'),
		},
		invalidAuthenticationHeader: {
			message: () => authError('BAD_REQUEST', 'Malformed authorization header'),
		},
		invalidToken: {
			message: () => authError('UNAUTHORIZED', 'Invalid sync token'),
		},
	}),
);

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

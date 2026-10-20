import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostNotebookId, SessionId, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { createApi } from '../createApi';
import { createInitializedBucket, makeTestDeps } from '../testing';
import { loadHostNotebook } from './catalog';
import { HOST_PREFIX } from './protocol';

const user: AuthenticatedPrincipal = {
	id: UserId.parse('host-user'),
	email: 'host@example.com',
	credential: { kind: 'personal-access-token', id: 'host-token' },
};

afterEach(() => vi.restoreAllMocks());

async function setup() {
	const deps = makeTestDeps(await createInitializedBucket(), {
		authenticator: { authenticate: async () => user },
	});
	const project = await deps.services.projects.createProject(
		{ name: 'Host project', description: '' },
		user.id,
	);
	const notebook = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo\napp = marimo.App()\n' },
		user.id,
	);
	return { deps, project, notebook };
}

describe('temporary host notebook lookup', () => {
	it('returns the same notebook 404 for missing and invalid temporary sessions', async () => {
		const { deps, project, notebook } = await setup();
		const persistent = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: user.id,
			mode: 'edit',
		});
		const app = createApi(deps);
		for (const sessionId of [SessionId.create(), persistent.session_id]) {
			const id = HostNotebookId.create(project.id, notebook.id, sessionId);
			const response = await app.request(`${HOST_PREFIX}/notebooks/${id}/events`, {
				headers: { Authorization: 'Bearer test' },
			});
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ status: 404, detail: 'Notebook not found' });
		}
	});

	it('does not disguise session storage failures as missing notebooks', async () => {
		const { deps, project, notebook } = await setup();
		const error = new Error('Storage unavailable');
		vi.spyOn(deps.services.sessions, 'getSession').mockRejectedValueOnce(error);
		await expect(
			loadHostNotebook(
				deps,
				user,
				HostNotebookId.create(project.id, notebook.id, SessionId.create()),
			),
		).rejects.toBe(error);
	});
});

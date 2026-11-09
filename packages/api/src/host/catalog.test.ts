import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostNotebookId, SessionId, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { createApi } from '../createApi';
import { createInitializedBucket, makeTestDeps } from '../testing';
import { catalogEvents, loadHostNotebook } from './catalog';
import { localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { createMcpSession, mcpPrincipal as principal } from '../testing/mcp';
import { createHubHostPlatform } from './platform';
import { HOST_PREFIX } from './createHostApp';

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

it('shares subject context across catalog sessions and refreshes it for the next operation', async () => {
	const security = localResourceSecurity(['SECRET'], makeSubjectContext());
	const { deps, project, session } = await createMcpSession(undefined, {
		resourceSecurity: security,
	});
	await deps.services.projects.setSecurityLabels(
		project.id,
		{ classification: 'SECRET', compartments: [] },
		principal.id,
	);
	for (let i = 0; i < 2; i++) {
		const created = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: session.notebook_id,
			user_id: principal.id,
			mode: 'edit',
			ephemeral: true,
		});
		await deps.services.sessions.setRunning(
			project.id,
			created.session_id,
			'https://kernel.example',
		);
	}
	const resolve = vi.spyOn(security.subjectContext!, 'resolve');
	const list = deps.services.sessions.listActiveByProject.bind(deps.services.sessions);
	let readsBeforeSessions = 0;
	vi.spyOn(deps.services.sessions, 'listActiveByProject').mockImplementation(async (pid) => {
		readsBeforeSessions = resolve.mock.calls.length;
		return list(pid);
	});
	const snapshot = await catalogEvents(deps, principal);
	expect(snapshot.events.filter((event) => event.event === 'notebook')).toHaveLength(3);
	expect(readsBeforeSessions).toBeGreaterThan(0);
	expect(resolve).toHaveBeenCalledTimes(readsBeforeSessions);
	const visible = new Set(
		snapshot.sessions
			.get(project.id)!
			.map((current) =>
				HostNotebookId.create(
					project.id,
					current.notebook_id,
					current.ephemeral ? current.session_id : undefined,
				),
			),
	);
	const platform = createHubHostPlatform(deps);
	resolve.mockClear();
	const runtimes = await platform.runtimes(
		principal,
		snapshot,
		visible,
		new AbortController().signal,
	);
	expect(runtimes).toHaveLength(3);
	expect(runtimes.every((runtime) => runtime.authorized)).toBe(true);
	expect(resolve).toHaveBeenCalledTimes(1);
	resolve.mockResolvedValue(null);
	const revoked = await platform.runtimes(
		principal,
		snapshot,
		visible,
		new AbortController().signal,
	);
	expect(revoked.every((runtime) => !runtime.authorized)).toBe(true);
	expect(
		(await catalogEvents(deps, principal)).events.some((event) => event.event === 'notebook'),
	).toBe(false);
});

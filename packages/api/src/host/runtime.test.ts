import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxId, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { requestRuntimeHost } from '@marimo-hub/core/host-bridge';
import { makeFakeCompute } from '@marimo-hub/core/testing';
import { createInitializedBucket, makeTestDeps } from '../testing';
import { callRuntime } from './runtime';

vi.mock('@marimo-hub/core/host-bridge', () => ({ requestRuntimeHost: vi.fn() }));

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(requestRuntimeHost).mockReset();
});

describe('host runtime notebook paths', () => {
	it.each([
		{ syncMode: 'pull' as const, root: 'python', expected: '/workspace/python/apps/dashboard.py' },
		{ syncMode: 'pull' as const, root: '', expected: '/workspace/apps/dashboard.py' },
		{ syncMode: 'push' as const, root: 'python', expected: '/workspace/apps/dashboard.py' },
	])('locates a $syncMode source rooted at "$root"', async ({ syncMode, root, expected }) => {
		const user: AuthenticatedPrincipal = {
			id: UserId.parse('host-user'),
			email: 'host@example.com',
			credential: { kind: 'personal-access-token', id: 'host-token' },
		};
		const compute = makeFakeCompute();
		const deps = makeTestDeps(await createInitializedBucket(), { compute });
		deps.sandbox.workdir = '/workspace';
		const project = await deps.services.projects.createProject(
			{ name: 'Host project', description: '' },
			user.id,
		);
		const synced = await deps.services.notebooks.synced.create(
			project.id,
			{
				title: 'Git notebook',
				description: '',
				repo: 'owner/repo',
				branch: 'main',
				root_path: root,
				entry_notebook: 'apps/dashboard.py',
				sync_mode: syncMode,
			},
			user.id,
		);
		const notebook = await deps.services.notebooks.getNotebook(project.id, synced.meta.id);
		const created = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.meta.id,
			user_id: user.id,
			sandbox_id: SandboxId.create(),
			mode: 'edit',
			editor_sandbox_sharing: 'shared',
		});
		await deps.services.sessions.claimEditor(
			project.id,
			notebook.meta.id,
			created.session_id,
			'shared',
			user.id,
		);
		const session = await deps.services.sessions.setRunning(
			project.id,
			created.session_id,
			'https://sandbox.example',
		);
		const sandbox = compute.create(session.sandbox_id!);
		sandbox.resolveProcessPath = (path) => `/host-root${path}`;
		vi.spyOn(compute, 'create').mockReturnValue(sandbox);
		vi.mocked(requestRuntimeHost).mockResolvedValue({
			status: 200,
			notebook: { id: 'local', operations: [] },
			events: [],
		});
		await callRuntime(deps, user, project, notebook, session, { method: 'GET', path: '/catalog' });
		expect(requestRuntimeHost).toHaveBeenCalledWith(
			sandbox,
			{ method: 'GET', path: '/catalog', notebookPath: `/host-root${expected}` },
			expect.any(AbortSignal),
		);
	});
});

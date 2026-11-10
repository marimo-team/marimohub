import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogService, createSandboxId, NotFoundError } from '@marimo-hub/core';
import type { SourceControlReader } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { withRequestMemo } from '../requestMemo';
import * as sessionStart from '../routes/sessionStart';
import { makeTestDeps, stubSourceControl } from '../testing';
import { mcpPrincipal as principal, mcpRequest } from '../testing/mcp';
import { startMcpSession } from './sessionStartup';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function startingPreviewSession() {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(principal.id);
	const reader: SourceControlReader = {
		provider: 'github',
		previews: true,
		supportsRepository: () => true,
		getBranchHead: async () => ({ commit: 'a'.repeat(40) }),
		resolveCommit: async (_repo, commit) => ({ commit }),
		fetchWorkspace: async () => [
			{ path: 'notebook.py', bytes: new TextEncoder().encode('import marimo') },
		],
	};
	const deps = withRequestMemo(
		makeTestDeps(bucket, { sourceControl: stubSourceControl({ reader }) }),
	);
	const { projects, notebooks, previews, sessions } = deps.services;
	const project = await projects.createProject({ name: 'Project', description: '' }, principal.id);
	const notebook = await notebooks.synced.create(
		project.id,
		{
			title: 'Notebook',
			description: '',
			repo: 'owner/repo',
			branch: 'main',
			root_path: '',
			entry_notebook: 'notebook.py',
			sync_mode: 'push',
		},
		principal.id,
	);
	const created = await previews.create(
		project.id,
		notebook.meta.id,
		{ name: 'Review', source: { type: 'branch', branch: 'feature' } },
		principal.id,
		deps.sourceControl,
	);
	const preview = await previews.prepare(created, deps.sourceControl);
	const session = await sessions.createSession({
		project_id: project.id,
		notebook_id: preview.current!.notebook_id,
		user_id: principal.id,
		sandbox_id: createSandboxId(),
		mode: 'app',
		origin: {
			type: 'preview',
			notebook_id: notebook.meta.id,
			preview_id: preview.id,
			revision_id: preview.current!.version_id,
			commit: preview.current!.commit,
		},
	});
	vi.spyOn(sessionStart, 'startNotebookSession').mockResolvedValue({
		...sessionStart.toSessionResponse(session, {
			role: 'admin',
			attach: true,
			stop: true,
			surface: true,
			appReadOnly: false,
		}),
		reused: false,
	});
	const readPreview = vi.spyOn(previews, 'get');
	const start = () =>
		startMcpSession({
			deps,
			principal,
			request: mcpRequest,
			project,
			notebookId: notebook.meta.id,
			mode: 'app',
			waitSeconds: 10,
		});
	return { deps, project, preview, session, readPreview, start };
}

describe('MCP session startup visibility', () => {
	it.each(['running', 'timeout'] as const)(
		'rejects a preview retired during the wait when startup ends in %s',
		async (outcome) => {
			vi.useFakeTimers();
			const { deps, project, preview, session, readPreview, start } =
				await startingPreviewSession();
			const pending = start();
			const rejected = expect(pending).rejects.toThrow(NotFoundError);
			await vi.advanceTimersByTimeAsync(0);
			expect(readPreview).toHaveBeenCalledOnce();
			await deps.services.previews.retire(preview);
			if (outcome === 'running') {
				await deps.services.sessions.setRunning(
					project.id,
					session.session_id,
					'https://preview.example',
				);
			}
			await vi.advanceTimersByTimeAsync(outcome === 'running' ? 2_000 : 10_000);
			await rejected;
		},
	);

	it('projects the sandbox URL when the preview remains active after startup', async () => {
		vi.useFakeTimers();
		const { deps, project, session, readPreview, start } = await startingPreviewSession();
		const pending = start();
		await vi.advanceTimersByTimeAsync(0);
		expect(readPreview).toHaveBeenCalledOnce();
		await deps.services.sessions.setRunning(
			project.id,
			session.session_id,
			'https://preview.example',
		);
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(pending).resolves.toMatchObject({
			status: 'running',
			sandbox_url: 'https://preview.example',
		});
	});
});

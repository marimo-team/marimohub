import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogService, createVersionId, UnavailableError, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, SourceControlReader, VersionId } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { localResourceSecurity } from '@marimo-hub/core/testing';
import { makeTestDeps, stubSourceControl } from '../testing';
import { connectMcpClient, mcpPrincipal } from '../testing/mcp';

const HEAD = 'a'.repeat(40);
const encode = (value: string) => new TextEncoder().encode(value);

afterEach(() => vi.restoreAllMocks());

function callSync(client: Client, args: Record<string, unknown>) {
	return client.callTool({ name: 'sync_notebook_source', arguments: args });
}

async function setup(
	provider: 'github' | 'gitlab' | 'azure-devops' = 'github',
	syncMode: 'push' | 'pull' = 'push',
) {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(mcpPrincipal.id);
	const reader: SourceControlReader = {
		provider,
		supportsRepository: () => true,
		getBranchHead: vi.fn(async () => ({ commit: HEAD })),
		fetchWorkspace: vi.fn(async () => [{ path: 'app.py', bytes: encode('print("synced")') }]),
		fetchGitDirectory: vi.fn(async () => [
			{ path: 'HEAD', bytes: encode('ref: refs/heads/main\n') },
		]),
	};
	const deps = makeTestDeps(bucket, { sourceControl: stubSourceControl({ reader }) });
	const project = await deps.services.projects.createProject(
		{ name: 'Analytics', description: '' },
		mcpPrincipal.id,
	);
	const repo = {
		github: 'org/repo',
		gitlab: 'https://gitlab.com/team/repo',
		'azure-devops': 'https://dev.azure.com/org/project/_git/repo',
	}[provider];
	const { meta: notebook } = await deps.services.notebooks.synced.create(
		project.id,
		{
			title: 'Report',
			description: '',
			repo,
			branch: 'main',
			entry_notebook: 'app.py',
			sync_mode: syncMode,
		},
		mcpPrincipal.id,
	);
	const client = await connectMcpClient(deps, mcpPrincipal);
	const sync = () => callSync(client, { project: project.id, notebook: notebook.id });
	const createSession = (mode: 'edit' | 'app', version?: VersionId) =>
		deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: mcpPrincipal.id,
			mode,
			source_version_id: version,
		});
	return { deps, reader, project, notebook, client, sync, createSession };
}

describe('sync_notebook_source', () => {
	it.each([undefined, new Error('Connection closed')])(
		'does not sync an already cancelled request with reason %s',
		async (reason) => {
			const { deps, reader, project, notebook } = await setup();
			const publish = vi.spyOn(deps.services.notebooks.synced, 'sync');
			const audit = vi.spyOn(deps.services.events, 'append');
			const client = await connectMcpClient(deps, mcpPrincipal, {
				method: 'POST',
				path: '/mcp',
				hostname: 'hub.example.com',
				appBaseUrl: 'https://hub.example.com',
				signal: AbortSignal.abort(reason),
			});
			expect(await callSync(client, { project: project.id, notebook: notebook.id })).toMatchObject({
				isError: true,
				structuredContent: { code: 'REQUEST_CANCELLED' },
			});
			expect(reader.getBranchHead).not.toHaveBeenCalled();
			expect(reader.fetchWorkspace).not.toHaveBeenCalled();
			expect(publish).not.toHaveBeenCalled();
			expect(audit).not.toHaveBeenCalled();
		},
	);

	it.each([
		{},
		{ project: 'Analytics' },
		{ notebook: 'Report' },
		{ project: '', notebook: 'Report' },
		{ project: ' \t\n', notebook: 'Report' },
		{ project: 'Analytics', notebook: '' },
		{ project: 'Analytics', notebook: ' \t\n' },
		{ project: null, notebook: 'Report' },
		{ project: 'Analytics', notebook: 42 },
		{ project: ['Analytics'], notebook: 'Report' },
		{ project: 'Analytics', notebook: {} },
		{ project: 'Analytics', notebook: 'Report', restart: true },
	])('rejects invalid arguments %j before accessing storage or Git', async (args) => {
		const { deps, reader, client } = await setup();
		const getProject = vi.spyOn(deps.services.projects, 'getProject');
		const listProjects = vi.spyOn(deps.services.projects, 'listProjects');
		const publish = vi.spyOn(deps.services.notebooks.synced, 'sync');
		const audit = vi.spyOn(deps.services.events, 'append');
		expect(await callSync(client, args)).toMatchObject({
			isError: true,
		});
		expect(getProject).not.toHaveBeenCalled();
		expect(listProjects).not.toHaveBeenCalled();
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});

	it('rejects missing and ambiguous projects or notebooks before fetching', async () => {
		const { deps, reader, project, notebook, client } = await setup();
		await deps.services.projects.createProject(
			{ name: project.name.toUpperCase(), description: '' },
			mcpPrincipal.id,
		);
		for (const [projectRef, notebookRef, code] of [
			['Missing project', notebook.id, 'NOT_FOUND'],
			[project.id, 'Missing notebook', 'NOT_FOUND'],
			[project.name, notebook.id, 'BAD_REQUEST'],
		]) {
			expect(await callSync(client, { project: projectRef, notebook: notebookRef })).toMatchObject({
				isError: true,
				structuredContent: { code },
			});
		}
		expect(reader.getBranchHead).not.toHaveBeenCalled();
	});

	it('denies a token scoped to another project before fetching', async () => {
		const { deps, reader, project, notebook } = await setup();
		const other = await deps.services.projects.createProject(
			{ name: 'Other', description: '' },
			mcpPrincipal.id,
		);
		const client = await connectMcpClient(deps, {
			...mcpPrincipal,
			credential: {
				kind: 'personal-access-token',
				id: 'other-project',
				grant: { actions: ['project.read', 'notebook.write'], projects: [other.id] },
			},
		});
		expect(await callSync(client, { project: project.id, notebook: notebook.id })).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
		expect(reader.getBranchHead).not.toHaveBeenCalled();
	});

	it('hides notebooks with inaccessible security labels before fetching', async () => {
		const { deps, reader, project, notebook, sync } = await setup();
		deps.resourceSecurity = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
		await deps.services.notebooks.setSecurityLabels(
			project.id,
			notebook.id,
			{ classification: 'SECRET', compartments: [] },
			mcpPrincipal.id,
		);
		expect(await sync()).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
		expect(reader.getBranchHead).not.toHaveBeenCalled();
	});

	it('rejects deleted notebooks by ID and name before fetching', async () => {
		const { deps, reader, project, notebook, client } = await setup();
		await deps.services.notebooks.deleteNotebook(project.id, notebook.id, mcpPrincipal.id);
		for (const ref of [notebook.id, notebook.title]) {
			expect(await callSync(client, { project: project.id, notebook: ref })).toMatchObject({
				isError: true,
				structuredContent: { code: 'NOT_FOUND' },
			});
		}
		expect(reader.getBranchHead).not.toHaveBeenCalled();
	});

	it.each(['getBranchHead', 'fetchWorkspace', 'fetchGitDirectory'] as const)(
		'preserves the source and sessions when %s fails',
		async (operation) => {
			const { deps, reader, project, notebook, sync, createSession } = await setup(
				'github',
				'pull',
			);
			await sync();
			await createSession('edit');
			const before = await deps.services.notebooks.getNotebook(project.id, notebook.id);
			const versions = await deps.services.notebooks.listVersions(project.id, notebook.id);
			const sessions = await deps.services.sessions.listActiveByProject(project.id);
			const audit = vi.spyOn(deps.services.events, 'append');
			vi.mocked(reader.getBranchHead).mockResolvedValue({ commit: 'b'.repeat(40) });
			vi.mocked(reader[operation]!).mockRejectedValue(new UnavailableError('Provider unavailable'));
			expect(await sync()).toMatchObject({
				isError: true,
				structuredContent: { code: 'SERVICE_UNAVAILABLE', message: 'Provider unavailable' },
			});
			expect(await deps.services.notebooks.getNotebook(project.id, notebook.id)).toEqual(before);
			expect(await deps.services.notebooks.listVersions(project.id, notebook.id)).toEqual(versions);
			expect(await deps.services.sessions.listActiveByProject(project.id)).toEqual(sessions);
			expect(audit).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ files: [], code: 'BAD_REQUEST' },
		{ files: [{ path: 'other.py', bytes: encode('pass') }], code: 'VALIDATION_ERROR' },
		{ files: [{ path: '../app.py', bytes: encode('pass') }], code: 'BAD_REQUEST' },
	])('rejects an invalid workspace with $code without publishing', async ({ files, code }) => {
		const { deps, reader, project, notebook, sync } = await setup();
		const before = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		const audit = vi.spyOn(deps.services.events, 'append');
		vi.mocked(reader.fetchWorkspace).mockResolvedValue(files);
		expect(await sync()).toMatchObject({ isError: true, structuredContent: { code } });
		expect(await deps.services.notebooks.getNotebook(project.id, notebook.id)).toEqual(before);
		expect(await deps.services.notebooks.listVersions(project.id, notebook.id)).toEqual([]);
		expect(audit).not.toHaveBeenCalled();
	});

	it.each(['unsupported repository', 'missing Git directory reader', 'missing registry'])(
		'rejects %s before contacting the provider',
		async (reason) => {
			const { deps, reader, sync } = await setup('github', 'pull');
			if (reason === 'unsupported repository') reader.supportsRepository = () => false;
			else if (reason === 'missing Git directory reader') reader.fetchGitDirectory = undefined;
			else deps.sourceControl = undefined;
			expect(await sync()).toMatchObject({
				isError: true,
				structuredContent: { code: 'SYNC_NOT_CONFIGURED' },
			});
			expect(reader.getBranchHead).not.toHaveBeenCalled();
		},
	);

	it('applies pending settings even when the commit is unchanged', async () => {
		const { deps, reader, project, notebook, sync } = await setup();
		await sync();
		const before = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		await deps.services.notebooks.synced.updateSource(
			project.id,
			notebook.id,
			{
				repo: 'org/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'app.py',
			},
			mcpPrincipal.id,
		);
		expect(await sync()).toMatchObject({ structuredContent: { synced: true, commit: HEAD } });
		expect(reader.getBranchHead).toHaveBeenLastCalledWith('org/repo', 'release');
		expect(reader.fetchWorkspace).toHaveBeenLastCalledWith('org/repo', HEAD, 'apps');
		const { source } = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		expect(source).toMatchObject({ branch: 'release', root_path: 'apps' });
		expect(source).not.toHaveProperty('pending_config');
		expect(source.current_version_id).not.toBe(before.source.current_version_id);
	});

	it('sanitizes unexpected errors and permits retry after a post-sync session lookup failure', async () => {
		const { deps, project, notebook, sync } = await setup();
		const audit = vi.spyOn(deps.services.events, 'append');
		vi.spyOn(deps.services.sessions, 'listActiveByProject').mockRejectedValueOnce(
			new Error('Private storage endpoint and credentials'),
		);
		const response = await sync();
		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'INTERNAL_ERROR', message: 'Internal error' },
		});
		expect(JSON.stringify(response)).not.toContain('Private storage');
		expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'notebook.source.sync' }));
		audit.mockClear();
		const { source } = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		expect(await sync()).toMatchObject({
			structuredContent: {
				synced: false,
				current_version_id: source.current_version_id,
				restart_needed: false,
			},
		});
		expect(audit).not.toHaveBeenCalled();
	});

	it.each(['github', 'gitlab', 'azure-devops'] as const)(
		'syncs %s pull sources by name and returns the current version on repeat calls',
		async (provider) => {
			const { deps, reader, project, notebook, client, sync } = await setup(provider, 'pull');
			const audit = vi.spyOn(deps.services.events, 'append');
			const response = await callSync(client, { project: 'aNALYTICS', notebook: 'rEPORT' });
			expect(response.isError).not.toBe(true);
			const { source } = await deps.services.notebooks.getNotebook(project.id, notebook.id);
			expect(response.structuredContent).toEqual({
				project_id: project.id,
				notebook_id: notebook.id,
				synced: true,
				commit: HEAD,
				version_id: source.current_version_id,
				current_version_id: source.current_version_id,
				sessions: [],
				restart_needed: false,
			});
			expect(reader.fetchGitDirectory).toHaveBeenCalledOnce();
			expect(audit).toHaveBeenCalledWith({
				event: 'notebook.source.sync',
				actor: mcpPrincipal.id,
				project_id: project.id,
				notebook_id: notebook.id,
				commit: HEAD,
				trigger: 'manual',
			});
			audit.mockClear();
			expect(await sync()).toMatchObject({
				structuredContent: {
					synced: false,
					commit: HEAD,
					version_id: null,
					current_version_id: source.current_version_id,
				},
			});
			expect(reader.fetchWorkspace).toHaveBeenCalledOnce();
			expect(audit).not.toHaveBeenCalled();
		},
	);

	it('reports stale, current, and unknown edit/app sessions without restarting them', async () => {
		const { deps, project, notebook, sync, createSession } = await setup();
		const stale = await createSession('edit', createVersionId());
		const unknown = await createSession('app');
		await deps.services.sessions.setRunning(project.id, stale.session_id, 'https://kernel.example');
		await deps.services.sessions.beginTerminating(project.id, unknown.session_id);
		expect(await sync()).toMatchObject({
			structuredContent: { synced: true, restart_needed: true },
		});
		const { source } = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		const current = await createSession('app', source.current_version_id!);
		const ended = await createSession('edit', createVersionId());
		await deps.services.sessions.markTerminated(project.id, ended.session_id);
		const other = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Other', description: '', code: '' },
			mcpPrincipal.id,
		);
		await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: other.id,
			user_id: mcpPrincipal.id,
		});
		const before = await deps.services.sessions.listActiveByProject(project.id);
		const response = await sync();
		expect(response.structuredContent).toMatchObject({
			synced: false,
			restart_needed: true,
			sessions: expect.arrayContaining([
				{
					session_id: stale.session_id,
					mode: 'edit',
					status: 'running',
					source_version_id: stale.source_version_id,
					restart_needed: true,
				},
				{
					session_id: unknown.session_id,
					mode: 'app',
					status: 'terminating',
					source_version_id: null,
					restart_needed: null,
				},
				{
					session_id: current.session_id,
					mode: 'app',
					status: 'starting',
					source_version_id: current.source_version_id,
					restart_needed: false,
				},
			]),
		});
		expect(response.structuredContent).toHaveProperty('sessions.length', 3);
		expect(await deps.services.sessions.listActiveByProject(project.id)).toEqual(before);
		await deps.services.sessions.markTerminated(project.id, stale.session_id);
		expect(await sync()).toMatchObject({ structuredContent: { restart_needed: null } });
		await deps.services.sessions.markTerminated(project.id, unknown.session_id);
		expect(await sync()).toMatchObject({ structuredContent: { restart_needed: false } });
	});

	it.each([HEAD, 'b'.repeat(40)])(
		'preserves concurrent commit %s and only accepts a matching sync',
		async (winningCommit) => {
			const { deps, reader, project, notebook, sync } = await setup();
			const audit = vi.spyOn(deps.services.events, 'append');
			vi.mocked(reader.fetchWorkspace).mockImplementation(async () => {
				const files = [{ path: 'app.py', bytes: encode('print("synced")') }];
				await deps.services.notebooks.synced.sync(project.id, notebook.id, {
					repo: 'org/repo',
					branch: 'main',
					root_path: '',
					commit: winningCommit,
					files,
				});
				return files;
			});
			const response = await sync();
			const { source } = await deps.services.notebooks.getNotebook(project.id, notebook.id);
			expect(source).toMatchObject({ commit: winningCommit });
			expect(source.current_version_id).not.toBeNull();
			expect(await deps.services.notebooks.listVersions(project.id, notebook.id)).toHaveLength(1);
			if (winningCommit === HEAD) {
				expect(response.isError).not.toBe(true);
				expect(response.structuredContent).toMatchObject({
					synced: false,
					commit: HEAD,
					version_id: null,
					current_version_id: source.current_version_id,
				});
			} else {
				expect(response).toMatchObject({ isError: true, structuredContent: { code: 'CONFLICT' } });
			}
			expect(audit).not.toHaveBeenCalledWith(
				expect.objectContaining({ event: 'notebook.source.sync' }),
			);
		},
	);

	it('keeps a successful sync successful when the audit append fails', async () => {
		const { deps, sync } = await setup();
		vi.spyOn(deps.services.events, 'append').mockRejectedValue(new Error('Audit unavailable'));
		const response = await sync();
		expect(response.isError).not.toBe(true);
		expect(response.structuredContent).toMatchObject({ synced: true, commit: HEAD });
	});

	it('reports an unknown current source version as unknown restart status', async () => {
		const { deps, project, notebook, sync, createSession } = await setup();
		await sync();
		await createSession('edit', createVersionId());
		const detail = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		if (detail.source.type !== 'git') throw new Error('Expected Git source');
		vi.spyOn(deps.services.notebooks, 'getNotebook').mockResolvedValue({
			...detail,
			source: { ...detail.source, current_version_id: null },
		});
		expect(await sync()).toMatchObject({
			structuredContent: {
				current_version_id: null,
				restart_needed: null,
				sessions: [{ restart_needed: null }],
			},
		});
	});

	it('requires notebook.write and denies viewers and read-only token grants before fetching', async () => {
		const { deps, reader, project, notebook } = await setup();
		const viewer: AuthenticatedPrincipal = { ...mcpPrincipal, id: UserId.parse('viewer') };
		await deps.services.projects.addMember(
			project.id,
			{ user_id: viewer.id },
			'viewer',
			mcpPrincipal.id,
		);
		const readOnly: AuthenticatedPrincipal = {
			...mcpPrincipal,
			credential: {
				kind: 'personal-access-token',
				id: 'read-only',
				grant: { actions: ['project.read'], projects: [project.id] },
			},
		};
		for (const principal of [viewer, readOnly]) {
			const client = await connectMcpClient(deps, principal);
			expect(await callSync(client, { project: project.id, notebook: notebook.id })).toMatchObject({
				isError: true,
				structuredContent: { code: 'FORBIDDEN' },
			});
		}
		expect(reader.getBranchHead).not.toHaveBeenCalled();
	});

	it('rejects local notebooks and ambiguous titles before fetching', async () => {
		const { deps, reader, project, client, sync } = await setup();
		const local = await deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Report', description: '', code: '' },
			mcpPrincipal.id,
		);
		for (const [notebook, code] of [
			[local.id, 'NOT_FOUND'],
			['Report', 'BAD_REQUEST'],
		]) {
			expect(await callSync(client, { project: project.id, notebook })).toMatchObject({
				isError: true,
				structuredContent: { code },
			});
		}
		expect(reader.getBranchHead).not.toHaveBeenCalled();
		expect(await sync()).toMatchObject({ structuredContent: { synced: true } });
	});
});

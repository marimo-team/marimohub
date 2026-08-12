import { describe, it, expect, beforeEach } from 'vitest';
import { ACTOR, setupTestEnv } from '../../testing';
import type { ProjectId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { CatalogService } from '../catalog/CatalogService';
import type { NotebookService } from './NotebookService';
import type { ProjectService } from './ProjectService';
import { SyncedNotebookService } from './SyncedNotebookService';
import type { CreateSyncedNotebookInput } from '../../integrations/syncedSource';

const enc = (s: string) => new TextEncoder().encode(s);

const CREATE_INPUT: CreateSyncedNotebookInput = {
	title: 'Synced NB',
	description: 'from git',
	repo: 'owner/repo',
	branch: 'main',
	entry_notebook: 'app.py',
	root_path: '',
};

function syncInput(commit: string) {
	return {
		repo: 'owner/repo',
		branch: 'main',
		root_path: '',
		commit,
		files: [{ path: 'app.py', bytes: enc('import marimo') }],
	};
}

describe('SyncedNotebookService', () => {
	let notebooks: NotebookService;
	let projects: ProjectService;
	let catalog: CatalogService;
	let projectId: ProjectId;

	beforeEach(async () => {
		const env = await setupTestEnv();
		notebooks = env.notebooks;
		projects = env.projects;
		catalog = env.catalog;
		const project = await projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		projectId = project.id;
	});

	async function entry(nid: string) {
		const snap = await catalog.getCurrentSnapshot();
		const p = snap.projects.find((pr) => pr.id === projectId);
		return p?.notebooks.find((n) => n.id === nid);
	}

	describe('create', () => {
		it('writes content files and a git catalog entry', async () => {
			const { meta, sync_token } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);

			expect(meta.status).toBe('draft');
			expect(sync_token).toMatch(/^mhsync_/);

			const nb = await notebooks.getNotebook(projectId, meta.id);
			expect(nb.source.type).toBe('git');

			const e = await entry(meta.id);
			expect(e?.source_type).toBe('git');
			expect(e?.status).toBe('draft');
			expect(e?.title).toBe('Synced NB');

			const p = (await catalog.getCurrentSnapshot()).projects.find((pr) => pr.id === projectId);
			expect(p?.notebook_count).toBe(1);
		});

		it('rejects a repo that is neither owner/repo nor a repository URL', async () => {
			for (const repo of ['just-a-name', 'a/b/c', 'https://gitlab.com/only-group']) {
				await expect(
					notebooks.synced.create(projectId, { ...CREATE_INPUT, repo }, ACTOR),
				).rejects.toThrow('repo must be owner/repo');
			}
		});

		it('accepts repository URLs and derives the provider from the host', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'https://gitlab.example.com/group1/marimo/nb' },
				ACTOR,
			);
			const nb = await notebooks.getNotebook(projectId, meta.id);
			expect(nb.source).toMatchObject({
				type: 'git',
				provider: 'gitlab',
				repo: 'https://gitlab.example.com/group1/marimo/nb',
			});
		});

		it('maps owner/repo shorthand to gitlab.com when provider is gitlab', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'group/project', provider: 'gitlab' },
				ACTOR,
			);
			const nb = await notebooks.getNotebook(projectId, meta.id);
			expect(nb.source).toMatchObject({
				provider: 'gitlab',
				repo: 'https://gitlab.com/group/project',
			});
		});

		it('prefers host detection over a contradictory explicit provider', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'https://gitlab.com/group/project', provider: 'github' },
				ACTOR,
			);
			const nb = await notebooks.getNotebook(projectId, meta.id);
			expect(nb.source).toMatchObject({ provider: 'gitlab' });
		});

		it('stores a null provider for unrecognized hosts', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'https://code.my-company.org/team/repo' },
				ACTOR,
			);
			const nb = await notebooks.getNotebook(projectId, meta.id);
			expect(nb.source).toMatchObject({ provider: null });
		});
	});

	describe('verifyToken / rotateToken', () => {
		it('verifies the minted token and rejects wrong/absent tokens', async () => {
			const { meta, sync_token } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);

			expect(await notebooks.synced.verifyToken(projectId, meta.id, sync_token)).toBe(true);
			expect(await notebooks.synced.verifyToken(projectId, meta.id, 'mhsync_wrong')).toBe(false);
			expect(await notebooks.synced.verifyToken(projectId, meta.id, undefined)).toBe(false);
		});

		it('rotateToken invalidates the previous token', async () => {
			const { meta, sync_token } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			const { sync_token: rotated } = await notebooks.synced.rotateToken(projectId, meta.id);

			expect(rotated).not.toBe(sync_token);
			expect(await notebooks.synced.verifyToken(projectId, meta.id, rotated)).toBe(true);
			expect(await notebooks.synced.verifyToken(projectId, meta.id, sync_token)).toBe(false);
		});
	});

	describe('updateSource', () => {
		it('rejects a repo that is neither owner/repo nor a repository URL', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await expect(
				notebooks.synced.updateSource(
					projectId,
					meta.id,
					{
						repo: 'just-a-name',
						branch: 'main',
						root_path: '',
						entry_notebook: 'app.py',
					},
					ACTOR,
				),
			).rejects.toThrow('repo must be owner/repo');
		});

		it('updates an unsynced draft immediately', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'new/repo',
					branch: 'release',
					root_path: 'apps',
					entry_notebook: 'dashboard.py',
				},
				ACTOR,
			);

			expect(source).toMatchObject({
				repo: 'new/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			});
			expect(source.pending_config).toBeUndefined();
			expect((await notebooks.getNotebook(projectId, meta.id)).meta.status).toBe('draft');
		});

		it('re-derives the provider when an unsynced draft moves to another host', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'https://gitlab.com/group/project',
					branch: 'main',
					root_path: '',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);

			expect(source).toMatchObject({
				repo: 'https://gitlab.com/group/project',
				provider: 'gitlab',
			});
		});

		it('re-homes a shorthand repo onto the host the source already lives on', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'group/project', provider: 'gitlab' },
				ACTOR,
			);

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{ repo: 'team/new', branch: 'main', root_path: '', entry_notebook: 'app.py' },
				ACTOR,
			);

			expect(source).toMatchObject({
				repo: 'https://gitlab.com/team/new',
				provider: 'gitlab',
			});
		});

		it('treats a bare shorthand edit of a URL-form GitHub source as a no-op', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'https://github.com/owner/repo' },
				ACTOR,
			);
			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{ repo: 'owner/repo', branch: 'main', root_path: '', entry_notebook: 'app.py' },
				ACTOR,
			);

			expect(source.repo).toBe('https://github.com/owner/repo');
			expect(source.pending_config).toBeUndefined();
		});

		it('keeps an explicit provider across a path-only change on an unrecognized host', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'https://code.my-company.org/team/old', provider: 'gitlab' },
				ACTOR,
			);

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'https://code.my-company.org/team/new',
					branch: 'main',
					root_path: '',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);

			expect(source).toMatchObject({
				repo: 'https://code.my-company.org/team/new',
				provider: 'gitlab',
			});
		});

		it('stages edits after a sync and keeps serving the active source', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			const before = await notebooks.getNotebook(projectId, meta.id);

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'new/repo',
					branch: 'release',
					root_path: 'apps',
					entry_notebook: 'dashboard.py',
				},
				ACTOR,
			);

			expect(source.repo).toBe('owner/repo');
			expect(source.current_version_id).toBe(
				before.source.type === 'git' ? before.source.current_version_id : null,
			);
			expect(source.commit).toBe('commit-aaaa');
			expect(source.pending_config).toEqual({
				repo: 'new/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			});
			expect(await notebooks.getNotebookContent(projectId, meta.id)).toBe('import marimo');
		});

		it('clears a pending edit when settings are reverted to the active source', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'new/repo',
					branch: 'release',
					root_path: 'apps',
					entry_notebook: 'dashboard.py',
				},
				ACTOR,
			);

			const source = await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'owner/repo',
					branch: 'main',
					root_path: '',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);

			expect(source.pending_config).toBeUndefined();
			expect(source.repo).toBe('owner/repo');
			expect(source.commit).toBe('commit-aaaa');
		});
	});

	describe('sync', () => {
		it('advances the source to a new version and flips status to active', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);

			const updated = await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			expect(updated.status).toBe('active');

			const nb = await notebooks.getNotebook(projectId, meta.id);
			expect(nb.source.type).toBe('git');
			if (nb.source.type === 'git') {
				expect(nb.source.commit).toBe('commit-aaaa');
				expect(nb.source.current_version_id).not.toBeNull();
			}

			// The cut version records the commit it mirrors (the UI links it).
			const [version] = await notebooks.listVersions(projectId, meta.id);
			expect(version?.commit).toBe('commit-aaaa');
			expect(version?.message).toBe('Sync commit-aaaa');

			const e = await entry(meta.id);
			expect(e?.status).toBe('active');
		});

		it('is a no-op when re-syncing the same commit', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			const before = await notebooks.getNotebook(projectId, meta.id);

			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			const after = await notebooks.getNotebook(projectId, meta.id);

			if (before.source.type === 'git' && after.source.type === 'git') {
				expect(after.source.current_version_id).toBe(before.source.current_version_id);
			}
		});

		it('accepts a bare-path repo header for a URL-stored repo (CI states $CI_PROJECT_PATH)', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{ ...CREATE_INPUT, repo: 'https://gitlab.example.com/group1/marimo/nb' },
				ACTOR,
			);
			const updated = await notebooks.synced.sync(projectId, meta.id, {
				...syncInput('commit-aaaa'),
				repo: 'group1/marimo/nb',
			});
			expect(updated.status).toBe('active');
		});

		it('reports every mismatched source header with received and expected values', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await expect(
				notebooks.synced.sync(projectId, meta.id, {
					...syncInput('commit-bbbb'),
					repo: 'other/repo',
					branch: 'feature',
					root_path: 'apps',
				}),
			).rejects.toThrow(
				'Sync source mismatch: X-Marimohub-Repo received "other/repo", expected "owner/repo"; X-Marimohub-Branch received "feature", expected "main"; X-Marimohub-Root-Path received "apps", expected "". Update the request headers or the notebook\'s sync settings.',
			);
		});

		it('promotes pending settings even when the commit SHA matches the active source', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'new/repo',
					branch: 'release',
					root_path: 'apps',
					entry_notebook: 'dashboard.py',
				},
				ACTOR,
			);

			await notebooks.synced.sync(projectId, meta.id, {
				repo: 'new/repo',
				branch: 'release',
				root_path: 'apps',
				commit: 'commit-aaaa',
				files: [{ path: 'dashboard.py', bytes: enc('print("new")') }],
			});

			const after = await notebooks.getNotebook(projectId, meta.id);
			expect(after.source).toMatchObject({
				type: 'git',
				repo: 'new/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
				commit: 'commit-aaaa',
			});
			if (after.source.type === 'git') {
				expect(after.source.pending_config).toBeUndefined();
			}
			expect(await notebooks.getNotebookContent(projectId, meta.id)).toBe('print("new")');
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(2);
		});

		it('re-derives the provider when a pending repo change lands', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await notebooks.synced.sync(projectId, meta.id, syncInput('commit-aaaa'));
			await notebooks.synced.updateSource(
				projectId,
				meta.id,
				{
					repo: 'https://gitlab.com/group/project',
					branch: 'main',
					root_path: '',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);

			await notebooks.synced.sync(projectId, meta.id, {
				...syncInput('commit-bbbb'),
				repo: 'group/project',
			});

			const after = await notebooks.getNotebook(projectId, meta.id);
			expect(after.source).toMatchObject({
				repo: 'https://gitlab.com/group/project',
				provider: 'gitlab',
				commit: 'commit-bbbb',
			});
		});

		// A stale-source push whose commit was already claimed by a concurrent push
		// must lose its CAS and skip, leaving the winner's version as the pointer —
		// its own freshly-written version is a harmless orphan.
		it('leaves the concurrent winner in place when a push already claimed the commit', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const pid = project.id;
			const { meta } = await env.notebooks.synced.create(pid, CREATE_INPUT, ACTOR);

			// First push claims commit A; capture that source as the "stale" read.
			await env.notebooks.synced.sync(pid, meta.id, syncInput('commit-aaaa'));
			const stale = await env.notebooks.getNotebook(pid, meta.id);

			// A concurrent push claims commit B and advances the pointer to its version.
			await env.notebooks.synced.sync(pid, meta.id, syncInput('commit-bbbb'));
			const winner = await env.notebooks.getNotebook(pid, meta.id);
			const winnerVersionId =
				winner.source.type === 'git' ? winner.source.current_version_id : null;

			const versionsBefore = await env.notebooks.listVersions(pid, meta.id);
			let protectedVersionId: string | undefined;

			// Our push also targets commit B, but started from the stale (commit-A) source.
			// Its CAS re-reads the pointer (now commit B) and must no-op rather than clobber.
			const racing = new SyncedNotebookService(env.bucket, env.catalog, noopMetrics, {
				getNotebook: async () => ({ meta: stale.meta, source: stale.source }),
				pruneVersions: async (_projectId, _notebookId, keep) => {
					protectedVersionId = keep;
				},
				withNotebookWriteLock: async (_projectId, _notebookId, operation) =>
					operation(async () => {}),
			});
			await expect(racing.sync(pid, meta.id, syncInput('commit-bbbb'))).resolves.toBeDefined();

			const after = await env.notebooks.getNotebook(pid, meta.id);
			expect(after.source.type).toBe('git');
			if (after.source.type === 'git') {
				expect(after.source.commit).toBe('commit-bbbb');
				expect(after.source.current_version_id).toBe(winnerVersionId);
			}
			expect(protectedVersionId).toBe(winnerVersionId);
			// The losing push's version is left behind as a harmless orphan.
			const versionsAfter = await env.notebooks.listVersions(pid, meta.id);
			expect(versionsAfter.length).toBe(versionsBefore.length + 1);
		});

		it('rejects an in-flight push when the source settings change before its CAS', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const pid = project.id;
			const { meta } = await env.notebooks.synced.create(pid, CREATE_INPUT, ACTOR);
			await env.notebooks.synced.sync(pid, meta.id, syncInput('commit-aaaa'));
			const stale = await env.notebooks.getNotebook(pid, meta.id);

			await env.notebooks.synced.updateSource(
				pid,
				meta.id,
				{
					repo: 'new/repo',
					branch: 'main',
					root_path: '',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);
			const racing = new SyncedNotebookService(env.bucket, env.catalog, noopMetrics, {
				getNotebook: async () => ({ meta: stale.meta, source: stale.source }),
				pruneVersions: async () => {},
				withNotebookWriteLock: async (_projectId, _notebookId, operation) =>
					operation(async () => {}),
			});

			await expect(racing.sync(pid, meta.id, syncInput('commit-bbbb'))).rejects.toThrow(
				'X-Marimohub-Repo received "owner/repo", expected "new/repo"',
			);
			const after = await env.notebooks.getNotebook(pid, meta.id);
			expect(after.source).toMatchObject({
				type: 'git',
				repo: 'owner/repo',
				commit: 'commit-aaaa',
				pending_config: { repo: 'new/repo' },
			});
			expect(await env.notebooks.listVersions(pid, meta.id)).toHaveLength(1);
		});
	});

	describe('non-synced (local) notebooks', () => {
		async function createLocal() {
			return notebooks.createNotebook(
				projectId,
				{ title: 'Local', description: 'd', code: 'import marimo' },
				ACTOR,
			);
		}

		it('rotateToken rejects a local (non-git) notebook', async () => {
			const local = await createLocal();
			await expect(notebooks.synced.rotateToken(projectId, local.id)).rejects.toThrow();
		});

		it('updateSource rejects a local (non-git) notebook', async () => {
			const local = await createLocal();
			await expect(
				notebooks.synced.updateSource(
					projectId,
					local.id,
					{
						repo: 'owner/repo',
						branch: 'main',
						root_path: '',
						entry_notebook: 'app.py',
					},
					ACTOR,
				),
			).rejects.toThrow('Notebook is not backed by a synced source');
		});

		it('sync rejects a local (non-git) notebook', async () => {
			const local = await createLocal();
			await expect(
				notebooks.synced.sync(projectId, local.id, syncInput('commit-aaaa')),
			).rejects.toThrow();
		});

		it('verifyToken returns false when no sync-token sidecar exists', async () => {
			const local = await createLocal();
			expect(await notebooks.synced.verifyToken(projectId, local.id, 'mhsync_anything')).toBe(
				false,
			);
		});
	});
});

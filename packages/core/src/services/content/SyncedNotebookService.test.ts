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

		it('rejects a payload whose repo does not match the source', async () => {
			const { meta } = await notebooks.synced.create(projectId, CREATE_INPUT, ACTOR);
			await expect(
				notebooks.synced.sync(projectId, meta.id, {
					...syncInput('commit-bbbb'),
					repo: 'other/repo',
				}),
			).rejects.toThrow();
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

			// Our push also targets commit B, but started from the stale (commit-A) source.
			// Its CAS re-reads the pointer (now commit B) and must no-op rather than clobber.
			const racing = new SyncedNotebookService(env.bucket, env.catalog, noopMetrics, {
				getNotebook: async () => ({ meta: stale.meta, source: stale.source }),
				pruneVersions: async () => {},
			});
			await expect(racing.sync(pid, meta.id, syncInput('commit-bbbb'))).resolves.toBeDefined();

			const after = await env.notebooks.getNotebook(pid, meta.id);
			expect(after.source.type).toBe('git');
			if (after.source.type === 'git') {
				expect(after.source.commit).toBe('commit-bbbb');
				expect(after.source.current_version_id).toBe(winnerVersionId);
			}
			// The losing push's version is left behind as a harmless orphan.
			const versionsAfter = await env.notebooks.listVersions(pid, meta.id);
			expect(versionsAfter.length).toBe(versionsBefore.length + 1);
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

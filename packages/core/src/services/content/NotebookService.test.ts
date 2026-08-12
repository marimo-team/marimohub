import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryBucket } from '../../testing';
import {
	BadRequestError,
	ConflictError,
	DomainError,
	NotFoundError,
	PreconditionFailedError,
	ValidationError,
} from '../../errors';
import { createNotebookId, createVersionId } from '../../ids';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import { ACTOR, setupTestEnv } from '../../testing';
import type { CatalogService } from '../catalog/CatalogService';
import { MAX_VERSIONS } from './NotebookService';
import type { NotebookService } from './NotebookService';
import type { ProjectService } from './ProjectService';
import { listAllKeys, listAllPrefixes } from '../catalog/storage';

const enc = (s: string) => new TextEncoder().encode(s);

/** Count distinct `versions/{vid}/` folders present in the bucket for a notebook. */
async function countVersionFolders(
	bucket: MemoryBucket,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<number> {
	const nb = paths.project(projectId).notebook(notebookId);
	return (await listAllPrefixes(bucket, `${nb.base}/versions/`)).length;
}

describe('NotebookService', () => {
	let bucket: MemoryBucket;
	let notebooks: NotebookService;
	let projects: ProjectService;
	let catalog: CatalogService;
	let projectId: ProjectId;

	beforeEach(async () => {
		const env = await setupTestEnv();
		bucket = env.bucket;
		notebooks = env.notebooks;
		projects = env.projects;
		catalog = env.catalog;

		const project = await projects.createProject(
			{ name: 'Test Project', description: 'test' },
			ACTOR,
		);
		projectId = project.id;
	});

	describe('createNotebook', () => {
		it('creates a notebook with all content files', async () => {
			const meta = await notebooks.createNotebook(
				projectId,
				{
					title: 'Analysis',
					description: 'Revenue analysis',
					code: 'import marimo',
					tags: ['finance'],
				},
				ACTOR,
			);

			expect(meta.title).toBe('Analysis');
			expect(meta.status).toBe('active');
			expect(meta.project_id).toBe(projectId);

			const nb = paths.project(projectId).notebook(meta.id);
			const metaObj = await bucket.get(nb.meta);
			expect(metaObj).not.toBeNull();

			const codeObj = await bucket.get(nb.code);
			expect(await codeObj!.text()).toBe('import marimo');

			const sourceObj = await bucket.get(nb.source);
			const source = await sourceObj!.json<any>();
			expect(source.type).toBe('local');
			expect(source.current_version_id).toBeTruthy();
		});

		it('adds notebook to the snapshot', async () => {
			const meta = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			const snap = await catalog.getCurrentSnapshot();
			const proj = snap.projects.find((p) => p.id === projectId);
			expect(proj!.notebooks).toHaveLength(1);
			expect(proj!.notebooks[0].id).toBe(meta.id);
			expect(proj!.notebook_count).toBe(1);
		});

		it('creates an initial version snapshot', async () => {
			const meta = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			const versions = await notebooks.listVersions(projectId, meta.id);
			expect(versions).toHaveLength(1);
			expect(versions[0].message).toBe('Initial version');
			expect(versions[0].parent_id).toBeNull();
		});

		it('generates a default README from title+description', async () => {
			const meta = await notebooks.createNotebook(
				projectId,
				{ title: 'My Title', description: 'My desc', code: 'code' },
				ACTOR,
			);

			const readme = await bucket.get(paths.project(projectId).notebook(meta.id).readme);
			expect(await readme!.text()).toBe('# My Title\n\nMy desc\n');
		});

		it('persists a base image choice and omits the field when unset', async () => {
			const withImage = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code', base_image: 'ghcr.io/marimo/gpu:1' },
				ACTOR,
			);
			expect(withImage.base_image).toBe('ghcr.io/marimo/gpu:1');

			const without = await notebooks.createNotebook(
				projectId,
				{ title: 'NB2', description: 'D', code: 'code' },
				ACTOR,
			);
			const stored = await bucket.get(paths.project(projectId).notebook(without.id).meta);
			expect(await stored!.json<Record<string, unknown>>()).not.toHaveProperty('base_image');
		});

		it('rolls back content blobs when the catalog write fails', async () => {
			const before = (await listAllKeys(bucket, '')).sort();
			vi.spyOn(catalog, 'mutateSnapshot').mockRejectedValueOnce(new Error('catalog boom'));

			await expect(
				notebooks.createNotebook(
					projectId,
					{ title: 'Doomed', description: 'will fail', code: 'x = 1' },
					ACTOR,
				),
			).rejects.toThrow('catalog boom');

			// Saga compensation deleted the orphaned notebook blobs: no new keys remain.
			const after = (await listAllKeys(bucket, '')).sort();
			expect(after).toEqual(before);
		});
	});

	describe('duplicateNotebook', () => {
		it('copies content into a fresh notebook with a "(copy)" title', async () => {
			const original = await notebooks.createNotebook(
				projectId,
				{
					title: 'Analysis',
					description: 'Revenue analysis',
					code: 'x = 1',
					tags: ['finance'],
					deps: '[project]\nname = "a"\n',
				},
				ACTOR,
			);

			const copy = await notebooks.duplicateNotebook(projectId, original.id, ACTOR);

			expect(copy.id).not.toBe(original.id);
			expect(copy.title).toBe('Analysis (copy)');
			expect(copy.description).toBe('Revenue analysis');
			expect(copy.tags).toEqual(['finance']);

			const nb = paths.project(projectId).notebook(copy.id);
			expect(await (await bucket.get(nb.code))!.text()).toBe('x = 1');
			expect(await (await bucket.get(nb.deps))!.text()).toBe('[project]\nname = "a"\n');

			const snap = await catalog.getCurrentSnapshot();
			const proj = snap.projects.find((p) => p.id === projectId);
			expect(proj!.notebook_count).toBe(2);
		});

		it('honors an explicit new title', async () => {
			const original = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			const copy = await notebooks.duplicateNotebook(projectId, original.id, ACTOR, 'My Fork');
			expect(copy.title).toBe('My Fork');
		});

		it('throws NotFoundError for a missing notebook', async () => {
			await expect(
				notebooks.duplicateNotebook(projectId, createNotebookId(), ACTOR),
			).rejects.toThrow(NotFoundError);
		});

		it('copies the base image choice', async () => {
			const original = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code', base_image: 'ghcr.io/marimo/gpu:1' },
				ACTOR,
			);

			const copy = await notebooks.duplicateNotebook(projectId, original.id, ACTOR);
			expect(copy.base_image).toBe('ghcr.io/marimo/gpu:1');
		});
	});

	describe('git-synced notebooks', () => {
		const create = (overrides: Record<string, unknown> = {}) =>
			notebooks.synced.create(
				projectId,
				{
					title: 'Git NB',
					description: 'from repo',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
					...overrides,
				},
				ACTOR,
			);
		const sync = (
			notebookId: NotebookId,
			commit: string,
			files: { path: string; bytes: Uint8Array }[],
		) =>
			notebooks.synced.sync(projectId, notebookId, {
				repo: 'org/repo',
				branch: 'main',
				root_path: '',
				commit,
				files,
			});
		const currentVersionId = async (notebookId: NotebookId) => {
			const { source } = await notebooks.getNotebook(projectId, notebookId);
			return source.type === 'git' ? source.current_version_id : null;
		};

		it('creates a draft git notebook with a private sync token', async () => {
			const { meta, sync_token } = await create({ root_path: 'apps', entry_notebook: 'my_app.py' });

			expect(meta.status).toBe('draft');
			expect(sync_token).toMatch(/^mhsync_/);
			const nb = paths.project(projectId).notebook(meta.id);
			const source = await (await bucket.get(nb.source))!.json<any>();
			expect(source).toMatchObject({
				type: 'git',
				provider: 'github',
				repo: 'org/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'my_app.py',
				sync_mode: 'push',
				current_version_id: null,
			});
			const tokenRecord = await (await bucket.get(nb.integrationSyncToken))!.json<any>();
			expect(tokenRecord.token_sha256).toBeTruthy();
			expect(tokenRecord.token_sha256).not.toContain(sync_token);

			const snap = await catalog.getCurrentSnapshot();
			const entry = snap.projects.find((p) => p.id === projectId)!.notebooks[0];
			expect(entry.source_type).toBe('git');
			expect(entry.status).toBe('draft');
		});

		it('validates git root and entry notebook paths', async () => {
			await expect(create({ root_path: '../apps' })).rejects.toThrow(BadRequestError);
			await expect(create({ entry_notebook: 'apps/app.ipynb' })).rejects.toThrow(BadRequestError);
		});

		it('syncs a workspace mirror, versions it, and returns entry_notebook content', async () => {
			const { meta } = await create({ entry_notebook: 'apps/my_app.py' });

			const synced = await sync(meta.id, 'abc123', [
				{ path: 'apps/my_app.py', bytes: enc('print("app")') },
				{ path: 'data/cars.csv', bytes: enc('a,b\n1,2\n') },
			]);

			expect(synced.status).toBe('active');
			expect(await notebooks.getNotebookContent(projectId, meta.id)).toBe('print("app")');
			const detail = await notebooks.getNotebook(projectId, meta.id);
			expect(detail.source.type).toBe('git');
			if (detail.source.type === 'git') {
				expect(detail.source.commit).toBe('abc123');
				expect(detail.source.current_version_id).toBeTruthy();
				const ver = paths
					.project(projectId)
					.notebook(meta.id)
					.version(detail.source.current_version_id!);
				expect(await (await bucket.get(ver.workspaceFile('apps/my_app.py')))!.text()).toBe(
					'print("app")',
				);
			}
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(1);
		});

		it('does not resurrect a notebook deleted before sync metadata publication', async () => {
			const { meta } = await create();
			const nb = paths.project(projectId).notebook(meta.id);
			const realPut = bucket.put.bind(bucket);
			let metaPutReached!: () => void;
			let releaseMetaPut!: () => void;
			const atMetaPut = new Promise<void>((resolve) => {
				metaPutReached = resolve;
			});
			const metaPutGate = new Promise<void>((resolve) => {
				releaseMetaPut = resolve;
			});
			let gated = false;
			const putSpy = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				const status =
					typeof value === 'string' ? (JSON.parse(value) as { status?: string }).status : undefined;
				if (key === nb.meta && status === 'active' && !gated) {
					gated = true;
					metaPutReached();
					await metaPutGate;
				}
				return realPut(key, value, options);
			});

			const syncing = sync(meta.id, 'abc123', [{ path: 'app.py', bytes: enc('v1') }]);
			try {
				await atMetaPut;
				await notebooks.deleteNotebook(projectId, meta.id, ACTOR);
				releaseMetaPut();
				await expect(syncing).rejects.toThrow(NotFoundError);

				const stored = await (await bucket.get(nb.meta))!.json<any>();
				const snapshot = await catalog.getCurrentSnapshot();
				const project = snapshot.projects.find((candidate) => candidate.id === projectId)!;
				expect(stored.status).toBe('deleted');
				expect(project.notebooks[0].status).toBe('deleted');
				expect(project.notebook_count).toBe(0);
			} finally {
				releaseMetaPut();
				await Promise.allSettled([syncing]);
				putSpy.mockRestore();
			}
		});

		it('rejects a sync for an already-deleted notebook without writing content', async () => {
			const { meta } = await create();
			const nb = paths.project(projectId).notebook(meta.id);
			await notebooks.deleteNotebook(projectId, meta.id, ACTOR);
			const sourceBefore = await (await bucket.get(nb.source))!.text();

			await expect(sync(meta.id, 'abc123', [{ path: 'app.py', bytes: enc('v1') }])).rejects.toThrow(
				NotFoundError,
			);

			expect(await (await bucket.get(nb.source))!.text()).toBe(sourceBefore);
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(0);
		});

		it('lists the current version workspace for download', async () => {
			const { meta } = await create();
			await sync(meta.id, 'abc123', [
				{ path: 'app.py', bytes: enc('print(1)') },
				{ path: 'data/cars.csv', bytes: enc('a,b\n1,2\n') },
			]);

			const files = await notebooks.listWorkspaceFiles(projectId, meta.id);
			expect(files.map((f) => f.path).sort()).toEqual(['app.py', 'data/cars.csv']);
		});

		it('lists no workspace files for an unsynced draft', async () => {
			const { meta } = await create();
			expect(await notebooks.listWorkspaceFiles(projectId, meta.id)).toEqual([]);
		});

		it('writes each push as an independent immutable version', async () => {
			const { meta } = await create();

			await sync(meta.id, 'abc123', [
				{ path: 'app.py', bytes: enc('v1') },
				{ path: 'stale.txt', bytes: enc('old') },
			]);
			const firstVid = (await currentVersionId(meta.id))!;
			await sync(meta.id, 'def456', [{ path: 'app.py', bytes: enc('v2') }]);
			const secondVid = (await currentVersionId(meta.id))!;

			expect(secondVid).not.toBe(firstVid);
			expect(await notebooks.getNotebookContent(projectId, meta.id)).toBe('v2');

			const nb = paths.project(projectId).notebook(meta.id);
			// The newest version is a clean mirror — a file dropped between pushes does
			// not leak into it.
			expect(await bucket.get(nb.version(secondVid).workspaceFile('stale.txt'))).toBeNull();
			expect(await (await bucket.get(nb.version(secondVid).workspaceFile('app.py')))!.text()).toBe(
				'v2',
			);
			// The older version is immutable and retains exactly what it was synced with.
			expect(
				await (await bucket.get(nb.version(firstVid).workspaceFile('stale.txt')))!.text(),
			).toBe('old');
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(2);
		});

		it('treats a re-pushed commit as idempotent even if bytes differ', async () => {
			const { meta } = await create();

			const first = await sync(meta.id, 'abc123', [{ path: 'app.py', bytes: enc('v1') }]);
			// Git commits are content-addressed, so the same SHA can never carry different
			// bytes; a re-push is a no-op, not a conflict.
			const second = await sync(meta.id, 'abc123', [{ path: 'app.py', bytes: enc('v2') }]);

			expect(second.updated_at).toBe(first.updated_at);
			expect(await notebooks.getNotebookContent(projectId, meta.id)).toBe('v1');
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(1);
		});

		it('keeps the source pointer consistent under concurrent distinct-commit pushes', async () => {
			const { meta } = await create();

			const [a, b] = await Promise.allSettled([
				sync(meta.id, 'aaa111', [{ path: 'app.py', bytes: enc('va') }]),
				sync(meta.id, 'bbb222', [{ path: 'app.py', bytes: enc('vb') }]),
			]);
			expect(a.status).toBe('fulfilled');
			expect(b.status).toBe('fulfilled');

			const detail = await notebooks.getNotebook(projectId, meta.id);
			const commit = detail.source.type === 'git' ? detail.source.commit : null;
			expect(['aaa111', 'bbb222']).toContain(commit);
			// The served content is exactly the one the pointer landed on — never a mix.
			const content = await notebooks.getNotebookContent(projectId, meta.id);
			expect(content).toBe(commit === 'aaa111' ? 'va' : 'vb');
			// Both pushes left their own immutable version behind.
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(2);
		});

		it('rolls back the version and leaves the source unchanged when a workspace write fails', async () => {
			const { meta } = await create();
			const nb = paths.project(projectId).notebook(meta.id);

			const realPut = bucket.put.bind(bucket);
			const spy = vi.spyOn(bucket, 'put').mockImplementation((key, value, opts) => {
				if (key.includes('/versions/') && key.endsWith('/app.py')) {
					return Promise.reject(new Error('disk full'));
				}
				return realPut(key, value, opts);
			});

			await expect(
				sync(meta.id, 'abc123', [{ path: 'app.py', bytes: enc('v1') }]),
			).rejects.toThrow();
			spy.mockRestore();

			const source = await (await bucket.get(nb.source))!.json<any>();
			expect(source.commit).toBeNull();
			expect(source.current_version_id).toBeNull();
			expect(await notebooks.listVersions(projectId, meta.id)).toHaveLength(0);
		});

		it('rejects sync when the entry_notebook is missing', async () => {
			const { meta } = await create();
			await expect(
				sync(meta.id, 'abc123', [{ path: 'other.py', bytes: enc('print(1)') }]),
			).rejects.toThrow(ValidationError);
		});

		it('rotates and verifies sync tokens', async () => {
			const { meta, sync_token } = await create();

			expect(await notebooks.synced.verifyToken(projectId, meta.id, sync_token)).toBe(true);
			const rotated = await notebooks.synced.rotateToken(projectId, meta.id);
			expect(await notebooks.synced.verifyToken(projectId, meta.id, sync_token)).toBe(false);
			expect(await notebooks.synced.verifyToken(projectId, meta.id, rotated.sync_token)).toBe(true);
		});

		it('treats malformed sync token sidecars as failed verification', async () => {
			const { meta, sync_token } = await create();
			const nb = paths.project(projectId).notebook(meta.id);

			await bucket.put(nb.integrationSyncToken, '{not-json');

			expect(await notebooks.synced.verifyToken(projectId, meta.id, sync_token)).toBe(false);
		});

		it('surfaces token verification failures after a valid sidecar read', async () => {
			const { meta, sync_token } = await create();
			const digest = vi
				.spyOn(crypto.subtle, 'digest')
				.mockRejectedValueOnce(new Error('crypto unavailable'));

			try {
				await expect(notebooks.synced.verifyToken(projectId, meta.id, sync_token)).rejects.toThrow(
					'crypto unavailable',
				);
			} finally {
				digest.mockRestore();
			}
		});
	});

	describe('getNotebook', () => {
		it('returns meta, readme, and source', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'c', readme: '# Hello' },
				ACTOR,
			);

			const detail = await notebooks.getNotebook(projectId, created.id);
			expect(detail.meta.title).toBe('NB');
			expect(detail.readme).toBe('# Hello');
			expect(detail.source.type).toBe('local');
		});

		it('throws NotFoundError for missing notebook', async () => {
			await expect(
				notebooks.getNotebook(projectId, 'nb_01HXY00000000000000000000' as NotebookId),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('getNotebookContent', () => {
		it('returns notebook code for local source', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'print("hello")' },
				ACTOR,
			);

			const code = await notebooks.getNotebookContent(projectId, created.id);
			expect(code).toBe('print("hello")');
		});
	});

	describe('listWorkspaceFiles', () => {
		it('returns every workspace file with a path relative to the workspace root', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'print(1)', deps: '[project]' },
				ACTOR,
			);

			// Seed an extra user file alongside the always-present notebook.py/pyproject.toml.
			const nb = paths.project(projectId).notebook(created.id);
			await bucket.put(nb.workspaceFile('data/cars.csv'), 'a,b\n1,2\n');

			const files = await notebooks.listWorkspaceFiles(projectId, created.id);
			const byPath = new Map(files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]));

			expect(byPath.get('notebook.py')).toBe('print(1)');
			expect(byPath.get('pyproject.toml')).toBe('[project]');
			expect(byPath.get('data/cars.csv')).toBe('a,b\n1,2\n');
			// Paths are relativized — no `workspace/` prefix leaks through.
			expect(files.every((f) => !f.path.startsWith('workspace/'))).toBe(true);
		});

		it('throws NotFoundError for a missing notebook', async () => {
			await expect(
				notebooks.listWorkspaceFiles(projectId, 'nb-0000000000000000' as NotebookId),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('updateNotebook', () => {
		it('projects the latest metadata when catalog updates finish out of order', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Original', description: 'D', code: 'v1' },
				ACTOR,
			);
			const realUpdateEntry = catalog.updateNotebookEntry.bind(catalog);
			let raced = false;
			vi.spyOn(catalog, 'updateNotebookEntry').mockImplementation(async (...args) => {
				if (!raced && args[0] === 'notebook.update') {
					raced = true;
					await notebooks.updateNotebook(projectId, created.id, { title: 'Winner' }, ACTOR);
				}
				return realUpdateEntry(...args);
			});

			await notebooks.updateNotebook(projectId, created.id, { title: 'Delayed' }, ACTOR);

			const stored = (await notebooks.getNotebook(projectId, created.id)).meta;
			const snapshot = await catalog.getCurrentSnapshot();
			const listed = snapshot.projects[0].notebooks[0];
			expect(raced).toBe(true);
			expect(stored.title).toBe('Winner');
			expect(listed.title).toBe('Winner');
			expect(listed.updated_at).toBe(stored.updated_at);
			expect(snapshot.projects[0].updated_at).toBe(stored.updated_at);
		});

		it('does not fail or resurrect a notebook purged after its metadata commit', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Original', description: 'D', code: 'v1' },
				ACTOR,
			);
			const realUpdateEntry = catalog.updateNotebookEntry.bind(catalog);
			let purged = false;
			vi.spyOn(catalog, 'updateNotebookEntry').mockImplementation(async (...args) => {
				if (!purged && args[0] === 'notebook.update') {
					purged = true;
					await notebooks.deleteNotebook(projectId, created.id, ACTOR);
					await notebooks.hardDeleteNotebook(projectId, created.id);
				}
				return realUpdateEntry(...args);
			});

			const updated = await notebooks.updateNotebook(
				projectId,
				created.id,
				{ title: 'Delayed' },
				ACTOR,
			);

			const snapshot = await catalog.getCurrentSnapshot();
			const project = snapshot.projects.find((entry) => entry.id === projectId)!;
			expect(updated.title).toBe('Delayed');
			expect(project.notebooks[0].status).toBe('deleted');
			expect(project.notebook_count).toBe(0);
		});

		it('merges a concurrent metadata update after retrying the CAS', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Original', description: 'Original', code: 'v1' },
				ACTOR,
			);
			const metaKey = paths.project(projectId).notebook(created.id).meta;
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (!raced && key === metaKey && options?.onlyIfEtagMatches) {
					raced = true;
					await notebooks.updateNotebook(projectId, created.id, { title: 'Racer' }, ACTOR);
				}
				return realPut(key, value, options);
			});

			await notebooks.updateNotebook(projectId, created.id, { description: 'Mine' }, ACTOR);

			const stored = await (await bucket.get(metaKey))!.json<any>();
			expect(raced).toBe(true);
			expect(stored.title).toBe('Racer');
			expect(stored.description).toBe('Mine');
		});

		it('returns 412 when If-Match becomes stale during the CAS', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Original', description: 'D', code: 'v1' },
				ACTOR,
			);
			const metaKey = paths.project(projectId).notebook(created.id).meta;
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (!raced && key === metaKey && options?.onlyIfEtagMatches) {
					raced = true;
					const current = await (await bucket.get(metaKey))!.json<any>();
					await realPut(
						metaKey,
						JSON.stringify({ ...current, title: 'Racer', updated_at: '2099-01-01T00:00:00.000Z' }),
					);
				}
				return realPut(key, value, options);
			});

			await expect(
				notebooks.updateNotebook(
					projectId,
					created.id,
					{ description: 'Mine' },
					ACTOR,
					created.updated_at,
				),
			).rejects.toBeInstanceOf(PreconditionFailedError);

			const stored = await (await bucket.get(metaKey))!.json<any>();
			expect(stored.title).toBe('Racer');
			expect(stored.description).toBe('D');
		});

		it('does not resurrect a notebook deleted during an update', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const metaKey = paths.project(projectId).notebook(created.id).meta;
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (!raced && key === metaKey && options?.onlyIfEtagMatches) {
					raced = true;
					await notebooks.deleteNotebook(projectId, created.id, ACTOR);
				}
				return realPut(key, value, options);
			});

			await expect(
				notebooks.updateNotebook(projectId, created.id, { title: 'Resurrected' }, ACTOR),
			).rejects.toBeInstanceOf(NotFoundError);

			const stored = await (await bucket.get(metaKey))!.json<any>();
			const snapshot = await catalog.getCurrentSnapshot();
			const project = snapshot.projects.find((entry) => entry.id === projectId)!;
			expect(stored.status).toBe('deleted');
			expect(project.notebooks[0].status).toBe('deleted');
			expect(project.notebook_count).toBe(0);
		});

		it('returns 404 when updating an already-deleted notebook', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			await notebooks.deleteNotebook(projectId, created.id, ACTOR);

			await expect(
				notebooks.updateNotebook(projectId, created.id, { title: 'Resurrected' }, ACTOR),
			).rejects.toBeInstanceOf(NotFoundError);
		});

		it('rejects a stale expectedVersion with PreconditionFailedError', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			await expect(
				notebooks.updateNotebook(
					projectId,
					created.id,
					{ title: 'New' },
					ACTOR,
					'2000-01-01T00:00:00.000Z',
				),
			).rejects.toThrow(PreconditionFailedError);
		});

		it('rejects code/deps changes on a git-backed notebook', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{
					title: 'Git NB',
					description: 'from repo',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);

			await expect(
				notebooks.updateNotebook(projectId, meta.id, { code: 'hacked' }, ACTOR),
			).rejects.toThrow(ConflictError);
			await expect(
				notebooks.updateNotebook(projectId, meta.id, { deps: 'hacked' }, ACTOR),
			).rejects.toThrow(ConflictError);
		});

		it('updates metadata without creating a version when no code change', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Old', description: 'D', code: 'code' },
				ACTOR,
			);

			const updated = await notebooks.updateNotebook(
				projectId,
				created.id,
				{ title: 'New Title' },
				ACTOR,
			);

			expect(updated.title).toBe('New Title');
			expect(updated.description).toBe('D'); // unchanged

			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(1);
		});

		it('sets, preserves, and clears the base image', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			const set = await notebooks.updateNotebook(
				projectId,
				created.id,
				{ base_image: 'ghcr.io/marimo/gpu:1' },
				ACTOR,
			);
			expect(set.base_image).toBe('ghcr.io/marimo/gpu:1');

			// undefined leaves the stored choice untouched
			const untouched = await notebooks.updateNotebook(
				projectId,
				created.id,
				{ title: 'Renamed' },
				ACTOR,
			);
			expect(untouched.base_image).toBe('ghcr.io/marimo/gpu:1');

			// null clears back to the deployment default (key dropped from meta.json)
			const cleared = await notebooks.updateNotebook(
				projectId,
				created.id,
				{ base_image: null },
				ACTOR,
			);
			expect(cleared.base_image).toBeUndefined();
			const stored = await bucket.get(paths.project(projectId).notebook(created.id).meta);
			expect(await stored!.json<Record<string, unknown>>()).not.toHaveProperty('base_image');
		});

		it('creates a new version when code changes', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ code: 'v2', message: 'Updated code' },
				ACTOR,
			);

			const code = await notebooks.getNotebookContent(projectId, created.id);
			expect(code).toBe('v2');

			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(2);

			const latest = versions.find((v) => v.message === 'Updated code');
			expect(latest).toBeDefined();
			expect(latest!.parent_id).toBe(
				versions.find((v) => v.message === 'Initial version')!.version_id,
			);
		});

		it('updates the snapshot', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Old', description: 'D', code: 'code' },
				ACTOR,
			);

			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ title: 'New', tags: ['updated'] },
				ACTOR,
			);

			const snap = await catalog.getCurrentSnapshot();
			const proj = snap.projects.find((p) => p.id === projectId)!;
			expect(proj.notebooks[0].title).toBe('New');
			expect(proj.notebooks[0].tags).toEqual(['updated']);
		});

		it('preserves existing deps when code is updated without new deps', async () => {
			const originalDeps = '[project]\ndependencies = ["pandas"]';
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1', deps: originalDeps },
				ACTOR,
			);

			// Update code only — no deps in the input (realistic code-only save).
			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ code: 'v2', message: 'code-only' },
				ACTOR,
			);

			const nb = paths.project(projectId).notebook(created.id);

			// Live pyproject.toml must still hold the original deps, not ''.
			const depsObj = await bucket.get(nb.deps);
			expect(await depsObj!.text()).toBe(originalDeps);

			// The new version snapshot must record the preserved deps too.
			const versions = await notebooks.listVersions(projectId, created.id);
			const latest = versions.find((v) => v.message === 'code-only')!;
			const verDepsObj = await bucket.get(nb.version(latest.version_id).deps);
			expect(await verDepsObj!.text()).toBe(originalDeps);
		});

		it('overwrites deps when code is updated with new deps', async () => {
			const originalDeps = '[project]\ndependencies = ["pandas"]';
			const newDeps = '[project]\ndependencies = ["numpy"]';
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1', deps: originalDeps },
				ACTOR,
			);

			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ code: 'v2', deps: newDeps, message: 'with-deps' },
				ACTOR,
			);

			const nb = paths.project(projectId).notebook(created.id);

			const depsObj = await bucket.get(nb.deps);
			expect(await depsObj!.text()).toBe(newDeps);

			const versions = await notebooks.listVersions(projectId, created.id);
			const latest = versions.find((v) => v.message === 'with-deps')!;
			const verDepsObj = await bucket.get(nb.version(latest.version_id).deps);
			expect(await verDepsObj!.text()).toBe(newDeps);
		});

		it('leaves code and deps untouched on a metadata-only update', async () => {
			const originalDeps = '[project]\ndependencies = ["pandas"]';
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Old', description: 'D', code: 'v1', deps: originalDeps },
				ACTOR,
			);

			const nb = paths.project(projectId).notebook(created.id);

			await notebooks.updateNotebook(projectId, created.id, { title: 'New Title' }, ACTOR);

			const codeObj = await bucket.get(nb.code);
			expect(await codeObj!.text()).toBe('v1');
			const depsObj = await bucket.get(nb.deps);
			expect(await depsObj!.text()).toBe(originalDeps);

			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(1);
		});

		it('prunes old versions beyond MAX_VERSIONS while keeping the current one', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v0' },
				ACTOR,
			);

			// Record the first few version ids so we can prove the OLDEST were deleted.
			const initialVersions = await notebooks.listVersions(projectId, created.id);
			const oldestVid = initialVersions[0].version_id;

			// Save MAX_VERSIONS + 5 more times (well over the cap).
			const extraSaves = MAX_VERSIONS + 5;
			let currentVid = oldestVid;
			const originalList = bucket.list.bind(bucket);
			bucket.list = (options) => originalList({ ...options, limit: 2 });
			try {
				for (let i = 1; i <= extraSaves; i++) {
					await notebooks.updateNotebook(
						projectId,
						created.id,
						{ code: `v${i}`, message: `save ${i}` },
						ACTOR,
					);
					const source = await (await bucket.get(
						paths.project(projectId).notebook(created.id).source,
					))!.json<{ current_version_id: string }>();
					currentVid = source.current_version_id as typeof currentVid;
				}
			} finally {
				bucket.list = originalList;
			}

			// The right things were deleted: version-folder count is bounded.
			const folderCount = await countVersionFolders(bucket, projectId, created.id);
			expect(folderCount).toBeLessThanOrEqual(MAX_VERSIONS);
			// We saved far more than MAX_VERSIONS, so pruning must have actually run.
			expect(folderCount).toBeGreaterThan(0);
			expect(1 + extraSaves).toBeGreaterThan(MAX_VERSIONS);

			// The oldest version's files were deleted.
			const oldestPrefix = `${paths.project(projectId).notebook(created.id).base}/versions/${oldestVid}/`;
			expect(await listAllKeys(bucket, oldestPrefix)).toEqual([]);

			// Live data survived: the CURRENT version still resolves via getVersion
			// and its code matches the latest save.
			const { version, code } = await notebooks.getVersion(projectId, created.id, currentVid);
			expect(version.version_id).toBe(currentVid);
			expect(code).toBe(`v${extraSaves}`);
			// And the live notebook content is the latest code.
			expect(await notebooks.getNotebookContent(projectId, created.id)).toBe(`v${extraSaves}`);
		});

		it('does not fail the save when pruning errors (best-effort)', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v0' },
				ACTOR,
			);

			// Make pruning fail: `pruneVersions` lists the versions folder first, so
			// throwing from `list` reliably exercises the swallow-and-continue path
			// regardless of how many versions exist. `updateNotebook`'s own writes use
			// `put`/`get`, not `list`, so the save itself is unaffected. The save must
			// still succeed despite the prune failure.
			const originalList = bucket.list.bind(bucket);
			bucket.list = async () => {
				throw new Error('simulated prune list failure');
			};
			try {
				const updated = await notebooks.updateNotebook(
					projectId,
					created.id,
					{ code: 'v1', message: 'survives prune failure' },
					ACTOR,
				);
				expect(updated).toBeDefined();
			} finally {
				bucket.list = originalList;
			}

			// The save committed: latest content and a new version both present.
			expect(await notebooks.getNotebookContent(projectId, created.id)).toBe('v1');
			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(2);
		});
	});

	describe('restoreVersion', () => {
		it('rejects a non-local (git) notebook with ConflictError', async () => {
			const { meta } = await notebooks.synced.create(
				projectId,
				{
					title: 'Git NB',
					description: 'from repo',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);

			await expect(
				notebooks.restoreVersion(projectId, meta.id, createVersionId(), ACTOR),
			).rejects.toThrow(ConflictError);
		});

		it('throws NotFoundError when the version folder does not exist', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			await expect(
				notebooks.restoreVersion(projectId, created.id, createVersionId(), ACTOR),
			).rejects.toThrow(NotFoundError);
		});

		it('cuts a new version carrying the restored code, leaving history intact', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const original = (await notebooks.listVersions(projectId, created.id))[0];

			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ code: 'v2', message: 'second' },
				ACTOR,
			);

			// Restore the ORIGINAL version: a restore is another save, so it cuts a NEW
			// version carrying v1 rather than rewinding history.
			await notebooks.restoreVersion(projectId, created.id, original.version_id, ACTOR);

			expect(await notebooks.getNotebookContent(projectId, created.id)).toBe('v1');
			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(3);
			// The original version is still present — history was preserved.
			expect(versions.map((v) => v.version_id)).toContain(original.version_id);
			// The restore version chains onto the most recent (v2) version.
			const restore = versions.find((v) => v.message === `Restore version ${original.version_id}`);
			expect(restore).toBeDefined();
			expect(restore!.version_id).not.toBe(original.version_id);
		});
	});

	describe('deleteNotebook', () => {
		it('projects its tombstone when hard deletion wins before the catalog write', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Doomed', description: 'D', code: 'v1' },
				ACTOR,
			);
			const realUpdateEntry = catalog.updateNotebookEntry.bind(catalog);
			let purged = false;
			vi.spyOn(catalog, 'updateNotebookEntry').mockImplementation(async (...args) => {
				if (!purged && args[0] === 'notebook.delete') {
					purged = true;
					await notebooks.hardDeleteNotebook(projectId, created.id);
				}
				return realUpdateEntry(...args);
			});

			await notebooks.deleteNotebook(projectId, created.id, ACTOR);

			const snapshot = await catalog.getCurrentSnapshot();
			const project = snapshot.projects.find((entry) => entry.id === projectId)!;
			expect(purged).toBe(true);
			expect(project.notebooks[0].status).toBe('deleted');
			expect(project.notebook_count).toBe(0);
		});

		it('rejects a stale expectedVersion with PreconditionFailedError', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			await expect(
				notebooks.deleteNotebook(projectId, created.id, ACTOR, '2000-01-01T00:00:00.000Z'),
			).rejects.toThrow(PreconditionFailedError);

			// The stale precondition must abort the delete: the notebook is still active.
			const snap = await catalog.getCurrentSnapshot();
			const proj = snap.projects.find((p) => p.id === projectId)!;
			expect(proj.notebooks[0].status).toBe('active');
		});

		it('soft-deletes — sets status to deleted in snapshot and meta', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			await notebooks.deleteNotebook(projectId, created.id, ACTOR);

			const metaObj = await bucket.get(paths.project(projectId).notebook(created.id).meta);
			const meta = await metaObj!.json<any>();
			expect(meta.status).toBe('deleted');

			const snap = await catalog.getCurrentSnapshot();
			const proj = snap.projects.find((p) => p.id === projectId)!;
			expect(proj.notebooks[0].status).toBe('deleted');
			expect(proj.notebook_count).toBe(0);
		});

		it('listNotebooks filters out deleted notebooks', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			await notebooks.deleteNotebook(projectId, created.id, ACTOR);

			const list = await notebooks.listNotebooks(projectId);
			expect(list).toHaveLength(0);
		});

		it('is idempotent — double-delete does not decrement notebook_count twice', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			const snapBefore = await catalog.getCurrentSnapshot();
			expect(snapBefore.projects.find((p) => p.id === projectId)!.notebook_count).toBe(1);

			await notebooks.deleteNotebook(projectId, created.id, ACTOR);

			// Second delete (e.g. retry / double-click) — must not throw and must not
			// decrement the count again.
			await expect(notebooks.deleteNotebook(projectId, created.id, ACTOR)).resolves.not.toThrow();

			const snapAfter = await catalog.getCurrentSnapshot();
			const proj = snapAfter.projects.find((p) => p.id === projectId)!;
			expect(proj.notebooks[0].status).toBe('deleted');
			// Count should be exactly 0, not negative
			expect(proj.notebook_count).toBe(0);
		});
	});

	describe('listVersions / getVersion', () => {
		it('returns versions across every listing page', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			for (let version = 2; version <= 4; version++) {
				await notebooks.updateNotebook(projectId, created.id, { code: `v${version}` }, ACTOR);
			}
			const originalList = bucket.list.bind(bucket);
			bucket.list = (options) => originalList({ ...options, limit: 2 });

			expect(await notebooks.listVersions(projectId, created.id)).toHaveLength(4);
		});

		it('returns all versions in order of creation', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ code: 'v2', message: 'second' },
				ACTOR,
			);
			await notebooks.updateNotebook(
				projectId,
				created.id,
				{ code: 'v3', message: 'third' },
				ACTOR,
			);

			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(3);
		});

		it('skips a corrupt version record and logs without its bytes', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			await notebooks.updateNotebook(projectId, created.id, { code: 'v2' }, ACTOR);
			const versions = await notebooks.listVersions(projectId, created.id);
			const key = paths
				.project(projectId)
				.notebook(created.id)
				.version(versions[0].version_id).meta;
			await bucket.put(key, '{"secret":"do-not-log"');
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});

			try {
				expect(await notebooks.listVersions(projectId, created.id)).toHaveLength(1);
				const line = log.mock.calls[0]?.[0] as string;
				expect(line).toContain('notebook.version_list');
				expect(line).not.toContain('do-not-log');
			} finally {
				log.mockRestore();
			}
		});

		it('getVersion returns specific version code', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			const versions = await notebooks.listVersions(projectId, created.id);
			const { version, code } = await notebooks.getVersion(
				projectId,
				created.id,
				versions[0].version_id,
			);

			expect(version.message).toBe('Initial version');
			expect(code).toBe('v1');
		});

		it('getVersion maps a malformed version id to a domain error, not a raw 500', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'c' },
				ACTOR,
			);

			// A malformed version id is a client mistake: it must surface as a 4xx domain
			// error (400/404), never a raw parse Error that the API renders as a 500.
			await expect(
				notebooks.getVersion(projectId, created.id, 'not-a-valid-version-id'),
			).rejects.toBeInstanceOf(DomainError);
		});

		it('getVersion throws NotFoundError for missing version', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'c' },
				ACTOR,
			);

			await expect(notebooks.getVersion(projectId, created.id, createVersionId())).rejects.toThrow(
				NotFoundError,
			);
		});
	});

	describe('getLatestHtmlSnapshot', () => {
		it('returns null when no version has an HTML snapshot', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			expect(await notebooks.getLatestHtmlSnapshot(projectId, created.id)).toBeNull();
		});

		it('returns the newest snapshot, skipping newer versions that lack one', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const withHtml = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html: '<html>v2 outputs</html>' },
				ACTOR,
			);
			// A newer version without a snapshot (e.g. a manual save) must not hide it.
			await notebooks.updateNotebook(projectId, created.id, { code: 'v3', message: 'm' }, ACTOR);

			const snapshot = await notebooks.getLatestHtmlSnapshot(projectId, created.id);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.html).toBe('<html>v2 outputs</html>');
			expect(snapshot!.versionId).toBe(withHtml!.versionId);
			expect(snapshot!.capturedAt).toBeDefined();
		});

		it('prefers the newest of several snapshots', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html: '<html>old</html>' },
				ACTOR,
			);
			await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v3', html: '<html>new</html>' },
				ACTOR,
			);

			const snapshot = await notebooks.getLatestHtmlSnapshot(projectId, created.id);
			expect(snapshot!.html).toBe('<html>new</html>');
		});
	});

	describe('getVersionHtmlSnapshot', () => {
		it('returns the pinned version’s snapshot, not the latest', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const first = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html: '<html>first</html>' },
				ACTOR,
			);
			await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v3', html: '<html>second</html>' },
				ACTOR,
			);

			const snapshot = await notebooks.getVersionHtmlSnapshot(
				projectId,
				created.id,
				first!.versionId,
			);
			expect(snapshot).toEqual({
				versionId: first!.versionId,
				capturedAt: expect.any(String),
				html: '<html>first</html>',
			});
		});

		it('returns null for a version without a snapshot, and when the html object was pruned', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			// The initial save captured no HTML.
			const { source } = await notebooks.getNotebook(projectId, created.id);
			expect(
				await notebooks.getVersionHtmlSnapshot(projectId, created.id, source.current_version_id!),
			).toBeNull();

			// Descriptor present but the html object itself is gone (pruned).
			const committed = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html: '<html>x</html>' },
				ACTOR,
			);
			const ver = paths.project(projectId).notebook(created.id).version(committed!.versionId);
			await bucket.delete(ver.html);
			expect(
				await notebooks.getVersionHtmlSnapshot(projectId, created.id, committed!.versionId),
			).toBeNull();
		});

		it('rejects with NotFoundError for unknown and malformed version ids', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			await expect(
				notebooks.getVersionHtmlSnapshot(projectId, created.id, createVersionId()),
			).rejects.toThrow(NotFoundError);
			await expect(
				notebooks.getVersionHtmlSnapshot(projectId, created.id, 'not-a-version-id'),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('commitSession', () => {
		it('returns null without writing when the notebook is already deleted', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const nb = paths.project(projectId).notebook(created.id);
			await notebooks.deleteNotebook(projectId, created.id, ACTOR);
			const sourceBefore = await (await bucket.get(nb.source))!.text();
			const versionCountBefore = await countVersionFolders(bucket, projectId, created.id);

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'late edit' },
				ACTOR,
			);

			expect(result).toBeNull();
			expect(await (await bucket.get(nb.code))!.text()).toBe('v1');
			expect(await (await bucket.get(nb.source))!.text()).toBe(sourceBefore);
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(versionCountBefore);
		});

		it('cuts a new version from changed code and updates the live notebook + source', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1', deps: '[project]\nname="a"' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2 # edited', deps: '[project]\nname="b"' },
				ACTOR,
			);

			expect(result).not.toBeNull();
			expect(result!.newVersion).toBe(true);

			// Two versions now; live code/source advanced to the new one.
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(2);
			const nb = paths.project(projectId).notebook(created.id);
			expect(await (await bucket.get(nb.code))!.text()).toBe('v2 # edited');
			const after = await notebooks.getNotebook(projectId, created.id);
			expect(after.source.type).toBe('local');
			expect((after.source as { current_version_id: string }).current_version_id).not.toBe(
				(before.source as { current_version_id: string }).current_version_id,
			);
			expect(result!.versionId).toBe(
				(after.source as { current_version_id: string }).current_version_id,
			);

			// The new version records the edit author and chains to the previous one.
			const newVersion = await notebooks.getVersion(projectId, created.id, result!.versionId);
			expect(newVersion.version.message).toBe('Session edits');
			expect(newVersion.version.author).toBe(ACTOR);
		});

		it('does not cut a new version when the read-back content is unchanged', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'd' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v1', deps: 'd' },
				ACTOR,
			);

			expect(result!.newVersion).toBe(false);
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(1);
			const after = await notebooks.getNotebook(projectId, created.id);
			expect((after.source as { current_version_id: string }).current_version_id).toBe(
				(before.source as { current_version_id: string }).current_version_id,
			);
		});

		it('attaches HTML + session snapshots to the new version and records descriptors', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html: '<html>out</html>', session: '{"v":1}' },
				ACTOR,
			);

			const nb = paths.project(projectId).notebook(created.id);
			const ver = nb.version(result!.versionId as any);

			// Sidecar artifacts written with the right content.
			expect(await (await bucket.get(ver.html))!.text()).toBe('<html>out</html>');
			expect(await (await bucket.get(ver.session))!.text()).toBe('{"v":1}');

			// version.json carries presence + size descriptors (no storage path).
			const version = (await (await bucket.get(ver.meta))!.json()) as any;
			expect(version.html_snapshot.size_bytes).toBe(
				new TextEncoder().encode('<html>out</html>').length,
			);
			expect(version.session_snapshot.size_bytes).toBeGreaterThan(0);
			expect(result!.capturedHtml).toBe(true);
			expect(result!.capturedSession).toBe(true);
		});

		it('attaches snapshots to the existing version when code is unchanged', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);
			const currentVid = (before.source as { current_version_id: string }).current_version_id;

			await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v1', html: '<html>rendered</html>' },
				ACTOR,
			);

			// No new version, but the HTML landed in the current version's folder and
			// its version.json was patched with the descriptor.
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(1);
			const ver = paths
				.project(projectId)
				.notebook(created.id)
				.version(currentVid as any);
			expect(await (await bucket.get(ver.html))!.text()).toBe('<html>rendered</html>');
			const version = (await (await bucket.get(ver.meta))!.json()) as any;
			expect(version.html_snapshot).toBeTruthy();
		});

		it('retries the descriptor attach on a losing CAS race instead of dropping the winner', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);
			const currentVid = (before.source as { current_version_id: string }).current_version_id;
			const ver = paths
				.project(projectId)
				.notebook(created.id)
				.version(currentVid as any);

			// Between the CAS read of version.json and its conditional write, a
			// competing teardown attaches a session descriptor. The stale write must
			// lose (ETag mismatch) and retry against the fresh value, so BOTH
			// descriptors survive.
			const competing = { captured_at: new Date().toISOString(), size_bytes: 42 };
			const realGet = bucket.get.bind(bucket);
			let metaGets = 0;
			const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				const obj = await realGet(key);
				if (key === ver.meta && obj && ++metaGets === 2) {
					const current = (await obj.json()) as Record<string, unknown>;
					await bucket.put(ver.meta, JSON.stringify({ ...current, session_snapshot: competing }));
				}
				return obj; // etag captured before the competing put — stale for the CAS
			});

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v1', html: '<html>x</html>' },
				ACTOR,
			);
			spy.mockRestore();

			expect(result!.newVersion).toBe(false);
			// Three reads of version.json: the existence check, the losing CAS
			// attempt, and the retry — proving the conflict was actually exercised.
			expect(metaGets).toBe(3);
			const version = (await (await bucket.get(ver.meta))!.json()) as any;
			expect(version.html_snapshot).toBeTruthy();
			expect(version.session_snapshot).toEqual(competing);
		});

		it('returns null when no code is read back (nothing to commit)', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			const result = await notebooks.commitSession(projectId, created.id, {}, ACTOR);

			expect(result).toBeNull();
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(1);
		});

		it('preserves existing deps when none are read back', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'keep-me' },
				ACTOR,
			);

			await notebooks.commitSession(projectId, created.id, { code: 'v2' }, ACTOR);

			const nb = paths.project(projectId).notebook(created.id);
			expect(await (await bucket.get(nb.deps))!.text()).toBe('keep-me');
		});

		it('cuts a new version on a deps-only change', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'old-deps' },
				ACTOR,
			);

			// Same code, different deps — still a content change → new version.
			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v1', deps: 'new-deps' },
				ACTOR,
			);

			expect(result!.newVersion).toBe(true);
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(2);
			const nb = paths.project(projectId).notebook(created.id);
			expect(await (await bucket.get(nb.deps))!.text()).toBe('new-deps');
		});

		it('compares against the version snapshot, not the live notebook (mounted-bucket case)', async () => {
			// In the mounted case the live notebook.py is updated in place during the
			// session but never versioned. commitSession must detect the change by
			// comparing the read-back code against the CURRENT VERSION's stored code,
			// not against the (already-updated) live file — otherwise the edit is lost.
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const nb = paths.project(projectId).notebook(created.id);

			// Simulate the mount having already overwritten the live code with the edit,
			// while the current version's snapshot still holds the pre-session code.
			await bucket.put(nb.code, 'v2 # edited via mount');

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2 # edited via mount' },
				ACTOR,
			);

			expect(result!.newVersion).toBe(true);
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(2);
		});

		it('treats a missing current-version code file as changed and re-snapshots', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);
			const currentVid = (before.source as { current_version_id: string }).current_version_id;
			const nb = paths.project(projectId).notebook(created.id);

			// Corrupt: drop the current version's snapshot code file.
			await bucket.delete(nb.version(currentVid as any).code);

			const result = await notebooks.commitSession(projectId, created.id, { code: 'v1' }, ACTOR);

			// A missing snapshot is treated as "changed", so the content is re-captured.
			expect(result!.newVersion).toBe(true);
		});

		it('chains parent_id across consecutive session commits', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const initial = (await notebooks.listVersions(projectId, created.id))[0];

			const first = await notebooks.commitSession(projectId, created.id, { code: 'v2' }, ACTOR);
			const second = await notebooks.commitSession(projectId, created.id, { code: 'v3' }, ACTOR);

			const v2 = await notebooks.getVersion(projectId, created.id, first!.versionId);
			const v3 = await notebooks.getVersion(projectId, created.id, second!.versionId);

			expect(v2.version.parent_id).toBe(initial.version_id);
			expect(v3.version.parent_id).toBe(first!.versionId);
		});

		it('records only the html_snapshot descriptor when session is absent', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html: '<html>only</html>' },
				ACTOR,
			);

			const ver = paths
				.project(projectId)
				.notebook(created.id)
				.version(result!.versionId as any);
			const version = (await (await bucket.get(ver.meta))!.json()) as any;
			expect(version.html_snapshot).toBeTruthy();
			expect(version.session_snapshot).toBeUndefined();
			expect(await bucket.get(ver.session)).toBeNull();
			expect(result!.capturedSession).toBe(false);
		});

		it('returns null for a non-local (git) source', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const nb = paths.project(projectId).notebook(created.id);

			// Rewrite the source pointer to a git source — commitSession must no-op.
			await bucket.put(
				nb.source,
				JSON.stringify({
					schema_version: 1,
					type: 'git',
					provider: 'github',
					repo: 'org/repo',
					branch: 'main',
					root_path: '',
					entry_notebook: 'nb.py',
					sync_mode: 'push',
					current_version_id: null,
					commit: 'abc123',
					last_synced_at: '2025-03-05T14:00:00.000Z',
				}),
			);

			const result = await notebooks.commitSession(projectId, created.id, { code: 'v2' }, ACTOR);

			expect(result).toBeNull();
			expect(await countVersionFolders(bucket, projectId, created.id)).toBe(1);
		});

		it('records UTF-8 byte length (not character count) in size_bytes', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);

			const html = '<p>café 🚀</p>'; // multibyte: é = 2 bytes, 🚀 = 4 bytes
			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v2', html },
				ACTOR,
			);

			const ver = paths
				.project(projectId)
				.notebook(created.id)
				.version(result!.versionId as any);
			const version = (await (await bucket.get(ver.meta))!.json()) as any;
			expect(version.html_snapshot.size_bytes).toBe(new TextEncoder().encode(html).length);
			expect(version.html_snapshot.size_bytes).toBeGreaterThan(html.length);
		});

		it('swallows a NotFoundError when version.json is deleted mid-CAS', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);
			const currentVid = (before.source as { current_version_id: string }).current_version_id;
			const ver = paths
				.project(projectId)
				.notebook(created.id)
				.version(currentVid as any);

			// Unchanged code + a fresh html snapshot takes the "attach to existing version"
			// path. The existence check reads version.json (present); then between that
			// read and the CAS re-read (inside mutateObject), a concurrent purge deletes
			// version.json. mutateObject throws NotFoundError, which commitSession must
			// swallow rather than surface.
			const realGet = bucket.get.bind(bucket);
			let metaGets = 0;
			const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				if (key === ver.meta) {
					metaGets++;
					// First read (existence check) returns the object; the CAS re-read sees
					// it deleted.
					if (metaGets >= 2) return null;
				}
				return realGet(key);
			});

			let result: Awaited<ReturnType<typeof notebooks.commitSession>>;
			try {
				result = await notebooks.commitSession(
					projectId,
					created.id,
					{ code: 'v1', html: '<html>x</html>' },
					ACTOR,
				);
			} finally {
				// Restore in finally so a failed assertion/throw can't leak the forced-null
				// get spy into later tests.
				spy.mockRestore();
			}

			expect(result).not.toBeNull();
			expect(result!.newVersion).toBe(false);
			// The whole attach was skipped, so no orphan html sidecar was left behind.
			expect(await bucket.get(ver.html)).toBeNull();
		});

		it('skips the descriptor attach entirely when version.json is missing', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			const before = await notebooks.getNotebook(projectId, created.id);
			const currentVid = (before.source as { current_version_id: string }).current_version_id;
			const ver = paths
				.project(projectId)
				.notebook(created.id)
				.version(currentVid as any);

			// Drop the current version's version.json (keep its code so the session reads
			// as unchanged). With no version.json to record a descriptor against, the
			// attach is skipped — no sidecar html is written that we could never track.
			await bucket.delete(ver.meta);

			const result = await notebooks.commitSession(
				projectId,
				created.id,
				{ code: 'v1', html: '<html>x</html>' },
				ACTOR,
			);

			expect(result).not.toBeNull();
			expect(result!.newVersion).toBe(false);
			// The sidecar html was NOT written because the descriptor could not be recorded.
			expect(await bucket.get(ver.html)).toBeNull();
		});
	});

	describe('hardDeleteNotebook', () => {
		it('refuses to hard-delete a live (non-deleted) notebook and leaves its files intact', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'Live', description: 'D', code: 'code' },
				ACTOR,
			);
			const prefix = `${paths.project(projectId).notebook(created.id).base}/`;
			const before = await listAllKeys(bucket, prefix);
			expect(before.length).toBeGreaterThan(0);

			await expect(notebooks.hardDeleteNotebook(projectId, created.id)).rejects.toThrow(
				/Refusing to hard-delete/,
			);

			// Live data survived: nothing was deleted.
			expect(await listAllKeys(bucket, prefix)).toEqual(before);
		});

		it('hard-deletes a soft-deleted notebook subtree while leaving siblings intact', async () => {
			const doomed = await notebooks.createNotebook(
				projectId,
				{ title: 'Doomed', description: 'D', code: 'v1' },
				ACTOR,
			);
			// Give it an extra version too.
			await notebooks.updateNotebook(projectId, doomed.id, { code: 'v2', message: 'm' }, ACTOR);

			// A sibling notebook in the SAME project that must be untouched.
			const sibling = await notebooks.createNotebook(
				projectId,
				{ title: 'Sibling', description: 'D', code: 's1' },
				ACTOR,
			);

			const doomedPrefix = `${paths.project(projectId).notebook(doomed.id).base}/`;
			const siblingPrefix = `${paths.project(projectId).notebook(sibling.id).base}/`;
			const siblingKeysBefore = await listAllKeys(bucket, siblingPrefix);
			expect(siblingKeysBefore.length).toBeGreaterThan(0);
			expect((await listAllKeys(bucket, doomedPrefix)).length).toBeGreaterThan(0);

			// Soft-delete first (the guard requires status === 'deleted').
			await notebooks.deleteNotebook(projectId, doomed.id, ACTOR);

			await notebooks.hardDeleteNotebook(projectId, doomed.id);

			// The right things were deleted: the doomed notebook's subtree is empty.
			expect(await listAllKeys(bucket, doomedPrefix)).toEqual([]);

			// Live data survived: the sibling notebook is fully intact and resolvable.
			expect(await listAllKeys(bucket, siblingPrefix)).toEqual(siblingKeysBefore);
			expect(await notebooks.getNotebookContent(projectId, sibling.id)).toBe('s1');
		});

		it('removes the app claim when the soft-delete cleanup did not', async () => {
			const doomed = await notebooks.createNotebook(
				projectId,
				{ title: 'Doomed', description: 'D', code: 'v1' },
				ACTOR,
			);
			await notebooks.deleteNotebook(projectId, doomed.id, ACTOR);
			// The claim lives outside the notebook subtree, so one the soft-delete's
			// best-effort cleanup missed would outlive the notebook forever.
			await bucket.put(
				paths.appClaim(projectId, doomed.id),
				JSON.stringify({
					session_id: 'sess-0000000000000001',
					claimed_at: new Date().toISOString(),
				}),
			);

			await notebooks.hardDeleteNotebook(projectId, doomed.id);

			expect(await bucket.get(paths.appClaim(projectId, doomed.id))).toBeNull();
		});
	});

	describe('sweepDeletedNotebooks', () => {
		it('purges only soft-deleted notebooks past the grace period', async () => {
			const doomed = await notebooks.createNotebook(
				projectId,
				{ title: 'Doomed', description: 'D', code: 'v1' },
				ACTOR,
			);
			// A live sibling that must never be swept.
			const sibling = await notebooks.createNotebook(
				projectId,
				{ title: 'Sibling', description: 'D', code: 's1' },
				ACTOR,
			);

			const doomedPrefix = `${paths.project(projectId).notebook(doomed.id).base}/`;
			const siblingPrefix = `${paths.project(projectId).notebook(sibling.id).base}/`;
			const siblingKeysBefore = await listAllKeys(bucket, siblingPrefix);

			await notebooks.deleteNotebook(projectId, doomed.id, ACTOR);

			// Within the grace period nothing is purged.
			expect((await notebooks.sweepDeletedNotebooks()).purged).toBe(0);
			expect((await listAllKeys(bucket, doomedPrefix)).length).toBeGreaterThan(0);

			// Past the grace period (retentionMs 0) the soft-deleted notebook is purged.
			expect((await notebooks.sweepDeletedNotebooks(0)).purged).toBe(1);
			expect(await listAllKeys(bucket, doomedPrefix)).toEqual([]);

			// Its snapshot entry is dropped; the live sibling is untouched.
			const snap = await catalog.getCurrentSnapshot();
			const project = snap.projects.find((p) => p.id === projectId);
			expect(project?.notebooks.map((n) => n.id)).not.toContain(doomed.id);
			expect(project?.notebooks.map((n) => n.id)).toContain(sibling.id);
			expect(await listAllKeys(bucket, siblingPrefix)).toEqual(siblingKeysBefore);
			expect(await notebooks.getNotebookContent(projectId, sibling.id)).toBe('s1');
		});

		it('skips notebooks under a soft-deleted project (the project sweep owns them)', async () => {
			const nb = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'v1' },
				ACTOR,
			);
			await notebooks.deleteNotebook(projectId, nb.id, ACTOR);
			await projects.deleteProject(projectId, ACTOR);

			// The project is soft-deleted, so the notebook sweep leaves it for the
			// project sweep — even with a zero grace period.
			expect((await notebooks.sweepDeletedNotebooks(0)).purged).toBe(0);
			const prefix = `${paths.project(projectId).notebook(nb.id).base}/`;
			expect((await listAllKeys(bucket, prefix)).length).toBeGreaterThan(0);
		});
	});

	describe('filesystem-snapshot pointer', () => {
		it('round-trips the sidecar pointer and returns the previous on overwrite', async () => {
			const nb = await notebooks.createNotebook(
				projectId,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			expect(await notebooks.getFsSnapshot(projectId, nb.id)).toBeNull();

			const first = await notebooks.setFsSnapshot(projectId, nb.id, {
				snapshot_id: 's1',
				captured_at: '2020-01-01T00:00:00.000Z',
			});
			expect(first.previous).toBeNull();
			expect((await notebooks.getFsSnapshot(projectId, nb.id))?.snapshot_id).toBe('s1');

			const second = await notebooks.setFsSnapshot(projectId, nb.id, {
				snapshot_id: 's2',
				captured_at: '2020-01-02T00:00:00.000Z',
			});
			expect(second.previous?.snapshot_id).toBe('s1');
			expect((await notebooks.getFsSnapshot(projectId, nb.id))?.snapshot_id).toBe('s2');

			// Clearing removes the sidecar.
			await notebooks.setFsSnapshot(projectId, nb.id, null);
			expect(await notebooks.getFsSnapshot(projectId, nb.id)).toBeNull();
		});

		it('sweepDeletedNotebooks surfaces orphaned snapshot ids before wiping the subtree', async () => {
			const nb = await notebooks.createNotebook(
				projectId,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			await notebooks.setFsSnapshot(projectId, nb.id, {
				snapshot_id: 'orphan_1',
				captured_at: '2020-01-01T00:00:00.000Z',
			});
			await notebooks.deleteNotebook(projectId, nb.id, ACTOR);

			const result = await notebooks.sweepDeletedNotebooks(0);
			expect(result.purged).toBe(1);
			expect(result.orphanedSnapshots).toEqual([
				{ snapshot_id: 'orphan_1', captured_at: '2020-01-01T00:00:00.000Z' },
			]);
		});
	});
});

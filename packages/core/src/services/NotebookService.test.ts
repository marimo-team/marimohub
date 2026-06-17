import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryBucket } from '../testing';
import { NotFoundError } from '../errors';
import type { NotebookId, ProjectId } from '../ids';
import { paths } from '../paths';
import { ACTOR, setupTestEnv } from '../testing';
import type { CatalogService } from './CatalogService';
import { MAX_VERSIONS, type NotebookService } from './NotebookService';
import type { ProjectService } from './ProjectService';
import { listAllKeys } from './storage';

/** Count distinct `versions/{vid}/` folders present in the bucket for a notebook. */
async function countVersionFolders(
	bucket: MemoryBucket,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<number> {
	const nb = paths.project(projectId).notebook(notebookId);
	const res = await bucket.list({ prefix: `${nb.prefix}versions/`, delimiter: '/' });
	return res.delimitedPrefixes.length;
}

describe('NotebookService', () => {
	let bucket: MemoryBucket;
	let notebooks: NotebookService;
	let projects: ProjectService;
	let catalog: CatalogService;
	let projectId: ProjectId;

	beforeEach(async () => {
		const env = await setupTestEnv();
		bucket = env.bucket as MemoryBucket;
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

			// Verify content files written
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

	describe('updateNotebook', () => {
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

			// Still only one version
			const versions = await notebooks.listVersions(projectId, created.id);
			expect(versions).toHaveLength(1);
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

			// Latest code is v2
			const code = await notebooks.getNotebookContent(projectId, created.id);
			expect(code).toBe('v2');

			// Two versions now
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

			// Code and deps are unchanged.
			const codeObj = await bucket.get(nb.code);
			expect(await codeObj!.text()).toBe('v1');
			const depsObj = await bucket.get(nb.deps);
			expect(await depsObj!.text()).toBe(originalDeps);

			// No new version folder was created.
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
			for (let i = 1; i <= extraSaves; i++) {
				const updated = await notebooks.updateNotebook(
					projectId,
					created.id,
					{ code: `v${i}`, message: `save ${i}` },
					ACTOR,
				);
				// Track the live current version id via the source file.
				const source = await (await bucket.get(
					paths.project(projectId).notebook(created.id).source,
				))!.json<{ current_version_id: string }>();
				currentVid = source.current_version_id as typeof currentVid;
				void updated;
			}

			// The right things were deleted: version-folder count is bounded.
			const folderCount = await countVersionFolders(bucket, projectId, created.id);
			expect(folderCount).toBeLessThanOrEqual(MAX_VERSIONS);
			// We saved far more than MAX_VERSIONS, so pruning must have actually run.
			expect(folderCount).toBeGreaterThan(0);
			expect(1 + extraSaves).toBeGreaterThan(MAX_VERSIONS);

			// The oldest version's files were deleted.
			const oldestPrefix = `${paths.project(projectId).notebook(created.id).prefix}versions/${oldestVid}/`;
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

	describe('deleteNotebook', () => {
		it('soft-deletes — sets status to deleted in snapshot and meta', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'code' },
				ACTOR,
			);

			await notebooks.deleteNotebook(projectId, created.id, ACTOR);

			// Meta file still exists with deleted status
			const metaObj = await bucket.get(paths.project(projectId).notebook(created.id).meta);
			const meta = await metaObj!.json<any>();
			expect(meta.status).toBe('deleted');

			// Snapshot reflects deleted status
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
	});

	describe('listVersions / getVersion', () => {
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

		it('getVersion throws NotFoundError for missing version', async () => {
			const created = await notebooks.createNotebook(
				projectId,
				{ title: 'NB', description: 'D', code: 'c' },
				ACTOR,
			);

			await expect(
				notebooks.getVersion(projectId, created.id, 'ver_01HXY00000000000000000000'),
			).rejects.toThrow(NotFoundError);
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
	});
});

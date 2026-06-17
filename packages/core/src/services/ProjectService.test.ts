import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundError } from '../errors';
import type { ProjectId } from '../ids';
import { ACTOR, setupTestEnv } from '../testing';
import type { MemoryBucket } from '../testing';
import type { CatalogService } from './CatalogService';
import type { NotebookService } from './NotebookService';
import type { ProjectService } from './ProjectService';
import { listAllKeys } from './storage';

describe('ProjectService', () => {
	let bucket: MemoryBucket;
	let projects: ProjectService;
	let notebooks: NotebookService;
	let catalog: CatalogService;

	beforeEach(async () => {
		const env = await setupTestEnv();
		bucket = env.bucket as MemoryBucket;
		projects = env.projects;
		notebooks = env.notebooks;
		catalog = env.catalog;
	});

	describe('createProject', () => {
		it('creates a project and adds it to the snapshot', async () => {
			const project = await projects.createProject(
				{ name: 'ML Pipeline', description: 'ML notebooks' },
				ACTOR,
			);

			expect(project.name).toBe('ML Pipeline');
			expect(project.owner).toBe(ACTOR);
			expect(project.members).toEqual([{ user_id: ACTOR, role: 'admin' }]);

			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects).toHaveLength(1);
			expect(snap.projects[0].name).toBe('ML Pipeline');
			expect(snap.projects[0].notebook_count).toBe(0);
		});

		it('uses provided tags', async () => {
			const project = await projects.createProject(
				{ name: 'P', description: 'D', tags: ['a', 'b'] },
				ACTOR,
			);
			expect(project.tags).toEqual(['a', 'b']);
		});

		it('defaults tags to empty array', async () => {
			const project = await projects.createProject({ name: 'P', description: 'D' }, ACTOR);
			expect(project.tags).toEqual([]);
		});
	});

	describe('getProject', () => {
		it('returns the project by id', async () => {
			const created = await projects.createProject({ name: 'Test', description: 'D' }, ACTOR);
			const fetched = await projects.getProject(created.id);
			expect(fetched.id).toBe(created.id);
			expect(fetched.name).toBe('Test');
		});

		it('throws NotFoundError for missing project', async () => {
			await expect(
				projects.getProject('proj_01HXY00000000000000000000' as ProjectId),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('listProjects', () => {
		it('returns empty list initially', async () => {
			const list = await projects.listProjects();
			expect(list).toEqual([]);
		});

		it('returns all created projects', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.createProject({ name: 'B', description: 'b' }, ACTOR);

			const list = await projects.listProjects();
			expect(list).toHaveLength(2);
			expect(list.map((p) => p.name).sort()).toEqual(['A', 'B']);
		});
	});

	describe('updateProject', () => {
		it('updates name and description', async () => {
			const created = await projects.createProject({ name: 'Old', description: 'old desc' }, ACTOR);

			const updated = await projects.updateProject(
				created.id,
				{ name: 'New', description: 'new desc' },
				ACTOR,
			);

			expect(updated.name).toBe('New');
			expect(updated.description).toBe('new desc');

			// Verify snapshot also updated
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects[0].name).toBe('New');
		});

		it('partially updates — only changes provided fields', async () => {
			const created = await projects.createProject(
				{ name: 'Keep', description: 'Change me', tags: ['keep'] },
				ACTOR,
			);

			const updated = await projects.updateProject(created.id, { description: 'Changed' }, ACTOR);

			expect(updated.name).toBe('Keep');
			expect(updated.description).toBe('Changed');
			expect(updated.tags).toEqual(['keep']);
		});

		it('throws NotFoundError for missing project', async () => {
			await expect(
				projects.updateProject('proj_01HXY00000000000000000000' as ProjectId, { name: 'X' }, ACTOR),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('deleteProject', () => {
		it('removes project from snapshot', async () => {
			const created = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);

			await projects.deleteProject(created.id, ACTOR);

			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects).toHaveLength(0);
		});

		it('throws NotFoundError for missing project', async () => {
			await expect(
				projects.deleteProject('proj_01HXY00000000000000000000' as ProjectId, ACTOR),
			).rejects.toThrow(NotFoundError);
		});

		it('hard-deletes the entire project subtree and removes it from listProjects', async () => {
			// Project to be deleted, with a notebook and an extra version.
			const doomed = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			const nb = await notebooks.createNotebook(
				doomed.id,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'd', readme: '# r' },
				ACTOR,
			);
			await notebooks.updateNotebook(doomed.id, nb.id, { code: 'v2', message: 'm' }, ACTOR);

			// A SURVIVOR project that must be untouched by the delete.
			const survivor = await projects.createProject({ name: 'Survivor', description: 'S' }, ACTOR);
			const survivorNb = await notebooks.createNotebook(
				survivor.id,
				{ title: 'Keep', description: 'D', code: 's1', deps: 'sd' },
				ACTOR,
			);

			const doomedPrefix = `projects/${doomed.id}/`;
			const survivorPrefix = `projects/${survivor.id}/`;

			// Sanity: objects exist under both subtrees before the delete.
			expect((await listAllKeys(bucket, doomedPrefix)).length).toBeGreaterThan(0);
			const survivorKeysBefore = await listAllKeys(bucket, survivorPrefix);
			expect(survivorKeysBefore.length).toBeGreaterThan(0);

			await projects.deleteProject(doomed.id, ACTOR);

			// The right things were deleted: nothing remains under projects/{pid}/.
			expect(await listAllKeys(bucket, doomedPrefix)).toEqual([]);
			expect(await bucket.get(`projects/${doomed.id}/project.json`)).toBeNull();

			// And it is gone from the catalog.
			const list = await projects.listProjects();
			expect(list.map((p) => p.id)).not.toContain(doomed.id);
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects.map((p) => p.id)).not.toContain(doomed.id);

			// Live data survived: the survivor project, its keys, and its notebook
			// content are all intact and untouched.
			expect(await listAllKeys(bucket, survivorPrefix)).toEqual(survivorKeysBefore);
			expect(list.map((p) => p.id)).toContain(survivor.id);
			expect(await notebooks.getNotebookContent(survivor.id, survivorNb.id)).toBe('s1');
		});
	});
});

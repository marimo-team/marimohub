import { describe, it, expect, beforeEach } from 'vitest';
import { ACTOR, MemoryBucket } from './testing';
import type { NotebookId, ProjectId } from './ids';
import { createServices } from './services';

/**
 * Integration tests for the full service stack.
 *
 * These exercise the complete flow: Bucket -> CatalogService -> domain services,
 * verifying that operations compose correctly end-to-end.
 */

describe('Integration: full service stack', () => {
	let bucket: MemoryBucket;
	let services: ReturnType<typeof createServices>;

	beforeEach(async () => {
		bucket = new MemoryBucket();
		services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
	});

	describe('project + notebook lifecycle', () => {
		it('create project -> create notebook -> read -> update -> delete', async () => {
			// Create project
			const project = await services.projects.createProject(
				{ name: 'Data Science', description: 'DS notebooks' },
				ACTOR,
			);
			expect(project.name).toBe('Data Science');

			// Create notebook
			const nb = await services.notebooks.createNotebook(
				project.id,
				{
					title: 'Revenue Analysis',
					description: 'Monthly revenue',
					code: 'import marimo as mo',
					tags: ['finance'],
				},
				ACTOR,
			);
			expect(nb.title).toBe('Revenue Analysis');

			// Read notebook detail
			const detail = await services.notebooks.getNotebook(project.id, nb.id);
			expect(detail.meta.title).toBe('Revenue Analysis');
			expect(detail.source.type).toBe('local');

			// Read notebook code
			const code = await services.notebooks.getNotebookContent(project.id, nb.id);
			expect(code).toBe('import marimo as mo');

			// Update notebook
			const updated = await services.notebooks.updateNotebook(
				project.id,
				nb.id,
				{ code: 'import marimo as mo\napp = mo.App()', message: 'Add app init' },
				ACTOR,
			);
			expect(updated.title).toBe('Revenue Analysis'); // unchanged

			// Verify updated code
			const newCode = await services.notebooks.getNotebookContent(project.id, nb.id);
			expect(newCode).toBe('import marimo as mo\napp = mo.App()');

			// Verify version chain
			const versions = await services.notebooks.listVersions(project.id, nb.id);
			expect(versions).toHaveLength(2);

			// Delete notebook (soft)
			await services.notebooks.deleteNotebook(project.id, nb.id, ACTOR);

			// Notebook no longer appears in listing
			const list = await services.notebooks.listNotebooks(project.id);
			expect(list).toHaveLength(0);

			// But it's still in the snapshot as deleted
			const snap = await services.catalog.getCurrentSnapshot();
			const proj = snap.projects.find((p) => p.id === project.id)!;
			expect(proj.notebooks[0].status).toBe('deleted');
		});
	});

	describe('snapshot chain integrity', () => {
		it('each mutation creates a new snapshot with correct previous_snapshot_id', async () => {
			const snap0 = await services.catalog.getCurrentSnapshot();

			await services.projects.createProject({ name: 'P1', description: 'd' }, ACTOR);
			const snap1 = await services.catalog.getCurrentSnapshot();
			expect(snap1.snapshot_id).not.toBe(snap0.snapshot_id);

			await services.projects.createProject({ name: 'P2', description: 'd' }, ACTOR);
			const snap2 = await services.catalog.getCurrentSnapshot();
			expect(snap2.snapshot_id).not.toBe(snap1.snapshot_id);

			// Verify catalog has correct chain
			const catalogObj = await bucket.get('_system/catalog.json');
			const catalog = await catalogObj!.json<any>();
			expect(catalog.current_snapshot_id).toBe(snap2.snapshot_id);
			expect(catalog.previous_snapshot_id).toBe(snap1.snapshot_id);
		});
	});

	describe('multi-project isolation', () => {
		it('notebooks in different projects are isolated', async () => {
			const p1 = await services.projects.createProject(
				{ name: 'Project A', description: 'a' },
				ACTOR,
			);
			const p2 = await services.projects.createProject(
				{ name: 'Project B', description: 'b' },
				ACTOR,
			);

			await services.notebooks.createNotebook(
				p1.id,
				{ title: 'NB-A', description: 'in A', code: 'a' },
				ACTOR,
			);
			await services.notebooks.createNotebook(
				p2.id,
				{ title: 'NB-B', description: 'in B', code: 'b' },
				ACTOR,
			);

			const listA = await services.notebooks.listNotebooks(p1.id);
			const listB = await services.notebooks.listNotebooks(p2.id);

			expect(listA).toHaveLength(1);
			expect(listA[0].title).toBe('NB-A');
			expect(listB).toHaveLength(1);
			expect(listB[0].title).toBe('NB-B');
		});
	});

	describe('session lifecycle', () => {
		it('create -> run -> terminate', async () => {
			const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const nb = await services.notebooks.createNotebook(
				project.id,
				{ title: 'NB', description: 'd', code: 'c' },
				ACTOR,
			);

			const session = await services.sessions.createSession({
				notebook_id: nb.id,
				project_id: project.id,
				user_id: ACTOR,
			});
			expect(session.status).toBe('starting');

			const running = await services.sessions.setRunning(
				project.id,
				session.session_id,
				'https://sandbox.example',
			);
			expect(running.status).toBe('running');

			const terminated = await services.sessions.terminate(project.id, session.session_id);
			expect(terminated.status).toBe('terminated');

			// Session still appears in listing
			const list = await services.sessions.listSessions(nb.id);
			expect(list).toHaveLength(1);
			expect(list[0].status).toBe('terminated');
		});
	});

	describe('event logging', () => {
		it('events are recorded and retrievable', async () => {
			await services.events.append({
				event: 'project.create',
				actor: ACTOR,
				project_id: 'proj_test',
			});
			await services.events.append({
				event: 'notebook.create',
				actor: ACTOR,
				notebook_id: 'nb_test',
			});

			const today = new Date().toISOString().slice(0, 10);
			const evts = await services.events.getEvents(today);
			expect(evts).toHaveLength(2);
			expect(evts[0].event).toBe('project.create');
			expect(evts[1].event).toBe('notebook.create');
		});
	});

	describe('error handling', () => {
		const cases = [
			{
				name: 'getProject with non-existent id',
				fn: (s: typeof services) =>
					s.projects.getProject('proj_01HXY00000000000000000000' as ProjectId),
				errorName: 'NotFoundError',
			},
			{
				name: 'getNotebook with non-existent project',
				fn: (s: typeof services) =>
					s.notebooks.getNotebook(
						'proj_01HXY00000000000000000000' as ProjectId,
						'nb_01HXY00000000000000000000' as NotebookId,
					),
				errorName: 'NotFoundError',
			},
			{
				name: 'listNotebooks with non-existent project',
				fn: (s: typeof services) =>
					s.notebooks.listNotebooks('proj_01HXY00000000000000000000' as ProjectId),
				errorName: 'NotFoundError',
			},
		];

		it.each(cases)('$name throws $errorName', async ({ fn, errorName }) => {
			await expect(fn(services)).rejects.toThrow(expect.objectContaining({ name: errorName }));
		});
	});
});

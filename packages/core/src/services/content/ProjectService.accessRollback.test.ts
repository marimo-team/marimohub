import { describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv } from '../../testing';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../errors';
import { paths } from '../../paths';
import { CatalogService } from '../catalog/CatalogService';
import { ProjectService } from './ProjectService';

describe('default role mutation rollback', () => {
	it.each([false, true])(
		'clears only the rejected writer after a CAS race (winner pending: %s)',
		async (winnerPending) => {
			const { bucket, projects, catalog } = await setupTestEnv();
			const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
			const otherCatalog = new CatalogService(bucket);
			const other = new ProjectService(bucket, otherCatalog);
			const update = otherCatalog.updateProjectEntry.bind(otherCatalog);
			if (winnerPending) {
				vi.spyOn(otherCatalog, 'updateProjectEntry').mockImplementation((operation, ...args) => {
					if (operation === 'project.update') throw new Error('projection unavailable');
					return update(operation, ...args);
				});
			}
			const put = bucket.put.bind(bucket);
			let raced = false;
			let winnerMarker: string | undefined;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
				if (!raced && key === paths.project(project.id).meta) {
					raced = true;
					const winner = other.updateProject(
						project.id,
						{ default_role: 'app-user' },
						ACTOR,
						project.updated_at,
					);
					if (winnerPending) await expect(winner).rejects.toThrow('projection unavailable');
					else await winner;
					const [entry] = (await catalog.getCurrentSnapshot()).projects;
					expect(entry.access_pending).toHaveLength(winnerPending ? 2 : 1);
					winnerMarker = entry.access_pending?.[1];
				}
				return put(key, ...args);
			});

			await expect(
				projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR, project.updated_at),
			).rejects.toBeInstanceOf(PreconditionFailedError);
			expect(raced).toBe(true);
			const [entry] = (await catalog.getCurrentSnapshot()).projects;
			if (winnerPending) {
				expect(entry.access_pending).toEqual([winnerMarker]);
				expect(entry.access).toBeUndefined();
			} else {
				expect(entry.access_pending).toBeUndefined();
				expect(entry.access?.default_role).toBe('app-user');
			}
			expect((await projects.getProject(project.id)).default_role).toBe('app-user');
		},
	);

	it('clears the marker when all conditional writes lose their CAS', async () => {
		const { bucket, projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation((key, ...args) => {
			if (key === paths.project(project.id).meta) throw new PreconditionFailedError('Lost CAS');
			return put(key, ...args);
		});
		await expect(
			projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR),
		).rejects.toBeInstanceOf(ConflictError);
		const [entry] = (await catalog.getCurrentSnapshot()).projects;
		expect(entry.access_pending).toBeUndefined();
		expect(entry.access?.default_role).toBe('inherit');
	});

	it.each([false, true])(
		'preserves the marker on ambiguous storage failure (committed: %s)',
		async (committed) => {
			const { bucket, projects, catalog } = await setupTestEnv();
			const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
			const put = bucket.put.bind(bucket);
			const error = new NotFoundError('Storage response lost');
			vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
				if (key !== paths.project(project.id).meta) return put(key, ...args);
				if (committed) await put(key, ...args);
				throw error;
			});
			await expect(
				projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR),
			).rejects.toBe(error);
			const [entry] = (await catalog.getCurrentSnapshot()).projects;
			expect(entry.access_pending).toHaveLength(1);
			expect(entry.access).toBeUndefined();
			expect((await projects.getProject(project.id)).default_role).toBe(
				committed ? 'viewer' : project.default_role,
			);
		},
	);

	it('clears its marker without restoring access when metadata disappears before writing', async () => {
		const { bucket, projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
		const update = catalog.updateProjectEntry.bind(catalog);
		vi.spyOn(catalog, 'updateProjectEntry').mockImplementation(async (operation, ...args) => {
			const snapshot = await update(operation, ...args);
			if (operation === 'project.access.pending')
				await bucket.delete(paths.project(project.id).meta);
			return snapshot;
		});
		await expect(
			projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR),
		).rejects.toBeInstanceOf(NotFoundError);
		const [entry] = (await catalog.getCurrentSnapshot()).projects;
		expect(entry.access_pending).toBeUndefined();
		expect(entry.access).toBeUndefined();
	});

	it('preserves the original rejection and pending marker when rollback fails', async () => {
		const { bucket, projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
		const other = new ProjectService(bucket, new CatalogService(bucket));
		const update = catalog.updateProjectEntry.bind(catalog);
		vi.spyOn(catalog, 'updateProjectEntry').mockImplementation(async (operation, ...args) => {
			if (operation === 'project.access.rollback') throw new Error('Rollback unavailable');
			const snapshot = await update(operation, ...args);
			if (operation === 'project.access.pending') {
				await other.updateProject(project.id, { default_role: 'app-user' }, ACTOR);
			}
			return snapshot;
		});
		await expect(
			projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR, project.updated_at),
		).rejects.toBeInstanceOf(PreconditionFailedError);
		const [entry] = (await catalog.getCurrentSnapshot()).projects;
		expect(entry.access_pending).toHaveLength(1);
		expect(entry.access).toBeUndefined();
	});
});

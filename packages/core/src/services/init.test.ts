import { describe, it, expect, vi } from 'vitest';
import { ACTOR, MemoryBucket } from '../testing';
import { paths } from '../paths';
import { UserId } from '../ids';
import { createServices, ensureInitialized } from '.';

describe('ensureInitialized', () => {
	it('creates catalog and default project on empty bucket', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);

		const services = createServices(bucket);
		const projects = await services.projects.listProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0].name).toBe('My Projects');
		expect(projects[0].description).toBe('Default project');
	});

	it('creates catalog.json in bucket', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);

		const catalog = await bucket.head(paths.catalog);
		expect(catalog).not.toBeNull();
	});

	it('is idempotent — no duplicate projects on second call', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);

		const services = createServices(bucket);
		const projects = await services.projects.listProjects();
		expect(projects).toHaveLength(1);
	});

	it('does not create default project if one already exists', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		await services.projects.createProject({ name: 'Existing', description: 'Already here' }, ACTOR);

		await ensureInitialized(bucket, ACTOR);

		const projects = await services.projects.listProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0].name).toBe('Existing');
	});

	it('skips snapshot reads when default project creation is disabled', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);

		const headSpy = vi.spyOn(bucket, 'head');
		const getSpy = vi.spyOn(bucket, 'get');

		await ensureInitialized(bucket, ACTOR, { createDefaultProject: false });

		expect(headSpy).toHaveBeenCalledTimes(1);
		expect(getSpy).not.toHaveBeenCalled();
	});

	it("lets a later authorized user seed an app-only user's empty catalog", async () => {
		const bucket = new MemoryBucket();
		const appUser = UserId.parse('user_app_only');
		const services = createServices(bucket);
		await ensureInitialized(bucket, appUser, { createDefaultProject: false });
		await ensureInitialized(bucket, appUser, { createDefaultProject: false });
		expect(await services.projects.listProjects()).toEqual([]);

		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);
		const projects = await services.projects.listProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0]).toMatchObject({ name: 'My Projects', owner: ACTOR });
	});

	it('does not replace a catalog containing only deleted projects', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);
		const services = createServices(bucket);
		const [project] = await services.projects.listProjects();
		await services.projects.deleteProject(project.id, ACTOR);

		await ensureInitialized(bucket, ACTOR);

		expect(await services.projects.listProjects()).toEqual([]);
		expect((await services.catalog.getCurrentSnapshot()).projects).toHaveLength(1);
	});

	it('resolves bootstrap permission only for an empty catalog and retries a prior denial', async () => {
		const bucket = new MemoryBucket();
		const authorize = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
		await ensureInitialized(bucket, ACTOR, { createDefaultProject: authorize });
		const services = createServices(bucket);
		expect(await services.projects.listProjects()).toEqual([]);
		expect(authorize).toHaveBeenCalledTimes(1);

		authorize.mockResolvedValue(true);
		await ensureInitialized(bucket, ACTOR, { createDefaultProject: authorize });
		expect(await services.projects.listProjects()).toHaveLength(1);
		expect(authorize).toHaveBeenCalledTimes(2);

		await ensureInitialized(bucket, ACTOR, { createDefaultProject: authorize });
		expect(authorize).toHaveBeenCalledTimes(2);
	});

	it('does not seed when bootstrap authorization cannot resolve', async () => {
		const bucket = new MemoryBucket();
		await expect(
			ensureInitialized(bucket, ACTOR, {
				createDefaultProject: async () => {
					throw new Error('Membership lookup failed');
				},
			}),
		).rejects.toThrow('Membership lookup failed');
		expect(await createServices(bucket).projects.listProjects()).toEqual([]);
	});
});

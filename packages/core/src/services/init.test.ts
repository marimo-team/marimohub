import { afterEach, describe, it, expect, vi } from 'vitest';
import { ACTOR, advanceTime, MemoryBucket, RecordingBucket, restoreClock } from '../testing';
import { paths } from '../paths';
import { UserId } from '../ids';
import { createServices, ensureInitialized } from '.';

async function populatedCatalog() {
	const inner = new MemoryBucket();
	await ensureInitialized(inner, ACTOR);
	return new RecordingBucket(inner);
}

describe('ensureInitialized', () => {
	afterEach(restoreClock);
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

	it('skips snapshot reads for an unchanged populated catalog', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);
		const get = vi.spyOn(bucket, 'get');

		await ensureInitialized(bucket, ACTOR);

		expect(get).not.toHaveBeenCalled();
	});

	it('skips catalog HEADs for 30 seconds after finding a populated catalog', async () => {
		advanceTime(0);
		const bucket = await populatedCatalog();

		await ensureInitialized(bucket, ACTOR);
		advanceTime(29_999);
		await ensureInitialized(bucket, ACTOR);

		expect(bucket.calls.head).toEqual([paths.catalog]);
	});

	it('rechecks and refreshes the populated catalog cache when its TTL expires', async () => {
		advanceTime(0);
		const bucket = await populatedCatalog();
		await ensureInitialized(bucket, ACTOR);
		bucket.calls.get.length = 0;

		advanceTime(30_000);
		await ensureInitialized(bucket, ACTOR);
		expect(bucket.calls.head).toEqual([paths.catalog, paths.catalog]);
		expect(bucket.calls.get).toEqual([]);

		advanceTime(29_999);
		await ensureInitialized(bucket, ACTOR);
		expect(bucket.calls.head).toHaveLength(2);
		await ensureInitialized(bucket, ACTOR, { createDefaultProject: false });
		expect(bucket.calls.head).toHaveLength(3);
	});

	it('does not share a populated catalog cache with another bucket', async () => {
		const populated = new MemoryBucket();
		await ensureInitialized(populated, ACTOR);
		await ensureInitialized(populated, ACTOR);
		const empty = new RecordingBucket();

		await ensureInitialized(empty, ACTOR);

		expect(empty.calls.head).toContain(paths.catalog);
		expect(await createServices(empty).projects.listProjects()).toHaveLength(1);
	});

	it('retries a failed HEAD without extending the populated catalog TTL', async () => {
		advanceTime(0);
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);
		const head = vi.spyOn(bucket, 'head').mockRejectedValueOnce(new Error('Storage unavailable'));
		advanceTime(30_000);

		await expect(ensureInitialized(bucket, ACTOR)).rejects.toThrow('Storage unavailable');
		await ensureInitialized(bucket, ACTOR);
		expect(head).toHaveBeenCalledTimes(2);

		await ensureInitialized(bucket, ACTOR);
		expect(head).toHaveBeenCalledTimes(2);
	});

	it('does not cache a catalog whose snapshot could not be read', async () => {
		const bucket = await populatedCatalog();
		vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('Snapshot unavailable'));

		await expect(ensureInitialized(bucket, ACTOR)).rejects.toThrow('Snapshot unavailable');
		await ensureInitialized(bucket, ACTOR);

		expect(bucket.calls.head).toEqual([paths.catalog, paths.catalog]);
		expect(bucket.calls.get).toContain(paths.catalog);
		expect(await createServices(bucket).projects.listProjects()).toHaveLength(1);
	});

	it('invalidates the populated cache when a caller disables seeding after a reset', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);
		await bucket.delete(paths.catalog);

		await ensureInitialized(bucket, ACTOR, { createDefaultProject: false });
		const services = createServices(bucket);
		expect(await services.projects.listProjects()).toEqual([]);

		await ensureInitialized(bucket, ACTOR);
		expect(await services.projects.listProjects()).toHaveLength(1);
	});

	it('never reuses a populated catalog whose backend reports an empty ETag', async () => {
		const inner = new MemoryBucket();
		const bucket = new RecordingBucket(inner);
		const blankEtag = <T extends { etag: string } | null>(result: T): T =>
			result ? { ...result, etag: '' } : result;
		vi.spyOn(bucket, 'head').mockImplementation(async (key) => blankEtag(await inner.head(key)));
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => blankEtag(await inner.get(key)));
		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);
		advanceTime(30_000);
		const get = vi.spyOn(bucket, 'get');

		await ensureInitialized(bucket, ACTOR);

		expect(get).toHaveBeenCalledWith(paths.catalog);
	});

	it('rechecks a changed catalog and initializes again after a storage reset', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);
		await ensureInitialized(bucket, ACTOR);
		const services = createServices(bucket);
		await services.projects.createProject({ name: 'Another project', description: '' }, ACTOR);
		const get = vi.spyOn(bucket, 'get');

		advanceTime(30_000);
		await ensureInitialized(bucket, ACTOR);
		expect(get).toHaveBeenCalledWith(paths.catalog);
		expect(await services.projects.listProjects()).toHaveLength(2);

		await bucket.delete(paths.catalog);
		advanceTime(30_000);
		await ensureInitialized(bucket, ACTOR);
		expect(await services.projects.listProjects()).toHaveLength(1);
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

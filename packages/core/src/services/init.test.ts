import { describe, it, expect } from 'vitest';
import { MemoryBucket } from '../testing';
import { paths } from '../paths';
import { createServices, ensureInitialized } from '.';
import { ACTOR } from '../testing';

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

	it('skips init when catalog already exists (cheap head check)', async () => {
		const bucket = new MemoryBucket();
		await ensureInitialized(bucket, ACTOR);

		// Spy on head to verify it's the only call on subsequent invocations
		const headSpy = vi.spyOn(bucket, 'head');
		const getSpy = vi.spyOn(bucket, 'get');

		await ensureInitialized(bucket, ACTOR);

		expect(headSpy).toHaveBeenCalledTimes(1);
		expect(getSpy).not.toHaveBeenCalled();
	});
});

import { vi } from 'vitest';

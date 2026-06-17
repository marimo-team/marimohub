import { describe, it, expect, beforeEach } from 'vitest';
import { createServices, type ProjectId } from '@marimo-hub/core';
import { ACTOR, type MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

describe('Notebook routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];
	let projectId: ProjectId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const project = await createServices(bucket).projects.createProject(
			{ name: 'Test', description: 'test' },
			ACTOR,
		);
		projectId = project.id;
		request = createTestApi({ bucket }).request;
	});

	const nb = (path: string) => `/projects/${projectId}/notebooks${path}`;

	it('GET /projects/{pid}/notebooks returns empty list', async () => {
		expect(await expectOk(await request('GET', nb('')))).toEqual([]);
	});

	it('POST creates a notebook', async () => {
		const data = await expectOk<any>(
			await request('POST', nb(''), {
				title: 'Revenue',
				description: 'Monthly',
				code: 'import marimo',
			}),
			201,
		);
		expect(data.title).toBe('Revenue');
		expect(data.id).toMatch(/^nb-/);
	});

	it('POST validates body — missing required code', async () => {
		await expectError(await request('POST', nb(''), { title: 'NB', description: 'D' }), 422);
	});

	it('GET /{nid} returns notebook detail', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'c' }),
			201,
		);

		const data = await expectOk<any>(await request('GET', nb(`/${created.id}`)));
		expect(data.meta.title).toBe('NB');
		expect(data.source.type).toBe('local');
	});

	it('GET /{nid}/content returns code', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(42)' }),
			201,
		);

		const data = await expectOk<any>(await request('GET', nb(`/${created.id}/content`)));
		expect(data.code).toBe('print(42)');
	});

	it('PUT /{nid} updates notebook', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'Old', description: 'D', code: 'v1' }),
			201,
		);

		const data = await expectOk<any>(
			await request('PUT', nb(`/${created.id}`), { title: 'New', code: 'v2', message: 'updated' }),
		);
		expect(data.title).toBe('New');
	});

	it('DELETE /{nid} soft-deletes notebook', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'c' }),
			201,
		);

		await expectOk(await request('DELETE', nb(`/${created.id}`)));

		expect(await expectOk(await request('GET', nb('')))).toHaveLength(0);
	});

	it('GET /{nid}/versions lists versions', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);

		await request('PUT', nb(`/${created.id}`), { code: 'v2', message: 'update' });

		expect(await expectOk(await request('GET', nb(`/${created.id}/versions`)))).toHaveLength(2);
	});

	it('GET /{nid}/versions/{vid} returns specific version', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);

		const versions = await expectOk<any>(await request('GET', nb(`/${created.id}/versions`)));

		const data = await expectOk<any>(
			await request('GET', nb(`/${created.id}/versions/${versions[0].version_id}`)),
		);
		expect(data.code).toBe('v1');
		expect(data.version.version_id).toBe(versions[0].version_id);
	});
});

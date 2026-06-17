import { describe, it, expect, beforeEach } from 'vitest';
import { createProjectId } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

describe('Project routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket }).request;
	});

	it('GET /projects returns empty list initially', async () => {
		const res = await request('GET', '/projects');
		expect(await expectOk(res)).toEqual([]);
	});

	it('POST /projects creates a project', async () => {
		const res = await request('POST', '/projects', {
			name: 'ML Pipeline',
			description: 'ML notebooks',
		});
		const data = await expectOk<any>(res, 201);
		expect(data.name).toBe('ML Pipeline');
		expect(data.id).toMatch(/^proj-/);
	});

	it('POST /projects validates body — name required', async () => {
		const res = await request('POST', '/projects', { description: 'no name' });
		await expectError(res, 422);
	});

	it('GET /projects/{pid} returns the project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'P1', description: 'd' }),
			201,
		);

		const data = await expectOk<any>(await request('GET', `/projects/${created.id}`));
		expect(data.name).toBe('P1');
	});

	it('PUT /projects/{pid} updates the project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Old', description: 'd' }),
			201,
		);

		const data = await expectOk<any>(
			await request('PUT', `/projects/${created.id}`, { name: 'New' }),
		);
		expect(data.name).toBe('New');
	});

	it('DELETE /projects/{pid} deletes the project', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Doomed', description: 'd' }),
			201,
		);

		await expectOk(await request('DELETE', `/projects/${created.id}`));

		expect(await expectOk(await request('GET', '/projects'))).toHaveLength(0);
	});

	it('PUT/DELETE return 403 for a non-member', async () => {
		const created = await expectOk<any>(
			await request('POST', '/projects', { name: 'Owned', description: 'd' }),
			201,
		);

		// A different authenticated user who is not a member of the project.
		const stranger = createTestApi({ bucket, userId: 'user_stranger' }).request;

		await expectError(await stranger('PUT', `/projects/${created.id}`, { name: 'Hijacked' }), 403);
		await expectError(await stranger('DELETE', `/projects/${created.id}`), 403);

		// The project is untouched.
		const data = await expectOk<any>(await request('GET', `/projects/${created.id}`));
		expect(data.name).toBe('Owned');
	});

	it('GET /projects/{pid} returns 404 for non-existent project', async () => {
		await expectError(await request('GET', `/projects/${createProjectId()}`), 404);
	});

	it('GET /projects/{pid} returns 422 for invalid id format', async () => {
		await expectError(await request('GET', '/projects/invalid-id'), 422);
	});
});

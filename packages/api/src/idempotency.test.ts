import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApi, expectOk } from './testing';

describe('idempotentCreate replay', () => {
	let request: ReturnType<typeof createTestApi>['request'];
	const payload = { name: 'Alpha', description: 'a' };

	beforeEach(() => {
		({ request } = createTestApi());
	});

	const createProject = (body = payload) =>
		request('POST', '/projects', body, { 'Idempotency-Key': 'shared-key' });

	it('rejects a different body under the same key', async () => {
		const first = await expectOk<{ id: string; name: string }>(await createProject(), 201);
		const second = await createProject({ name: 'Beta', description: 'b' });

		expect(second.status).toBe(422);
		expect(first.name).toBe('Alpha');
	});

	it('replays equivalent JSON regardless of object key order', async () => {
		const first = await expectOk(await createProject(), 201);
		const replay = await expectOk(await createProject({ description: 'a', name: 'Alpha' }), 201);
		expect(replay).toEqual(first);
	});

	it('replays the original response after the created project is deleted', async () => {
		const created = await expectOk<{ id: string }>(await createProject(), 201);
		expect((await request('DELETE', `/projects/${created.id}`)).status).toBe(200);

		const replayed = await expectOk<{ id: string }>(await createProject(), 201);

		// A retry must not recreate a resource deliberately deleted after the first request.
		expect(replayed.id).toBe(created.id);
		expect((await request('GET', `/projects/${replayed.id}`)).status).toBe(404);
	});
});

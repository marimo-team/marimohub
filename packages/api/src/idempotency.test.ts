import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { HonoEnv } from './context';
import { idempotentCreate } from './idempotency';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createTestApi, expectError, expectOk } from './testing';

describe('idempotentCreate replay', () => {
	let request: ReturnType<typeof createTestApi>['request'];
	let api: ReturnType<typeof createTestApi>;
	const payload = { name: 'Alpha', description: 'a' };

	beforeEach(() => {
		api = createTestApi();
		({ request } = api);
	});

	it.each([false, true])(
		'allows handlers to read JSON after fingerprinting (previously parsed: %s)',
		async (previouslyParsed) => {
			const app = new Hono<HonoEnv>();
			app.post('/create', async (c) => {
				c.set('deps', api.deps);
				c.set('user', {
					id: ACTOR,
					email: 'user@example.com',
					credential: { kind: 'development' },
				});
				if (previouslyParsed) await c.req.json();
				const data = await idempotentCreate(c, 'POST /create', () => c.req.json());
				return c.json(data);
			});
			const response = await app.request('/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'body-read' },
				body: JSON.stringify(payload),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(payload);
		},
	);

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

	it('recognizes case-insensitive JSON media types on retries', async () => {
		const first = await expectOk(await createProject(), 201);
		const response = await api.app.request('/api/v1/projects', {
			method: 'POST',
			headers: {
				'Idempotency-Key': 'shared-key',
				'Content-Type': 'Application/JSON; charset=utf-8',
			},
			body: JSON.stringify({ description: 'a', name: 'Alpha' }),
		});
		expect(await expectOk(response, 201)).toEqual(first);
	});

	it('keeps replay keys separate across users', async () => {
		const first = await expectOk<{ id: string }>(await createProject(), 201);
		const otherUser = createTestApi({
			bucket: api.bucket,
			userId: uid('another-user'),
			deps: { policy: { defaultRole: 'editor' } },
		});
		const other = await expectOk<{ id: string }>(
			await otherUser.request('POST', '/projects', payload, { 'Idempotency-Key': 'shared-key' }),
			201,
		);
		expect(other.id).not.toBe(first.id);
	});

	it('rejects fingerprintless project replay records without creating another project', async () => {
		await request('GET', '/projects');
		const before = await api.deps.services.projects.listProjects();
		await api.deps.services.idempotency.record(`${ACTOR}:POST /projects`, 'shared-key', {
			id: 'old-project',
		});
		const error = await expectError(await createProject(), 422, 'VALIDATION_ERROR');
		expect(error.message).toContain('predates request validation');
		expect(await api.deps.services.projects.listProjects()).toEqual(before);
	});

	it('rejects a legacy coarse scope without creating a duplicate in any project', async () => {
		const project = await expectOk<{ id: string }>(
			await request('POST', '/projects', payload),
			201,
		);
		await api.deps.services.idempotency.record(
			`${ACTOR}:POST /projects/{pid}/notebooks`,
			'old-key',
			{ id: 'old-notebook' },
		);
		const error = await expectError(
			await request(
				'POST',
				`/projects/${project.id}/notebooks`,
				{
					title: 'Notebook',
					description: '',
					code: 'import marimo',
				},
				{ 'Idempotency-Key': 'old-key' },
			),
			422,
			'VALIDATION_ERROR',
		);
		expect(error.message).toContain('predates request validation');
		expect(await expectOk(await request('GET', `/projects/${project.id}/notebooks`))).toMatchObject(
			{ items: [] },
		);
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

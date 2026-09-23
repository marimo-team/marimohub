import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	createNotebookId,
	createServices,
	WarmPoolService,
	WarmPoolStore,
	WarmPoolClaimExpiredError,
	paths,
} from '@marimo-hub/core';
import type { SandboxProvider, Session } from '@marimo-hub/core';
import { ACTOR, makeFakeSandbox } from '@marimo-hub/core/testing';
import type { FakeSandboxOptions } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';

async function setup(options: FakeSandboxOptions = {}) {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'Warm', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo as mo' },
		ACTOR,
	);
	const fake = makeFakeSandbox(options);
	const create = vi.fn(() => fake.instance);
	const compute: SandboxProvider = {
		create,
		connectExisting: () => fake.instance,
		proxy: async () => null,
	};
	const warmPool = new WarmPoolService(
		new WarmPoolStore(bucket, 'kubernetes'),
		compute,
		services.sessions,
		{
			enabled: true,
			size: 1,
			profiles: [{ key: 'default', resources: {} }],
			creationTimeoutMs: 300_000,
			minimumRemainingMs: 60_000,
		},
	);
	const api = createTestApi({ bucket, compute, deps: { warmPool } });
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	return { bucket, services, project, notebook, fake, create, compute, warmPool, api, path };
}

afterEach(() => vi.restoreAllMocks());

describe('session warm sandbox assignment', () => {
	it.each(['edit', 'app'])(
		'uses the warm sandbox for %s and keeps reuse ahead of warm allocation',
		async (mode) => {
			const w = await setup();
			await w.warmPool.sweep();
			const member = (await w.warmPool.store.read()).pools[0].members[0];
			const response = await expectOk<Session>(await w.api.request('POST', w.path, { mode }));
			const session = await w.services.sessions.getSession(w.project.id, response.session_id);
			expect(session.sandbox_id).toBe(member.sandbox_id);
			expect(w.create).toHaveBeenCalledTimes(1);
			expect(w.fake.calls.startProcess).toHaveLength(1);
			if (mode === 'app') {
				const record = await (await w.bucket.get(
					paths.appPool(w.project.id, w.notebook.id),
				))!.json<{ members: { sandbox_id: string }[] }>();
				expect(record.members[0].sandbox_id).toBe(member.sandbox_id);
			}
			await w.warmPool.sweep();
			const claim = vi.spyOn(w.warmPool, 'claim');
			const reused = await expectOk<Session & { reused: boolean }>(
				await w.api.request('POST', w.path, { mode }),
			);
			expect(reused.session_id).toBe(session.session_id);
			expect(reused.reused).toBe(true);
			expect(claim).not.toHaveBeenCalled();
		},
	);

	it.each(['edit', 'app'])(
		'falls back to a fresh sandbox after a %s claim is reaped before session publication',
		async (mode) => {
			const w = await setup();
			await w.warmPool.sweep();
			const oldId = (await w.warmPool.store.read()).pools[0].members[0].sandbox_id;
			const cold = makeFakeSandbox();
			vi.spyOn(w.compute, 'create').mockImplementation((id) =>
				id === oldId ? w.fake.instance : cold.instance,
			);
			const claim = w.warmPool.claim.bind(w.warmPool);
			vi.spyOn(w.warmPool, 'claim').mockImplementationOnce(async (request) => {
				const result = await claim(request);
				await w.warmPool.store.mutate((record) => {
					record.pools[0].members[0].operation_until = 0;
				});
				await new WarmPoolService(w.warmPool.store, w.compute, w.services.sessions, {
					...w.warmPool.config,
					enabled: false,
				}).sweep();
				return result;
			});
			const response = await expectOk<Session>(await w.api.request('POST', w.path, { mode }));
			const session = await w.services.sessions.getSession(w.project.id, response.session_id);
			expect(session.sandbox_id).not.toBe(oldId);
			expect(session.status).toBe('running');
			expect(session.sandbox_reclaimed_at).toBeUndefined();
			expect(w.fake.calls.writeFiles).toEqual([]);
			expect(cold.calls.startProcess).toHaveLength(1);
			if (mode === 'app') {
				const pool = await new AppPoolService(w.bucket, w.services.sessions).store.read(
					w.project.id,
					w.notebook.id,
				);
				expect(pool?.members[0].sandbox_id).toBe(session.sandbox_id);
			}
		},
	);

	it('keeps delayed cleanup of an expired claim separate from its cold replacement', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		const oldId = (await w.warmPool.store.read()).pools[0].members[0].sandbox_id;
		const cold = makeFakeSandbox();
		vi.spyOn(w.compute, 'create').mockImplementation((id) =>
			id === oldId ? w.fake.instance : cold.instance,
		);
		vi.spyOn(w.warmPool, 'handoff').mockRejectedValueOnce(new WarmPoolClaimExpiredError());
		vi.spyOn(w.fake.instance, 'destroy').mockRejectedValueOnce(new Error('delete unavailable'));
		const response = await expectOk<Session>(await w.api.request('POST', w.path, { mode: 'edit' }));
		const session = await w.services.sessions.getSession(w.project.id, response.session_id);
		expect(session.sandbox_id).not.toBe(oldId);
		expect((await w.warmPool.store.read()).pools[0].members[0].state).toBe('retiring');
		await w.warmPool.sweep();
		expect(cold.calls.destroy).toBe(0);
		expect(await w.services.sessions.getSession(w.project.id, session.session_id)).toMatchObject({
			status: 'running',
			sandbox_id: session.sandbox_id,
		});
		expect(
			(await w.services.sessions.getSession(w.project.id, session.session_id)).sandbox_reclaimed_at,
		).toBeUndefined();
	});

	it('uses ordinary creation on a pool miss', async () => {
		const w = await setup();
		await expectOk(await w.api.request('POST', w.path, { mode: 'edit' }));
		expect(w.create).toHaveBeenCalledTimes(1);
		expect((await w.warmPool.store.read()).pools).toEqual([]);
	});

	it('falls back to cold creation when only the warm ownership record is unavailable', async () => {
		const w = await setup();
		const get = w.bucket.get.bind(w.bucket);
		vi.spyOn(w.bucket, 'get').mockImplementation((key) => {
			if (key === paths.warmPool('kubernetes')) throw new Error('pool storage unavailable');
			return get(key);
		});
		await expectOk(await w.api.request('POST', w.path, { mode: 'edit' }));
		expect(w.create).toHaveBeenCalledOnce();
		expect(w.fake.calls.startProcess).toHaveLength(1);
	});

	it('reclaims a warm app claim when its reservation cannot be rebound', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		vi.spyOn(AppPoolService.prototype, 'bindWarmSandbox').mockRejectedValue(
			new Error('reservation expired'),
		);
		const response = await w.api.request('POST', w.path, { mode: 'app' });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(w.fake.calls.writeFiles).toEqual([]);
		expect(w.fake.calls.setEnvVars).toEqual([]);
		expect(w.fake.calls.destroy).toBeGreaterThan(0);
		expect((await w.warmPool.store.read()).pools[0].members).toEqual([]);
		const reservation = await new AppPoolService(w.bucket, w.services.sessions).store.read(
			w.project.id,
			w.notebook.id,
		);
		expect(reservation?.members ?? []).toEqual([]);
	});

	it.each(['edit', 'app'])(
		'reclaims the warm sandbox after a failed %s kernel launch',
		async (mode) => {
			const w = await setup({ failWaitForPort: new Error('kernel did not start') });
			await w.warmPool.sweep();
			const response = await w.api.request('POST', w.path, { mode });
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(w.fake.calls.startProcess).toHaveLength(1);
			expect(w.fake.calls.destroy).toBe(1);
			expect((await w.warmPool.store.read()).pools[0].members).toEqual([]);
			const sessions = await w.services.sessions.listSessions(w.notebook.id);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				status: 'failed',
				sandbox_reclaimed_at: expect.any(String),
			});
		},
	);

	it('destroys once when app admission fails after warm provisioning succeeds', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		vi.spyOn(AppPoolService.prototype, 'complete').mockRejectedValue(
			new Error('admission expired'),
		);
		const response = await w.api.request('POST', w.path, { mode: 'app' });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(w.fake.calls.startProcess).toHaveLength(1);
		expect(w.fake.calls.destroy).toBe(1);
		expect((await w.warmPool.store.read()).pools[0].members).toEqual([]);
		const [session] = await w.services.sessions.listSessions(w.notebook.id);
		expect(session.sandbox_reclaimed_at).toEqual(expect.any(String));
	});

	it('enforces the project app limit before claiming warm capacity', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		await w.services.sessions.createSession({
			project_id: w.project.id,
			notebook_id: createNotebookId(),
			user_id: ACTOR,
			mode: 'app',
		});
		const claim = vi.spyOn(w.warmPool, 'claim');
		const api = createTestApi({
			bucket: w.bucket,
			compute: w.compute,
			deps: {
				warmPool: w.warmPool,
				policy: { maxAppsPerProject: 1 },
			},
		});
		const response = await api.request('POST', w.path, { mode: 'app' });
		expect(response.status).toBe(429);
		expect(claim).not.toHaveBeenCalled();
		expect(w.fake.calls.startProcess).toEqual([]);
		expect((await w.warmPool.store.read()).pools[0].members[0].state).toBe('ready');
	});

	it.each(['edit', 'app'])(
		'cleans up after a committed %s session PUT loses its response',
		async (mode) => {
			const w = await setup();
			await w.warmPool.sweep();
			const id = (await w.warmPool.store.read()).pools[0].members[0].sandbox_id;
			const put = w.bucket.put.bind(w.bucket);
			let failed = false;
			vi.spyOn(w.bucket, 'put').mockImplementation(async (key, body, options) => {
				const result = await put(key, body, options);
				if (!failed && key.includes('/sessions/')) {
					failed = true;
					throw new Error('session PUT response lost');
				}
				return result;
			});
			const response = await w.api.request('POST', w.path, { mode });
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(failed).toBe(true);
			expect((await w.services.sessions.listSessions(w.notebook.id))[0].sandbox_id).toBe(id);
			expect(w.fake.calls.writeFiles).toEqual([]);
			expect(w.fake.calls.destroy).toBeGreaterThan(0);
			expect((await w.warmPool.store.read()).pools[0].members).toEqual([]);
		},
	);

	it('retains failed request cleanup so maintenance can retry destruction', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		vi.spyOn(w.warmPool, 'handoff').mockRejectedValue(new Error('handoff expired'));
		const destroy = vi
			.spyOn(w.fake.instance, 'destroy')
			.mockRejectedValue(new Error('provider unavailable'));
		const response = await w.api.request('POST', w.path, { mode: 'edit' });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect((await w.warmPool.store.read()).pools[0].members[0].state).toBe('retiring');
		expect(w.fake.calls.writeFiles).toEqual([]);
		const [failed] = await w.services.sessions.listSessions(w.notebook.id);
		expect(failed.status).toBe('failed');
		expect(failed.sandbox_reclaimed_at).toBeUndefined();
		destroy.mockRestore();
		await w.warmPool.sweep();
		expect(w.fake.calls.destroy).toBe(1);
		expect(await w.services.sessions.getSession(w.project.id, failed.session_id)).toMatchObject({
			status: 'failed',
			sandbox_reclaimed_at: expect.any(String),
		});
		expect((await w.warmPool.store.read()).pools[0].members.map((member) => member.state)).toEqual([
			'ready',
		]);
	});

	it('destroys the claimed sandbox when session publication fails', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		const put = w.bucket.put.bind(w.bucket);
		vi.spyOn(w.bucket, 'put').mockImplementation((key, body, options) => {
			if (key.includes('/sessions/')) throw new Error('session write failed');
			return put(key, body, options);
		});
		const response = await w.api.request('POST', w.path, { mode: 'edit' });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(w.fake.calls.destroy).toBeGreaterThan(0);
		expect((await w.warmPool.store.read()).pools[0].members).toEqual([]);
		expect(w.fake.calls.writeFiles).toEqual([]);
	});

	it('fences a lost handoff before writing notebook data', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		vi.spyOn(w.warmPool, 'handoff').mockRejectedValue(new Error('expired handoff'));
		const response = await w.api.request('POST', w.path, { mode: 'edit' });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(w.fake.calls.writeFiles).toEqual([]);
		expect(w.fake.calls.setEnvVars).toEqual([]);
		expect(w.fake.calls.destroy).toBeGreaterThan(0);
	});
});

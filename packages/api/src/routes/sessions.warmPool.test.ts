import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	createNotebookId,
	createSandboxId,
	createServices,
	WarmPoolService,
	WarmPoolStore,
	WarmPoolClaimExpiredError,
	paths,
} from '@marimo-hub/core';
import type { SandboxProvider, Session } from '@marimo-hub/core';
import { ACTOR, makeFakeSandbox, makeSession } from '@marimo-hub/core/testing';
import type { FakeSandboxOptions } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { isSandboxContextCommand } from '../testing/sandboxContext';

async function setup(options: FakeSandboxOptions = {}, providerLifetimeMs?: number) {
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
		warmPool: providerLifetimeMs === undefined ? undefined : { maxLifetimeMs: providerLifetimeMs },
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
			providerLifetimeMs,
		},
	);
	const api = createTestApi({ bucket, compute, deps: { warmPool } });
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	return { bucket, services, project, notebook, fake, create, compute, warmPool, api, path };
}

async function seedEditorClaim(
	w: Awaited<ReturnType<typeof setup>>,
	overrides: Partial<Session> = {},
) {
	const holder = makeSession({
		project_id: w.project.id,
		notebook_id: w.notebook.id,
		status: 'expired',
		sandbox_id: createSandboxId(),
		...overrides,
	});
	await w.bucket.put(paths.session(w.project.id, holder.session_id), JSON.stringify(holder));
	await w.bucket.put(
		paths.editorClaim(w.project.id, w.notebook.id),
		JSON.stringify({
			session_id: holder.session_id,
			sharing: holder.editor_sandbox_sharing ?? 'shared',
			claimed_at: holder.started_at,
		}),
	);
	return holder;
}

afterEach(() => vi.restoreAllMocks());

describe('session warm sandbox assignment', () => {
	it.each(['warm', 'legacy-warm', 'cold-fallback'] as const)(
		'preserves the provider lifetime boundary after idle and provisioning time: %s',
		async (scenario) => {
			let now = Date.now();
			vi.spyOn(Date, 'now').mockImplementation(() => now);
			const lifetime = 60 * 60_000;
			const w = await setup({}, lifetime);
			await w.warmPool.sweep();
			const original = (await w.warmPool.store.read()).pools[0].members[0];
			expect(original.sandbox_deadline_at).toBe(original.checked_at + lifetime);
			if (scenario === 'legacy-warm') {
				await w.warmPool.store.mutate((record) => {
					delete record.pools[0].members[0].sandbox_deadline_at;
				});
			} else if (scenario === 'cold-fallback') {
				vi.spyOn(w.warmPool, 'handoff').mockRejectedValueOnce(new WarmPoolClaimExpiredError());
			}
			now += 10 * 60_000;
			const start = w.fake.instance.startProcess.bind(w.fake.instance);
			vi.spyOn(w.fake.instance, 'startProcess').mockImplementation(async (...args) => {
				now += 2 * 60_000;
				return start(...args);
			});
			const response = await expectOk<Session>(await w.api.request('POST', w.path));
			const stored = await w.services.sessions.getSession(w.project.id, response.session_id);
			expect(stored.sandbox_deadline_at).toBe(
				new Date(
					scenario === 'cold-fallback' ? now + lifetime : original.checked_at + lifetime,
				).toISOString(),
			);
			if (scenario === 'cold-fallback') expect(stored.sandbox_id).not.toBe(original.sandbox_id);
			else expect(stored.sandbox_id).toBe(original.sandbox_id);
		},
	);

	it.each(
		(['shared', 'exclusive'] as const).flatMap((sharing) =>
			(['expired', 'terminating', 'terminated', 'failed'] as const).flatMap((status) =>
				[false, true].map((warm) => ({ sharing, status, warm })),
			),
		),
	)(
		'rejects a $status $sharing holder before allocation (warm=$warm)',
		async ({ sharing, status, warm }) => {
			const w = await setup();
			if (warm) await w.warmPool.sweep();
			const poolBefore = await w.warmPool.store.read();
			await seedEditorClaim(w, { status, editor_sandbox_sharing: sharing });
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const api = createTestApi({
				bucket: w.bucket,
				compute: w.compute,
				deps: {
					warmPool: warm ? w.warmPool : undefined,
					policy: { editorSandboxSharing: sharing },
					metrics,
				},
			});
			const claim = vi.spyOn(w.warmPool, 'claim');
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			w.create.mockClear();
			await expectError(await api.request('POST', w.path), 409, 'EDIT_SESSION_RETIRING');
			expect(claim).not.toHaveBeenCalled();
			expect(w.create).not.toHaveBeenCalled();
			expect(await w.warmPool.store.read()).toEqual(poolBefore);
			expect(await w.services.sessions.listSessions()).toHaveLength(1);
			expect(metrics.increment).toHaveBeenCalledWith('sessions.editor_claim.lost', 1, {
				phase: 'preflight',
			});
			const provisionEvents = log.mock.calls
				.filter(([line]) => typeof line === 'string' && line.startsWith('{'))
				.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
				.filter((event) => event.event === 'session_provision');
			expect(provisionEvents).toEqual([
				expect.objectContaining({
					project_id: w.project.id,
					notebook_id: w.notebook.id,
					editor_claim_lost: true,
					editor_claim_lost_phase: 'preflight',
					success: false,
				}),
			]);
		},
	);

	it.each(['reclaimed', 'missing-sandbox', 'temporary'] as const)(
		'allows a new editor when the old claim does not block it: %s',
		async (scenario) => {
			const w = await setup();
			const holder = await seedEditorClaim(w, {
				sandbox_id: scenario === 'missing-sandbox' ? undefined : createSandboxId(),
				sandbox_reclaimed_at: scenario === 'reclaimed' ? new Date().toISOString() : undefined,
				editor_sandbox_sharing: 'exclusive',
			});
			const api = createTestApi({
				bucket: w.bucket,
				compute: w.compute,
				deps: {
					policy: { editorSandboxSharing: 'exclusive' },
				},
			});
			const started = await expectOk<Session>(
				await api.request(
					'POST',
					w.path,
					scenario === 'temporary' ? { edit_intent: 'temporary' } : undefined,
				),
			);
			expect(started.session_id).not.toBe(holder.session_id);
			expect(started.status).toBe('running');
			expect(
				(await w.services.sessions.getEditorClaim(w.project.id, w.notebook.id))?.session_id,
			).toBe(scenario === 'temporary' ? holder.session_id : started.session_id);
		},
	);

	it.each([-1, 0, 1])(
		'honors the provider claim deadline before taking warm capacity (%s ms)',
		async (offset) => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);
			const w = await setup();
			await w.warmPool.sweep();
			const holder = await seedEditorClaim(w, {
				sandbox_deadline_at: new Date(now + offset).toISOString(),
			});
			const claim = vi.spyOn(w.warmPool, 'claim');
			const response = await w.api.request('POST', w.path);
			if (offset > 0) {
				await expectError(response, 409, 'EDIT_SESSION_RETIRING');
				expect(claim).not.toHaveBeenCalled();
			} else {
				const started = await expectOk<Session>(response);
				expect(started.status).toBe('running');
				expect(started.session_id).not.toBe(holder.session_id);
				expect(claim).toHaveBeenCalledOnce();
			}
		},
	);

	it('rejects a retiring takeover replacement before taking warm capacity', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		const displaced = await seedEditorClaim(w, { sandbox_reclaimed_at: new Date().toISOString() });
		const replacement = makeSession({
			project_id: w.project.id,
			notebook_id: w.notebook.id,
			user_id: ACTOR,
			status: 'expired',
			sandbox_id: createSandboxId(),
		});
		await w.bucket.put(
			paths.session(w.project.id, replacement.session_id),
			JSON.stringify(replacement),
		);
		await w.services.sessions.reserveTakeover(w.project.id, w.notebook.id, {
			takeoverId: 'retiring-replacement',
			requestedBy: ACTOR,
			expectedHolder: displaced.session_id,
			expectedActivity: 'idle',
		});
		await w.services.sessions.setTakeoverPhase(
			w.project.id,
			w.notebook.id,
			'retiring-replacement',
			'ready',
			replacement.session_id,
		);
		const claim = vi.spyOn(w.warmPool, 'claim');
		w.create.mockClear();
		await expectError(await w.api.request('POST', w.path), 409, 'EDIT_SESSION_RETIRING');
		expect(claim).not.toHaveBeenCalled();
		expect(w.create).not.toHaveBeenCalled();
		expect(
			(await w.services.sessions.getEditorClaim(w.project.id, w.notebook.id))?.transfer
				?.replacement_session_id,
		).toBe(replacement.session_id);
	});

	it.each([false, true])(
		'cleans up a warm claim lost after preflight (destroy fails=%s)',
		async (destroyFails) => {
			const w = await setup();
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const api = createTestApi({
				bucket: w.bucket,
				compute: w.compute,
				deps: { warmPool: w.warmPool, metrics },
			});
			await w.warmPool.sweep();
			const warmId = (await w.warmPool.store.read()).pools[0].members[0].sandbox_id;
			const writes = [...w.fake.calls.writeFiles];
			let holder: Session | undefined;
			const claim = w.warmPool.claim.bind(w.warmPool);
			vi.spyOn(w.warmPool, 'claim').mockImplementationOnce(async (request) => {
				const result = await claim(request);
				holder = await seedEditorClaim(w);
				return result;
			});
			if (destroyFails)
				vi.spyOn(w.fake.instance, 'destroy').mockRejectedValueOnce(
					new Error('provider unavailable'),
				);
			await expectError(await api.request('POST', w.path), 409, 'EDIT_SESSION_RETIRING');
			expect(
				metrics.increment.mock.calls.filter(([name]) => name === 'sessions.editor_claim.lost'),
			).toEqual([['sessions.editor_claim.lost', 1, { phase: 'claim' }]]);
			expect(holder).toBeDefined();
			expect(
				(await w.services.sessions.getEditorClaim(w.project.id, w.notebook.id))?.session_id,
			).toBe(holder!.session_id);
			expect(w.fake.calls.writeFiles).toEqual(writes);
			const rejected = (await w.services.sessions.listSessions()).filter(
				(session) => session.session_id !== holder!.session_id,
			);
			expect(rejected).toHaveLength(1);
			expect(rejected[0].status).toBe('terminated');
			expect(!!rejected[0].sandbox_reclaimed_at).toBe(!destroyFails);
			expect(
				(await w.warmPool.store.read()).pools[0].members
					.filter((member) => member.sandbox_id === warmId)
					.map((member) => member.state),
			).toEqual(destroyFails ? ['retiring'] : []);
			if (destroyFails) {
				await w.warmPool.sweep();
				expect(
					(await w.warmPool.store.read()).pools[0].members.some(
						(member) => member.sandbox_id === warmId,
					),
				).toBe(false);
				expect(
					(await w.services.sessions.getSession(w.project.id, rejected[0].session_id))
						.sandbox_reclaimed_at,
				).toBeDefined();
			}
		},
	);

	it.each(['claim', 'holder'] as const)(
		'does not take warm capacity when the stored %s is corrupt',
		async (record) => {
			const w = await setup();
			await w.warmPool.sweep();
			const holder = await seedEditorClaim(w);
			const before = await w.warmPool.store.read();
			await w.bucket.put(
				record === 'claim'
					? paths.editorClaim(w.project.id, w.notebook.id)
					: paths.session(w.project.id, holder.session_id),
				'{invalid JSON',
			);
			const claim = vi.spyOn(w.warmPool, 'claim');
			w.create.mockClear();
			const response = await w.api.request('POST', w.path);
			expect(response.headers.get('Retry-After')).toBe('2');
			await expectError(response, 503, 'SERVICE_UNAVAILABLE');
			expect(claim).not.toHaveBeenCalled();
			expect(w.create).not.toHaveBeenCalled();
			expect(await w.warmPool.store.read()).toEqual(before);
		},
	);

	it('can replace a dangling claim whose holder record has disappeared', async () => {
		const w = await setup();
		await w.warmPool.sweep();
		const holder = await seedEditorClaim(w);
		await w.bucket.delete(paths.session(w.project.id, holder.session_id));
		const started = await expectOk<Session>(await w.api.request('POST', w.path));
		expect(started.status).toBe('running');
		expect(started.session_id).not.toBe(holder.session_id);
		expect(
			(await w.services.sessions.getEditorClaim(w.project.id, w.notebook.id))?.session_id,
		).toBe(started.session_id);
	});

	it('does not allocate when the holder cannot be read', async () => {
		const w = await setup();
		const started = await expectOk<Session>(await w.api.request('POST', w.path));
		await w.services.sessions.markTerminated(w.project.id, started.session_id);
		vi.spyOn(w.api.deps.services.sessions, 'getSession').mockRejectedValueOnce(
			new Error('storage unavailable'),
		);
		const claim = vi.spyOn(w.warmPool, 'claim');
		w.create.mockClear();
		expect((await w.api.request('POST', w.path)).status).toBe(500);
		expect(claim).not.toHaveBeenCalled();
		expect(w.create).not.toHaveBeenCalled();
	});

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

	it.each(['edit', 'app'])(
		'keeps a warm %s sandbox running if context publication fails',
		async (mode) => {
			const w = await setup();
			await w.warmPool.sweep();
			const exec = w.fake.instance.exec;
			vi.spyOn(w.fake.instance, 'exec').mockImplementation(async (...args) => {
				if (isSandboxContextCommand(args[0])) {
					return {
						success: false,
						stdout: '',
						stderr: 'permission denied',
						error: { code: 'COMMAND_FAILED' },
					};
				}
				return exec(...args);
			});
			await expectOk(await w.api.request('POST', w.path, { mode }));
			expect(w.fake.calls.startProcess).toHaveLength(1);
			expect(w.fake.calls.destroy).toBe(0);
			const [session] = await w.services.sessions.listSessions(w.notebook.id);
			expect((await w.warmPool.store.read()).pools[0].members).toEqual([
				expect.objectContaining({
					state: 'claimed',
					assigned: true,
					sandbox_id: session.sandbox_id,
					destination: expect.objectContaining({ session_id: session.session_id }),
				}),
			]);
			expect(session.status).toBe('running');
			expect(session.sandbox_reclaimed_at).toBeUndefined();
			expect(session.sandbox_url).toBeTruthy();
		},
	);

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

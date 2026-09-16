import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	DEFAULT_APP_POOL_POLICY,
	paths,
	ProxyExposure,
	AppPoolService,
	createSandboxId,
	signProxyToken,
} from '@marimo-hub/core';
import type { NotebookId, ProjectId, SessionId } from '@marimo-hub/core';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeCompute,
	makeFakeSandbox,
	uid,
} from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { authorizeProxyRequest } from '../sandboxProxy';
import { sweepAppPools } from '../appPools';

describe('app pool HTTP integration', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let nid: NotebookId;
	const policy = { ...DEFAULT_APP_POOL_POLICY, maxUsersPerSession: 4, maxSessionsPerVersion: 2 };
	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		pid = (await services.projects.createProject({ name: 'P', description: '' }, ACTOR)).id;
		nid = (
			await services.notebooks.createNotebook(
				pid,
				{ title: 'App', description: '', code: 'original' },
				ACTOR,
			)
		).id;
	});
	afterEach(() => vi.restoreAllMocks());
	const api = (user = 'alice', maxAppsPerProject?: number) =>
		createTestApi({
			bucket,
			userId: uid(user),
			compute: makeFakeCompute(),
			deps: { policy: { defaultRole: 'editor', appPool: policy, maxAppsPerProject } },
		});
	const path = (suffix = '') => `/projects/${pid}/notebooks/${nid}/sessions${suffix}`;
	const start = async (user = 'alice', visitId = 'tab') =>
		expectOk<any>(await api(user).request('POST', path(), { mode: 'app', app_visit_id: visitId }));

	it('packs accounts, scales, and sends only new accounts to a new committed version', async () => {
		const first = await start();
		for (const name of ['bob', 'charlie', 'dan'])
			expect((await start(name)).session_id).toBe(first.session_id);
		const second = await start('eve');
		expect(second.session_id).not.toBe(first.session_id);
		await createServices(bucket).notebooks.commitSession(pid, nid, { code: 'updated' }, ACTOR);
		const latest = await start('frank');
		expect(latest.source_version_id).not.toBe(first.source_version_id);
		expect((await start('alice', 'phone')).session_id).toBe(first.session_id);
		const old = await expectOk<any>(await api().request('GET', path(`/${first.session_id}`)));
		expect(old.app_pool).toMatchObject({ state: 'draining', users: 4, max_users: 4 });
	});

	it('reads a pool once per session listing regardless of its sandbox count', async () => {
		await start();
		for (const user of ['bob', 'charlie', 'dan', 'eve']) await start(user);
		const get = vi.spyOn(bucket, 'get');
		const response = await expectOk<any>(await api().request('GET', `/projects/${pid}/sessions`));
		expect(response.items).toHaveLength(2);
		expect(get.mock.calls.filter(([key]) => key === paths.appPool(pid, nid))).toHaveLength(1);
		expect(response.items.map((item: any) => item.app_pool.users).sort()).toEqual([1, 4]);
	});

	it('returns terminal app status through the heartbeat without renewing presence', async () => {
		const first = await start();
		await api().request('DELETE', path(`/${first.session_id}`));
		const put = vi.spyOn(bucket, 'put');
		const response = await expectOk<any>(
			await api().request('POST', path(`/${first.session_id}/heartbeat`), first.app_assignment),
		);
		expect(response.status).toBe('terminated');
		expect(response.sandbox_url).toBeUndefined();
		expect(put.mock.calls.filter(([key]) => key === paths.appPool(pid, nid))).toHaveLength(0);
	});

	it('replaces the selected sandbox without changing the operator assignment', async () => {
		const assigned = await start('alice');
		await createServices(bucket).notebooks.commitSession(pid, nid, { code: 'version two' }, ACTOR);
		const selected = await start('bob');
		const body = { mode: 'app', replace_app_session_id: selected.session_id };
		const replacement = await expectOk<any>(await api('alice').request('POST', path(), body));
		expect(replacement.session_id).not.toBe(selected.session_id);
		expect(replacement.session_id).not.toBe(assigned.session_id);
		expect(replacement.source_version_id).toBe(selected.source_version_id);
		expect(replacement.app_assignment).toBeUndefined();
		expect(replacement.can.attach).toBe(false);
		expect(replacement.sandbox_url).toBeUndefined();
		expect(replacement.surfaces?.marimo?.url).toBeUndefined();
		expect((await start('alice', 'phone')).session_id).toBe(assigned.session_id);
		expect((await start('carol')).session_id).toBe(replacement.session_id);
		const retry = await expectOk<any>(await api('alice').request('POST', path(), body));
		expect(retry.session_id).toBe(replacement.session_id);
		expect(retry.reused).toBe(true);
		const stopped = await createServices(bucket).sessions.getSession(pid, selected.session_id);
		expect(stopped.sandbox_reclaimed_at).toBeTruthy();
		expect(
			(await createServices(bucket).sessions.getSession(pid, replacement.session_id)).user_id,
		).toBe(uid('alice'));
	});

	it('keeps the selected app running when replacement reservation cannot be persisted', async () => {
		const selected = await start();
		const fake = makeFakeSandbox();
		const client = createTestApi({
			bucket,
			userId: uid('alice'),
			compute: fakeComputeFrom(fake.instance),
			deps: { policy: { defaultRole: 'editor', appPool: { ...policy, maxSessionsPerVersion: 1 } } },
		});
		const body = { mode: 'app', replace_app_session_id: selected.session_id };
		const put = bucket.put.bind(bucket);
		const failure = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (
				key === paths.appPool(pid, nid) &&
				typeof value === 'string' &&
				value.includes('"replaces_session_id"')
			)
				throw new Error('pool storage unavailable');
			return put(key, value, options);
		});
		try {
			expect((await client.request('POST', path(), body)).status).toBe(500);
		} finally {
			failure.mockRestore();
		}
		expect(fake.calls.destroy).toBe(0);
		expect(fake.calls.startProcess).toHaveLength(0);
		expect(await client.deps.services.sessions.getSession(pid, selected.session_id)).toMatchObject({
			status: 'running',
		});
		const replacement = await expectOk<any>(await client.request('POST', path(), body));
		expect(replacement.status).toBe('running');
		expect(replacement.session_id).not.toBe(selected.session_id);
		expect(fake.calls.destroy).toBe(1);
	});

	it('releases the replacement reservation when destruction fails and retries after cleanup', async () => {
		const selected = await start();
		const fake = makeFakeSandbox();
		const destroy = vi
			.spyOn(fake.instance, 'destroy')
			.mockRejectedValue(new Error('provider unavailable'));
		const client = createTestApi({
			bucket,
			userId: uid('alice'),
			compute: fakeComputeFrom(fake.instance),
			deps: { policy: { defaultRole: 'editor', appPool: policy } },
		});
		const body = { mode: 'app', replace_app_session_id: selected.session_id };
		await expectError(await client.request('POST', path(), body), 409, 'CONFLICT');
		expect(fake.calls.startProcess).toHaveLength(0);
		const services = createServices(bucket);
		const stored = await services.sessions.getSession(pid, selected.session_id);
		expect(stored.status).toBe('terminated');
		expect(stored.sandbox_reclaimed_at).toBeUndefined();
		const pool = new AppPoolService(bucket, services.sessions, policy);
		expect((await pool.store.read(pid, nid))?.members).toHaveLength(1);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(1);
		destroy.mockResolvedValue();
		await sweepAppPools(client.deps);
		expect(destroy).toHaveBeenCalledTimes(2);
		expect(
			(await services.sessions.getSession(pid, selected.session_id)).sandbox_reclaimed_at,
		).toBeTruthy();
		const replacement = await expectOk<any>(await client.request('POST', path(), body));
		expect(replacement.session_id).not.toBe(selected.session_id);
		expect(replacement.status).toBe('running');
	});

	it.each(['get', 'put'] as const)(
		'retires the sandbox when pool invalidation fails during %s and reconciles later',
		async (operation) => {
			const selected = await start();
			const fake = makeFakeSandbox();
			const client = createTestApi({
				bucket,
				userId: uid('alice'),
				compute: fakeComputeFrom(fake.instance),
				deps: { policy: { defaultRole: 'editor', appPool: policy } },
			});
			const failPoolAccess = (key: string) => {
				if (key === paths.appPool(pid, nid)) throw new Error('pool storage unavailable');
			};
			const originalGet = bucket.get.bind(bucket);
			const originalPut = bucket.put.bind(bucket);
			const failure =
				operation === 'get'
					? vi.spyOn(bucket, 'get').mockImplementation((key) => {
							failPoolAccess(key);
							return originalGet(key);
						})
					: vi.spyOn(bucket, 'put').mockImplementation((key, ...args) => {
							failPoolAccess(key);
							return originalPut(key, ...args);
						});
			try {
				expect((await client.request('DELETE', path(`/${selected.session_id}`))).status).toBe(500);
				expect(fake.calls.destroy).toBe(1);
				expect(
					await client.deps.services.sessions.getSession(pid, selected.session_id),
				).toMatchObject({
					status: 'terminated',
					sandbox_reclaimed_at: expect.any(String),
				});
			} finally {
				failure.mockRestore();
			}
			const pool = new AppPoolService(bucket, client.deps.services.sessions, policy);
			expect((await pool.store.read(pid, nid))?.members).toMatchObject([
				{ session_id: selected.session_id, state: 'ready' },
			]);
			await sweepAppPools(client.deps);
			expect(await pool.store.read(pid, nid)).toMatchObject({ members: [], assignments: [] });
			expect(fake.calls.destroy).toBe(1);
		},
	);

	it.each([false, true])(
		'releases admission after snapshot lookup fails before session creation (replacement: %s)',
		async (replacement) => {
			const selected = replacement ? await start() : undefined;
			const fake = makeFakeSandbox();
			const compute = {
				...fakeComputeFrom(fake.instance),
				filesystemSnapshotsEnabled: true,
				createFromSnapshot: () => fake.instance,
				captureSnapshot: async () => ({ snapshotId: 'unused' }),
				deleteSnapshot: async () => {},
			};
			const client = createTestApi({
				bucket,
				userId: uid('alice'),
				compute,
				deps: {
					policy: { defaultRole: 'editor', appPool: { ...policy, maxSessionsPerVersion: 1 } },
				},
			});
			const body = {
				mode: 'app',
				...(selected ? { replace_app_session_id: selected.session_id } : { app_visit_id: 'tab' }),
			};
			const pool = new AppPoolService(bucket, client.deps.services.sessions, policy);
			let reservedSessionId: SessionId | undefined;
			const get = bucket.get.bind(bucket);
			const failure = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				if (key === paths.project(pid).notebook(nid).fsSnapshot) {
					reservedSessionId = (await pool.store.read(pid, nid))?.members.find(
						(member) => member.session_id !== selected?.session_id,
					)?.session_id;
					throw new Error('snapshot storage unavailable');
				}
				return get(key);
			});
			try {
				expect((await client.request('POST', path(), body)).status).toBe(500);
			} finally {
				failure.mockRestore();
			}
			const stored = await pool.store.read(pid, nid);
			expect(reservedSessionId).toBeDefined();
			expect(stored!.members.some((member) => member.session_id === reservedSessionId)).toBe(false);
			expect(stored!.assignments).toEqual([]);
			await expect(
				client.deps.services.sessions.getSession(pid, reservedSessionId!),
			).rejects.toThrow('not found');
			expect(fake.calls.startProcess).toHaveLength(0);
			expect(fake.calls.destroy).toBe(replacement ? 1 : 0);
			const retry = await expectOk<any>(await client.request('POST', path(), body));
			expect(retry.status).toBe('running');
			expect(retry.session_id).not.toBe(reservedSessionId);
		},
	);

	it('reclaims a failed replacement startup and permits a subsequent retry', async () => {
		const selected = await start();
		const fake = makeFakeSandbox({ failWaitForPort: new Error('kernel failed to start') });
		const client = createTestApi({
			bucket,
			userId: uid('alice'),
			compute: fakeComputeFrom(fake.instance),
			deps: { policy: { defaultRole: 'editor', appPool: policy } },
		});
		const body = { mode: 'app', replace_app_session_id: selected.session_id };
		await expectError(await client.request('POST', path(), body), 503, 'SERVICE_UNAVAILABLE');
		const services = createServices(bucket);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(0);
		const pool = await new AppPoolService(bucket, services.sessions, policy).store.read(pid, nid);
		const failed = pool!.members.find(
			(member) => member.replaces_session_id === selected.session_id,
		)!;
		expect(failed.state).toBe('retiring');
		expect(fake.calls.destroy).toBeGreaterThan(0);
		const replacement = await expectOk<any>(await api().request('POST', path(), body));
		expect(replacement.status).toBe('running');
		expect(replacement.session_id).not.toBe(failed.session_id);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(1);
	});

	it.each(['edit target', 'another notebook', 'another project'] as const)(
		'rejects replacement of an %s before any teardown',
		async (kind) => {
			const services = createServices(bucket);
			let targetPid = pid;
			let targetNid = nid;
			if (kind === 'another project')
				targetPid = (
					await services.projects.createProject({ name: 'Other', description: '' }, ACTOR)
				).id;
			if (kind !== 'edit target')
				targetNid = (
					await services.notebooks.createNotebook(
						targetPid,
						{ title: 'Other', description: '', code: 'other' },
						ACTOR,
					)
				).id;
			const target = await expectOk<any>(
				await api().request('POST', `/projects/${targetPid}/notebooks/${targetNid}/sessions`, {
					mode: kind === 'edit target' ? 'edit' : 'app',
				}),
			);
			await expectError(
				await api().request('POST', path(), {
					mode: 'app',
					replace_app_session_id: target.session_id,
				}),
				404,
				'NOT_FOUND',
			);
			expect(
				(await services.sessions.getSession(targetPid, target.session_id as SessionId)).status,
			).toBe('running');
		},
	);

	it.each([
		{ mode: 'edit', replace_app_session_id: 'target' },
		{ mode: 'app', app_visit_id: 'tab', replace_app_session_id: 'target' },
	])('rejects incompatible restart options before stopping a sandbox: $mode', async (options) => {
		const selected = await start();
		await expectError(
			await api().request('POST', path(), {
				...options,
				replace_app_session_id: selected.session_id,
			}),
			400,
			'BAD_REQUEST',
		);
		expect(
			(await createServices(bucket).sessions.getSession(pid, selected.session_id)).status,
		).toBe('running');
	});

	it('requires stop permission for replacement before touching the selected sandbox', async () => {
		const selected = await start();
		const viewer = createTestApi({
			bucket,
			userId: uid('viewer'),
			compute: makeFakeCompute(),
			deps: { policy: { defaultRole: 'viewer', viewerMode: 'applications', appPool: policy } },
		});
		await expectError(
			await viewer.request('POST', path(), {
				mode: 'app',
				replace_app_session_id: selected.session_id,
			}),
			403,
			'FORBIDDEN',
		);
		expect(
			(await createServices(bucket).sessions.getSession(pid, selected.session_id)).status,
		).toBe('running');
	});

	it('redacts both direct URLs in GET and list until the account is assigned', async () => {
		const selected = await start();
		expect(selected.surfaces.marimo.url).toBe(selected.sandbox_url);
		const unassigned = api('bob');
		const get = await expectOk<any>(
			await unassigned.request('GET', path(`/${selected.session_id}`)),
		);
		const list = await expectOk<any>(await unassigned.request('GET', `/projects/${pid}/sessions`));
		for (const response of [get, ...list.items]) {
			expect(response.sandbox_url).toBeUndefined();
			expect(response.can.attach).toBe(false);
			expect(response.surfaces.marimo.url).toBeUndefined();
		}
		await start('bob');
		const admitted = await expectOk<any>(
			await unassigned.request('GET', path(`/${selected.session_id}`)),
		);
		expect(admitted.surfaces.marimo.url).toBe(selected.sandbox_url);
		expect(admitted.can.attach).toBe(true);
	});

	it('admits the actual committed head when saves publish in reverse ID order', async () => {
		const notebooks = createServices(bucket).notebooks;
		const sourceKey = paths.project(pid).notebook(nid).source;
		const put = bucket.put.bind(bucket);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let held = false;
		const putSpy = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === sourceKey && !held) {
				held = true;
				entered();
				await gate;
			}
			return put(key, value, options);
		});
		const slow = notebooks.commitSession(pid, nid, { code: 'slow save A' }, ACTOR);
		try {
			await Promise.race([writing, slow]);
			await notebooks.commitSession(pid, nid, { code: 'fast save B' }, ACTOR);
			const first = await start();
			release();
			await slow;
			const head = (await notebooks.getNotebook(pid, nid)).source.current_version_id!;
			expect(head < first.source_version_id).toBe(true);
			const next = await start('bob');
			expect(next.source_version_id).toBe(head);
			expect((await start('alice')).session_id).toBe(first.session_id);
		} finally {
			release();
			putSpy.mockRestore();
			await slow.catch(() => {});
		}
	});

	it('retains project compute caps during rollover and returns a retry header', async () => {
		const first = await start();
		await createServices(bucket).notebooks.commitSession(pid, nid, { code: 'updated' }, ACTOR);
		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await api('bob', 1).request('POST', path(), { mode: 'app' });
			expect(response.headers.get('Retry-After')).toBe('5');
			await expectError(response, 429, 'RESOURCE_EXHAUSTED');
			const pool = await new AppPoolService(bucket, createServices(bucket).sessions).store.read(
				pid,
				nid,
			);
			expect(pool!.members.map((member) => member.session_id)).toEqual([first.session_id]);
			expect(pool!.assignments.map((assignment) => assignment.user_id)).toEqual([uid('alice')]);
		}
		expect((await start()).status).toBe('running');
	});

	it('retains cleanup intent when a session write commits but its acknowledgement fails', async () => {
		const client = api();
		const put = bucket.put.bind(bucket);
		let sessionId: SessionId | undefined;
		const create = vi.spyOn(client.deps.services.sessions, 'createSession');
		const failure = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			const requested = create.mock.calls.at(-1)?.[0];
			if (requested?.session_id && key === paths.session(pid, requested.session_id)) {
				sessionId = requested.session_id;
				await put(key, value, options);
				throw new Error('session write acknowledgement lost');
			}
			return put(key, value, options);
		});
		try {
			expect((await client.request('POST', path(), { mode: 'app' })).status).toBe(500);
		} finally {
			failure.mockRestore();
		}
		expect(sessionId).toBeDefined();
		expect(await client.deps.services.sessions.getSession(pid, sessionId!)).toMatchObject({
			status: 'starting',
		});
		const pool = new AppPoolService(bucket, client.deps.services.sessions);
		expect((await pool.store.read(pid, nid))?.members).toMatchObject([
			{ session_id: sessionId, state: 'retiring' },
		]);
		await sweepAppPools(client.deps);
		expect((await pool.store.read(pid, nid))?.members).toEqual([]);
	});

	it('releases the last visit after grace and fences late heartbeats', async () => {
		const first = await start();
		const phone = await start('alice', 'phone');
		await expectOk(
			await api().request('POST', path(`/${first.session_id}/leave`), first.app_assignment),
		);
		await expectError(
			await api().request('POST', path(`/${first.session_id}/heartbeat`), first.app_assignment),
			409,
			'CONFLICT',
		);
		const current = await expectOk<any>(await api().request('GET', path(`/${first.session_id}`)));
		expect(current.app_pool.users).toBe(1);
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		try {
			await expectOk(
				await api().request('POST', path(`/${first.session_id}/leave`), phone.app_assignment),
			);
			const pool = new AppPoolService(bucket, createServices(bucket).sessions, policy);
			expect((await pool.store.read(pid, nid))?.assignments).toMatchObject([
				{ visits: [], grace_until: now + policy.reconnectGraceMs },
			]);
			expect((await pool.inspect(pid, nid))[0].users).toBe(1);
			clock.mockReturnValue(now + policy.reconnectGraceMs + 1);
			await expectError(
				await api().request('POST', path(`/${first.session_id}/heartbeat`), phone.app_assignment),
				409,
				'CONFLICT',
			);
			expect((await pool.store.read(pid, nid))?.assignments).toEqual([]);
			expect((await pool.inspect(pid, nid))[0].users).toBe(0);
		} finally {
			clock.mockRestore();
		}
	});

	it('requires admission before heartbeat or direct URL discovery', async () => {
		const first = await start();
		await expectError(
			await api('bob').request('POST', path(`/${first.session_id}/heartbeat`)),
			409,
			'CONFLICT',
		);
		const unassigned = await expectOk<any>(
			await api('bob').request('GET', path(`/${first.session_id}`)),
		);
		expect(unassigned.sandbox_url).toBeUndefined();
		expect((await start('bob')).sandbox_url).toBeTruthy();
	});

	it('checks pool assignments in shared proxy authorization', async () => {
		const exposure = new ProxyExposure('test-secret');
		const owner = createTestApi({
			bucket,
			userId: ACTOR,
			compute: makeFakeCompute(),
			deps: {
				sandbox: {
					...api().deps.sandbox,
					hostname: 'test.local',
					persistWorkspace: 'source',
					exposure,
					appBaseUrl: 'https://hub.test',
				},
			},
		});
		const first = await expectOk<any>(
			await owner.request('POST', path(), { mode: 'app', app_visit_id: 'tab' }),
		);
		const other = api('bob');
		other.deps.sandbox = owner.deps.sandbox;
		expect(await authorizeProxyRequest(new Request(first.sandbox_url), other.deps)).toMatchObject({
			kind: 'reject',
			status: 410,
		});
		expect(await authorizeProxyRequest(new Request(first.sandbox_url), owner.deps)).toMatchObject({
			kind: 'forward',
		});
	});

	it('returns service unavailable for failed pool reads in shared proxy authorization', async () => {
		const selected = await start();
		const client = api();
		const secret = 'proxy-secret';
		client.deps.sandbox.exposure = new ProxyExposure(secret);
		const sessions = client.deps.services.sessions;
		await sessions.setRunning(pid, selected.session_id, '/proxy/app/', false, 'http://kernel:2718');
		const token = await signProxyToken(pid, selected.session_id, secret);
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key === paths.appPool(pid, nid)) throw new Error('storage unavailable');
			return get(key);
		});
		expect(
			await authorizeProxyRequest(new Request(`https://hub.test/proxy/${token}/`), client.deps),
		).toMatchObject({ kind: 'reject', status: 503, code: 'SERVICE_UNAVAILABLE' });
	});

	it('keeps a late legacy app reachable until heartbeat adoption completes', async () => {
		await start();
		const client = api('bob');
		const secret = 'proxy-secret';
		client.deps.sandbox.exposure = new ProxyExposure(secret);
		const sessions = client.deps.services.sessions;
		const legacy = await sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: uid('bob'),
			mode: 'app',
			sandbox_id: createSandboxId(),
		});
		await sessions.setRunning(pid, legacy.session_id, '/proxy/app/', false, 'http://kernel:2718');
		const token = await signProxyToken(pid, legacy.session_id, secret);
		const request = new Request(`https://hub.test/proxy/${token}/`);
		const pool = new AppPoolService(bucket, sessions, policy);
		expect(
			(await pool.inspect(pid, nid)).some((member) => member.session_id === legacy.session_id),
		).toBe(false);
		expect(await authorizeProxyRequest(request, client.deps)).toMatchObject({ kind: 'forward' });
		await expectOk(await client.request('POST', path(`/${legacy.session_id}/heartbeat`)));
		expect(
			(await pool.inspect(pid, nid)).find((member) => member.session_id === legacy.session_id),
		).toMatchObject({ state: 'draining' });
		expect(await authorizeProxyRequest(request, client.deps)).toMatchObject({ kind: 'forward' });
		await pool.invalidate(pid, nid, legacy.session_id);
		expect(await authorizeProxyRequest(request, client.deps)).toMatchObject({
			kind: 'reject',
			status: 410,
		});
	});

	it.each([false, true])(
		'does not invalidate a delayed startup reservation (replacement: %s)',
		async (replacement) => {
			const selected = replacement ? await start() : undefined;
			const fake = makeFakeSandbox();
			const client = createTestApi({
				bucket,
				userId: uid('alice'),
				compute: fakeComputeFrom(fake.instance),
				deps: { policy: { defaultRole: 'editor', appPool: policy } },
			});
			const sessions = client.deps.services.sessions;
			const create = sessions.createSession.bind(sessions);
			let release!: () => void;
			let entered!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const creating = new Promise<void>((resolve) => {
				entered = resolve;
			});
			vi.spyOn(sessions, 'createSession').mockImplementation(async (input) => {
				entered();
				await gate;
				return create(input);
			});
			const starting = client.request('POST', path(), {
				mode: 'app',
				...(selected ? { replace_app_session_id: selected.session_id } : {}),
			});
			await creating;
			try {
				await expectError(
					await api('bob').request('POST', path(), { mode: 'app' }),
					409,
					'CONFLICT',
				);
				const pool = await new AppPoolService(bucket, sessions, policy).store.read(pid, nid);
				const member = pool!.members.find((item) => item.state === 'starting')!;
				expect(member.user_id).toBe(uid('alice'));
				expect(pool!.assignments.find((item) => item.user_id === uid('bob'))?.session_id).toBe(
					member.session_id,
				);
				expect(fake.calls.startProcess).toHaveLength(0);
			} finally {
				release();
			}
			const running = await expectOk<any>(await starting);
			const joined = await start('bob');
			expect(joined.session_id).toBe(running.session_id);
			expect(joined.reused).toBe(true);
			expect((await sessions.getSession(pid, running.session_id)).user_id).toBe(uid('alice'));
			expect(sessions.createSession).toHaveBeenCalledTimes(1);
			expect(fake.calls.startProcess).toHaveLength(1);
		},
	);

	it('leaves a concurrent stop in control of sandbox teardown', async () => {
		const selected = await start();
		const fake = makeFakeSandbox();
		const client = createTestApi({
			bucket,
			userId: uid('alice'),
			compute: fakeComputeFrom(fake.instance),
			deps: { policy: { defaultRole: 'editor', appPool: policy } },
		});
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const destroying = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const destroy = vi.spyOn(fake.instance, 'destroy').mockImplementation(async () => {
			entered();
			await gate;
		});
		const stopping = client.request('DELETE', path(`/${selected.session_id}`));
		await destroying;
		try {
			await sweepAppPools(client.deps);
			await sweepAppPools(client.deps);
			expect(destroy).toHaveBeenCalledTimes(1);
			expect(
				(await client.deps.services.sessions.getSession(pid, selected.session_id)).status,
			).toBe('terminating');
		} finally {
			release();
		}
		await expectOk(await stopping);
		await sweepAppPools(client.deps);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(
			await new AppPoolService(bucket, client.deps.services.sessions, policy).inspect(pid, nid),
		).toEqual([]);
	});

	it('removes a reclaimed pool member without redundant session reads or teardown', async () => {
		const selected = await start();
		const client = api();
		await expectOk(await client.request('DELETE', path(`/${selected.session_id}`)));
		const get = vi.spyOn(bucket, 'get');
		const create = vi.spyOn(client.deps.compute, 'create');
		await sweepAppPools(client.deps);
		expect(
			get.mock.calls.filter(([key]) => key === paths.session(pid, selected.session_id)),
		).toHaveLength(2);
		expect(create).not.toHaveBeenCalled();
		expect(
			await new AppPoolService(bucket, client.deps.services.sessions, policy).inspect(pid, nid),
		).toEqual([]);
	});

	it('retries app reclamation after project GC without removing its deletion fence', async () => {
		const fake = makeFakeSandbox();
		const client = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(fake.instance),
		});
		const selected = await expectOk<any>(await client.request('POST', path(), { mode: 'app' }));
		const { projects, sessions } = client.deps.services;
		const pool = new AppPoolService(bucket, sessions, policy);
		await projects.deleteProject(pid, ACTOR);
		await projects.hardDeleteProject(pid);
		expect(await bucket.get(paths.project(pid).meta)).toBeNull();
		expect((await sessions.getSession(pid, selected.session_id)).status).toBe('running');
		const deleted = (await pool.store.read(pid, nid))!;
		expect(deleted.deleted_at).toBeTypeOf('number');
		expect(deleted.assignments).toEqual([]);
		expect(deleted.members).toMatchObject([{ session_id: selected.session_id, state: 'retiring' }]);

		const destroy = vi
			.spyOn(fake.instance, 'destroy')
			.mockRejectedValueOnce(new Error('provider unavailable'));
		await sweepAppPools(client.deps);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(
			(await sessions.getSession(pid, selected.session_id)).sandbox_reclaimed_at,
		).toBeUndefined();
		expect((await pool.store.read(pid, nid))!.members).toHaveLength(1);

		await sweepAppPools(client.deps);
		expect(destroy).toHaveBeenCalledTimes(2);
		expect((await sessions.getSession(pid, selected.session_id)).sandbox_reclaimed_at).toBeTruthy();
		expect(await pool.store.read(pid, nid)).toMatchObject({
			deleted_at: deleted.deleted_at,
			members: [],
			assignments: [],
		});
		await sweepAppPools(client.deps);
		expect(destroy).toHaveBeenCalledTimes(2);
	});

	it('recovers interrupted teardown after generic stale-session expiry', async () => {
		const selected = await start();
		const fake = makeFakeSandbox();
		const client = createTestApi({
			bucket,
			userId: uid('alice'),
			compute: fakeComputeFrom(fake.instance),
		});
		const sessions = client.deps.services.sessions;
		await sessions.beginTerminating(pid, selected.session_id);
		await sweepAppPools(client.deps);
		expect(fake.calls.destroy).toBe(0);
		const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
		try {
			expect(await sessions.expireStale()).toBe(1);
			await sweepAppPools(client.deps);
			expect(fake.calls.destroy).toBe(1);
			expect(
				(await sessions.getSession(pid, selected.session_id)).sandbox_reclaimed_at,
			).toBeTruthy();
		} finally {
			clock.mockRestore();
		}
	});

	it('overlays the committed local source instead of serving uncommitted edits', async () => {
		await bucket.put(paths.project(pid).notebook(nid).code, 'uncommitted');
		const fake = makeFakeSandbox();
		const owner = createTestApi({ bucket, userId: ACTOR, compute: fakeComputeFrom(fake.instance) });
		await expectOk(await owner.request('POST', path(), { mode: 'app' }));
		const writes = fake.calls.writeFile.filter((file) => file.path.endsWith('/notebook.py'));
		expect(new TextDecoder().decode(writes.at(-1)!.content as Uint8Array)).toBe('original');
	});

	it('missing immutable source fails startup and compensates the sandbox', async () => {
		const notebook = await createServices(bucket).notebooks.getNotebook(pid, nid);
		await bucket.delete(
			paths.project(pid).notebook(nid).version(notebook.source.current_version_id!).code,
		);
		const fake = makeFakeSandbox();
		const owner = createTestApi({ bucket, userId: ACTOR, compute: fakeComputeFrom(fake.instance) });
		expect((await owner.request('POST', path(), { mode: 'app' })).status).toBeGreaterThanOrEqual(
			400,
		);
		expect(fake.calls.destroy).toBeGreaterThan(0);
		expect(await createServices(bucket).sessions.countActiveAppsForProject(pid)).toBe(0);
	});

	it('maintenance reclaims an interrupted reservation with no session record', async () => {
		const owner = api();
		const sessions = createServices(bucket).sessions;
		let now = Date.now();
		const pool = new AppPoolService(bucket, sessions, policy, undefined, () => now);
		const notebook = await createServices(bucket).notebooks.getNotebook(pid, nid);
		await pool.admit({
			projectId: pid,
			notebookId: nid,
			userId: ACTOR,
			versionId: notebook.source.current_version_id!,
			startupMs: 1,
		});
		now += 2;
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		try {
			await sweepAppPools(owner.deps);
			expect(await pool.inspect(pid, nid)).toEqual([]);
		} finally {
			clock.mockRestore();
		}
	});
});

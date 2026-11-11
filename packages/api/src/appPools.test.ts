import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	NotFoundError,
	AppPoolStore,
	createPreviewId,
	createNotebookId,
	createProjectId,
	createSandboxId,
	paths,
} from '@marimo-hub/core';
import { createInitializedBucket, makeTestDeps } from './testing';
import { sweepAppPools } from './appPools';
import { makeNotebookMeta, makeSession, makeFakeSandbox } from '@marimo-hub/core/testing';

afterEach(() => vi.restoreAllMocks());

function emptyPool(deleted = false): string {
	return JSON.stringify({
		schema_version: 1,
		members: [],
		assignments: [],
		...(deleted ? { deleted_at: 1 } : {}),
	});
}

describe('sweepAppPools operation budget', () => {
	it.each([true, false])('reads 2k empty retained pools once (deleted: %s)', async (deleted) => {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const pid = createProjectId();
		const keys = Array.from({ length: 2000 }, () => paths.appPool(pid, createNotebookId()));
		for (const key of keys) {
			await bucket.put(key, emptyPool(deleted));
		}
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		const remove = vi.spyOn(bucket, 'delete');
		const sessions = vi.spyOn(deps.services.sessions, 'listActiveByProject');
		const gauge = vi.fn();
		deps.metrics = { gauge, increment: vi.fn() };
		await sweepAppPools(deps);
		expect(get).toHaveBeenCalledTimes(2000);
		expect(get.mock.calls.every(([key]) => key.startsWith(paths.appPoolsPrefix))).toBe(true);
		expect(sessions).toHaveBeenCalledTimes(deleted ? 0 : 1);
		expect(put).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(gauge).toHaveBeenCalledExactlyOnceWith('app_pool.visits', 0);
	});

	it.each(
		(['existing', 'missing', 'failed', 'unsupported'] as const).flatMap((outcome) =>
			(['connectExisting', 'destroyExisting'] as const).map((method) => ({ outcome, method })),
		),
	)('reclaims an orphan through $method only ($outcome)', async ({ outcome, method }) => {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const session = makeSession({ sandbox_id: createSandboxId() });
		const key = paths.appPool(session.project_id, session.notebook_id);
		await bucket.put(
			key,
			JSON.stringify({
				schema_version: 1,
				deleted_at: 1,
				assignments: [],
				members: [
					{
						session_id: session.session_id,
						sandbox_id: session.sandbox_id,
						user_id: session.user_id,
						state: 'retiring',
						created_at: Date.now(),
						operation_token: 'test',
						operation_expires_at: 0,
					},
				],
			}),
		);
		const destroy = vi.fn(async () => {
			if (outcome === 'missing') throw new NotFoundError('Sandbox missing');
			if (outcome === 'failed') throw new Error('temporarily unavailable');
		});
		deps.compute = {
			...deps.compute,
			connectExisting:
				method === 'connectExisting' && outcome !== 'unsupported'
					? () => ({ ...makeFakeSandbox().instance, destroy })
					: undefined,
			destroyExisting:
				method === 'destroyExisting' && outcome !== 'unsupported' ? destroy : undefined,
		};
		const create = vi.spyOn(deps.compute, 'create');
		await sweepAppPools(deps);
		const pool = await new AppPoolStore(bucket).read(session.project_id, session.notebook_id);
		expect(pool?.members).toHaveLength(outcome === 'failed' || outcome === 'unsupported' ? 1 : 0);
		expect(create).not.toHaveBeenCalled();
		expect(destroy).toHaveBeenCalledTimes(outcome === 'unsupported' ? 0 : 1);
	});

	it('skips inert tombstones only while the listed ETag is unchanged', async () => {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const key = paths.appPool(createProjectId(), createNotebookId());
		await bucket.put(key, emptyPool(true));
		await sweepAppPools(deps);
		const get = vi.spyOn(bucket, 'get');
		await sweepAppPools(deps);
		expect(get).not.toHaveBeenCalled();
		await bucket.put(key, emptyPool(true));
		await sweepAppPools(deps);
		expect(get).toHaveBeenCalledExactlyOnceWith(key);
	});

	it.each([false, true])(
		'aggregates visits for active pools (presence expired: %s)',
		async (expired) => {
			const bucket = await createInitializedBucket();
			const deps = makeTestDeps(bucket);
			const pid = createProjectId();
			const now = Date.now();
			for (let i = 0; i < 2; i++) {
				const nid = createNotebookId();
				const session = makeSession({
					project_id: pid,
					notebook_id: nid,
					mode: 'app',
					status: 'running',
					sandbox_id: createSandboxId(),
					app_pool: true,
				});
				await bucket.put(paths.session(pid, session.session_id), JSON.stringify(session));
				await bucket.put(
					paths.appPool(pid, nid),
					JSON.stringify({
						schema_version: 1,
						members: [
							{
								session_id: session.session_id,
								sandbox_id: session.sandbox_id,
								user_id: session.user_id,
								state: 'ready',
								created_at: now,
								operation_token: 'test',
								operation_expires_at: now,
							},
						],
						assignments: [
							{
								session_id: session.session_id,
								user_id: session.user_id,
								visit_id: 'visit',
								generation: 'test',
								visits: [{ visit_id: 'visit', expires_at: now + (expired ? -1 : 60_000) }],
							},
						],
					}),
				);
			}
			const reconcile = vi.spyOn(AppPoolService.prototype, 'reconcile');
			const sessions = vi.spyOn(deps.services.sessions, 'listActiveByProject');
			const gauge = vi.fn();
			deps.metrics = { gauge, increment: vi.fn() };
			await sweepAppPools(deps);
			expect(reconcile).toHaveBeenCalledTimes(expired ? 2 : 0);
			expect(sessions).toHaveBeenCalledTimes(expired ? 0 : 1);
			expect(gauge.mock.calls.filter(([name]) => name === 'app_pool.visits')).toEqual([
				['app_pool.visits', expired ? 0 : 2],
			]);
		},
	);

	it.each([false, true])(
		'cleans assignments from retained tombstones (expired: %s)',
		async (expired) => {
			const bucket = await createInitializedBucket();
			const deps = makeTestDeps(bucket);
			const session = makeSession();
			const pid = session.project_id;
			const nid = session.notebook_id;
			const key = paths.appPool(pid, nid);
			await bucket.put(
				key,
				JSON.stringify({
					schema_version: 1,
					deleted_at: 1,
					members: [],
					assignments: [
						{
							session_id: session.session_id,
							user_id: session.user_id,
							visit_id: 'visit',
							generation: 'test',
							visits: [{ visit_id: 'visit', expires_at: Date.now() + (expired ? -1 : 60_000) }],
						},
					],
				}),
			);
			const remove = vi.spyOn(bucket, 'delete');
			const gauge = vi.fn();
			deps.metrics = { gauge, increment: vi.fn() };

			await sweepAppPools(deps);

			expect(await new AppPoolStore(bucket).read(pid, nid)).toMatchObject({
				deleted_at: 1,
				members: [],
				assignments: [],
			});
			expect(remove).not.toHaveBeenCalled();
			expect(gauge).toHaveBeenCalledExactlyOnceWith('app_pool.visits', 0);
		},
	);

	it.each([
		{ kind: 'normal', idleMinutes: 10, due: false },
		{ kind: 'normal', idleMinutes: 30, due: true },
		{ kind: 'preview', idleMinutes: 4, due: false },
		{ kind: 'preview', idleMinutes: 5, due: true },
		{ kind: 'corrupt preview', idleMinutes: 5, due: true },
	])(
		'applies the $kind idle deadline at $idleMinutes minutes',
		async ({ kind, idleMinutes, due }) => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const bucket = await createInitializedBucket();
			const deps = makeTestDeps(bucket);
			const session = makeSession({
				mode: 'app',
				status: 'running',
				sandbox_id: createSandboxId(),
				app_pool: true,
			});
			const pid = session.project_id;
			const nid = session.notebook_id;
			await bucket.put(paths.session(pid, session.session_id), JSON.stringify(session));
			const notebook = paths.project(pid).notebook(nid);
			const meta = makeNotebookMeta({
				id: nid,
				project_id: pid,
				...(kind === 'normal'
					? {}
					: { preview: { notebook_id: createNotebookId(), preview_id: createPreviewId() } }),
			});
			await bucket.put(
				kind === 'normal' ? notebook.meta : notebook.previewMeta,
				kind === 'corrupt preview' ? '{broken' : JSON.stringify(meta),
			);
			await bucket.put(
				paths.appPool(pid, nid),
				JSON.stringify({
					schema_version: 1,
					members: [
						{
							session_id: session.session_id,
							sandbox_id: session.sandbox_id,
							user_id: session.user_id,
							state: 'ready',
							created_at: now,
							operation_token: 'test',
							operation_expires_at: now,
							idle_since: now - idleMinutes * 60_000,
						},
					],
					assignments: [],
				}),
			);
			const reconcile = vi.spyOn(AppPoolService.prototype, 'reconcile').mockResolvedValue();

			await sweepAppPools(deps);

			expect(reconcile).toHaveBeenCalledTimes(due ? 1 : 0);
		},
	);

	it.each(['read', 'corrupt', 'session scan'] as const)(
		'continues after a pool failure (%s), suppresses incomplete totals, and retries next tick',
		async (failure) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const bucket = await createInitializedBucket();
			const deps = makeTestDeps(bucket);
			const badProject = createProjectId();
			const goodProject = createProjectId();
			const badKeys = Array.from({ length: 2 }, () =>
				paths.appPool(badProject, createNotebookId()),
			);
			const goodKey = paths.appPool(goodProject, createNotebookId());
			const empty = emptyPool();
			for (const key of [...badKeys, goodKey]) await bucket.put(key, empty);
			if (failure === 'corrupt') await bucket.put(badKeys[0], 'invalid-json');
			let failing = true;
			const get = bucket.get.bind(bucket);
			const reads = vi.spyOn(bucket, 'get').mockImplementation((key) => {
				if (failing && failure === 'read' && key === badKeys[0])
					throw new Error('read unavailable');
				return get(key);
			});
			const scan = vi
				.spyOn(deps.services.sessions, 'listActiveByProject')
				.mockImplementation(async (pid) => {
					if (failing && failure === 'session scan' && pid === badProject)
						throw new Error('sessions unavailable');
					return [];
				});
			const gauge = vi.fn();
			deps.metrics = { gauge, increment: vi.fn() };
			const remove = vi.spyOn(bucket, 'delete');
			await expect(sweepAppPools(deps)).resolves.toBeUndefined();
			expect(reads).toHaveBeenCalledWith(goodKey);
			expect(scan.mock.calls.filter(([pid]) => pid === badProject)).toHaveLength(1);
			expect(scan).toHaveBeenCalledWith(goodProject);
			expect(gauge).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			failing = false;
			await bucket.put(badKeys[0], empty);
			scan.mockClear();
			await sweepAppPools(deps);
			expect(scan.mock.calls.filter(([pid]) => pid === badProject)).toHaveLength(1);
			expect(gauge).toHaveBeenCalledExactlyOnceWith('app_pool.visits', 0);
		},
	);

	it('does not publish a partial aggregate when a later listing page fails', async () => {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const pid = createProjectId();
		for (let i = 0; i < 2; i++)
			await bucket.put(paths.appPool(pid, createNotebookId()), emptyPool(true));
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementation((options) => {
			if (options?.cursor) throw new Error('page unavailable');
			return list({ ...options, limit: 1 });
		});
		const gauge = vi.fn();
		deps.metrics = { gauge, increment: vi.fn() };
		await expect(sweepAppPools(deps)).rejects.toThrow('page unavailable');
		expect(gauge).not.toHaveBeenCalled();
	});
	it('bounds pool reads at eight concurrent requests', async () => {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const pid = createProjectId();
		for (let i = 0; i < 24; i++) {
			await bucket.put(paths.appPool(pid, createNotebookId()), emptyPool(true));
		}
		const get = bucket.get.bind(bucket);
		let active = 0;
		let maximum = 0;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			try {
				return await get(key);
			} finally {
				active--;
			}
		});
		await sweepAppPools(deps);
		expect(maximum).toBe(8);
	});
});

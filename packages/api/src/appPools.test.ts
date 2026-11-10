import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	createNotebookId,
	createProjectId,
	createSandboxId,
	paths,
} from '@marimo-hub/core';
import { createInitializedBucket, makeTestDeps } from './testing';
import { sweepAppPools } from './appPools';
import { makeSession } from '@marimo-hub/core/testing';

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

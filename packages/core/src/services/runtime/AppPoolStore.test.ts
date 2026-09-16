import { describe, expect, it, vi } from 'vitest';
import { PreconditionFailedError } from '../../errors';
import { paths } from '../../paths';
import {
	createNotebookId,
	createProjectId,
	createVersionId,
	createSessionId,
	createSandboxId,
	UserId,
} from '../../ids';
import { MemoryBucket } from '../../testing/MemoryBucket';
import type { AppPool } from './AppPoolRouter';
import { AppPoolStore } from './AppPoolStore';

describe('app pool snapshot reads', () => {
	it.each([false, true])(
		'returns a no-op value without writing (existing=%s)',
		async (existing) => {
			const bucket = new MemoryBucket();
			const store = new AppPoolStore(bucket);
			const pid = createProjectId();
			const nid = createNotebookId();
			if (existing)
				await store.mutate(pid, nid, (pool) => ({
					pool: { ...pool, latest_version_id: createVersionId() },
					value: undefined,
				}));
			const before = await store.read(pid, nid);
			const put = vi.spyOn(bucket, 'put');
			const result = await store.mutate(pid, nid, (pool) => ({ pool, value: 'unchanged' }));
			expect(result).toBe('unchanged');
			expect(put).not.toHaveBeenCalled();
			expect(await store.read(pid, nid)).toEqual(before);
		},
	);

	it('shares concurrent reads within a request but observes changes on the next request', async () => {
		const bucket = new MemoryBucket();
		const store = new AppPoolStore(bucket);
		const pid = createProjectId();
		const nid = createNotebookId();
		const firstRequest = store.reader();
		const get = vi.spyOn(bucket, 'get');
		await Promise.all(Array.from({ length: 20 }, () => firstRequest(pid, nid)));
		expect(get).toHaveBeenCalledTimes(1);
		const version = createVersionId();
		await store.mutate(pid, nid, (pool) => {
			pool.latest_version_id = version;
			return { pool, value: undefined };
		});
		get.mockClear();
		expect(await firstRequest(pid, nid)).toBeNull();
		expect((await store.reader()(pid, nid))?.latest_version_id).toBe(version);
		expect(get).toHaveBeenCalledTimes(1);
	});
});

describe('app pool storage failures', () => {
	const pid = createProjectId();
	const nid = createNotebookId();
	const key = paths.appPool(pid, nid);
	const version = createVersionId();

	it.each([
		'not JSON',
		JSON.stringify({ schema_version: 99 }),
		JSON.stringify({ schema_version: 1, members: [], assignments: {} }),
	])('preserves corrupt or unsupported records: %s', async (content) => {
		const bucket = new MemoryBucket();
		await bucket.put(key, content);
		const store = new AppPoolStore(bucket);
		const put = vi.spyOn(bucket, 'put');
		const update = vi.fn((pool: AppPool) => ({ pool, value: undefined }));
		await expect(store.mutate(pid, nid, update)).rejects.toThrow();
		expect(update).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(await (await bucket.get(key))!.text()).toBe(content);
	});

	it.each(['read', 'write', 'validation'] as const)(
		'propagates %s failures without retrying or acknowledging a reservation',
		async (stage) => {
			const bucket = new MemoryBucket();
			const store = new AppPoolStore(bucket);
			const failure =
				stage === 'validation'
					? new PreconditionFailedError('stale head')
					: new Error('storage unavailable');
			const get = vi.spyOn(bucket, 'get');
			const put = vi.spyOn(bucket, 'put');
			if (stage === 'read') get.mockRejectedValue(failure);
			if (stage === 'write') put.mockRejectedValue(failure);
			const update = vi.fn(async (pool: AppPool) => {
				pool.latest_version_id = version;
				if (stage === 'validation') throw failure;
				return { pool, value: 'reserved' };
			});
			await expect(store.mutate(pid, nid, update)).rejects.toBe(failure);
			expect(get).toHaveBeenCalledTimes(1);
			expect(update).toHaveBeenCalledTimes(stage === 'read' ? 0 : 1);
			expect(put).toHaveBeenCalledTimes(stage === 'write' ? 1 : 0);
			get.mockRestore();
			expect(await bucket.get(key)).toBeNull();
		},
	);

	it('bounds CAS retries, reports contention, and preserves the prior record on exhaustion', async () => {
		vi.useFakeTimers();
		try {
			const bucket = new MemoryBucket();
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const store = new AppPoolStore(bucket, metrics);
			const original = JSON.stringify({ schema_version: 1, members: [], assignments: [] });
			await bucket.put(key, original);
			const put = vi.spyOn(bucket, 'put').mockRejectedValue(new PreconditionFailedError('race'));
			const failed = expect(
				store.mutate(pid, nid, (pool) => {
					pool.latest_version_id = version;
					return { pool, value: 'reserved' };
				}),
			).rejects.toMatchObject({ status: 409 });
			await vi.runAllTimersAsync();
			await failed;
			expect(put).toHaveBeenCalledTimes(12);
			expect(
				metrics.increment.mock.calls.filter(([name]) => name === 'app_pool.cas.conflicts'),
			).toHaveLength(12);
			expect(metrics.increment).toHaveBeenCalledWith('app_pool.cas.exhausted');
			expect(await (await bucket.get(key))!.text()).toBe(original);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('app pool deletion fences', () => {
	const pid = createProjectId();
	const nid = createNotebookId();
	const reservation = () => ({
		session_id: createSessionId(),
		sandbox_id: createSandboxId(),
		user_id: UserId.parse('alice'),
		state: 'starting' as const,
		created_at: 100,
		operation_token: 'operation',
		operation_expires_at: 1000,
	});

	it.each([false, true])(
		'fences an admission that read the pool before deletion (existing: %s)',
		async (existing) => {
			const bucket = new MemoryBucket();
			const store = new AppPoolStore(bucket);
			const member = reservation();
			if (existing) {
				await store.mutate(pid, nid, (pool) => {
					pool.members.push(member);
					return { pool, value: undefined };
				});
			}
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const admission = store.mutate(pid, nid, async (pool) => {
				entered.resolve();
				await release.promise;
				pool.members.push(reservation());
				return { pool, value: 'reserved' };
			});
			await entered.promise;
			await store.retireForDeletion(pid, nid);
			release.resolve();
			await expect(admission).rejects.toMatchObject({ status: 404 });
			const deleted = await store.read(pid, nid);
			expect(deleted?.deleted_at).toEqual(expect.any(Number));
			expect(deleted?.members).toEqual(existing ? [{ ...member, state: 'retiring' }] : []);
			expect(deleted?.assignments).toEqual([]);
		},
	);

	it('retains a stable deletion fence after reclamation and rejects resurrection', async () => {
		const bucket = new MemoryBucket();
		const store = new AppPoolStore(bucket);
		const member = reservation();
		await store.mutate(pid, nid, (pool) => {
			pool.members.push(member);
			pool.assignments.push({
				user_id: member.user_id,
				session_id: member.session_id,
				generation: 'generation',
				visits: [{ visit_id: 'tab', expires_at: 1000 }],
			});
			return { pool, value: undefined };
		});
		await store.retireForDeletion(pid, nid);
		const tombstone = (await store.read(pid, nid))!.deleted_at;
		await store.mutate(pid, nid, (pool) => {
			pool.members = [];
			return { pool, value: undefined };
		});
		const put = vi.spyOn(bucket, 'put');
		await store.retireForDeletion(pid, nid);
		expect(put).not.toHaveBeenCalled();
		expect(await store.read(pid, nid)).toMatchObject({ deleted_at: tombstone, members: [] });
		await expect(
			store.mutate(pid, nid, (pool) => {
				delete pool.deleted_at;
				return { pool, value: undefined };
			}),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			store.mutate(pid, nid, (pool) => {
				pool.assignments.push({
					user_id: member.user_id,
					session_id: member.session_id,
					generation: 'stale',
					visits: [{ visit_id: 'tab', expires_at: 1000 }],
				});
				return { pool, value: undefined };
			}),
		).rejects.toMatchObject({ status: 404 });
	});
});

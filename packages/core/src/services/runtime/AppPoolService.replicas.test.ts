import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import type { Bucket } from '../../ports/bucket';
import {
	createNotebookId,
	createProjectId,
	createSandboxId,
	createSessionId,
	UserId,
} from '../../ids';
import { paths } from '../../paths';
import { AppPoolService } from './AppPoolService';
import { SessionService } from './SessionService';
import { DEFAULT_APP_POOL_POLICY } from './AppPoolRouter';
import type { AppPool } from './AppPoolRouter';
import { PreconditionFailedError, UnavailableError } from '../../errors';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(count = 4) {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	vi.spyOn(Math, 'random').mockReturnValue(0);
	const bucket = new MemoryBucket();
	const pid = createProjectId();
	const nid = createNotebookId();
	const sid = createSessionId();
	const key = paths.appPool(pid, nid);
	const pool: AppPool = {
		schema_version: 1,
		members: [
			{
				session_id: sid,
				sandbox_id: createSandboxId(),
				user_id: UserId.parse('owner'),
				state: 'ready',
				created_at: 0,
				operation_token: 'op',
				operation_expires_at: 2_000_000,
			},
		],
		assignments: Array.from({ length: count }, (_, i) => ({
			user_id: UserId.parse(`viewer-${i}`),
			session_id: sid,
			generation: `generation-${i}`,
			visit_id: `visit-${i}`,
			visits: [{ visit_id: `visit-${i}`, expires_at: Date.now() + 60_000 }],
		})),
	};
	await bucket.put(key, JSON.stringify(pool));
	const services = Array.from({ length: count }, () => {
		const replica = new Proxy(bucket, {
			get(target, property) {
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as Bucket;
		return new AppPoolService(replica, new SessionService(replica), DEFAULT_APP_POOL_POLICY);
	});
	const heartbeat = (i: number) =>
		services[i].heartbeat(pid, nid, pool.assignments[i].user_id, sid, {
			visit_id: `visit-${i}`,
			generation: `generation-${i}`,
		});
	return { bucket, pool, key, services, heartbeat, pid, nid };
}

describe('app presence across replicas', () => {
	it('paces four distinct replica batches with a backward-compatible missing timestamp', async () => {
		const { bucket, heartbeat, services, pid, nid } = await fixture();
		const committed: number[] = [];
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			const result = await put(...args);
			committed.push(Date.now());
			return result;
		});
		const pending = Promise.all([0, 1, 2, 3].map(heartbeat));
		await vi.advanceTimersByTimeAsync(0);
		expect(committed).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(4000);
		expect(await pending).toEqual([true, true, true, true]);
		expect(committed).toEqual([1_000_000, 1_001_000, 1_002_000, 1_003_000]);
		const saved = await services[0].store.read(pid, nid);
		expect(saved?.last_presence_write_at).toBe(1_003_000);
		expect(saved?.assignments.map((assignment) => assignment.visits[0].expires_at).sort()).toEqual(
			committed.map((time) => time + DEFAULT_APP_POOL_POLICY.userLeaseMs),
		);
	});

	it('rereads and paces a losing CAS after another replica commits', async () => {
		const { bucket, pool, key, heartbeat } = await fixture(1);
		const put = bucket.put.bind(bucket);
		let raced = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			if (!raced) {
				raced = true;
				await put(key, JSON.stringify({ ...pool, last_presence_write_at: Date.now() }));
				throw new PreconditionFailedError('another replica won');
			}
			return put(...args);
		});
		let settled = false;
		const pending = heartbeat(0).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toBe(true);
	});

	it.each(['deleted', 'expired'] as const)('revalidates a %s visit after waiting', async (race) => {
		const { bucket, pool, key, heartbeat } = await fixture(1);
		pool.last_presence_write_at = Date.now();
		if (race === 'expired') pool.assignments[0].visits[0].expires_at = Date.now() + 500;
		await bucket.put(key, JSON.stringify(pool));
		const pending = heartbeat(0);
		await vi.advanceTimersByTimeAsync(0);
		if (race === 'deleted')
			await bucket.put(
				key,
				JSON.stringify({ ...pool, deleted_at: Date.now(), assignments: [], members: [] }),
			);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toBe(false);
		const saved = JSON.parse(await (await bucket.get(key))!.text()) as AppPool;
		expect(saved.assignments).toEqual([]);
	});

	it('bounds contention when more replica batches arrive than fit in the budget', async () => {
		const { heartbeat } = await fixture(7);
		const pending = Promise.allSettled(Array.from({ length: 7 }, (_, i) => heartbeat(i)));
		await vi.advanceTimersByTimeAsync(5000);
		const results = await pending;
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
		const rejected = results.filter((result) => result.status === 'rejected');
		expect(rejected).toHaveLength(2);
		for (const result of rejected) expect(result.reason).toBeInstanceOf(UnavailableError);
	});

	it('returns retryable unavailability instead of waiting beyond the bounded budget', async () => {
		const { bucket, pool, key, heartbeat } = await fixture(1);
		pool.last_presence_write_at = Date.now() + 10_000;
		await bucket.put(key, JSON.stringify(pool));
		const put = vi.spyOn(bucket, 'put');
		const pending = expect(heartbeat(0)).rejects.toBeInstanceOf(UnavailableError);
		await vi.advanceTimersByTimeAsync(0);
		await pending;
		expect(put).not.toHaveBeenCalled();
	});
});

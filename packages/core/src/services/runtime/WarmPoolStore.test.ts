import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { createSandboxId } from '../../ids';
import { WarmPoolStore } from './WarmPoolStore';

afterEach(() => vi.restoreAllMocks());

describe('WarmPoolStore', () => {
	it('discovers ownership from arbitrary providers across listing pages', async () => {
		const bucket = new MemoryBucket();
		const ids = [createSandboxId(), createSandboxId()];
		for (const [index, backend] of ['external-a', 'external-b'].entries()) {
			await new WarmPoolStore(bucket, backend).mutate((record) => {
				record.pools.push({
					key: 'default',
					failures: 0,
					retry_at: 0,
					members: [
						{
							sandbox_id: ids[index],
							state: 'ready',
							token: 'token',
							assigned: false,
							created_at: 0,
							checked_at: 0,
							ready_until: 60_000,
							operation_until: 60_000,
						},
					],
				});
			});
		}
		const list = bucket.list.bind(bucket);
		const pages = vi
			.spyOn(bucket, 'list')
			.mockImplementation((options) => list({ ...options, limit: 1 }));
		expect(await WarmPoolStore.allOwnedSandboxIds(bucket)).toEqual(new Set(ids));
		expect(pages).toHaveBeenCalledTimes(2);
	});

	it('rejects a listed ownership record that cannot be read', async () => {
		const bucket = new MemoryBucket();
		await new WarmPoolStore(bucket, 'external').mutate((record) => {
			record.pools.push({ key: 'default', failures: 0, retry_at: 0, members: [] });
		});
		vi.spyOn(bucket, 'get').mockResolvedValue(null);
		await expect(WarmPoolStore.allOwnedSandboxIds(bucket)).rejects.toThrow('ownership unavailable');
	});
	it('preserves concurrent changes when replicas both initialize the record', async () => {
		const bucket = new MemoryBucket();
		const stores = [
			new WarmPoolStore(bucket, 'kubernetes'),
			new WarmPoolStore(bucket, 'kubernetes'),
		];
		await Promise.all(
			stores.map((store, index) =>
				store.mutate((record) => {
					record.pools.push({ key: `profile-${index}`, failures: 0, retry_at: 0, members: [] });
				}),
			),
		);
		expect((await stores[0].read()).pools.map((pool) => pool.key).sort()).toEqual([
			'profile-0',
			'profile-1',
		]);
	});

	it('keeps backend records independent', async () => {
		const bucket = new MemoryBucket();
		const kubernetes = new WarmPoolStore(bucket, 'kubernetes');
		const coreweave = new WarmPoolStore(bucket, 'coreweave');
		await kubernetes.mutate((record) => {
			record.pools.push({ key: 'default', failures: 1, retry_at: 10, members: [] });
		});
		expect(await coreweave.read()).toEqual({ pools: [] });
		expect((await kubernetes.read()).pools).toHaveLength(1);
	});

	it('does not persist a mutation whose callback throws', async () => {
		const bucket = new MemoryBucket();
		const store = new WarmPoolStore(bucket, 'kubernetes');
		const put = vi.spyOn(bucket, 'put');
		await expect(
			store.mutate((record) => {
				record.pools.push({ key: 'default', failures: 0, retry_at: 0, members: [] });
				throw new Error('interrupted mutation');
			}),
		).rejects.toThrow('interrupted mutation');
		expect(put).not.toHaveBeenCalled();
		expect(await store.read()).toEqual({ pools: [] });
	});

	it('does not retry an ambiguous committed write as a new mutation', async () => {
		const bucket = new MemoryBucket();
		const store = new WarmPoolStore(bucket, 'kubernetes');
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
			await put(...args);
			throw new Error('response lost');
		});
		const update = vi.fn((record: Awaited<ReturnType<WarmPoolStore['read']>>) => {
			record.pools.push({ key: 'default', failures: 0, retry_at: 0, members: [] });
		});
		await expect(store.mutate(update)).rejects.toThrow('response lost');
		expect(update).toHaveBeenCalledOnce();
		expect((await store.read()).pools).toHaveLength(1);
	});

	it.each(['{invalid', '{"pools":{}}', '{"pools":[{"key":"default"}]}'])(
		'preserves corrupt ownership instead of replacing it: %s',
		async (body) => {
			const bucket = new MemoryBucket();
			const key = paths.warmPool('kubernetes');
			await bucket.put(key, body);
			const store = new WarmPoolStore(bucket, 'kubernetes');
			const update = vi.fn();
			await expect(store.mutate(update)).rejects.toThrow();
			await expect(store.ownedSandboxIds()).rejects.toThrow();
			expect(update).not.toHaveBeenCalled();
			expect(await (await bucket.get(key))!.text()).toBe(body);
		},
	);
});

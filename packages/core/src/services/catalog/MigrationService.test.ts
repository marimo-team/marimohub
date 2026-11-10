import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { MigrationService } from './MigrationService';
import type { BackgroundMigration, MigrationBatch } from './MigrationService';

const id = 'test-v1';
const key = paths.migration(id);
const complete = async (): Promise<MigrationBatch> => ({ done: true });
const definition = (runBatch: BackgroundMigration['runBatch'] = complete) => ({ id, runBatch });
afterEach(() => vi.restoreAllMocks());

describe('background migrations', () => {
	it('persists completion across restarts and performs no I/O on later ticks', async () => {
		const bucket = new MemoryBucket();
		const runBatch = vi.fn(complete);
		const first = new MigrationService(bucket, [definition(runBatch)]);
		expect(await first.tick()).toBe(true);
		expect(await (await bucket.get(key))!.json()).toMatchObject({ status: 'complete' });
		const second = new MigrationService(bucket, [definition(runBatch)]);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		expect(await second.tick()).toBe(true);
		expect(get).toHaveBeenCalledExactlyOnceWith(key);
		get.mockClear();
		for (const service of [first, second]) expect(await service.tick()).toBe(true);
		expect(runBatch).toHaveBeenCalledTimes(1);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it('runs one bounded batch per tick and resumes its cursor after a restart', async () => {
		const bucket = new MemoryBucket();
		const runBatch = vi
			.fn<BackgroundMigration['runBatch']>()
			.mockResolvedValueOnce({ done: false, cursor: 'page-2' })
			.mockResolvedValueOnce({ done: true });
		expect(await new MigrationService(bucket, [definition(runBatch)]).tick()).toBe(false);
		expect(runBatch).toHaveBeenCalledTimes(1);
		expect(await new MigrationService(bucket, [definition(runBatch)]).tick()).toBe(true);
		expect(runBatch.mock.calls.map(([context]) => context.cursor)).toEqual([undefined, 'page-2']);
	});

	it('orders migrations, keeps receipts for removed definitions, and runs a new version', async () => {
		const bucket = new MemoryBucket();
		const first = vi.fn(complete);
		const next = vi.fn(complete);
		const service = new MigrationService(bucket, [
			definition(first),
			{ id: 'test-v2', runBatch: next },
		]);
		expect(await service.tick()).toBe(false);
		expect(next).not.toHaveBeenCalled();
		expect(await service.tick()).toBe(true);
		const restarted = new MigrationService(bucket, [{ id: 'test-v2', runBatch: next }]);
		expect(await restarted.tick()).toBe(true);
		expect(first).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledTimes(1);
		expect(await bucket.get(key)).not.toBeNull();
	});

	it('coalesces concurrent ticks in one process', async () => {
		const batch = Promise.withResolvers<MigrationBatch>();
		const runBatch = vi.fn(() => batch.promise);
		const service = new MigrationService(new MemoryBucket(), [definition(runBatch)]);
		const first = service.tick();
		expect(service.tick()).toBe(first);
		batch.resolve({ done: true });
		expect(await first).toBe(true);
		expect(runBatch).toHaveBeenCalledTimes(1);
	});

	it('allows only one replica to acquire a batch', async () => {
		const bucket = new MemoryBucket();
		const batch = Promise.withResolvers<MigrationBatch>();
		const entered = Promise.withResolvers<void>();
		const runBatch = vi.fn(() => {
			entered.resolve();
			return batch.promise;
		});
		const first = new MigrationService(bucket, [definition(runBatch)]).tick();
		await entered.promise;
		expect(await new MigrationService(bucket, [definition(runBatch)]).tick()).toBe(false);
		batch.resolve({ done: true });
		expect(await first).toBe(true);
		expect(runBatch).toHaveBeenCalledTimes(1);
	});

	it('handles a create-if-absent race without treating contention as failure', async () => {
		const bucket = new MemoryBucket();
		const runBatch = vi.fn(complete);
		const results = await Promise.all([
			new MigrationService(bucket, [definition(runBatch)]).tick(),
			new MigrationService(bucket, [definition(runBatch)]).tick(),
		]);
		expect(results.sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
		expect(runBatch).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		'fences a late worker after lease takeover (successor complete: %s)',
		async (done) => {
			let now = Date.now();
			vi.spyOn(Date, 'now').mockImplementation(() => now);
			const bucket = new MemoryBucket();
			const late = Promise.withResolvers<MigrationBatch>();
			const entered = Promise.withResolvers<void>();
			const first = new MigrationService(bucket, [
				definition(() => {
					entered.resolve();
					return late.promise;
				}),
			]).tick();
			await entered.promise;
			now += 60_001;
			expect(
				await new MigrationService(bucket, [
					definition(async () => (done ? { done: true } : { done: false, cursor: 'successor' })),
				]).tick(),
			).toBe(done);
			const successor = await (await bucket.get(key))!.text();
			late.resolve({ done: false, cursor: 'stale' });
			expect(await first).toBe(false);
			expect(await (await bucket.get(key))!.text()).toBe(successor);
		},
	);

	it('does not publish completion after its lease expires even without a successor', async () => {
		let now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const bucket = new MemoryBucket();
		const service = new MigrationService(bucket, [
			definition(async () => {
				now += 60_001;
				return { done: true };
			}),
		]);
		expect(await service.tick()).toBe(false);
		expect(await (await bucket.get(key))!.json()).toMatchObject({ status: 'pending' });
	});

	it('retries a failed batch from the last successful cursor', async () => {
		const bucket = new MemoryBucket();
		const runBatch = vi
			.fn<BackgroundMigration['runBatch']>()
			.mockResolvedValueOnce({ done: false, cursor: 'saved' })
			.mockRejectedValueOnce(new Error('storage unavailable'))
			.mockResolvedValueOnce({ done: true });
		const service = new MigrationService(bucket, [definition(runBatch)]);
		expect(await service.tick()).toBe(false);
		await expect(service.tick()).rejects.toThrow('storage unavailable');
		expect(await service.tick()).toBe(true);
		expect(runBatch.mock.calls.map(([context]) => context.cursor)).toEqual([
			undefined,
			'saved',
			'saved',
		]);
	});

	it.each([false, true])(
		'recovers from an uncertain checkpoint write (committed: %s)',
		async (committed) => {
			const bucket = new MemoryBucket();
			const put = bucket.put.bind(bucket);
			const spy = vi.spyOn(bucket, 'put').mockImplementation(async (path, value, options) => {
				if ((JSON.parse(value as string) as { status: string }).status === 'complete') {
					if (committed) await put(path, value, options);
					throw new Error('response lost');
				}
				return put(path, value, options);
			});
			const runBatch = vi.fn(complete);
			const service = new MigrationService(bucket, [definition(runBatch)]);
			await expect(service.tick()).rejects.toThrow('response lost');
			spy.mockRestore();
			expect(await service.tick()).toBe(true);
			expect(runBatch).toHaveBeenCalledTimes(committed ? 1 : 2);
		},
	);

	it.each(['{', '{"version":2,"status":"complete"}', '{"version":1,"status":"running"}'])(
		'does not overwrite invalid state: %s',
		async (body) => {
			const bucket = new MemoryBucket();
			await bucket.put(key, body);
			const runBatch = vi.fn(complete);
			const put = vi.spyOn(bucket, 'put');
			await expect(new MigrationService(bucket, [definition(runBatch)]).tick()).rejects.toThrow();
			expect(runBatch).not.toHaveBeenCalled();
			expect(put).not.toHaveBeenCalled();
		},
	);

	it('does not run work when reading or acquiring its checkpoint fails', async () => {
		const bucket = new MemoryBucket();
		const runBatch = vi.fn(complete);
		const service = new MigrationService(bucket, [definition(runBatch)]);
		const get = vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('read failed'));
		await expect(service.tick()).rejects.toThrow('read failed');
		get.mockRestore();
		const put = vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('write failed'));
		await expect(service.tick()).rejects.toThrow('write failed');
		put.mockRestore();
		expect(runBatch).not.toHaveBeenCalled();
		expect(await service.tick()).toBe(true);
	});

	it('waits for an uncertain lease acquisition to expire before retrying', async () => {
		let now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const bucket = new MemoryBucket();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
			await put(...args);
			throw new Error('response lost');
		});
		const runBatch = vi.fn(complete);
		const service = new MigrationService(bucket, [definition(runBatch)]);
		await expect(service.tick()).rejects.toThrow('response lost');
		expect(await service.tick()).toBe(false);
		expect(runBatch).not.toHaveBeenCalled();
		now += 60_001;
		expect(await service.tick()).toBe(true);
	});

	it('does not checkpoint work cancelled during a batch', async () => {
		const bucket = new MemoryBucket();
		const controller = new AbortController();
		const service = new MigrationService(bucket, [
			definition(async ({ signal }) => {
				expect(signal).toBe(controller.signal);
				controller.abort(new Error('shutdown'));
				return { done: true };
			}),
		]);
		await expect(service.tick(controller.signal)).rejects.toThrow('shutdown');
		expect(await (await bucket.get(key))!.json()).toMatchObject({ status: 'pending' });
		const get = vi.spyOn(bucket, 'get');
		await expect(service.tick(controller.signal)).rejects.toThrow('shutdown');
		expect(get).not.toHaveBeenCalled();
	});

	it('returns complete without storage access for an empty registry', async () => {
		const bucket = new MemoryBucket();
		const get = vi.spyOn(bucket, 'get');
		expect(await new MigrationService(bucket, []).tick()).toBe(true);
		expect(get).not.toHaveBeenCalled();
	});

	it.each(['../escape', '', 'UPPER', 'a/b'])('rejects invalid IDs: %s', (badId) => {
		expect(
			() => new MigrationService(new MemoryBucket(), [{ id: badId, runBatch: complete }]),
		).toThrow('Invalid');
	});
	it('rejects duplicate IDs', () => {
		expect(() => new MigrationService(new MemoryBucket(), [definition(), definition()])).toThrow(
			'duplicate',
		);
	});
});

it('preserves the batch error when releasing a failed lease also fails', async () => {
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const bucket = new MemoryBucket();
	const put = bucket.put.bind(bucket);
	const spy = vi.spyOn(bucket, 'put').mockImplementation((path, value, options) => {
		if ((JSON.parse(value as string) as { status: string }).status === 'pending')
			throw new Error('release failed');
		return put(path, value, options);
	});
	const batch = vi
		.fn<BackgroundMigration['runBatch']>()
		.mockRejectedValueOnce(new Error('batch failed'))
		.mockResolvedValueOnce({ done: true });
	const service = new MigrationService(bucket, [definition(batch)]);
	await expect(service.tick()).rejects.toThrow('batch failed');
	spy.mockRestore();
	expect(await service.tick()).toBe(false);
	now += 60_001;
	expect(await service.tick()).toBe(true);
});

it('does not checkpoint over a successor that takes over during the completion write', async () => {
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const bucket = new MemoryBucket();
	const successor = new MigrationService(bucket, [
		definition(async () => ({ done: false, cursor: 'successor' })),
	]);
	const put = bucket.put.bind(bucket);
	let raced = false;
	vi.spyOn(bucket, 'put').mockImplementation(async (path, value, options) => {
		if (!raced && (JSON.parse(value as string) as { status: string }).status === 'complete') {
			raced = true;
			now += 60_001;
			expect(await successor.tick()).toBe(false);
		}
		return put(path, value, options);
	});
	expect(await new MigrationService(bucket, [definition()]).tick()).toBe(false);
	expect(raced).toBe(true);
	expect(await (await bucket.get(key))!.json()).toEqual({
		version: 1,
		status: 'pending',
		cursor: 'successor',
	});
});

it('releases an acquired lease without running work when shutdown arrives during acquisition', async () => {
	const bucket = new MemoryBucket();
	await bucket.put(key, JSON.stringify({ version: 1, status: 'pending', cursor: 'saved' }));
	const controller = new AbortController();
	const put = bucket.put.bind(bucket);
	vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
		const result = await put(...args);
		controller.abort(new Error('shutdown'));
		return result;
	});
	const runBatch = vi.fn(complete);
	const service = new MigrationService(bucket, [definition(runBatch)]);
	await expect(service.tick(controller.signal)).rejects.toThrow('shutdown');
	expect(runBatch).not.toHaveBeenCalled();
	expect(await (await bucket.get(key))!.json()).toEqual({
		version: 1,
		status: 'pending',
		cursor: 'saved',
	});
	expect(await service.tick()).toBe(true);
	expect(runBatch).toHaveBeenCalledExactlyOnceWith({ cursor: 'saved', signal: undefined });
});

it.each([false, true])(
	'resumes the durable cursor after an uncertain intermediate checkpoint (committed: %s)',
	async (committed) => {
		const bucket = new MemoryBucket();
		await bucket.put(key, JSON.stringify({ version: 1, status: 'pending', cursor: 'previous' }));
		const put = bucket.put.bind(bucket);
		const spy = vi.spyOn(bucket, 'put').mockImplementation(async (path, value, options) => {
			const state = JSON.parse(value as string) as { status: string; cursor?: string };
			if (state.status === 'pending' && state.cursor === 'next') {
				if (committed) await put(path, value, options);
				throw new Error('checkpoint response lost');
			}
			return put(path, value, options);
		});
		await expect(
			new MigrationService(bucket, [
				definition(async () => ({ done: false, cursor: 'next' })),
			]).tick(),
		).rejects.toThrow('checkpoint response lost');
		spy.mockRestore();
		const resume = vi.fn(complete);
		expect(await new MigrationService(bucket, [definition(resume)]).tick()).toBe(true);
		expect(resume).toHaveBeenCalledExactlyOnceWith({
			cursor: committed ? 'next' : 'previous',
			signal: undefined,
		});
	},
);

it('blocks later migrations until a failed predecessor completes, including across restarts', async () => {
	const bucket = new MemoryBucket();
	const first = vi
		.fn<BackgroundMigration['runBatch']>()
		.mockRejectedValueOnce(new Error('predecessor failed'))
		.mockResolvedValueOnce({ done: true });
	const second = vi.fn(complete);
	const registry = [definition(first), { id: 'test-v2', runBatch: second }];
	await expect(new MigrationService(bucket, registry).tick()).rejects.toThrow('predecessor failed');
	expect(second).not.toHaveBeenCalled();
	expect(await bucket.get(paths.migration('test-v2'))).toBeNull();
	const restarted = new MigrationService(bucket, registry);
	expect(await restarted.tick()).toBe(false);
	expect(second).not.toHaveBeenCalled();
	expect(await restarted.tick()).toBe(true);
	expect(first).toHaveBeenCalledTimes(2);
	expect(second).toHaveBeenCalledTimes(1);
});

it('preserves successor completion when an expired worker fails late', async () => {
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const bucket = new MemoryBucket();
	const entered = Promise.withResolvers<void>();
	const late = Promise.withResolvers<MigrationBatch>();
	const first = new MigrationService(bucket, [
		definition(() => {
			entered.resolve();
			return late.promise;
		}),
	]);
	const attempt = first.tick();
	const rejected = expect(attempt).rejects.toThrow('late failure');
	await entered.promise;
	now += 60_001;
	expect(await new MigrationService(bucket, [definition()]).tick()).toBe(true);
	const receipt = await (await bucket.get(key))!.text();
	late.reject(new Error('late failure'));
	await rejected;
	expect(await (await bucket.get(key))!.text()).toBe(receipt);
	expect(await first.tick()).toBe(true);
});

it('coalesces read-only readiness refreshes, throttles pending checks, and stops after completion', async () => {
	const bucket = new MemoryBucket();
	const runBatch = vi.fn(complete);
	const service = new MigrationService(bucket, [definition(runBatch)]);
	let now = 1_000;
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const get = vi.spyOn(bucket, 'get');
	const first = service.refreshCompleted();
	expect(service.refreshCompleted()).toBe(first);
	await first;
	expect(service.isComplete(id)).toBe(false);
	expect(service.refreshCompleted()).toBeUndefined();
	expect(get).toHaveBeenCalledTimes(1);
	await new MigrationService(bucket, [definition()]).tick();
	now += 5_000;
	await service.refreshCompleted();
	expect(service.isComplete(id)).toBe(true);
	get.mockClear();
	now += 60_000;
	expect(service.refreshCompleted()).toBeUndefined();
	expect(get).not.toHaveBeenCalled();
	expect(runBatch).not.toHaveBeenCalled();
});

it.each(['read-failure', 'corrupt'])(
	'keeps readiness false after %s and recovers without running batches',
	async (failure) => {
		const bucket = new MemoryBucket();
		const runBatch = vi.fn(complete);
		const service = new MigrationService(bucket, [definition(runBatch)]);
		let now = 1_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		if (failure === 'corrupt') await bucket.put(key, '{}');
		else vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('read failed'));
		await expect(service.refreshCompleted()).rejects.toThrow();
		expect(service.isComplete(id)).toBe(false);
		expect(service.refreshCompleted()).toBeUndefined();
		await bucket.put(
			key,
			JSON.stringify({ version: 1, status: 'complete', completed_at: new Date().toISOString() }),
		);
		now += 5_000;
		await service.refreshCompleted();
		expect(service.isComplete(id)).toBe(true);
		expect(runBatch).not.toHaveBeenCalled();
	},
);

it('does not activate a later receipt before its predecessor completes', async () => {
	const bucket = new MemoryBucket();
	const runBatch = vi.fn(complete);
	const service = new MigrationService(bucket, [definition(runBatch), { id: 'next-v1', runBatch }]);
	await bucket.put(
		paths.migration('next-v1'),
		JSON.stringify({ version: 1, status: 'complete', completed_at: new Date().toISOString() }),
	);
	await service.refreshCompleted();
	expect(service.isComplete('next-v1')).toBe(false);
	expect(runBatch).not.toHaveBeenCalled();
});

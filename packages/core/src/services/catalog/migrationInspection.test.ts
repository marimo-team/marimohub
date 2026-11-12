import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { MigrationService } from './MigrationService';
import type { BackgroundMigration } from './MigrationService';

const at = '2026-11-12T12:00:00.000Z';
const definition = (id = 'first-v1'): BackgroundMigration => ({
	id,
	title: 'First',
	description: 'Work',
	impact: 'Available',
	runBatch: async () => ({ done: true, progress: { delta: 2 } }),
});
const put = (bucket: MemoryBucket, id: string, value: unknown) =>
	bucket.put(paths.migration(id), JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());

it('inspects known keys once without writes, scans, work, or readiness-cache changes', async () => {
	const bucket = new MemoryBucket();
	await put(bucket, 'first-v1', {
		version: 1,
		status: 'complete',
		completed_at: at,
		secret: 'hidden',
	});
	const service = new MigrationService(bucket, [definition()], [{ id: 'old-v1' }]);
	const get = vi.spyOn(bucket, 'get');
	const write = vi.spyOn(bucket, 'put');
	const list = vi.spyOn(bucket, 'list');
	const snapshot = await service.inspect();
	expect(get.mock.calls.map(([key]) => key)).toEqual([
		paths.migration('first-v1'),
		paths.migration('old-v1'),
	]);
	expect(write).not.toHaveBeenCalled();
	expect(list).not.toHaveBeenCalled();
	expect(service.isComplete('first-v1')).toBe(false);
	expect(snapshot.rows.map((row) => row.status)).toEqual(['completed', 'not_recorded']);
	expect(snapshot.counts).toEqual({ completed: 1, waiting: 0, running: 0, needs_attention: 0 });
	expect(snapshot.rows[0].progress).toBeUndefined();
	expect(JSON.stringify(snapshot)).not.toContain('hidden');
	expect(snapshot.action).toBe('already_complete');
	expect(snapshot.poll).toBe(false);
});

it('isolates corrupt and unreadable rows while independent work remains eligible', async () => {
	const bucket = new MemoryBucket();
	await put(bucket, 'first-v1', { version: 2, status: 'pending' });
	const get = bucket.get.bind(bucket);
	vi.spyOn(bucket, 'get').mockImplementation((key) =>
		key === paths.migration('unknown-v1') ? Promise.reject(new Error('secret')) : get(key),
	);
	const service = new MigrationService(bucket, [
		definition(),
		definition('dependent-v1'),
		{ ...definition('independent-v1'), after: [] },
		{ ...definition('unknown-v1'), after: [] },
	]);
	const snapshot = await service.inspect();
	expect(snapshot.rows.map((row) => row.status)).toEqual([
		'blocked',
		'dependency',
		'waiting',
		'unavailable',
	]);
	expect(snapshot.counts).toEqual({ completed: 0, waiting: 2, running: 0, needs_attention: 1 });
	expect(snapshot.incomplete).toBe(true);
	expect(snapshot.action).toBe('ready');
	await expect(service.tick()).rejects.toThrow();
	expect((await service.inspect()).rows[2].status).toBe('completed');
	expect(await (await get(paths.migration('first-v1')))!.json()).toEqual({
		version: 2,
		status: 'pending',
	});
});

it('commits deltas across restart, includes the final batch, and preserves unknown fields without leases', async () => {
	const bucket = new MemoryBucket();
	await put(bucket, 'first-v1', {
		version: 1,
		status: 'running',
		cursor: 'old',
		lease: 'secret',
		expires_at: 0,
		additive: { retained: true },
	});
	const batch = vi
		.fn<BackgroundMigration['runBatch']>()
		.mockResolvedValueOnce({ done: false, cursor: 'next', progress: { delta: 3 } })
		.mockResolvedValueOnce({ done: true, progress: { delta: 2 } });
	const def = { ...definition(), runBatch: batch };
	await new MigrationService(bucket, [def]).tick();
	const restarted = new MigrationService(bucket, [def]);
	await restarted.tick();
	const stored = await (await bucket.get(paths.migration('first-v1')))!.json<
		Record<string, unknown>
	>();
	expect(stored).toMatchObject({
		status: 'complete',
		attempts: 2,
		progress: { processed: 5, partial: true },
		additive: { retained: true },
	});
	for (const field of ['lease', 'expires_at', 'cursor', 'started_at'])
		expect(stored).not.toHaveProperty(field);
	const snapshot = await restarted.inspect();
	expect(JSON.stringify(snapshot)).not.toContain('additive');
});

it.each(['secret-token', new Error('secret-token', { cause: { provider: 'secret-token' } })])(
	'records fixed failure text without advancing progress',
	async (failure) => {
		const bucket = new MemoryBucket();
		const service = new MigrationService(bucket, [
			{
				...definition(),
				runBatch: async () => {
					// oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error provider failures.
					throw failure;
				},
			},
		]);
		await expect(service.tick()).rejects.toBe(failure);
		const snapshot = await service.inspect();
		expect(snapshot.rows[0]).toMatchObject({
			status: 'retrying',
			attempts: 1,
			failure: { code: 'migration_failed' },
		});
		expect(snapshot.rows[0].progress).toBeUndefined();
		expect(JSON.stringify(snapshot)).not.toContain('secret-token');
	},
);

it.each([-1, 0.5, Number.NaN])(
	'rejects invalid progress without saving a cursor (%s)',
	async (delta) => {
		const bucket = new MemoryBucket();
		const service = new MigrationService(bucket, [
			{
				...definition(),
				runBatch: async () => ({ done: false, cursor: 'next', progress: { delta } }),
			},
		]);
		await expect(service.tick()).rejects.toThrow();
		const stored = await (await bucket.get(paths.migration('first-v1')))!.json();
		expect(stored).not.toHaveProperty('cursor');
		expect(stored).not.toHaveProperty('progress');
	},
);

it('keeps a live retry in the running count and stops polling blocked dependencies', async () => {
	const bucket = new MemoryBucket();
	await put(bucket, 'first-v1', {
		version: 1,
		status: 'running',
		lease: 'secret',
		expires_at: Date.now() + 60_000,
		failure: { code: 'migration_failed', at },
	});
	const service = new MigrationService(bucket, [definition(), definition('dependent-v1')]);
	expect((await service.inspect()).counts).toEqual({
		completed: 0,
		waiting: 1,
		running: 1,
		needs_attention: 0,
	});
	await put(bucket, 'first-v1', {});
	expect(await service.inspect()).toMatchObject({ action: 'blocked', poll: false });
});

it('distinguishes shutdown from timeout and retains the original error after a failed release', async () => {
	for (const name of ['AbortError', 'TimeoutError']) {
		const bucket = new MemoryBucket();
		const controller = new AbortController();
		const service = new MigrationService(bucket, [
			{
				...definition(),
				runBatch: async () => {
					controller.abort(new DOMException('secret', name));
					controller.signal.throwIfAborted();
					return { done: true };
				},
			},
		]);
		const attempt = service.tick(controller.signal);
		await expect(attempt).rejects.toMatchObject({ name });
		expect((await service.inspect()).rows[0].failure?.code).toBe(
			name === 'TimeoutError' ? 'timeout' : undefined,
		);
	}
	const bucket = new MemoryBucket();
	const original = new Error('original');
	const service = new MigrationService(bucket, [
		{
			...definition(),
			runBatch: async () => {
				vi.spyOn(bucket, 'put').mockRejectedValue(new Error('release'));
				throw original;
			},
		},
	]);
	await expect(service.tick()).rejects.toBe(original);
});

it('validates descriptor identities and retired dependencies', () => {
	const bucket = new MemoryBucket();
	expect(() => new MigrationService(bucket, [definition()], [{ id: 'first-v1' }])).toThrow();
	expect(
		() =>
			new MigrationService(bucket, [{ ...definition(), after: ['old-v1'] }], [{ id: 'old-v1' }]),
	).toThrow();
});

it('does not activate dependents through an unready completed receipt', async () => {
	const bucket = new MemoryBucket();
	await put(bucket, 'second-v1', { version: 1, status: 'complete', completed_at: at });
	const service = new MigrationService(bucket, [
		definition(),
		definition('second-v1'),
		{ ...definition('third-v1'), after: ['second-v1'] },
	]);
	const snapshot = await service.inspect();
	expect(snapshot.rows.map((row) => row.status)).toEqual(['waiting', 'completed', 'dependency']);
});

it('bounds inspection reads to four even with a larger registry', async () => {
	const bucket = new MemoryBucket();
	const gate = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	const get = bucket.get.bind(bucket);
	const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
		active++;
		peak = Math.max(peak, active);
		await gate.promise;
		active--;
		return get(key);
	});
	const service = new MigrationService(
		bucket,
		Array.from({ length: 9 }, (_, index) => definition(`test-${index}`)),
	);
	const inspection = service.inspect();
	await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(4));
	gate.resolve();
	await inspection;
	expect(peak).toBe(4);
	expect(spy).toHaveBeenCalledTimes(9);
});

it.each([true, false])(
	'recovers progress after a lost checkpoint response (committed: %s)',
	async (committed) => {
		const bucket = new MemoryBucket();
		const write = bucket.put.bind(bucket);
		let lose = true;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			const state = JSON.parse(value as string) as { cursor?: string; status: string };
			if (state.cursor === 'next' && state.status === 'pending' && lose) {
				lose = false;
				if (committed) await write(key, value, options);
				throw new Error('response lost');
			}
			return write(key, value, options);
		});
		const batch = vi.fn<BackgroundMigration['runBatch']>(async ({ cursor }) =>
			cursor === 'next'
				? { done: true, progress: { delta: 2 } }
				: { done: false, cursor: 'next', progress: { delta: 3 } },
		);
		const def = { ...definition(), runBatch: batch };
		await expect(new MigrationService(bucket, [def]).tick()).rejects.toThrow('response lost');
		const restart = new MigrationService(bucket, [def]);
		if (!(await restart.tick())) await restart.tick();
		expect((await restart.inspect()).rows[0].progress).toEqual({ processed: 5, partial: false });
	},
);

it('rejects totals below committed visits and waiting batches that claim progress', async () => {
	for (const result of [
		{ done: true, progress: { delta: 3, total: 2 } },
		{ done: false, waiting_reason: 'waiting_for_initialization', progress: { delta: 0 } },
	] as const) {
		const bucket = new MemoryBucket();
		const service = new MigrationService(bucket, [
			{ ...definition(), runBatch: async () => result },
		]);
		await expect(service.tick()).rejects.toThrow();
		expect((await service.inspect()).rows[0].progress).toBeUndefined();
	}
});

it('stops polling when only retired history is unreadable', async () => {
	const bucket = new MemoryBucket();
	vi.spyOn(bucket, 'get').mockRejectedValue(new Error('unavailable'));
	const service = new MigrationService(bucket, [], [{ id: 'old-v1' }]);
	expect(await service.inspect()).toMatchObject({
		incomplete: true,
		poll: false,
		action: 'already_complete',
	});
});

it('replaces initialization waiting with a failure when execution fails', async () => {
	const bucket = new MemoryBucket();
	await put(bucket, 'first-v1', {
		version: 1,
		status: 'pending',
		waiting_reason: 'waiting_for_initialization',
	});
	const service = new MigrationService(bucket, [
		{
			...definition(),
			runBatch: async () => {
				throw new Error('failed');
			},
		},
	]);
	await expect(service.tick()).rejects.toThrow('failed');
	expect((await service.inspect()).rows[0].status).toBe('retrying');
});

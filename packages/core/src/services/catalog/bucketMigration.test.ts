import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { bucketMigration } from './bucketMigration';
import { MigrationService } from './MigrationService';

afterEach(() => vi.restoreAllMocks());

async function fixture(count = 3) {
	const bucket = new MemoryBucket();
	for (let i = 0; i < count; i++) await bucket.put(`records/${i}`, '{}');
	const migrate = vi.fn(async (_key: string) => {});
	const definition = bucketMigration({
		id: 'records-v1',
		bucket,
		prefix: 'records/',
		migrate,
		batchSize: 2,
	});
	return { bucket, migrate, definition, runner: new MigrationService(bucket, [definition]) };
}

it('bounds each batch and resumes after deletion of the cursor object', async () => {
	const { bucket, migrate, definition, runner } = await fixture();
	expect(await runner.tick()).toBe(false);
	expect(migrate.mock.calls.map(([key]) => key)).toEqual(['records/0', 'records/1']);
	await bucket.delete('records/1');
	const restarted = new MigrationService(bucket, [definition]);
	expect(await restarted.tick()).toBe(true);
	expect(migrate.mock.calls.map(([key]) => key)).toEqual(['records/0', 'records/1', 'records/2']);
	const get = vi.spyOn(bucket, 'get');
	const list = vi.spyOn(bucket, 'list');
	for (let i = 0; i < 3; i++) {
		expect(restarted.isComplete('records-v1')).toBe(true);
		expect(await restarted.tick()).toBe(true);
	}
	expect(get).not.toHaveBeenCalled();
	expect(list).not.toHaveBeenCalled();
});

it('completes an empty prefix without calling the visitor', async () => {
	const { runner, migrate } = await fixture(0);
	expect(await runner.tick()).toBe(true);
	expect(migrate).not.toHaveBeenCalled();
});

it('retains the preceding checkpoint when a later page fails and replays partial writes', async () => {
	const { bucket, runner, migrate, definition } = await fixture(5);
	await runner.tick();
	migrate.mockImplementation(async (key) => {
		if (key === 'records/3') throw new Error('write failed');
	});
	const key = paths.migration(definition.id);
	const checkpoint = await (await bucket.get(key))!.json<{
		status: string;
		cursor: string;
		progress: unknown;
	}>();
	await expect(runner.tick()).rejects.toThrow('write failed');
	expect(await (await bucket.get(key))!.json()).toMatchObject({
		status: checkpoint.status,
		cursor: checkpoint.cursor,
		progress: checkpoint.progress,
	});
	expect(runner.isComplete(definition.id)).toBe(false);
	migrate.mockResolvedValue(undefined);
	const restarted = new MigrationService(bucket, [definition]);
	expect(await restarted.tick()).toBe(false);
	expect(await restarted.tick()).toBe(true);
	expect(migrate.mock.calls.filter(([key]) => key === 'records/2')).toHaveLength(2);
});

it('does not advance on list failure', async () => {
	const { bucket, runner, migrate } = await fixture();
	vi.spyOn(bucket, 'list').mockRejectedValueOnce(new Error('listing unavailable'));
	await expect(runner.tick()).rejects.toThrow('listing unavailable');
	expect(migrate).not.toHaveBeenCalled();
	expect(await runner.tick()).toBe(false);
});

it.each([undefined, 'saved'])(
	'rejects a truncated page with a nonadvancing cursor (%s)',
	async (cursor) => {
		const { bucket, definition, migrate } = await fixture();
		vi.spyOn(bucket, 'list').mockResolvedValue({
			objects: [],
			truncated: true,
			cursor,
			delimitedPrefixes: [],
		});
		await expect(definition.runBatch({ cursor: 'saved' })).rejects.toThrow('did not advance');
		expect(migrate).not.toHaveBeenCalled();
	},
);

it('waits for active visitors and cancels queued work before releasing the lease', async () => {
	const bucket = new MemoryBucket();
	for (let i = 0; i < 100; i++) await bucket.put(`records/${i}`, '{}');
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const migrate = vi.fn(async () => {
		if (migrate.mock.calls.length === BUCKET_SCAN_CONCURRENCY) started.resolve();
		await release.promise;
	});
	const runner = new MigrationService(bucket, [
		bucketMigration({ id: 'records-v1', bucket, prefix: 'records/', migrate }),
	]);
	const tick = runner.tick(controller.signal);
	const rejection = expect(tick).rejects.toThrow('shutdown');
	await started.promise;
	controller.abort(new Error('shutdown'));
	expect(await (await bucket.get(paths.migration('records-v1')))!.json()).toMatchObject({
		status: 'running',
	});
	release.resolve();
	await rejection;
	expect(migrate).toHaveBeenCalledTimes(BUCKET_SCAN_CONCURRENCY);
	expect(await (await bucket.get(paths.migration('records-v1')))!.json()).toMatchObject({
		version: 1,
		status: 'pending',
	});
	expect(runner.isComplete('records-v1')).toBe(false);
});

it.each([0, -1, 0.5, Infinity])('rejects an invalid batch size %s', (batchSize) => {
	expect(() =>
		bucketMigration({
			id: 'records-v1',
			bucket: new MemoryBucket(),
			prefix: '',
			migrate: async () => {},
			batchSize,
		}),
	).toThrow('positive integer');
});

it('learns completion once after restart and runs only the appended migration', async () => {
	const { bucket, definition, runner, migrate } = await fixture(0);
	await runner.tick();
	const next = vi.fn(async () => ({ done: true as const }));
	const restarted = new MigrationService(bucket, [
		definition,
		{ id: 'records-v2', runBatch: next },
	]);
	const get = vi.spyOn(bucket, 'get');
	expect(restarted.isComplete(definition.id)).toBe(false);
	expect(get).not.toHaveBeenCalled();
	expect(await restarted.tick()).toBe(true);
	expect(restarted.isComplete(definition.id)).toBe(true);
	expect(restarted.isComplete('records-v2')).toBe(true);
	expect(restarted.isComplete('unknown')).toBe(false);
	expect(migrate).not.toHaveBeenCalled();
	expect(next).toHaveBeenCalledTimes(1);
	get.mockClear();
	expect(await restarted.tick()).toBe(true);
	expect(get).not.toHaveBeenCalled();
});

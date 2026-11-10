import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ACTOR } from '@marimo-hub/core/testing';
import { paths } from '@marimo-hub/core';
import { BackgroundLoops } from './backgroundLoops';
import { startMigrations } from './cron';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('startup migrations', () => {
	it('runs immediately and stops polling after completion', async () => {
		const bucket = await createInitializedBucket();
		const deps = makeTestDeps(bucket);
		const project = await deps.services.projects.createProject(
			{ name: 'Existing', description: '' },
			ACTOR,
		);
		await deps.services.catalog.updateProjectEntry('test.legacy', ACTOR, project.id, () => ({
			access: undefined,
		}));
		const loops = new BackgroundLoops();
		const tick = vi.spyOn(deps.services.migrations, 'tick');
		const stop = startMigrations(deps, loops);
		try {
			await loops.drain();
			expect(tick).toHaveBeenCalledTimes(1);
			expect((await deps.services.catalog.getCurrentSnapshot()).projects[0].access?.version).toBe(
				1,
			);
			const get = vi.spyOn(bucket, 'get');
			await vi.advanceTimersByTimeAsync(60_000);
			expect(tick).toHaveBeenCalledTimes(1);
			expect(get).not.toHaveBeenCalled();
		} finally {
			stop();
			await loops.drain();
		}
	});

	it('retries failures in the background and reports health until recovery', async () => {
		const deps = makeTestDeps(await createInitializedBucket());
		const tick = vi
			.spyOn(deps.services.migrations, 'tick')
			.mockRejectedValueOnce(new Error('storage unavailable'));
		const loops = new BackgroundLoops();
		const stop = startMigrations(deps, loops);
		try {
			await loops.drain();
			expect(loops.health().loops.migrations.status).toBe('failing');
			await vi.advanceTimersByTimeAsync(5_000);
			await loops.drain();
			expect(tick).toHaveBeenCalledTimes(2);
			expect(await deps.bucket.get(paths.migration('project-access-v1'))).not.toBeNull();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(tick).toHaveBeenCalledTimes(2);
		} finally {
			stop();
			await loops.drain();
		}
	});

	it('passes shutdown cancellation to in-flight work and stops future ticks', async () => {
		const deps = makeTestDeps(await createInitializedBucket());
		const pending = Promise.withResolvers<boolean>();
		const tick = vi
			.spyOn(deps.services.migrations, 'tick')
			.mockImplementation(() => pending.promise);
		const loops = new BackgroundLoops();
		const stop = startMigrations(deps, loops);
		await vi.advanceTimersByTimeAsync(0);
		expect(tick).toHaveBeenCalledTimes(1);
		const signal = tick.mock.calls[0][0]!;
		stop();
		expect(signal.aborted).toBe(true);
		pending.resolve(false);
		await loops.drain();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(tick).toHaveBeenCalledTimes(1);
	});
});

it('does not overlap a timed-out attempt and retries after the stalled work settles', async () => {
	const deps = makeTestDeps(await createInitializedBucket());
	const pending = Promise.withResolvers<boolean>();
	const tick = vi
		.spyOn(deps.services.migrations, 'tick')
		.mockImplementationOnce(() => pending.promise);
	const loops = new BackgroundLoops();
	const stop = startMigrations(deps, loops);
	try {
		await vi.advanceTimersByTimeAsync(55_000);
		expect(tick).toHaveBeenCalledTimes(1);
		expect(tick.mock.calls[0][0]!.aborted).toBe(true);
		expect(loops.health().loops.migrations.status).toBe('stalled');
		await vi.advanceTimersByTimeAsync(15_000);
		expect(tick).toHaveBeenCalledTimes(1);
		pending.resolve(false);
		await loops.drain();
		await vi.advanceTimersByTimeAsync(5_000);
		await loops.drain();
		expect(tick).toHaveBeenCalledTimes(2);
		expect(await deps.bucket.get(paths.migration('project-access-v1'))).not.toBeNull();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(tick).toHaveBeenCalledTimes(2);
	} finally {
		pending.resolve(false);
		stop();
		await loops.drain();
	}
});

it('lets both replica loops stop after one completes the migration', async () => {
	const bucket = await createInitializedBucket();
	const first = makeTestDeps(bucket);
	const second = makeTestDeps(bucket);
	const batch = vi.spyOn(first.services.projects, 'migrateAccessSummaries');
	const otherBatch = vi.spyOn(second.services.projects, 'migrateAccessSummaries');
	const loops = [new BackgroundLoops(), new BackgroundLoops()];
	const stops = [startMigrations(first, loops[0]), startMigrations(second, loops[1])];
	try {
		await Promise.all(loops.map((loop) => loop.drain()));
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.all(loops.map((loop) => loop.drain()));
		expect(batch.mock.calls.length + otherBatch.mock.calls.length).toBe(1);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	} finally {
		for (const stop of stops) stop();
		await Promise.all(loops.map((loop) => loop.drain()));
	}
});

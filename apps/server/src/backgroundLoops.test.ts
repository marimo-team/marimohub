import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceLock } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { BackgroundLoops } from './backgroundLoops';

describe('BackgroundLoops', () => {
	let loops: BackgroundLoops;
	let handles: ReturnType<BackgroundLoops['start']>[];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		loops = new BackgroundLoops();
		handles = [];
	});

	afterEach(() => {
		for (const handle of handles) handle.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function start(run: Parameters<BackgroundLoops['start']>[0]['run'], lock?: MaintenanceLock) {
		const handle = loops.start({ name: 'test', intervalMs: 100, deadlineMs: 250, run, lock });
		handles.push(handle);
		return handle;
	}

	it('records idle successes, failures, staleness, and recovery without I/O from health', async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		start(run);
		await vi.advanceTimersByTimeAsync(0);
		expect(loops.health().loops.test).toMatchObject({
			last_started_at: 0,
			last_completed_at: 0,
			last_success_at: 0,
			last_duration_ms: 0,
		});
		run.mockRejectedValue(new Error('unavailable'));
		await vi.advanceTimersByTimeAsync(350);
		expect(loops.health()).toMatchObject({
			ok: false,
			loops: { test: { last_success_at: 0, last_completed_at: 300 } },
		});
		expect(loops.collect()).toMatchObject({
			'gauge.loop.test.seconds_since_success': 0.35,
			'gauge.loop.test.stale': 1,
		});
		run.mockResolvedValue(undefined);
		await vi.advanceTimersByTimeAsync(50);
		expect(loops.health()).toMatchObject({ ok: true, loops: { test: { last_success_at: 400 } } });
	});

	it.each(['resolve', 'reject'] as const)(
		'ignores a late %s while the successor is in flight',
		async (outcome) => {
			const first = Promise.withResolvers<void>();
			const second = Promise.withResolvers<void>();
			const run = vi
				.fn()
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise)
				.mockResolvedValue(undefined);
			const handle = start(run);
			await vi.advanceTimersByTimeAsync(200);
			expect(run).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(50);
			await handle.drain();
			expect(loops.health().loops.test).toMatchObject({
				timeouts: 1,
				running: false,
				last_success_at: null,
			});
			expect(run.mock.calls[0][0].signal.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(50);
			if (outcome === 'resolve') first.resolve();
			else first.reject(new Error('late failure'));
			await vi.advanceTimersByTimeAsync(100);
			expect(run).toHaveBeenCalledTimes(2);
			expect(loops.health().loops.test).toMatchObject({
				running: true,
				last_completed_at: 250,
				last_success_at: null,
				stale: true,
			});
			second.resolve();
			await handle.drain();
			expect(loops.health().loops.test).toMatchObject({
				running: false,
				last_success_at: 400,
				stale: false,
			});
			expect(loops.collect()['counter.loop.test.timeouts']).toBe(1);
		},
	);

	it('abandons later steps and lease release after a deadline', async () => {
		const lock = new MaintenanceLock(new MemoryBucket());
		const acquire = vi.spyOn(lock, 'acquire');
		const release = vi.spyOn(lock, 'release');
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const nextStep = vi.fn(async () => {});
		let calls = 0;
		const handle = start(async ({ step }) => {
			await step(() => (++calls === 1 ? first.promise : second.promise));
			await step(nextStep);
		}, lock);
		await vi.advanceTimersByTimeAsync(300);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(acquire.mock.calls[0][0]).not.toBe(acquire.mock.calls[1][0]);
		first.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(nextStep).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		second.resolve();
		await handle.drain();
		expect(nextStep).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
	});

	it('bounds drains for hung work and stops future ticks', async () => {
		const run = vi.fn(() => new Promise<void>(() => {}));
		const handle = start(run);
		handle.stop();
		await vi.advanceTimersByTimeAsync(250);
		await handle.drain();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledOnce();
		expect(loops.health().loops.test.stopped).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('treats an empty registry and lease contention as healthy progress', async () => {
		expect(loops.health()).toEqual({ ok: true, loops: {} });
		const lock = new MaintenanceLock(new MemoryBucket());
		vi.spyOn(lock, 'acquire').mockResolvedValue(false);
		const run = vi.fn();
		start(run, lock);
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).not.toHaveBeenCalled();
		expect(loops.health()).toMatchObject({ ok: true, loops: { test: { last_success_at: 1000 } } });
	});
});

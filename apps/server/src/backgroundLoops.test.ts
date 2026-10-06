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

	it('expires the lease at the run deadline after a slow eligibility check', async () => {
		const eligible = Promise.withResolvers<boolean>();
		const shouldRun = vi.fn().mockReturnValueOnce(eligible.promise).mockResolvedValue(true);
		const lock = new MaintenanceLock(new MemoryBucket());
		const run = vi
			.fn()
			.mockImplementationOnce(() => new Promise<void>(() => {}))
			.mockResolvedValue(undefined);
		handles.push(
			loops.start({ name: 'test', intervalMs: 100, deadlineMs: 250, shouldRun, lock, run }),
		);
		await vi.advanceTimersByTimeAsync(200);
		eligible.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
		expect(loops.health().loops.test).toMatchObject({ timeouts: 1, last_success_at: 300 });
	});

	it.each(['eligibility', 'acquire', 'work', 'release'] as const)(
		'counts repeated %s errors as failures and recovers',
		async (phase) => {
			const lock = new MaintenanceLock(new MemoryBucket());
			const shouldRun = vi.fn(async () => true);
			const acquire = vi.spyOn(lock, 'acquire').mockResolvedValue(true);
			const release = vi.spyOn(lock, 'release').mockResolvedValue(undefined);
			const run = vi.fn(async () => {});
			const operation = { eligibility: shouldRun, acquire, work: run, release }[phase];
			operation.mockRejectedValue(new Error(`${phase} unavailable`));
			handles.push(
				loops.start({ name: 'test', intervalMs: 100, deadlineMs: 250, shouldRun, lock, run }),
			);
			await vi.advanceTimersByTimeAsync(350);
			expect(loops.health()).toMatchObject({
				ok: false,
				loops: {
					test: { last_completed_at: 300, last_success_at: null, timeouts: 0, running: false },
				},
			});
			if (phase === 'eligibility' || phase === 'acquire') {
				expect(run).not.toHaveBeenCalled();
				expect(release).not.toHaveBeenCalled();
			} else expect(release).toHaveBeenCalledTimes(4);
			expect(console.log).toHaveBeenCalledTimes(4);
			shouldRun.mockResolvedValue(true);
			acquire.mockResolvedValue(true);
			run.mockResolvedValue(undefined);
			release.mockResolvedValue(undefined);
			await vi.advanceTimersByTimeAsync(50);
			expect(loops.health().loops.test).toMatchObject({ last_success_at: 400, stale: false });
		},
	);

	it.each(['eligibility', 'acquire'] as const)(
		'does not start work when a timed-out %s resolves late',
		async (phase) => {
			const late = Promise.withResolvers<boolean>();
			const lock = new MaintenanceLock(new MemoryBucket());
			const acquire = vi.spyOn(lock, 'acquire').mockResolvedValue(true);
			const release = vi.spyOn(lock, 'release').mockResolvedValue(undefined);
			const shouldRun = vi.fn(async () => true);
			(phase === 'eligibility' ? shouldRun : acquire).mockReturnValueOnce(late.promise);
			const run = vi.fn(async () => {});
			handles.push(
				loops.start({ name: 'test', intervalMs: 100, deadlineMs: 250, shouldRun, lock, run }),
			);
			await vi.advanceTimersByTimeAsync(300);
			expect(run).toHaveBeenCalledOnce();
			const recovered = loops.health();
			late.resolve(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(run).toHaveBeenCalledOnce();
			expect(release).toHaveBeenCalledOnce();
			expect(loops.health()).toEqual(recovered);
			expect(console.log).toHaveBeenCalledOnce();
		},
	);

	it('clears the deadline when a run completes just before it', async () => {
		const done = Promise.withResolvers<void>();
		const handle = start(() => done.promise);
		await vi.advanceTimersByTimeAsync(249);
		done.resolve();
		await handle.drain();
		handle.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(loops.health().loops.test).toMatchObject({
			last_success_at: 249,
			last_duration_ms: 249,
			timeouts: 0,
		});
		expect(console.log).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reports staleness at the exact grace boundary without healthy loops masking it', async () => {
		start(() => new Promise<void>(() => {}));
		handles.push(
			loops.start({ name: 'healthy', intervalMs: 50, deadlineMs: 250, run: async () => {} }),
		);
		await vi.advanceTimersByTimeAsync(349);
		expect(loops.health().ok).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(loops.health()).toMatchObject({
			ok: false,
			loops: { test: { stale: true }, healthy: { stale: false, last_success_at: 350 } },
		});
	});

	it('contains a synchronous throw and retries without leaking a deadline timer', async () => {
		const run = vi
			.fn(async () => {})
			.mockImplementationOnce(() => {
				throw new Error('synchronous failure');
			});
		const handle = start(run);
		await handle.drain();
		expect(loops.health().loops.test.last_success_at).toBeNull();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('lets an in-flight leased run finish during shutdown', async () => {
		const done = Promise.withResolvers<void>();
		const lock = new MaintenanceLock(new MemoryBucket());
		const release = vi.spyOn(lock, 'release');
		const run = vi.fn<Parameters<BackgroundLoops['start']>[0]['run']>(async ({ signal }) => {
			await done.promise;
			expect(signal.aborted).toBe(false);
		});
		const handle = start(run, lock);
		await vi.advanceTimersByTimeAsync(0);
		handle.stop();
		let drained = false;
		const draining = handle.drain().then(() => {
			drained = true;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(drained).toBe(false);
		done.resolve();
		await draining;
		expect(release).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
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

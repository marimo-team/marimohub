import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceLock } from '@marimo-hub/core';
import type { Metrics } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { BackgroundLoops } from './backgroundLoops';

type LoopOptions = Parameters<BackgroundLoops['start']>[0];

function events() {
	return vi
		.mocked(console.log)
		.mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>);
}

describe('BackgroundLoops', () => {
	let loops: BackgroundLoops;
	let lock: MaintenanceLock;
	let handles: ReturnType<BackgroundLoops['start']>[];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		loops = new BackgroundLoops();
		lock = new MaintenanceLock(new MemoryBucket());
		handles = [];
	});

	afterEach(() => {
		for (const handle of handles) handle.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function start(run: LoopOptions['run'], options: Partial<Omit<LoopOptions, 'run'>> = {}) {
		const handle = loops.start({ name: 'test', intervalMs: 100, deadlineMs: 250, ...options, run });
		handles.push(handle);
		return handle;
	}

	it('serves the documented health body', async () => {
		expect(loops.health()).toEqual({ status: 'ok', loops: {} });
		start(async () => {});
		await vi.advanceTimersByTimeAsync(150);
		expect(loops.health()).toEqual({
			status: 'ok',
			loops: {
				test: {
					status: 'ok',
					last_started_at: 100,
					last_completed_at: 100,
					last_success_at: 100,
					last_duration_ms: 0,
					seconds_since_success: 0.05,
					consecutive_failures: 0,
					timeouts: 0,
					interval_ms: 100,
					deadline_ms: 250,
				},
			},
		});
		expect(loops.collect()).toEqual({
			'gauge.loop.test.seconds_since_success': 0.05,
			'gauge.loop.test.last_duration_ms': 0,
			'gauge.loop.test.consecutive_failures': 0,
			'gauge.loop.test.stalled': 0,
			'counter.loop.test.timeouts': 0,
		});
	});

	it('reports a failing dependency as degraded rather than stalled, then recovers', async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		start(run);
		await vi.advanceTimersByTimeAsync(0);
		run.mockRejectedValue(new Error('unavailable'));
		// Long past deadline + interval: persistent failures must not look like a wedged loop.
		await vi.advanceTimersByTimeAsync(1050);
		expect(loops.health()).toMatchObject({
			status: 'degraded',
			loops: {
				test: {
					status: 'failing',
					consecutive_failures: 10,
					last_success_at: 0,
					last_completed_at: 1000,
					timeouts: 0,
				},
			},
		});
		expect(loops.collect()).toMatchObject({
			'gauge.loop.test.seconds_since_success': 1.05,
			'gauge.loop.test.consecutive_failures': 10,
			'gauge.loop.test.stalled': 0,
		});
		const failures = events().filter((event) => event.event === 'test_failed');
		expect(failures).toHaveLength(10);
		expect(failures[0]).toMatchObject({ level: 'error', error: 'unavailable', name: 'Error' });
		run.mockResolvedValue(undefined);
		await vi.advanceTimersByTimeAsync(50);
		expect(loops.health()).toMatchObject({
			status: 'ok',
			loops: { test: { status: 'ok', consecutive_failures: 0, last_success_at: 1100 } },
		});
	});

	it('logs non-Error failures with their string form', async () => {
		// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises the non-Error path
		start(() => Promise.reject(42), { failureEvent: 'custom_failed' });
		await vi.advanceTimersByTimeAsync(0);
		expect(events()).toEqual([
			expect.objectContaining({ level: 'error', event: 'custom_failed', error: '42' }),
		]);
	});

	it.each(['resolve', 'reject'] as const)(
		'holds the in-flight guard for hung work and ignores its late %s',
		async (outcome) => {
			const hung = Promise.withResolvers<void>();
			const run = vi.fn().mockReturnValueOnce(hung.promise).mockResolvedValue(undefined);
			const onSuccess = vi.fn();
			start(run, { overlapEvent: 'test_overlap', onSuccess });
			await vi.advanceTimersByTimeAsync(250);
			expect(run.mock.calls[0][0].signal.aborted).toBe(true);
			expect(loops.health()).toMatchObject({
				status: 'stalled',
				loops: { test: { status: 'stalled', timeouts: 1, consecutive_failures: 1 } },
			});
			expect(events()).toContainEqual(
				expect.objectContaining({ level: 'error', event: 'test_stalled', deadline_ms: 250 }),
			);
			await vi.advanceTimersByTimeAsync(200);
			expect(run).toHaveBeenCalledOnce();
			expect(events().filter((event) => event.event === 'test_overlap')).toHaveLength(4);
			expect(loops.collect()).toMatchObject({
				'gauge.loop.test.stalled': 1,
				'counter.loop.test.timeouts': 1,
			});

			if (outcome === 'resolve') hung.resolve();
			else hung.reject(new Error('late failure'));
			await vi.advanceTimersByTimeAsync(0);
			expect(events().at(-1)).toMatchObject({ level: 'debug', event: 'test_recovered' });
			expect(events().some((event) => event.event === 'test_failed')).toBe(false);
			expect(onSuccess).not.toHaveBeenCalled();
			expect(loops.health()).toMatchObject({
				status: 'degraded',
				loops: { test: { status: 'failing', last_success_at: null } },
			});

			await vi.advanceTimersByTimeAsync(50);
			expect(run).toHaveBeenCalledTimes(2);
			expect(onSuccess).toHaveBeenCalledOnce();
			expect(loops.health()).toMatchObject({
				status: 'ok',
				loops: { test: { status: 'ok', last_success_at: 500, timeouts: 1 } },
			});
		},
	);

	it('holds the attempt on a hung step until it settles, then skips later steps', async () => {
		const hung = Promise.withResolvers<void>();
		const after = vi.fn();
		const run = vi.fn<LoopOptions['run']>(async ({ step }) => {
			await step(() => hung.promise);
			after();
		});
		start(run);
		await vi.advanceTimersByTimeAsync(300);
		expect(events().map((event) => event.event)).toEqual(['test_stalled']);
		expect(loops.health().loops.test.status).toBe('stalled');
		expect(run).toHaveBeenCalledOnce();
		hung.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(events().map((event) => event.event)).toEqual(['test_stalled', 'test_recovered']);
		expect(after).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
		expect(after).toHaveBeenCalledOnce();
		expect(loops.health().loops.test).toMatchObject({ status: 'ok', timeouts: 1 });
	});

	it('uses a fresh lease holder per attempt and abandons later steps and release after a deadline', async () => {
		const acquire = vi.spyOn(lock, 'acquire');
		const release = vi.spyOn(lock, 'release');
		const first = Promise.withResolvers<void>();
		const nextStep = vi.fn(async () => {});
		let calls = 0;
		const handle = start(
			async ({ step }) => {
				if (++calls === 1) await step(() => first.promise);
				await step(nextStep);
			},
			{ lock },
		);
		await vi.advanceTimersByTimeAsync(300);
		expect(acquire).toHaveBeenCalledOnce();
		expect(acquire.mock.calls[0][1]).toBe(250);
		first.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(nextStep).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		await handle.drain();
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(acquire.mock.calls[0][0]).not.toBe(acquire.mock.calls[1][0]);
		expect(nextStep).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0][0]).toBe(acquire.mock.calls[1][0]);
	});

	it('passes no holder to unleased loops', async () => {
		const run = vi.fn<LoopOptions['run']>(async () => {});
		start(run);
		await vi.advanceTimersByTimeAsync(0);
		expect(run.mock.calls[0][0].holder).toBeUndefined();
	});

	it('shrinks the lease to the remaining deadline after a slow eligibility check', async () => {
		const eligible = Promise.withResolvers<boolean>();
		const acquire = vi.spyOn(lock, 'acquire');
		start(async () => {}, {
			shouldRun: vi.fn().mockReturnValueOnce(eligible.promise).mockResolvedValue(true),
			lock,
		});
		await vi.advanceTimersByTimeAsync(200);
		eligible.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(acquire).toHaveBeenCalledWith(expect.any(String), 50);
	});

	it.each(['eligibility', 'acquire'] as const)(
		'does not start work when a timed-out %s resolves late',
		async (phase) => {
			const late = Promise.withResolvers<boolean>();
			const acquire = vi.spyOn(lock, 'acquire').mockResolvedValue(true);
			vi.spyOn(lock, 'release').mockResolvedValue(undefined);
			const shouldRun = vi.fn(async () => true);
			(phase === 'eligibility' ? shouldRun : acquire).mockReturnValueOnce(late.promise);
			const run = vi.fn(async () => {});
			start(run, { shouldRun, lock });
			await vi.advanceTimersByTimeAsync(300);
			expect(loops.health().loops.test.status).toBe('stalled');
			expect(run).not.toHaveBeenCalled();
			late.resolve(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(run).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(100);
			expect(run).toHaveBeenCalledOnce();
			expect(loops.health().loops.test).toMatchObject({
				status: 'ok',
				timeouts: 1,
				last_success_at: 400,
			});
		},
	);

	it.each(['eligibility', 'acquire', 'work'] as const)(
		'counts repeated %s errors as failures and recovers',
		async (phase) => {
			const shouldRun = vi.fn(async () => true);
			const acquire = vi.spyOn(lock, 'acquire').mockResolvedValue(true);
			const release = vi.spyOn(lock, 'release').mockResolvedValue(undefined);
			const run = vi.fn(async () => {});
			const operation = { eligibility: shouldRun, acquire, work: run }[phase];
			operation.mockRejectedValue(new Error(`${phase} unavailable`));
			start(run, { shouldRun, lock });
			await vi.advanceTimersByTimeAsync(350);
			expect(loops.health().loops.test).toMatchObject({
				status: 'failing',
				consecutive_failures: 4,
				last_success_at: null,
				timeouts: 0,
			});
			if (phase === 'work') expect(release).toHaveBeenCalledTimes(4);
			else {
				expect(run).not.toHaveBeenCalled();
				expect(release).not.toHaveBeenCalled();
			}
			operation.mockResolvedValue(true as never);
			await vi.advanceTimersByTimeAsync(50);
			expect(loops.health().loops.test).toMatchObject({ status: 'ok', last_success_at: 400 });
		},
	);

	it.each([false, true])(
		'keeps the sweep outcome when release fails (sweep failed: %s)',
		async (failed) => {
			vi.spyOn(lock, 'acquire').mockResolvedValue(true);
			vi.spyOn(lock, 'release').mockRejectedValue(new Error('release unavailable'));
			const onSuccess = vi.fn();
			start(
				async () => {
					if (failed) throw new Error('sweep failed');
				},
				{ lock, onSuccess },
			);
			await vi.advanceTimersByTimeAsync(350);
			expect(loops.health().loops.test).toMatchObject({
				status: failed ? 'failing' : 'ok',
				last_success_at: failed ? null : 300,
			});
			expect(onSuccess).toHaveBeenCalledTimes(failed ? 0 : 4);
			expect(events().filter((event) => event.event === 'test_release_failed')).toHaveLength(4);
			const failures = events().filter((event) => event.event === 'test_failed');
			expect(failures).toHaveLength(failed ? 4 : 0);
			for (const event of failures) expect(event.error).toBe('sweep failed');
		},
	);

	it('reports success only after lease release', async () => {
		const release = Promise.withResolvers<void>();
		vi.spyOn(lock, 'acquire').mockResolvedValue(true);
		vi.spyOn(lock, 'release').mockReturnValueOnce(release.promise);
		const reports: unknown[] = [];
		const onSuccess = vi.fn(() => {
			reports.push(loops.health().loops.test.last_success_at);
		});
		start(async () => {}, { lock, onSuccess });
		await vi.advanceTimersByTimeAsync(50);
		expect(onSuccess).not.toHaveBeenCalled();
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(reports).toEqual([50]);
	});

	it('does not report skipped work or let a report failure wedge the loop', async () => {
		const shouldRun = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		const onSuccess = vi.fn(() => {
			throw new Error('report unavailable');
		});
		const handle = start(async () => {}, { shouldRun, onSuccess });
		await handle.drain();
		expect(onSuccess).not.toHaveBeenCalled();
		expect(loops.health().loops.test).toMatchObject({ status: 'ok', last_success_at: 0 });
		await vi.advanceTimersByTimeAsync(200);
		expect(onSuccess).toHaveBeenCalledTimes(2);
		expect(events().map((event) => event.event)).toEqual([
			'test_report_failed',
			'test_report_failed',
		]);
	});

	it('treats lease contention as healthy progress', async () => {
		vi.spyOn(lock, 'acquire').mockResolvedValue(false);
		const run = vi.fn();
		start(run, { lock, notLeaderEvent: 'test_not_leader' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).not.toHaveBeenCalled();
		expect(loops.health()).toMatchObject({
			status: 'ok',
			loops: { test: { last_success_at: 1000 } },
		});
		expect(events()[0]).toMatchObject({ level: 'debug', event: 'test_not_leader' });
	});

	it('contains a synchronous throw and clears the deadline timer', async () => {
		const run = vi
			.fn(async () => {})
			.mockImplementationOnce(() => {
				throw new Error('synchronous failure');
			});
		const handle = start(run);
		await handle.drain();
		expect(loops.health().loops.test.status).toBe('failing');
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reports stopping after stop without failing overall health', async () => {
		const run = vi.fn(async () => {});
		const handle = start(run);
		await handle.drain();
		handle.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledOnce();
		expect(loops.health()).toMatchObject({ status: 'ok', loops: { test: { status: 'stopping' } } });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('lets an in-flight leased run finish during shutdown', async () => {
		const done = Promise.withResolvers<void>();
		const release = vi.spyOn(lock, 'release');
		const run = vi.fn<LoopOptions['run']>(async ({ signal }) => {
			await done.promise;
			expect(signal.aborted).toBe(false);
		});
		const handle = start(run, { lock, deadlineMs: 10_000 });
		await vi.advanceTimersByTimeAsync(0);
		let drained = false;
		const disposing = handle[Symbol.asyncDispose]().then(() => {
			drained = true;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(drained).toBe(false);
		done.resolve();
		await disposing;
		expect(release).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('aborts abortOnStop work without logging a failure', async () => {
		const run = vi.fn<LoopOptions['run']>(
			({ signal }) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason as Error));
				}),
		);
		const handle = start(run, { abortOnStop: true });
		await vi.advanceTimersByTimeAsync(0);
		handle[Symbol.dispose]();
		await handle.drain();
		expect(run.mock.calls[0][0].signal.aborted).toBe(true);
		expect(events()).toEqual([]);
		expect(loops.health().loops.test).toMatchObject({ status: 'stopping', timeouts: 0 });
	});

	it('publishes tagged loop metrics on completion and stalls', async () => {
		const metrics = { increment: vi.fn(), gauge: vi.fn() } satisfies Metrics;
		loops = new BackgroundLoops(metrics);
		const hung = Promise.withResolvers<void>();
		start(vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(hung.promise));
		await vi.advanceTimersByTimeAsync(0);
		const tags = { loop: 'test' };
		expect(metrics.gauge).toHaveBeenCalledWith('loop.seconds_since_success', 0, tags);
		expect(metrics.gauge).toHaveBeenCalledWith('loop.consecutive_failures', 0, tags);
		expect(metrics.gauge).toHaveBeenCalledWith('loop.last_duration_ms', 0, tags);
		expect(metrics.gauge).toHaveBeenCalledWith('loop.stalled', 0, tags);
		await vi.advanceTimersByTimeAsync(350);
		expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('loop.timeouts', 1, tags);
		expect(metrics.gauge).toHaveBeenLastCalledWith('loop.stalled', 1, tags);
		hung.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(metrics.gauge).toHaveBeenLastCalledWith('loop.stalled', 0, tags);
	});
});

describe('BackgroundLoops tracing', () => {
	let exporter: InMemorySpanExporter;
	let provider: NodeTracerProvider;
	let stop: (() => void) | undefined;

	beforeEach(() => {
		stop = undefined;
		vi.useFakeTimers();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		exporter = new InMemorySpanExporter();
		provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		provider.register();
	});

	afterEach(async () => {
		stop?.();
		await provider.shutdown();
		trace.disable();
		context.disable();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('parents spans created inside an attempt under the loop span', async () => {
		const loops = new BackgroundLoops();
		const handle = loops.start({
			name: 'test',
			intervalMs: 100,
			run: async () => {
				trace.getTracer('test').startActiveSpan('child', (span) => span.end());
			},
		});
		stop = handle.stop;
		await handle.drain();
		const spans = exporter.getFinishedSpans();
		const loop = spans.find((span) => span.name === 'loop.test')!;
		const child = spans.find((span) => span.name === 'child')!;
		expect(child.spanContext().traceId).toBe(loop.spanContext().traceId);
		expect(child.parentSpanContext?.spanId).toBe(loop.spanContext().spanId);
		expect(loop.attributes).toMatchObject({
			'marimohub.loop.name': 'test',
			'marimohub.loop.outcome': 'success',
		});
		expect(loop.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	it('marks stalled attempts as errors', async () => {
		const loops = new BackgroundLoops();
		const handle = loops.start({
			name: 'test',
			intervalMs: 100,
			deadlineMs: 250,
			run: () => new Promise<void>(() => {}),
		});
		stop = handle.stop;
		await vi.advanceTimersByTimeAsync(250);
		const [loop] = exporter.getFinishedSpans();
		expect(loop.attributes['marimohub.loop.outcome']).toBe('stalled');
		expect(loop.status).toMatchObject({
			code: SpanStatusCode.ERROR,
			message: 'test exceeded its 250 ms deadline',
		});
	});
});

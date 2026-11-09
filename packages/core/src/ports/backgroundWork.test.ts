import { logs } from '@opentelemetry/api-logs';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundWorkFrom, deferOrAwait, inlineBackgroundWork } from './backgroundWork';
import type { BackgroundWork } from './backgroundWork';
import { queuedBackgroundWork } from '../testing/backgroundWork';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('deferOrAwait', () => {
	it.each([undefined, inlineBackgroundWork])('waits for inline work (%s)', async (work) => {
		const gate = Promise.withResolvers<void>();
		let completed = false;
		const done = deferOrAwait(work, 'test', () => gate.promise).then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		gate.resolve();
		await done;
		expect(completed).toBe(true);
	});

	it('hands a lazy task to the host without waiting for execution', async () => {
		const host = queuedBackgroundWork();
		const task = vi.fn(async () => {});
		await deferOrAwait(host.work, 'test', task);
		expect(task).not.toHaveBeenCalled();
		expect(host.labels).toEqual(['test']);
		await host.runAll();
		expect(task).toHaveBeenCalledOnce();
		expect(host.pending()).toBe(0);
	});

	it('adapts a promise sink without starting the task synchronously', async () => {
		const kept: Promise<unknown>[] = [];
		const task = vi.fn(async () => 'done');
		await deferOrAwait(
			backgroundWorkFrom((work) => kept.push(work)),
			'test',
			task,
		);
		expect(kept).toHaveLength(1);
		await Promise.all(kept);
		expect(task).toHaveBeenCalledOnce();
	});

	it('records execution time without including time in the host queue', async () => {
		vi.useFakeTimers();
		const host = queuedBackgroundWork();
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const gate = Promise.withResolvers<void>();
		await deferOrAwait(host.work, 'test.queued', () => gate.promise, metrics);
		vi.advanceTimersByTime(1_000);
		expect(metrics.gauge).not.toHaveBeenCalled();
		expect(metrics.histogram).not.toHaveBeenCalled();
		const pending = host.runAll();
		expect(metrics.gauge).toHaveBeenCalledExactlyOnceWith('background.in_flight', 1, {
			label: 'test.queued',
		});
		vi.advanceTimersByTime(25);
		gate.resolve();
		await pending;
		expect(metrics.gauge).toHaveBeenLastCalledWith('background.in_flight', 0, {
			label: 'test.queued',
		});
		expect(metrics.histogram).toHaveBeenCalledExactlyOnceWith('background.duration_ms', 25, {
			label: 'test.queued',
		});
	});

	it('aggregates concurrent tasks by label within each metrics sink', async () => {
		vi.useFakeTimers();
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const otherMetrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const differentLabel = Promise.withResolvers<void>();
		const differentSink = Promise.withResolvers<void>();
		const pending = [
			deferOrAwait(undefined, 'test.a', () => first.promise, metrics),
			deferOrAwait(undefined, 'test.a', () => second.promise, metrics),
			deferOrAwait(undefined, 'test.b', () => differentLabel.promise, metrics),
			deferOrAwait(undefined, 'test.a', () => differentSink.promise, otherMetrics),
		];
		expect(metrics.gauge.mock.calls).toEqual([
			['background.in_flight', 1, { label: 'test.a' }],
			['background.in_flight', 2, { label: 'test.a' }],
			['background.in_flight', 1, { label: 'test.b' }],
		]);
		expect(otherMetrics.gauge).toHaveBeenCalledExactlyOnceWith('background.in_flight', 1, {
			label: 'test.a',
		});
		vi.advanceTimersByTime(10);
		first.resolve();
		await pending[0];
		expect(metrics.gauge).toHaveBeenLastCalledWith('background.in_flight', 1, { label: 'test.a' });
		vi.advanceTimersByTime(20);
		second.resolve();
		differentLabel.resolve();
		differentSink.resolve();
		await Promise.all(pending);
		expect(metrics.gauge.mock.calls.slice(3)).toEqual([
			['background.in_flight', 1, { label: 'test.a' }],
			['background.in_flight', 0, { label: 'test.a' }],
			['background.in_flight', 0, { label: 'test.b' }],
		]);
		expect(otherMetrics.gauge).toHaveBeenLastCalledWith('background.in_flight', 0, {
			label: 'test.a',
		});
		expect(metrics.histogram.mock.calls).toEqual([
			['background.duration_ms', 10, { label: 'test.a' }],
			['background.duration_ms', 30, { label: 'test.a' }],
			['background.duration_ms', 30, { label: 'test.b' }],
		]);
	});

	it('records duration and clears the running count when a task rejects', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const gate = Promise.withResolvers<void>();
		const pending = deferOrAwait(undefined, 'test.failure', () => gate.promise, metrics);
		vi.advanceTimersByTime(15);
		gate.reject(new Error('task failed'));
		await expect(pending).resolves.toBeUndefined();
		expect(metrics.gauge.mock.calls).toEqual([
			['background.in_flight', 1, { label: 'test.failure' }],
			['background.in_flight', 0, { label: 'test.failure' }],
		]);
		expect(metrics.histogram).toHaveBeenCalledExactlyOnceWith('background.duration_ms', 15, {
			label: 'test.failure',
		});
		expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('background.failed', 1, {
			label: 'test.failure',
		});
	});

	it('contains an asynchronous scheduler rejection without running the task', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const task = vi.fn(async () => {});
		await expect(
			deferOrAwait(
				{
					defer: async () => {
						throw new Error('host closed');
					},
				},
				'test.schedule',
				task,
				metrics,
			),
		).resolves.toBeUndefined();
		expect(task).not.toHaveBeenCalled();
		expect(metrics.gauge).not.toHaveBeenCalled();
		expect(metrics.histogram).not.toHaveBeenCalled();
		expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('background.failed', 1, {
			label: 'test.schedule',
		});
	});

	it('contains synchronous task failures even when logging and metrics fail', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {
			throw new Error('log sink unavailable');
		});
		const increment = vi.fn(() => {
			throw new Error('metrics unavailable');
		});
		const gauge = vi.fn((): void => {
			throw new Error('metrics unavailable');
		});
		const histogram = vi.fn((): void => {
			throw new Error('metrics unavailable');
		});
		const metrics = { increment, gauge, histogram };
		const task = vi.fn(() => {
			throw new Error('task failed');
		});
		await expect(deferOrAwait(undefined, 'test.telemetry', task, metrics)).resolves.toBeUndefined();
		expect(task).toHaveBeenCalledOnce();
		expect(increment).toHaveBeenCalledOnce();
		expect(gauge.mock.calls).toEqual([
			['background.in_flight', 1, { label: 'test.telemetry' }],
			['background.in_flight', 0, { label: 'test.telemetry' }],
		]);
		expect(histogram).toHaveBeenCalledOnce();
		gauge.mockImplementation(() => {});
		histogram.mockImplementation(() => {});
		const successful = vi.fn(async () => {});
		await deferOrAwait(undefined, 'test.telemetry', successful, metrics);
		expect(successful).toHaveBeenCalledOnce();
		expect(gauge.mock.calls.slice(2)).toEqual([
			['background.in_flight', 1, { label: 'test.telemetry' }],
			['background.in_flight', 0, { label: 'test.telemetry' }],
		]);
	});

	it('continues draining after one deferred task rejects', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const host = queuedBackgroundWork();
		const succeeded = vi.fn(async () => {});
		await deferOrAwait(host.work, 'test.bad', async () => {
			throw new Error('failed');
		});
		await deferOrAwait(host.work, 'test.good', succeeded);
		await expect(host.runAll()).resolves.toBeUndefined();
		expect(succeeded).toHaveBeenCalledOnce();
	});

	it.each(['inline', 'deferred', 'scheduler'] as const)(
		'logs and counts %s failures without throwing',
		async (mode) => {
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const metrics = { increment: vi.fn(), gauge: vi.fn() };
			const queue: (() => Promise<unknown>)[] = [];
			const work: BackgroundWork | undefined =
				mode === 'inline'
					? undefined
					: {
							defer(_label, task) {
								if (mode === 'scheduler') throw new Error('scheduler failed');
								queue.push(task);
							},
						};
			await expect(
				deferOrAwait(
					work,
					'test.failure',
					async () => {
						throw new Error('secret');
					},
					metrics,
					{ project_id: 'p1', notebook_id: 'n1', operation: 'overridden' },
				),
			).resolves.toBeUndefined();
			for (const task of queue) await expect(task()).resolves.toBeUndefined();
			expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('background.failed', 1, {
				label: 'test.failure',
			});
			expect(log).toHaveBeenCalledOnce();
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
				event: 'background_work_failed',
				level: 'error',
				operation: 'test.failure',
				project_id: 'p1',
				notebook_id: 'n1',
			});
			expect(JSON.parse(log.mock.calls[0][0])).not.toHaveProperty('label');
			expect(log.mock.calls[0][0]).not.toContain('secret');
		},
	);

	it('exports failures to the OTEL logs pipeline', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const exporter = new InMemoryLogRecordExporter();
		const provider = new LoggerProvider({
			processors: [new SimpleLogRecordProcessor({ exporter })],
		});
		logs.setGlobalLoggerProvider(provider);
		try {
			await deferOrAwait(
				undefined,
				'test.export',
				async () => {
					throw new Error('secret');
				},
				undefined,
				{ project_id: 'p1' },
			);
			const [record] = exporter.getFinishedLogRecords();
			expect(record.body).toBe('background_work_failed');
			expect(record.attributes).toMatchObject({
				operation: 'test.export',
				project_id: 'p1',
				error: { name: 'Error' },
			});
			expect(JSON.stringify(record.attributes)).not.toContain('secret');
		} finally {
			logs.disable();
			await provider.shutdown();
		}
	});
});

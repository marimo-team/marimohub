import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferOrAwait, inlineBackgroundWork } from './backgroundWork';
import type { BackgroundWork } from './backgroundWork';

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
		const queue: (() => Promise<unknown>)[] = [];
		const task = vi.fn(async () => {});
		await deferOrAwait(
			{
				defer: (_label, run) => {
					queue.push(run);
				},
			},
			'test',
			task,
		);
		expect(task).not.toHaveBeenCalled();
		await queue[0]();
		expect(task).toHaveBeenCalledOnce();
	});

	it('records execution time without including time in the host queue', async () => {
		vi.useFakeTimers();
		const tasks: (() => Promise<unknown>)[] = [];
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const gate = Promise.withResolvers<void>();
		await deferOrAwait(
			{ defer: (_label, task) => void tasks.push(task) },
			'test.queued',
			() => gate.promise,
			metrics,
		);
		vi.advanceTimersByTime(1_000);
		expect(metrics.gauge).not.toHaveBeenCalled();
		expect(metrics.histogram).not.toHaveBeenCalled();
		const pending = tasks[0]();
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
		vi.spyOn(console, 'error').mockImplementation(() => {});
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
		vi.spyOn(console, 'error').mockImplementation(() => {});
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
		vi.spyOn(console, 'error').mockImplementation(() => {
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
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const tasks: (() => Promise<unknown>)[] = [];
		const work: BackgroundWork = {
			defer: (_label, task) => {
				tasks.push(task);
			},
		};
		const succeeded = vi.fn(async () => {});
		await deferOrAwait(work, 'test.bad', async () => {
			throw new Error('failed');
		});
		await deferOrAwait(work, 'test.good', succeeded);
		await expect(Promise.all(tasks.map((task) => task()))).resolves.toEqual([undefined, undefined]);
		expect(succeeded).toHaveBeenCalledOnce();
	});

	it.each(['inline', 'deferred', 'scheduler'] as const)(
		'logs and counts %s failures without throwing',
		async (mode) => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
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
					{ project_id: 'p1', notebook_id: 'n1', operation: 'overridden', label: 'overridden' },
				),
			).resolves.toBeUndefined();
			for (const task of queue) await expect(task()).resolves.toBeUndefined();
			expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('background.failed', 1, {
				label: 'test.failure',
			});
			expect(log).toHaveBeenCalledOnce();
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
				event: 'background_work_failed',
				operation: 'test.failure',
				label: 'test.failure',
				project_id: 'p1',
				notebook_id: 'n1',
			});
			expect(log.mock.calls[0][0]).not.toContain('secret');
		},
	);
});

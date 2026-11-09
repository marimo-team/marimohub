import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferOrAwait, inlineBackgroundWork } from './backgroundWork';
import type { BackgroundWork } from './backgroundWork';

afterEach(() => vi.restoreAllMocks());

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

	it('contains an asynchronous scheduler rejection without running the task', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
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
		await expect(
			deferOrAwait(
				undefined,
				'test.telemetry',
				() => {
					throw new Error('task failed');
				},
				{ increment, gauge: vi.fn() },
			),
		).resolves.toBeUndefined();
		expect(increment).toHaveBeenCalledOnce();
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSession, MemoryBucket } from '@marimo-hub/core/testing';
import { makeTestDeps } from './testing';
import { deferTeardown } from './shared';

afterEach(() => vi.restoreAllMocks());

describe('teardown scheduling fallback', () => {
	it.each(['reject', 'queue-then-reject', 'start-then-reject', 'async-reject', 'legacy'] as const)(
		'awaits one cleanup and retains log context when the host does %s',
		async (mode) => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
			const session = makeSession();
			const context = {
				project_id: session.project_id,
				notebook_id: session.notebook_id,
				session_id: session.session_id,
			};
			const queued: (() => Promise<unknown>)[] = [];
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const task = vi.fn(() => {
				entered.resolve();
				return gate.promise;
			});
			const deps = makeTestDeps(new MemoryBucket(), {
				metrics,
				...(mode === 'legacy'
					? {
							backgroundTasks: {
								defer: () => {
									throw new Error('host closed');
								},
							},
						}
					: {
							backgroundWork: {
								defer: (_label, run) => {
									if (mode === 'queue-then-reject') queued.push(run);
									if (mode === 'start-then-reject') void run();
									if (mode === 'async-reject') return Promise.reject(new Error('host closed'));
									throw new Error('host closed');
								},
							},
						}),
			});
			let settled = false;
			const pending = deferTeardown(deps, 'session.stop', task, context).then(() => {
				settled = true;
			});
			await entered.promise;
			expect(settled).toBe(false);
			gate.resolve();
			await pending;
			for (const run of queued) await run();
			expect(task).toHaveBeenCalledOnce();
			expect(metrics.histogram).toHaveBeenCalledExactlyOnceWith(
				'background.duration_ms',
				expect.any(Number),
				{ label: 'session.stop' },
			);
			expect(metrics.gauge).toHaveBeenLastCalledWith('background.in_flight', 0, {
				label: 'session.stop',
			});
			expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('background.failed', 1, {
				label: 'session.stop',
			});
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
				...context,
				event: 'background_work_failed',
				label: 'session.stop',
			});
		},
	);

	it('isolates a failed fallback and reports both failures without repeating cleanup', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		const session = makeSession();
		const tasks: (() => Promise<unknown>)[] = [];
		const deps = makeTestDeps(new MemoryBucket(), {
			metrics,
			backgroundWork: {
				defer: (_label, task) => {
					tasks.push(task);
					throw new Error('scheduler secret');
				},
			},
		});
		const task = vi.fn(async () => {
			throw new Error('cleanup secret');
		});
		await expect(
			deferTeardown(deps, 'session.stop', task, { project_id: session.project_id }),
		).resolves.toBeUndefined();
		await tasks[0]();
		expect(task).toHaveBeenCalledOnce();
		expect(metrics.increment).toHaveBeenCalledTimes(2);
		expect(metrics.histogram).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
	});
});

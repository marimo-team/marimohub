import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noopMetrics } from './ports/metrics';
import { compensableWrite, metricsObserver, saga } from './saga';
import type { SagaObserver } from './saga';

function createObserver(): { observer: SagaObserver; tagged: Record<string, unknown> } {
	const tagged: Record<string, unknown> = {};
	const observer: SagaObserver = {
		tag: vi.fn((field: string, value: unknown) => {
			tagged[field] = value;
		}),
		error: vi.fn(),
	};
	return { observer, tagged };
}

describe('saga', () => {
	let mock: ReturnType<typeof createObserver>;

	beforeEach(() => {
		mock = createObserver();
	});

	it('runs steps in order and tags each as succeeded', async () => {
		const s1 = vi.fn();
		const s2 = vi.fn();

		await saga(mock.observer).step('first', s1).step('second', s2).run();

		expect(s1).toHaveBeenCalledOnce();
		expect(s2).toHaveBeenCalledOnce();
		expect(mock.tagged).toMatchObject({
			first_succeeded: true,
			second_succeeded: true,
		});
	});

	it('tags a failing step and rethrows the original error', async () => {
		const err = new Error('boom');
		const s1 = vi.fn();
		const s2 = vi.fn().mockRejectedValue(err);

		await expect(saga(mock.observer).step('first', s1).step('second', s2).run()).rejects.toThrow(
			err,
		);

		expect(mock.tagged).toMatchObject({
			first_succeeded: true,
			second_failed: true,
		});
	});

	it('runs compensations in reverse order on failure', async () => {
		const order: string[] = [];
		const compensate1 = vi.fn(() => {
			order.push('c1');
		});
		const compensate2 = vi.fn(() => {
			order.push('c2');
		});

		await expect(
			saga(mock.observer)
				.step('one', { do: vi.fn(), compensate: compensate1 })
				.step('two', { do: vi.fn(), compensate: compensate2 })
				.step('three', () => {
					throw new Error('fail');
				})
				.run(),
		).rejects.toThrow('fail');

		expect(order).toEqual(['c2', 'c1']);
		expect(mock.tagged).toMatchObject({
			one_succeeded: true,
			two_succeeded: true,
			three_failed: true,
			one_compensated: true,
			two_compensated: true,
		});
	});

	it('does not run compensation for the failing step itself', async () => {
		const compensate = vi.fn();
		await expect(
			saga(mock.observer)
				.step('failing', {
					do: () => {
						throw new Error('x');
					},
					compensate,
				})
				.run(),
		).rejects.toThrow('x');

		expect(compensate).not.toHaveBeenCalled();
	});

	it('records compensation failure without masking the original error', async () => {
		const err = new Error('primary');
		const compensate = vi.fn().mockRejectedValue(new Error('cleanup_failed'));

		await expect(
			saga(mock.observer)
				.step('one', { do: vi.fn(), compensate })
				.step('two', () => {
					throw err;
				})
				.run(),
		).rejects.toThrow('primary');

		expect(mock.tagged).toMatchObject({
			one_succeeded: true,
			two_failed: true,
			one_compensation_failed: true,
		});
		expect(mock.observer.error).toHaveBeenCalledWith(
			'saga compensation failed',
			expect.objectContaining({ step: 'one' }),
		);
	});

	it('skips compensations for steps without them', async () => {
		const ok = vi.fn(async () => {});
		await expect(
			saga(mock.observer)
				.step('no_compensate', ok)
				.step('fails', () => {
					throw new Error('fail');
				})
				.run(),
		).rejects.toThrow('fail');

		expect(mock.tagged).not.toHaveProperty('no_compensate_compensated');
		expect(mock.tagged).not.toHaveProperty('no_compensate_compensation_failed');
	});

	it('accepts both shorthand and object step forms', async () => {
		const s1 = vi.fn();
		const s2 = vi.fn();
		const compensate = vi.fn();

		await saga(mock.observer)
			.step('shorthand', s1)
			.step('with_compensate', { do: s2, compensate })
			.run();

		expect(s1).toHaveBeenCalledOnce();
		expect(s2).toHaveBeenCalledOnce();
		expect(compensate).not.toHaveBeenCalled();
	});
});

describe('metricsObserver', () => {
	it('maps step tags to prefixed counters', () => {
		const increment = vi.fn();
		const observer = metricsObserver({ ...noopMetrics, increment }, 'saga.thing');

		observer.tag('write_succeeded', true);
		observer.error('boom', {});

		expect(increment).toHaveBeenCalledWith('saga.thing.write_succeeded');
		expect(increment).toHaveBeenCalledWith('saga.thing.compensation_failed');
	});
});

describe('compensableWrite', () => {
	it('runs every write and does not clean up on success', async () => {
		const ran: number[] = [];
		const writes = [0, 1, 2].map((i) => async () => {
			ran.push(i);
		});
		const cleanup = vi.fn();

		await compensableWrite(writes, cleanup).do();

		expect(ran.sort((a, b) => a - b)).toEqual([0, 1, 2]);
		expect(cleanup).not.toHaveBeenCalled();
	});

	it('bounds write concurrency', async () => {
		let active = 0;
		let peak = 0;
		let ran = 0;
		const task = async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			ran++;
		};
		const writes = Array.from({ length: 6 }, () => task);

		await compensableWrite(writes, vi.fn(), 2).do();

		expect(ran).toBe(6);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('waits for all writes to settle before cleaning up, then rethrows the failure', async () => {
		let slowDone = false;
		let cleanupSawSlowDone: boolean | undefined;
		const writes = [
			() => Promise.reject(new Error('fast fail')),
			async () => {
				await new Promise((r) => setTimeout(r, 10));
				slowDone = true;
			},
		];
		const cleanup = vi.fn(async () => {
			cleanupSawSlowDone = slowDone;
		});

		const step = compensableWrite(writes, cleanup);

		await expect(step.do() as Promise<unknown>).rejects.toThrow('fast fail');
		expect(cleanup).toHaveBeenCalledOnce();
		// The straggler finished before cleanup ran, so the compensating delete can't
		// miss a put that lands afterward.
		expect(cleanupSawSlowDone).toBe(true);
		expect(step.compensate).toBe(cleanup);
	});

	it('does not mask the write failure when cleanup itself throws', async () => {
		const writes = [() => Promise.reject(new Error('write boom'))];
		const cleanup = vi.fn(() => Promise.reject(new Error('cleanup boom')));

		await expect(compensableWrite(writes, cleanup).do() as Promise<unknown>).rejects.toThrow(
			'write boom',
		);
	});
});

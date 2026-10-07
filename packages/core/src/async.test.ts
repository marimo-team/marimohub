import { describe, expect, it } from 'vitest';
import { forEachConcurrentUntilFailure } from './async';

describe('forEachConcurrentUntilFailure', () => {
	it('runs every item with bounded parallelism', async () => {
		let active = 0;
		let peak = 0;
		const seen: number[] = [];
		await forEachConcurrentUntilFailure({
			items: [1, 2, 3, 4, 5],
			concurrency: 2,
			run: async (item) => {
				active++;
				peak = Math.max(peak, active);
				await Promise.resolve();
				seen.push(item);
				active--;
			},
		});
		expect(peak).toBe(2);
		expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	});

	it('stops scheduling after a failure and waits for in-flight work before rejecting', async () => {
		const slow = Promise.withResolvers<void>();
		const started: number[] = [];
		let slowSettled = false;
		const result = forEachConcurrentUntilFailure({
			items: [0, 1, 2, 3],
			concurrency: 2,
			run: async (item) => {
				started.push(item);
				if (item === 0) {
					await slow.promise;
					slowSettled = true;
					return;
				}
				throw new Error(`failed ${item}`);
			},
		});
		let rejected = false;
		result.catch(() => {
			rejected = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rejected).toBe(false);
		slow.resolve();
		await expect(result).rejects.toThrow('failed 1');
		expect(slowSettled).toBe(true);
		expect(started).toEqual([0, 1]);
	});

	it('keeps the first failure when several in-flight items fail', async () => {
		await expect(
			forEachConcurrentUntilFailure({
				items: [1, 2],
				concurrency: 2,
				run: async (item) => {
					await new Promise((resolve) => setTimeout(resolve, item === 1 ? 0 : 5));
					throw new Error(`failed ${item}`);
				},
			}),
		).rejects.toThrow('failed 1');
	});

	it('catches synchronous throws and resolves on empty input', async () => {
		await expect(
			forEachConcurrentUntilFailure({
				items: [1],
				concurrency: 1,
				run: () => {
					throw new Error('sync');
				},
			}),
		).rejects.toThrow('sync');
		await expect(
			forEachConcurrentUntilFailure({ items: [], concurrency: 1, run: async () => {} }),
		).resolves.toBeUndefined();
	});

	it('rejects an invalid concurrency', async () => {
		await expect(
			forEachConcurrentUntilFailure({ items: [1], concurrency: 0, run: async () => {} }),
		).rejects.toThrow(RangeError);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { batchByWeight } from './batching';

describe('batchByWeight', () => {
	it.each([
		{ items: [], maxWeight: 5, expected: [] },
		{ items: [2, 3, 1], maxWeight: 5, expected: [[2, 3], [1]] },
		{ items: [2, 2, 2], maxWeight: 5, overhead: 2, expected: [[2], [2], [2]] },
		{ items: [0, 0, 0], maxWeight: 5, maxItems: 2, expected: [[0, 0], [0]] },
		{ items: [1, 8, 2], maxWeight: 5, expected: [[1], [8], [2]] },
		{ items: [5, 1], maxWeight: 5, overhead: 1, expected: [[5], [1]] },
		{ items: [0, 0, 1, 0], maxWeight: 0, expected: [[0, 0], [1], [0]] },
		{ items: [0, 0], maxWeight: 1, overhead: 2, expected: [[0], [0]] },
		{
			items: [2, 2, 2, 2],
			maxWeight: 5,
			maxItems: 2,
			overhead: 1,
			expected: [
				[2, 2],
				[2, 2],
			],
		},
	])('partitions $items with a budget of $maxWeight', ({ items, expected, ...options }) => {
		expect(batchByWeight(items, { ...options, weight: (item) => item })).toEqual(expected);
	});

	it('preserves object identity and order without dropping or duplicating items', () => {
		const items = Array.from({ length: 200 }, (_, id) => ({ id, size: id % 17 }));
		const batches = batchByWeight(items, {
			weight: (item) => item.size,
			maxWeight: 12,
			maxItems: 3,
			overhead: 2,
		});
		expect(batches.flat()).toEqual(items);
		batches.flat().forEach((item, index) => expect(item).toBe(items[index]));
		expect(
			batches.every(
				(batch) =>
					batch.length <= 3 &&
					(batch.length === 1 || batch.reduce((total, item) => total + item.size, 2) <= 12),
			),
		).toBe(true);
	});

	it('does not evaluate weights for an empty input', () => {
		const weight = vi.fn(() => {
			throw new Error('unexpected evaluation');
		});
		expect(batchByWeight([], { weight, maxWeight: 0, overhead: 1 })).toEqual([]);
		expect(weight).not.toHaveBeenCalled();
	});

	it('propagates a weight error without changing the input or evaluating later items', () => {
		const items = Object.freeze([1, 2, 3]);
		const failure = new Error('cannot size item');
		const weight = vi.fn((item: number) => {
			if (item === 2) throw failure;
			return item;
		});
		expect(() => batchByWeight(items, { weight, maxWeight: 1 })).toThrow(failure);
		expect(weight.mock.calls).toEqual([[1], [2]]);
		expect(items).toEqual([1, 2, 3]);
	});
});

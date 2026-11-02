import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedWithDeadline, validateEmbeddingVectors } from './embeddings';

afterEach(() => vi.useRealTimers());

describe('shared embedding validation', () => {
	it.each([
		{ vectors: null, count: 1 },
		{ vectors: [[1]], count: 2 },
		{ vectors: [null], count: 1 },
		{ vectors: [[]], count: 1 },
		{ vectors: [[0, 0]], count: 1 },
		{ vectors: [[Number.NaN]], count: 1 },
		{ vectors: [[Infinity]], count: 1 },
		{ vectors: [[1, '2']], count: 1 },
		{ vectors: [[1], [1, 2]], count: 2 },
		{ vectors: [Object.assign([1], { length: 2 })], count: 1 },
		{ vectors: [Array.from({ length: 4097 }, () => 1)], count: 1 },
	])('rejects malformed vectors from any provider (%#)', ({ vectors, count }) => {
		expect(() => validateEmbeddingVectors(vectors, count)).toThrow('Invalid embedding response');
	});
	it('accepts equal dimensions at the boundary without changing vectors', () => {
		const vectors = [
			Array.from({ length: 4096 }, (_, i) => i),
			Array.from({ length: 4096 }, () => -1),
		];
		const original = structuredClone(vectors);
		validateEmbeddingVectors(vectors, 2);
		expect(vectors).toEqual(original);
		validateEmbeddingVectors([], 0);
	});
	it('validates custom provider results through the same deadline wrapper', async () => {
		const provider = { space: 'test', embed: vi.fn(async () => [[1], [1, 2]]) };
		await expect(
			embedWithDeadline(provider, ['a', 'b'], {
				signal: new AbortController().signal,
				timeoutMs: 100,
			}),
		).rejects.toThrow('Invalid embedding response');
	});
	it('aborts a provider that ignores the deadline', async () => {
		vi.useFakeTimers();
		const embed = vi.fn(
			(_texts: string[], _signal: AbortSignal) => new Promise<number[][]>(() => {}),
		);
		const pending = embedWithDeadline({ space: 'test', embed }, ['a'], {
			signal: new AbortController().signal,
			timeoutMs: 100,
		});
		const rejected = expect(pending).rejects.toThrow('Embedding deadline');
		await vi.advanceTimersByTimeAsync(100);
		await rejected;
		expect(embed.mock.calls[0][1].aborted).toBe(true);
	});
	it('does not call a provider after caller cancellation', async () => {
		const embed = vi.fn(async () => [[1]]);
		await expect(
			embedWithDeadline({ space: 'test', embed }, ['a'], {
				signal: AbortSignal.abort(),
				timeoutMs: 100,
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(embed).not.toHaveBeenCalled();
	});
});

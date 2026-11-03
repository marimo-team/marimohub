import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId } from '../ids';
import type { SearchDocument } from './contracts';
import { MAX_SEARCH_CANDIDATES } from './limits';
import {
	embedWithDeadline,
	selectSearchCandidates,
	topKBySimilarity,
	validateEmbeddingVectors,
} from './embeddings';

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

describe('candidate selection', () => {
	const document = (id: number, vector?: number[]): SearchDocument => ({
		id: String(id),
		kind: 'code',
		resource: { type: 'notebook', notebook_id: createNotebookId() },
		title: '',
		text: '',
		fingerprint: '1',
		embedding: vector && { space: 'model', vector },
	});
	const query = { space: 'model', vector: [1, 0] };
	it('orders compatible documents by similarity and skips non-positive matches', () => {
		const docs = [
			document(0, [0, 1]),
			document(1, [1, 1]),
			document(2, [1, 0]),
			document(3, [-1, 0]),
		];
		expect(topKBySimilarity(docs, query, 2).map((d) => d.id)).toEqual(['2', '1']);
		expect(topKBySimilarity(docs, { ...query, space: 'other' }, 2)).toEqual([]);
	});
	it('reserves half of the budget for semantic matches when keyword matches overflow', () => {
		const keyword = Array.from({ length: MAX_SEARCH_CANDIDATES }, (_, i) => document(i, [1, 0]));
		const semantic = Array.from({ length: MAX_SEARCH_CANDIDATES }, (_, i) =>
			document(MAX_SEARCH_CANDIDATES + i, [1, i]),
		);
		const selected = selectSearchCandidates(keyword, [...keyword, ...semantic], {
			embedding: query,
		});
		expect(selected.documents).toHaveLength(MAX_SEARCH_CANDIDATES);
		expect(selected.documents.slice(0, MAX_SEARCH_CANDIDATES / 2)).toEqual(
			keyword.slice(0, MAX_SEARCH_CANDIDATES / 2),
		);
		expect(selected.documents[MAX_SEARCH_CANDIDATES / 2]).toBe(semantic[0]);
		expect(new Set(selected.documents).size).toBe(MAX_SEARCH_CANDIDATES);
		expect(selected.partial).toBe(true);
		expect(selectSearchCandidates(keyword.slice(0, 10), semantic, { embedding: query })).toEqual({
			documents: [...keyword.slice(0, 10), ...semantic.slice(0, MAX_SEARCH_CANDIDATES - 10)],
			partial: false,
		});
	});
	it('applies the kinds filter to keyword and semantic candidates', () => {
		const code = document(0, [1, 0]);
		const output = { ...document(1, [1, 0]), kind: 'output' as const };
		const semanticOutput = { ...document(2, [1, 1]), kind: 'output' as const };
		const semanticCode = document(3, [1, 1]);
		expect(
			selectSearchCandidates([code, output], [code, output, semanticOutput, semanticCode], {
				kinds: ['output'],
				embedding: query,
			}),
		).toEqual({ documents: [output, semanticOutput], partial: false });
	});
});

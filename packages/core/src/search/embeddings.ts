import { withDeadline } from '../async';
import type { EmbeddingProvider, SearchCandidatesRequest, SearchDocument } from './contracts';
import { MAX_EMBEDDING_DIMENSIONS, MAX_SEARCH_CANDIDATES } from './limits';

export function validateEmbeddingVectors(
	vectors: unknown,
	expectedCount: number,
): asserts vectors is number[][] {
	if (!Array.isArray(vectors) || vectors.length !== expectedCount)
		throw new Error('Invalid embedding response');
	let dimensions: number | undefined;
	for (const vector of vectors) {
		if (
			!Array.isArray(vector) ||
			vector.length === 0 ||
			vector.length > MAX_EMBEDDING_DIMENSIONS ||
			vector.includes(undefined) ||
			!vector.every(Number.isFinite) ||
			!vector.some((value) => value !== 0) ||
			(dimensions !== undefined && vector.length !== dimensions)
		)
			throw new Error('Invalid embedding response');
		dimensions = vector.length;
	}
}

export async function embedWithDeadline(
	provider: EmbeddingProvider,
	texts: string[],
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<number[][]> {
	const vectors = await withDeadline((signal) => provider.embed(texts, signal), {
		...options,
		timeoutError: () => new Error('Embedding deadline'),
	});
	validateEmbeddingVectors(vectors, texts.length);
	return vectors;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let left = 0;
	let right = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		left += a[i] * a[i];
		right += b[i] * b[i];
	}
	const norm = Math.sqrt(left) * Math.sqrt(right);
	return norm ? dot / norm : 0;
}

/** Positive-similarity documents in the query's embedding space, most similar first. */
export function topKBySimilarity(
	documents: readonly SearchDocument[],
	embedding: NonNullable<SearchDocument['embedding']>,
	k: number,
): SearchDocument[] {
	return documents
		.flatMap((document) => {
			const vector = document.embedding;
			if (vector?.space !== embedding.space || vector.vector.length !== embedding.vector.length)
				return [];
			const similarity = cosineSimilarity(vector.vector, embedding.vector);
			return similarity > 0 ? [{ document, similarity }] : [];
		})
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, k)
		.map(({ document }) => document);
}

/**
 * Keyword and semantic candidates each keep at least half of the candidate budget; either side
 * may use the other's unused share. Only dropped keyword matches make the result partial:
 * semantic retrieval is top-K by definition. `keyword` must be ordered best-first (most distinct
 * query terms matched); the cut keeps its prefix.
 */
export function selectSearchCandidates(
	keyword: readonly SearchDocument[],
	documents: readonly SearchDocument[],
	{ kinds, embedding }: Pick<SearchCandidatesRequest, 'kinds' | 'embedding'>,
): { documents: SearchDocument[]; partial: boolean } {
	const admitted = (d: SearchDocument) => !kinds || kinds.includes(d.kind);
	const lexical = keyword.filter(admitted);
	const matched = new Set(lexical);
	const semantic = embedding
		? topKBySimilarity(
				documents.filter((d) => admitted(d) && !matched.has(d)),
				embedding,
				MAX_SEARCH_CANDIDATES,
			)
		: [];
	const semanticCount = Math.min(
		semantic.length,
		Math.max(MAX_SEARCH_CANDIDATES / 2, MAX_SEARCH_CANDIDATES - lexical.length),
	);
	const lexicalCount = Math.min(lexical.length, MAX_SEARCH_CANDIDATES - semanticCount);
	return {
		documents: [...lexical.slice(0, lexicalCount), ...semantic.slice(0, semanticCount)],
		partial: lexical.length > lexicalCount,
	};
}

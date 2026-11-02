import { withDeadline } from '../async';
import type { EmbeddingProvider } from './contracts';
import { MAX_EMBEDDING_DIMENSIONS } from './limits';

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

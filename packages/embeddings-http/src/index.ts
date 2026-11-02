import type { EmbeddingProvider } from '@marimo-hub/core/search/contracts';
import { validateEmbeddingVectors } from '@marimo-hub/core/search/embeddings';
import { MAX_EMBEDDING_BATCH_SIZE, MAX_SEARCH_TEXT_LENGTH } from '@marimo-hub/core/search/limits';

export class HttpEmbeddings implements EmbeddingProvider {
	readonly space: string;
	constructor(
		private readonly endpoint: string,
		private readonly model: string,
		private readonly apiKey?: string,
		private readonly request: typeof fetch = fetch,
	) {
		const url = new URL(endpoint);
		if (
			!['https:', 'http:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.hash ||
			url.search
		)
			throw new Error('Invalid embedding endpoint');
		this.space = `${endpoint}:${model}`;
		if (this.space.length > 512) throw new Error('Embedding identity exceeds budget');
	}
	async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
		signal.throwIfAborted();
		if (
			texts.length > MAX_EMBEDDING_BATCH_SIZE ||
			texts.some((t) => t.length > MAX_SEARCH_TEXT_LENGTH)
		)
			throw new Error('Embedding input exceeds budget');
		const response = await this.request(this.endpoint, {
			method: 'POST',
			redirect: 'error',
			signal,
			headers: {
				'Content-Type': 'application/json',
				...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify({ model: this.model, input: texts }),
		});
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error('Embedding provider unavailable');
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				signal.throwIfAborted();
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 2 * 1024 * 1024) throw new Error('Embedding response exceeds budget');
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		try {
			const body = JSON.parse(new TextDecoder().decode(bytes)) as {
				data?: { index: number; embedding: number[] }[];
			};
			if (!Array.isArray(body.data) || body.data.length !== texts.length)
				throw new Error('Invalid embedding response');
			const rows = body.data.sort((a, b) => a.index - b.index);
			if (rows.some((row, i) => row.index !== i)) throw new Error('Invalid embedding response');
			const vectors = rows.map((row) => row.embedding);
			validateEmbeddingVectors(vectors, texts.length);
			return vectors;
		} catch {
			throw new Error('Invalid embedding response');
		}
	}
}

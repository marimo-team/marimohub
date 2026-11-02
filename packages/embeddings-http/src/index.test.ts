import { describe, expect, it, vi } from 'vitest';
import { HttpEmbeddings } from './index';
const signal = new AbortController().signal;
function createEmbeddings(request: typeof fetch) {
	return new HttpEmbeddings('https://embedding.example/v1/embeddings', 'model', undefined, request);
}
describe('HTTP embeddings', () => {
	it.each([
		'not a URL',
		'/embeddings',
		'https://',
		'file:///embeddings',
		'https://user:password@host',
		'https://host/#fragment',
		'https://host/?key=secret',
	])('rejects invalid endpoint %j with a stable error', (endpoint) => {
		expect(() => new HttpEmbeddings(endpoint, 'model')).toThrow('Invalid embedding endpoint');
	});
	it.each(['http://embedding.example/v1/embeddings', 'http://localhost:8000/embeddings'])(
		'rejects plaintext credentials at %j before any request',
		(endpoint) => {
			const request = vi.fn<typeof fetch>();
			expect(() => new HttpEmbeddings(endpoint, 'model', 'secret', request)).toThrow(
				'must use HTTPS',
			);
			expect(request).not.toHaveBeenCalled();
		},
	);
	it('allows credential-free HTTP endpoints for local providers', () => {
		expect(() => new HttpEmbeddings('http://localhost:8000/embeddings', 'model')).not.toThrow();
	});
	it.each([
		'null',
		'{',
		JSON.stringify({ data: [null] }),
		JSON.stringify({ data: [{ index: 0, embedding: [null] }] }),
		JSON.stringify({ data: [{ index: 0, embedding: ['private-value'] }] }),
		JSON.stringify({ data: [{ index: 1, embedding: [1] }] }),
		JSON.stringify({ data: [{ index: 0, embedding: [] }] }),
		JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 4097 }, () => 1) }] }),
	])('rejects malformed provider payloads with a stable error (%#)', async (body) => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
		const embeddings = createEmbeddings(request);
		await expect(embeddings.embed(['a'], signal)).rejects.toThrow('Invalid embedding response');
	});
	it.each([
		{
			data: [
				{ index: 0, embedding: [1] },
				{ index: 0, embedding: [1] },
			],
		},
		{
			data: [
				{ index: 0, embedding: [1] },
				{ index: 1, embedding: [1, 0] },
			],
		},
		{ data: [{ index: 0, embedding: [1] }] },
	])('rejects duplicate, mismatched, or missing vectors (%#)', async ({ data }) => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data })));
		const embeddings = createEmbeddings(request);
		await expect(embeddings.embed(['a', 'b'], signal)).rejects.toThrow(
			'Invalid embedding response',
		);
	});
	it('rejects oversized inputs and pre-aborted calls without contacting the provider', async () => {
		const request = vi.fn<typeof fetch>();
		const embeddings = createEmbeddings(request);
		await expect(
			embeddings.embed(
				Array.from({ length: 33 }, () => 'a'),
				signal,
			),
		).rejects.toThrow('input exceeds budget');
		await expect(embeddings.embed(['a'.repeat(8193)], signal)).rejects.toThrow(
			'input exceeds budget',
		);
		await expect(embeddings.embed(['a'], AbortSignal.abort())).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(request).not.toHaveBeenCalled();
	});
	it('cancels a streaming response as soon as its byte budget is exceeded', async () => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024));
				},
				cancel,
			}),
		);
		const request = vi.fn<typeof fetch>().mockResolvedValue(response);
		const embeddings = createEmbeddings(request);
		await expect(embeddings.embed(['a'], signal)).rejects.toThrow('response exceeds budget');
		expect(cancel).toHaveBeenCalledOnce();
		expect(response.body?.locked).toBe(false);
	});
	it('orders response vectors and forwards cancellation without exposing credentials', async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{ index: 1, embedding: [0, 1] },
						{ index: 0, embedding: [1, 0] },
					],
				}),
			),
		);
		const embeddings = new HttpEmbeddings(
			'https://embedding.example/v1/embeddings',
			'model',
			'secret',
			request,
		);
		expect(await embeddings.embed(['a', 'b'], signal)).toEqual([
			[1, 0],
			[0, 1],
		]);
		expect(request.mock.calls[0][1]).toMatchObject({ signal, redirect: 'error' });
		expect(embeddings.space).not.toContain('secret');
	});
	it('rejects oversized responses and invalid vectors', async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] })),
			);
		const embeddings = createEmbeddings(request);
		await expect(embeddings.embed(['a'], signal)).rejects.toThrow('budget');
		await expect(embeddings.embed(['a'], signal)).rejects.toThrow('Invalid');
	});
	it('does not echo upstream error bodies', async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('private provider details', { status: 401 }));
		await expect(createEmbeddings(request).embed(['a'], signal)).rejects.toThrow(
			'Embedding provider unavailable',
		);
	});
});

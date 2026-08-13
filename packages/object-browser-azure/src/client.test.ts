import type { WebResource } from '@azure/storage-blob';
import { describe, expect, it, vi } from 'vitest';
import { guardedHttpClient } from './client';

const resolver = async () => [{ address: '20.60.1.1', family: 4 }];

describe('Azure guarded HTTP client', () => {
	it('uses the operation context signal when the SDK request has none', async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
			await new Promise<void>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('canceled', 'AbortError')),
				);
			});
			return new Response();
		});
		const pending = guardedHttpClient(resolver, fetchImpl, controller.signal).sendRequest(
			request(),
		);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'aborted' });
		expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it('classifies transport deadline errors as aborted', async () => {
		const client = guardedHttpClient(
			resolver,
			vi.fn<typeof fetch>(async () => {
				throw new DOMException('deadline exceeded', 'TimeoutError');
			}),
		);
		await expect(client.sendRequest(request())).rejects.toMatchObject({ code: 'aborted' });
	});

	it('keeps download cancellation linked after response headers arrive', async () => {
		const requestController = new AbortController();
		const client = guardedHttpClient(resolver, (async (_input, init) => {
			return new Response(
				new ReadableStream({
					start(controller) {
						init?.signal?.addEventListener('abort', () =>
							controller.error(new DOMException('canceled', 'AbortError')),
						);
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch);
		const response = await client.sendRequest(
			request({ abortSignal: requestController.signal, streamResponseStatusCodes: new Set([200]) }),
		);
		const body = response.readableStreamBody!;
		body.on('error', () => {});
		body.resume();
		const closed = new Promise<void>((resolve) => body.once('close', resolve));
		requestController.abort();
		await closed;
	});

	it('cancels metadata responses that exceed the configured cap', async () => {
		const cancel = vi.fn();
		const response = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('too large'));
			},
			cancel,
		});
		const client = guardedHttpClient(
			resolver,
			(async () => new Response(response)) as typeof fetch,
			undefined,
			{ metadataMaxResponseBytes: 4, listMaxResponseBytes: 1024 },
		);

		await expect(client.sendRequest(request())).rejects.toMatchObject({ code: 'unsupported' });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('bounds list responses with the list cap instead of the metadata cap', async () => {
		const client = guardedHttpClient(
			resolver,
			(async () => new Response('<EnumerationResults></EnumerationResults>')) as typeof fetch,
			undefined,
			{ metadataMaxResponseBytes: 4, listMaxResponseBytes: 1024 },
		);

		const response = await client.sendRequest(
			request({ url: 'https://lake.blob.core.windows.net/raw?restype=container&comp=list' }),
		);
		expect(response.bodyAsText).toBe('<EnumerationResults></EnumerationResults>');
	});
});

function request(overrides: Partial<WebResource> = {}): WebResource {
	return {
		url: 'https://lake.blob.core.windows.net/raw/file.csv',
		method: 'GET',
		headers: {
			toJson: () => ({}),
		},
		...overrides,
	} as WebResource;
}

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

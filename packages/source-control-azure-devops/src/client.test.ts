import { describe, expect, it, vi } from 'vitest';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { sourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import { AzureClient } from './client';
import type { AzureCredential } from './client';
import { parseAzureRepository } from './repository';
import { repository } from './testing/fakeAzure';

const repo = parseAzureRepository(repository);
function setup() {
	const credential = {
		getToken: vi.fn<AzureCredential['getToken']>().mockResolvedValue({ token: 'private-token' }),
	};
	const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ value: [] }));
	const client = new AzureClient({ organization: 'acme', credential }, { fetcher });
	return { client, credential, fetcher };
}
function openStream(chunk: string, failCancel = false) {
	const cancel = vi.fn(() => {
		if (failCancel) throw new Error('private cleanup details');
	});
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(chunk));
		},
		cancel,
	});
	return { body, cancel };
}

describe('Azure HTTP failure handling', () => {
	it.each([null, { token: '' }])(
		'rejects missing credentials before contacting Azure: %j',
		async (token) => {
			const { client, credential, fetcher } = setup();
			credential.getToken.mockResolvedValue(token);
			const error = await client.json(repo, '/refs').catch((error: unknown) => error);
			expect(error).toBeInstanceOf(UnavailableError);
			expect(sourceControlPublishFailure(error)).toEqual({
				provider: 'azure-devops',
				stage: 'auth',
			});
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it('does not acquire credentials or send a request after cancellation', async () => {
		const { client, credential, fetcher } = setup();
		const controller = new AbortController();
		const reason = new Error('Cancelled by caller');
		controller.abort(reason);
		await expect(client.json(repo, '/refs', {}, { signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(credential.getToken).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('honors cancellation while credentials are acquired', async () => {
		const { client, credential, fetcher } = setup();
		const controller = new AbortController();
		const reason = new Error('Cancelled while authenticating');
		credential.getToken.mockImplementation(async () => {
			controller.abort(reason);
			return { token: 'private-token' };
		});
		await expect(client.json(repo, '/refs', {}, { signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('preserves the caller cancellation reason when the transport fails', async () => {
		const { client, fetcher } = setup();
		const controller = new AbortController();
		const reason = new Error('Cancelled during fetch');
		fetcher.mockImplementation(async () => {
			controller.abort(reason);
			throw new Error('transport abort');
		});
		await expect(client.json(repo, '/refs', {}, { signal: controller.signal })).rejects.toBe(
			reason,
		);
	});
	it('sanitizes network failures instead of exposing transport details', async () => {
		const { client, fetcher } = setup();
		fetcher.mockRejectedValue(new Error('Authorization: private-token'));
		const error = await client.json(repo, '/refs').catch((error: unknown) => error);
		expect(error).toBeInstanceOf(UnavailableError);
		expect(String(error)).not.toContain('private-token');
	});
	it.each([
		[400, BadRequestError],
		[401, ForbiddenError],
		[403, ForbiddenError],
		[404, NotFoundError],
		[409, ConflictError],
		[412, ConflictError],
		[429, UnavailableError],
		[500, UnavailableError],
		[503, UnavailableError],
	] as const)('maps HTTP %s and closes its response body', async (status, expected) => {
		const { client, fetcher } = setup();
		const { body, cancel } = openStream('private server details');
		fetcher.mockResolvedValue(new Response(body, { status }));
		const error = await client.json(repo, '/refs').catch((error: unknown) => error);
		expect(error).toBeInstanceOf(expected);
		expect(error).toHaveProperty('providerStatus', status);
		expect(String(error)).not.toContain('private server details');
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it('carries Retry-After on rate limits', async () => {
		const { client, fetcher } = setup();
		fetcher.mockResolvedValue(
			new Response(null, { status: 429, headers: { 'retry-after': '12' } }),
		);
		await expect(client.json(repo, '/refs')).rejects.toMatchObject({
			providerStatus: 429,
			retryAfterSeconds: 12,
		});
	});
	it('preserves an access-denied error when response cleanup fails', async () => {
		const { client, fetcher } = setup();
		const { body, cancel } = openStream('denied', true);
		fetcher.mockResolvedValue(new Response(body, { status: 403 }));
		await expect(client.json(repo, '/refs')).rejects.toBeInstanceOf(ForbiddenError);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('rejects paginated results rather than accepting an incomplete list', async () => {
		const { client, fetcher } = setup();
		const { body, cancel } = openStream('{"value":[]}');
		fetcher.mockResolvedValue(
			new Response(body, { headers: { 'x-ms-continuationtoken': 'next-page' } }),
		);
		await expect(client.json(repo, '/refs')).rejects.toBeInstanceOf(BadRequestError);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('rejects malformed JSON without echoing its body', async () => {
		const { client, fetcher } = setup();
		fetcher.mockResolvedValue(new Response('private malformed data'));
		const error = await client.json(repo, '/refs').catch((error: unknown) => error);
		expect(error).toBeInstanceOf(UnavailableError);
		expect(String(error)).not.toContain('private malformed data');
	});
	it('rejects oversized metadata before buffering its body', async () => {
		const { client, fetcher } = setup();
		const { body, cancel } = openStream('{');
		fetcher.mockResolvedValue(
			new Response(body, { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
		);
		await expect(client.json(repo, '/trees/abc')).rejects.toBeInstanceOf(BadRequestError);
		expect(cancel).toHaveBeenCalledOnce();
	});
});

describe('Azure credential cancellation', () => {
	it('cancels a stalled credential even when it ignores the abort signal', async () => {
		const { client, credential, fetcher } = setup();
		const controller = new AbortController();
		const reason = new Error('Stop reading');
		credential.getToken.mockImplementation(() => new Promise(() => {}));
		const pending = client.json(repo, '/refs', {}, { signal: controller.signal });
		const rejected = expect(pending).rejects.toBe(reason);
		expect(credential.getToken).toHaveBeenCalledOnce();
		const signal = credential.getToken.mock.calls[0][1]?.abortSignal;
		controller.abort(reason);
		await rejected;
		expect(signal?.aborted).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('starts the deadline before acquiring credentials even with a caller signal', async () => {
		const timeout = new AbortController();
		const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
		try {
			const { client, credential, fetcher } = setup();
			credential.getToken.mockImplementation(() => new Promise(() => {}));
			const pending = client.json(repo, '/refs', {}, { signal: new AbortController().signal });
			const error = pending.catch((error: unknown) => error);
			timeout.abort(new DOMException('Timeout', 'TimeoutError'));
			expect(sourceControlPublishFailure(await error)).toEqual({
				provider: 'azure-devops',
				stage: 'auth',
			});
			expect(spy).toHaveBeenCalledWith(60_000);
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	it('shares one deadline between credentials and the HTTP request', async () => {
		const { client, credential, fetcher } = setup();
		await client.json(repo, '/refs');
		expect(credential.getToken.mock.calls[0][1]?.abortSignal).toBe(
			fetcher.mock.calls[0][1]?.signal,
		);
	});
});

it('cancels a stalled Azure response body', async () => {
	const { client, fetcher } = setup();
	const cancel = vi.fn();
	const response = new Response(new ReadableStream({ cancel }));
	const reader = vi.spyOn(response.body!, 'getReader');
	fetcher.mockResolvedValue(response);
	const controller = new AbortController();
	const pending = client.json(repo, '/refs', {}, { signal: controller.signal });
	await vi.waitFor(() => expect(reader).toHaveBeenCalled());
	controller.abort(new Error('Stop reading Azure response'));
	await expect(pending).rejects.toBe(controller.signal.reason);
	expect(cancel).toHaveBeenCalledOnce();
});

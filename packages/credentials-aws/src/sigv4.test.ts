import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsSigV4Fetch } from './sigv4';

const credentials = {
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'secret',
	sessionToken: 'session-token',
};

const BASE = 'https://bedrock-runtime.eu-west-1.amazonaws.com';

function signed() {
	const fetchImpl = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'),
	);
	const signedFetch = createAwsSigV4Fetch({
		region: 'eu-west-1',
		service: 'bedrock',
		credentials,
		fetch: fetchImpl,
	});
	const lastInit = () => fetchImpl.mock.calls[0][1];
	return { fetchImpl, signedFetch, lastInit };
}

describe('createAwsSigV4Fetch', () => {
	afterEach(() => vi.useRealTimers());

	it('signs the exact request passed to the underlying fetch', async () => {
		const { fetchImpl, signedFetch } = signed();

		await signedFetch('https://bedrock-runtime.eu-west-1.amazonaws.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'eu.example-model', messages: [] }),
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/v1/chat/completions');
		const headers = new Headers(init?.headers);
		expect(headers.get('authorization')).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request,/,
		);
		expect(headers.get('x-amz-security-token')).toBe('session-token');
		expect(headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
		expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toContain('eu.example-model');
	});

	it.each(['GET', 'HEAD'])('signs a bodiless %s request with an undefined body', async (method) => {
		const { signedFetch, lastInit } = signed();
		await signedFetch(`${BASE}/openai/v1/models`, { method });
		const init = lastInit();
		expect(init?.method).toBe(method);
		expect(init?.body).toBeUndefined();
		expect(new Headers(init?.headers).get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
	});

	it('signs the query string, folding repeated keys into one multi-valued entry', async () => {
		// Freeze x-amz-date so equal canonical requests yield byte-equal signatures.
		vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
		const authorizationFor = async (url: string) => {
			const { signedFetch, lastInit } = signed();
			await signedFetch(url);
			return new Headers(lastInit()?.headers).get('authorization');
		};
		const plain = await authorizationFor(`${BASE}/openai/v1/models`);
		const both = await authorizationFor(`${BASE}/openai/v1/models?tag=a&tag=b`);
		expect(both).toMatch(/Signature=[0-9a-f]{64}$/);
		expect(both).not.toBe(plain);
		expect(both).not.toBe(await authorizationFor(`${BASE}/openai/v1/models?tag=a`));
		expect(both).not.toBe(await authorizationFor(`${BASE}/openai/v1/models?tag=b`));
		expect(both).toBe(await authorizationFor(`${BASE}/openai/v1/models?tag=a&tag=b`));
	});

	it('refuses to follow redirects (a signed request must not be replayed elsewhere)', async () => {
		const { signedFetch, lastInit } = signed();
		await signedFetch(`${BASE}/openai/v1/models`, { redirect: 'follow' });
		expect(lastInit()?.redirect).toBe('error');
	});

	it('passes the caller abort signal through to the underlying fetch', async () => {
		const { signedFetch, lastInit } = signed();
		const controller = new AbortController();
		await signedFetch(`${BASE}/openai/v1/chat/completions`, {
			method: 'POST',
			body: '{}',
			signal: controller.signal,
		});
		const signal = lastInit()?.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal?.aborted).toBe(false);
		controller.abort();
		expect(signal?.aborted).toBe(true);
	});
});

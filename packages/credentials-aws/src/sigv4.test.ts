import { describe, expect, it, vi } from 'vitest';
import { createAwsSigV4Fetch } from './sigv4';

const credentials = {
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'secret',
	sessionToken: 'session-token',
};

describe('createAwsSigV4Fetch', () => {
	it('signs the exact request passed to the underlying fetch', async () => {
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'),
		);
		const signedFetch = createAwsSigV4Fetch({
			region: 'eu-west-1',
			service: 'bedrock',
			credentials,
			fetch: fetchImpl,
		});

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
});

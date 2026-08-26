import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_BYTES, UnavailableError, mintAiSessionToken } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from '../context';
import { createApi } from '../createApi';
import { makeTestDeps } from '../testing';

const SECRET = 'sess-secret';
const AI: ApiDeps['ai'] = {
	upstreamBaseUrl: 'https://upstream.test/v1',
	upstreamApiKey: 'real-key',
	model: 'gpt-4o-mini',
	signingSecret: SECRET,
};

function app(overrides: Partial<ApiDeps> = {}) {
	return createApi(makeTestDeps(new MemoryBucket(), { ai: AI, ...overrides }));
}

function token() {
	return mintAiSessionToken(SECRET, {
		projectId: 'proj-1',
		notebookId: 'nb-1',
		sessionId: 'sess-1',
		userId: 'u-1',
	});
}

function post(
	t: string | null,
	body: unknown,
	overrides: Partial<ApiDeps> = {},
	path = '/api/ai/v1/chat/completions',
) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (t) headers.authorization = `Bearer ${t}`;
	return app(overrides).request(path, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
}

afterEach(() => vi.restoreAllMocks());

/**
 * Errors on this route must stay OpenAI-shaped (`{ error: { message, type } }`),
 * never the hub's `{ success, error }` envelope — marimo's `openai` client parses
 * the former to show the user why the call failed.
 */
async function expectOpenAiError(res: Response, message: string, type: string) {
	const json = (await res.json()) as { error?: { message?: string; type?: string } };
	expect(json).not.toHaveProperty('success');
	expect(json.error?.message).toBe(message);
	expect(json.error?.type).toBe(type);
}

describe('POST /api/ai/v1/chat/completions', () => {
	it('rejects a missing token', async () => {
		const res = await post(null, { model: 'x', messages: [] });
		expect(res.status).toBe(401);
		await expectOpenAiError(res, 'Missing bearer token', 'invalid_request_error');
	});

	it('rejects a forged token', async () => {
		const res = await post('not.a.token', { model: 'x', messages: [] });
		expect(res.status).toBe(401);
		await expectOpenAiError(res, 'Invalid or expired token', 'invalid_request_error');
	});

	it('404s when AI is not configured', async () => {
		const res = await createApi(makeTestDeps(new MemoryBucket())).request(
			'/api/ai/v1/chat/completions',
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
		);
		expect(res.status).toBe(404);
	});

	it('returns 400 for an invalid JSON body (valid token)', async () => {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			authorization: `Bearer ${await token()}`,
		};
		const res = await app().request('/api/ai/v1/chat/completions', {
			method: 'POST',
			headers,
			body: '{ this is not json',
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { type: string } };
		expect(json.error.type).toBe('invalid_request_error');
	});

	it('rejects a request body over 10 MB before forwarding it', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const res = await app().request('/api/ai/v1/chat/completions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
				'content-length': String(MAX_REQUEST_BYTES + 1),
			},
			body: '{}',
		});

		expect(res.status).toBe(413);
		await expectOpenAiError(
			res,
			`Request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
			'invalid_request_error',
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('allows a request body exactly at the 10 MB limit', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('ok', { status: 200 }));
		const base = { model: 'm', padding: '' };
		const overhead = JSON.stringify(base).length;
		const body = JSON.stringify({ ...base, padding: 'x'.repeat(MAX_REQUEST_BYTES - overhead) });
		expect(new TextEncoder().encode(body)).toHaveLength(MAX_REQUEST_BYTES);

		const res = await app().request('/api/ai/v1/chat/completions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
			},
			body,
		});

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns 502 when the upstream provider is unreachable', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
		const res = await post(await token(), { model: 'm', messages: [] });
		expect(res.status).toBe(502);
		const json = (await res.json()) as { error: { type: string } };
		expect(json.error.type).toBe('api_error');
	});

	it('rejects a well-formed but expired session token with 401', async () => {
		// Mint the token as if issued 2h ago (default TTL is 1h) so it is already expired.
		const expired = await mintAiSessionToken(
			SECRET,
			{ projectId: 'proj-1', notebookId: 'nb-1', sessionId: 'sess-1', userId: 'u-1' },
			{ now: () => Date.now() - 2 * 60 * 60 * 1000 },
		);
		const res = await post(expired, { model: 'm', messages: [] });
		expect(res.status).toBe(401);
		await expectOpenAiError(res, 'Invalid or expired token', 'invalid_request_error');
	});

	it('rejects a suspended token owner before contacting the upstream', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { ai: AI });
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(true);
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const res = await createApi(deps).request('/api/ai/v1/chat/completions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'm', messages: [] }),
		});

		expect(res.status).toBe(403);
		await expectOpenAiError(res, 'User account is suspended', 'access_denied');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fails closed when suspension status cannot be checked', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { ai: AI });
		vi.spyOn(deps.services.identities, 'isSuspended').mockRejectedValue(
			new UnavailableError('storage down'),
		);
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const res = await createApi(deps).request('/api/ai/v1/chat/completions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'm', messages: [] }),
		});

		expect(res.status).toBe(503);
		await expectOpenAiError(res, 'Unable to verify account status', 'api_error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not mask unexpected suspension-check failures as unavailable', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { ai: AI });
		vi.spyOn(deps.services.identities, 'isSuspended').mockRejectedValue(
			new TypeError('bad binding'),
		);
		const res = await createApi(deps).request('/api/ai/v1/chat/completions', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await token()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'm', messages: [] }),
		});

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({
			success: false,
			error: { code: 'INTERNAL_ERROR' },
		});
	});

	it('forwards to the upstream with the real key and streams back', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('data: {"x":1}\n\ndata: [DONE]\n\n', {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}),
		);
		const res = await post(await token(), {
			model: 'marimohub/gpt-4o-mini',
			messages: [],
			stream: true,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(await res.text()).toContain('[DONE]');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		// `proxy` calls fetch with a single Request carrying the rewritten body + key.
		const req = fetchMock.mock.calls[0][0] as Request;
		expect(req.url).toBe('https://upstream.test/v1/chat/completions');
		expect(req.headers.get('authorization')).toBe('Bearer real-key');
		// The marimo provider prefix is stripped before forwarding.
		expect(((await req.json()) as { model: string }).model).toBe('gpt-4o-mini');
	});

	it('forwards the OpenAI-Project header when upstreamProject is set', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('ok', { status: 200 }));
		await post(
			await token(),
			{ model: 'm', messages: [] },
			{
				ai: { ...AI, upstreamProject: 'my-team/my-project' },
			},
		);
		const req = fetchMock.mock.calls[0][0] as Request;
		expect(req.headers.get('openai-project')).toBe('my-team/my-project');
	});

	it('omits the OpenAI-Project header when upstreamProject is unset', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('ok', { status: 200 }));
		await post(await token(), { model: 'm', messages: [] });
		const req = fetchMock.mock.calls[0][0] as Request;
		expect(req.headers.get('openai-project')).toBeNull();
	});

	it('uses a request-authenticating fetch adapter without adding a bearer key', async () => {
		const upstreamFetch = vi.fn(async (request: Request) => {
			expect(request.headers.get('authorization')).toBeNull();
			return new Response('ok', { status: 200 });
		});
		const res = await post(
			await token(),
			{ model: 'm', messages: [] },
			{ ai: { ...AI, upstreamApiKey: undefined, upstreamFetch } },
		);

		expect(res.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledOnce();
	});

	it('falls back to the default model when off the allowlist', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('ok', { status: 200 }));
		await post(
			await token(),
			{ model: 'evil-model', messages: [] },
			{
				ai: { ...AI, allowedModels: ['gpt-4o-mini'] },
			},
		);
		const req = fetchMock.mock.calls[0][0] as Request;
		expect(((await req.json()) as { model: string }).model).toBe('gpt-4o-mini');
	});
});

describe('POST /api/ai/v1/responses', () => {
	const RESPONSES = '/api/ai/v1/responses';

	it('rejects a missing token', async () => {
		const res = await post(null, { model: 'x', input: 'hi' }, {}, RESPONSES);
		expect(res.status).toBe(401);
	});

	it('forwards to the upstream responses endpoint with the real key', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{"id":"resp_1"}', { status: 200 }));
		const res = await post(
			await token(),
			{ model: 'marimohub/gpt-4o-mini', input: 'hi' },
			{},
			RESPONSES,
		);
		expect(res.status).toBe(200);
		const req = fetchMock.mock.calls[0][0] as Request;
		expect(req.url).toBe('https://upstream.test/v1/responses');
		expect(req.headers.get('authorization')).toBe('Bearer real-key');
		expect(((await req.json()) as { model: string }).model).toBe('gpt-4o-mini');
	});
});

describe('GET /api/ai/v1/models', () => {
	it('lists the allowed models for a valid token', async () => {
		const res = await app({ ai: { ...AI, allowedModels: ['a', 'b'] } }).request(
			'/api/ai/v1/models',
			{ headers: { authorization: `Bearer ${await token()}` } },
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { data: { id: string }[] };
		expect(json.data.map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('rejects a missing token', async () => {
		const res = await app().request('/api/ai/v1/models');
		expect(res.status).toBe(401);
	});
});

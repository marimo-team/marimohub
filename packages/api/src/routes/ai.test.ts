import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAiSessionToken } from '@marimo-hub/core';
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
	xdgPath: '/opt/marimohub-config',
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

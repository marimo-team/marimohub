import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { apiClient, apiData, ApiRequestError } from './index';
import type { components } from './schema';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	const fn = vi.fn(impl);
	vi.stubGlobal('fetch', fn);
	return fn;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ApiRequestError', () => {
	it('carries a code and is an Error subclass', () => {
		const err = new ApiRequestError('NOT_FOUND', 'gone');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('ApiRequestError');
		expect(err.code).toBe('NOT_FOUND');
		expect(err.message).toBe('gone');
	});
});

describe('apiData', () => {
	it('unwraps the { success, data } envelope on success', async () => {
		stubFetch(async () => jsonResponse({ success: true, data: { id: 'proj-1', name: 'X' } }));

		const data = await apiData(apiClient.GET('/api/v1/me'));
		expect(data).toEqual({ id: 'proj-1', name: 'X' });
	});

	it('serializes the typed path, method, and body', async () => {
		const fn = stubFetch(async () => jsonResponse({ success: true, data: null }));

		await apiData(
			apiClient.POST('/api/v1/projects', {
				body: { name: 'Example', description: 'Typed request' },
			}),
		);

		const [input, init] = fn.mock.calls[0] ?? [];
		expect(input).toBe('/api/v1/projects');
		expect(init?.method).toBe('POST');
		expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
		expect(init?.body).toBe(JSON.stringify({ name: 'Example', description: 'Typed request' }));
	});

	it('throws ApiRequestError with the server code/message on { success: false }', async () => {
		stubFetch(async () =>
			jsonResponse({ success: false, error: { code: 'FORBIDDEN', message: 'nope' } }, 403),
		);

		await expect(apiData(apiClient.GET('/api/v1/me'))).rejects.toMatchObject({
			name: 'ApiRequestError',
			code: 'FORBIDDEN',
			message: 'nope',
		});
	});

	it('falls back to UNKNOWN / "Request failed" when the error envelope is bare', async () => {
		stubFetch(async () => jsonResponse({ success: false }, 500));

		await expect(apiData(apiClient.GET('/api/v1/me'))).rejects.toMatchObject({
			code: 'UNKNOWN',
			message: 'Request failed',
		});
	});

	it('throws PARSE_ERROR when the body is not JSON', async () => {
		stubFetch(
			async () =>
				new Response('<html>502 Bad Gateway</html>', {
					status: 502,
					headers: { 'content-type': 'text/html' },
				}),
		);

		const err = (await apiData(apiClient.GET('/api/v1/me')).catch(
			(e: unknown) => e,
		)) as ApiRequestError;
		expect(err).toBeInstanceOf(ApiRequestError);
		expect(err.code).toBe('PARSE_ERROR');
		expect(err.message).toContain('502');
	});

	it('throws NETWORK_ERROR when fetch rejects (no HTTP response)', async () => {
		stubFetch(async () => {
			throw new Error('Failed to fetch');
		});
		await expect(apiData(apiClient.GET('/api/v1/me'))).rejects.toMatchObject({
			name: 'ApiRequestError',
			code: 'NETWORK_ERROR',
		});
	});

	it('throws NETWORK_ERROR when the request times out', async () => {
		stubFetch(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('The operation was aborted', 'AbortError')),
					);
				}),
		);
		await expect(apiData(apiClient.GET('/api/v1/me', { timeout: 5 }))).rejects.toMatchObject({
			code: 'NETWORK_ERROR',
		});
	});

	it.each([null, [1, 2], 'plain', 42])(
		'throws PARSE_ERROR for a valid-JSON body that is not an envelope object (%o)',
		async (body) => {
			stubFetch(async () => jsonResponse(body));
			const err = (await apiData(apiClient.GET('/api/v1/me')).catch(
				(e: unknown) => e,
			)) as ApiRequestError;
			expect(err).toBeInstanceOf(ApiRequestError);
			expect(err.code).toBe('PARSE_ERROR');
		},
	);

	it('honors the envelope over the HTTP status (a 2xx { success:false } still throws)', async () => {
		stubFetch(async () =>
			jsonResponse({ success: false, error: { code: 'CONFLICT', message: 'stale' } }, 200),
		);
		await expect(apiData(apiClient.GET('/api/v1/me'))).rejects.toMatchObject({
			code: 'CONFLICT',
		});
	});

	it('returns undefined data when success is true but data is absent', async () => {
		stubFetch(async () => jsonResponse({ success: true }));
		expect(await apiData(apiClient.GET('/api/v1/me'))).toBeUndefined();
	});

	it('infers response data and rejects invalid paths and bodies', () => {
		expectTypeOf(() => apiData(apiClient.GET('/api/v1/me'))).returns.toEqualTypeOf<
			Promise<components['schemas']['Me']>
		>();

		expectTypeOf(
			// @ts-expect-error The route is not present in the generated schema.
			() => apiClient.GET('/api/v1/missing'),
		).toBeFunction();

		expectTypeOf(() =>
			apiClient.POST('/api/v1/projects', {
				// @ts-expect-error Project creation requires a description.
				body: { name: 'Missing description' },
			}),
		).toBeFunction();
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiRequestError } from './index';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function stubFetch(impl: () => Promise<Response>) {
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

describe('apiFetch', () => {
	it('unwraps the { success, data } envelope on success', async () => {
		stubFetch(async () => jsonResponse({ success: true, data: { id: 'proj-1', name: 'X' } }));

		const data = await apiFetch<{ id: string; name: string }>('/api/projects/proj-1');
		expect(data).toEqual({ id: 'proj-1', name: 'X' });
	});

	it('forwards the input URL and request init through to fetch', async () => {
		const fn = stubFetch(async () => jsonResponse({ success: true, data: null }));

		await apiFetch('/api/projects', { method: 'POST', body: '{}' });

		// ofetch normalizes options (Headers instance, added accept/content-type,
		// abort signal), so assert the URL + the parts we set, not verbatim equality.
		expect(fn).toHaveBeenCalledWith(
			'/api/projects',
			expect.objectContaining({ method: 'POST', body: '{}' }),
		);
	});

	it('throws ApiRequestError with the server code/message on { success: false }', async () => {
		stubFetch(async () =>
			jsonResponse({ success: false, error: { code: 'FORBIDDEN', message: 'nope' } }, 403),
		);

		await expect(apiFetch('/api/projects')).rejects.toMatchObject({
			name: 'ApiRequestError',
			code: 'FORBIDDEN',
			message: 'nope',
		});
	});

	it('falls back to UNKNOWN / "Request failed" when the error envelope is bare', async () => {
		stubFetch(async () => jsonResponse({ success: false }, 500));

		await expect(apiFetch('/api/projects')).rejects.toMatchObject({
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

		const err = (await apiFetch('/api/projects').catch((e) => e)) as ApiRequestError;
		expect(err).toBeInstanceOf(ApiRequestError);
		expect(err.code).toBe('PARSE_ERROR');
		expect(err.message).toContain('502');
	});
});

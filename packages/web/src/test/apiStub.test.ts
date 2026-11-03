import { afterEach, expect, it, vi } from 'vitest';
import { makeCapabilities, stubApi } from './apiStub';
import { jsonError } from './render';

afterEach(() => vi.unstubAllGlobals());

const read = async (path: string, init?: RequestInit) => {
	const response = await fetch(path, init);
	return { status: response.status, body: await response.json() };
};

it('routes by longest prefix and method, wrapping plain data in the envelope', async () => {
	const { requests } = stubApi({
		'/api/v1/projects': { items: [] },
		'/api/v1/projects/': ({ url }) => ({ id: url.pathname.split('/').at(-1) }),
		'PATCH /api/v1/projects/p': jsonError('FORBIDDEN', 'No', 403),
	});
	expect(await read('/api/v1/projects?limit=1')).toEqual({
		status: 200,
		body: { success: true, data: { items: [] } },
	});
	expect((await read('/api/v1/projects/p')).body).toEqual({ success: true, data: { id: 'p' } });
	expect((await read('/api/v1/projects/p', { method: 'PATCH' })).status).toBe(403);
	expect((await read('/api/v1/projects/p', { method: 'PATCH' })).status).toBe(403);
	await expect(fetch('/api/v1/other')).rejects.toThrow('Unexpected request: GET /api/v1/other');
	expect(requests).toEqual([
		'/api/v1/projects?limit=1',
		'/api/v1/projects/p',
		'/api/v1/projects/p',
		'/api/v1/projects/p',
		'/api/v1/other',
	]);
});

it('serves default identity and capabilities with nested overrides', async () => {
	stubApi({}, { me: { id: 'me' }, capabilities: { jobs: { available: true } } });
	expect((await read('/api/v1/me')).body).toMatchObject({ data: { id: 'me', app_only: false } });
	const { body } = await read('/api/v1/capabilities');
	expect(body).toMatchObject({ data: { jobs: { available: true, max_per_notebook: null } } });
	expect(makeCapabilities().search.available).toBe(false);
});

it('returns independent nested capabilities on each call', () => {
	const first = makeCapabilities();
	first.jobs.available = true;
	first.compute_profiles.push('large' as never);
	const second = makeCapabilities();
	expect(second.jobs.available).toBe(false);
	expect(second.compute_profiles).toEqual([]);
});

it('keeps defaults for undefined overrides', () => {
	const capabilities = makeCapabilities({
		search: undefined,
		jobs: { available: true, max_per_notebook: undefined },
	});
	expect(capabilities.search.available).toBe(false);
	expect(capabilities.jobs).toMatchObject({ available: true, max_per_notebook: null });
});

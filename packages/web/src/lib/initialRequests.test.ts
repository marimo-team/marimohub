import { afterEach, expect, it } from 'vitest';
import { consumeInitialRequest } from './initialRequests';
import { deferred } from '@/test/deferred';

afterEach(() => {
	delete window.__MARIMOHUB_PREFETCH__;
});

function seed(url: string, response: Promise<Response | null>, age = 0) {
	window.__MARIMOHUB_PREFETCH__ = {
		createdAt: Date.now() - age,
		responses: { [new URL(url, window.location.href).href]: response },
	};
}

it('consumes a matching request once, regardless of query ordering', async () => {
	const response = new Response('{}');
	seed('/api/v1/projects?limit=1&status=active', Promise.resolve(response));
	expect(await consumeInitialRequest('/api/v1/projects?status=active&limit=1')).toBe(response);
	expect(await consumeInitialRequest('/api/v1/projects?status=active&limit=1')).toBeUndefined();
});

it('gives a pending response to only one concurrent consumer', async () => {
	const fetch = deferred<Response | null>();
	seed('/api/v1/me', fetch.promise);
	const first = consumeInitialRequest('/api/v1/me');
	const second = consumeInitialRequest('/api/v1/me');
	expect(await second).toBeUndefined();
	fetch.resolve(new Response('account'));
	expect(await (await first)?.text()).toBe('account');
});

it('matches deployment prefixes exactly', async () => {
	const response = new Response('{}');
	seed('/hub/api/v1/me', Promise.resolve(response));
	expect(await consumeInitialRequest('/api/v1/me')).toBeUndefined();
	expect(await consumeInitialRequest('/hub/api/v1/me')).toBe(response);
});

it('discards expired preloads and never matches a different origin', async () => {
	seed('/api/v1/me', Promise.resolve(new Response('{}')), 30_001);
	expect(await consumeInitialRequest('/api/v1/me')).toBeUndefined();
	expect(window.__MARIMOHUB_PREFETCH__).toBeUndefined();
	seed('https://other.example/api/v1/me', Promise.resolve(new Response('{}')));
	expect(await consumeInitialRequest('https://other.example/api/v1/me')).toBeUndefined();
});

it.each([null, new Response('{}', { status: 503 })])(
	'retries failed preloads normally',
	async (response) => {
		seed('/api/v1/me', Promise.resolve(response));
		expect(await consumeInitialRequest('/api/v1/me')).toBeUndefined();
	},
);

it('does not deliver a preloaded response to an aborted consumer', async () => {
	seed('/api/v1/me', Promise.resolve(new Response('{}')));
	const controller = new AbortController();
	controller.abort(new Error('Cancelled'));
	await expect(consumeInitialRequest('/api/v1/me', controller.signal)).rejects.toThrow('Cancelled');
});

it('cancels a pending preload without waiting for the shell fetch', async () => {
	seed('/api/v1/me', new Promise(() => {}));
	const controller = new AbortController();
	const pending = consumeInitialRequest('/api/v1/me', controller.signal);
	controller.abort(new Error('Cancelled'));
	await expect(pending).rejects.toThrow('Cancelled');
});

it('falls back after a rejected preload', async () => {
	seed('/api/v1/me', Promise.reject(new Error('Network unavailable')));
	expect(await consumeInitialRequest('/api/v1/me')).toBeUndefined();
});

it('handles a late fetch rejection after consumer cancellation', async () => {
	const fetch = deferred<Response | null>();
	seed('/api/v1/me', fetch.promise);
	const controller = new AbortController();
	const pending = consumeInitialRequest('/api/v1/me', controller.signal);
	controller.abort('Route changed');
	await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	fetch.reject(new Error('Network unavailable'));
	await Promise.resolve();
});

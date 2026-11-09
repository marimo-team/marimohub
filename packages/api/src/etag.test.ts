import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { conditionalJsonEtag } from './etag';
import { createTestApi } from './testing';

describe('conditional GET (ETag)', () => {
	it('stamps an ETag + Cache-Control on reads and 304s a matching If-None-Match', async () => {
		const { app } = createTestApi();
		const res = await app.request('/api/v1/projects');
		expect(res.status).toBe(200);
		const etag = res.headers.get('etag');
		expect(etag).toBeTruthy();
		expect(res.headers.get('cache-control')).toBe('no-cache');

		const revalidated = await app.request('/api/v1/projects', {
			headers: { 'if-none-match': etag! },
		});
		expect(revalidated.status).toBe(304);
		expect(await revalidated.text()).toBe('');
		expect(revalidated.headers.get('etag')).toBe(etag);
		expect(revalidated.headers.get('cache-control')).toBe('no-cache');
	});

	it('returns 200 with a fresh body when the ETag is stale', async () => {
		const { app } = createTestApi();
		const res = await app.request('/api/v1/projects', {
			headers: { 'if-none-match': 'W/"deadbeef-0"' },
		});
		expect(res.status).toBe(200);
	});

	it('changes the ETag when the underlying data changes', async () => {
		const { app, request } = createTestApi();
		const before = (await app.request('/api/v1/projects')).headers.get('etag');
		await request('POST', '/projects', { name: 'New', description: 'd' });
		const after = (await app.request('/api/v1/projects')).headers.get('etag');
		expect(after).not.toBe(before);
	});
});

describe('JSON ETag scope', () => {
	function appFor(body: string, headers: Record<string, string> = {}) {
		const app = new Hono();
		app.use('*', conditionalJsonEtag());
		app.get(
			'/',
			() => new Response(body, { headers: { 'Content-Type': 'application/json', ...headers } }),
		);
		return app;
	}

	it.each([1023, 64 * 1024, 256 * 1024])(
		'hashes one bounded body copy independently of %i-byte stream chunks',
		async (chunkSize) => {
			const body = JSON.stringify('é'.repeat((256 * 1024 - 2) / 2));
			const bytes = new TextEncoder().encode(body);
			const app = new Hono();
			app.use('*', conditionalJsonEtag());
			app.get(
				'/',
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								for (let offset = 0; offset < bytes.length; offset += chunkSize) {
									controller.enqueue(bytes.slice(offset, offset + chunkSize));
								}
								controller.close();
							},
						}),
						{ headers: { 'Content-Type': 'application/json' } },
					),
			);
			const clone = vi.spyOn(Response.prototype, 'clone');
			try {
				const response = await app.request('/');
				expect(clone).toHaveBeenCalledTimes(1);
				expect(response.headers.get('ETag')).toBe(
					`W/"${createHash('sha1').update(bytes).digest('hex')}"`,
				);
				expect(response.headers.get('Content-Length')).toBe(String(bytes.length));
				expect(await response.text()).toBe(body);
			} finally {
				clone.mockRestore();
			}
		},
	);

	it.each([null, ''])('does not hash an empty response: %s', async (body) => {
		const app = new Hono();
		app.use('*', conditionalJsonEtag());
		app.get('/', () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
		const response = await app.request('/', { headers: { 'If-None-Match': '*' } });
		expect(response.status).toBe(200);
		expect(response.headers.has('ETag')).toBe(false);
		expect(await response.text()).toBe('');
	});

	it.each<Record<string, string>>([
		{ 'Cache-Control': 'private, no-store' },
		{ 'Content-Type': 'text/html' },
		{ 'Content-Type': 'text/event-stream' },
		{ 'Content-Length': String(256 * 1024 + 1) },
	])('does not hash or return 304 for excluded responses: %j', async (headers) => {
		const response = await appFor('{}', headers).request('/', {
			headers: { 'If-None-Match': '*' },
		});
		expect(response.status).toBe(200);
		expect(response.headers.has('ETag')).toBe(false);
		expect(await response.text()).toBe('{}');
	});

	it('skips large JSON without Content-Length and preserves the body', async () => {
		const body = JSON.stringify('x'.repeat(256 * 1024));
		const response = await appFor(body).request('/');
		expect(response.headers.has('ETag')).toBe(false);
		expect(await response.text()).toBe(body);
	});

	it('does not let an empty ETag bypass the size limit', async () => {
		const body = JSON.stringify('x'.repeat(256 * 1024));
		const response = await appFor(body, { ETag: '' }).request('/');
		expect(response.headers.get('ETag')).toBe('');
		expect(await response.text()).toBe(body);
	});

	it.each([256 * 1024, 256 * 1024 + 1])('bounds UTF-8 JSON hashing at %i bytes', async (size) => {
		const body = JSON.stringify('é'.repeat((256 * 1024 - 2) / 2) + (size % 2 ? 'a' : ''));
		expect(new TextEncoder().encode(body)).toHaveLength(size);
		const response = await appFor(body).request('/');
		expect(response.headers.has('ETag')).toBe(size === 256 * 1024);
		expect(await response.text()).toBe(body);
	});

	it('ignores conditional requests for no-store responses with an existing ETag', async () => {
		const response = await appFor('{}', {
			ETag: '"secret"',
			'Cache-Control': 'private, NO-STORE',
		}).request('/', { headers: { 'If-None-Match': '"secret"' } });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{}');
	});

	it('preserves cache metadata when a list of weak validators matches a strong route ETag', async () => {
		const headers = {
			ETag: '"revision"',
			'Cache-Control': 'private, no-cache',
			Vary: 'Origin',
			Expires: 'Wed, 01 Jan 2030 00:00:00 GMT',
		};
		const response = await appFor('{}', headers).request('/', {
			headers: { 'If-None-Match': '"stale", W/"revision"' },
		});
		expect(response.status).toBe(304);
		for (const [key, value] of Object.entries(headers))
			expect(response.headers.get(key)).toBe(value);
		expect(response.headers.has('Content-Length')).toBe(false);
		expect(await response.text()).toBe('');
	});

	it('retains a route ETag without reading a large body', async () => {
		const app = appFor(JSON.stringify('x'.repeat(256 * 1024)), { ETag: '"storage-revision"' });
		const response = await app.request('/', { headers: { 'If-None-Match': '"storage-revision"' } });
		expect(response.status).toBe(304);
		expect(response.headers.get('ETag')).toBe('"storage-revision"');
	});

	it('does not read an open SSE stream', async () => {
		const app = new Hono();
		app.use('*', conditionalJsonEtag());
		app.get(
			'/',
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('data: first\n\n'));
						},
					}),
					{ headers: { 'Content-Type': 'text/event-stream' } },
				),
		);
		const response = await app.request('/');
		expect(response.headers.has('ETag')).toBe(false);
		await response.body!.cancel();
	});

	it('stops inspecting an oversized chunked JSON body before the source closes', async () => {
		const body = JSON.stringify('x'.repeat(256 * 1024));
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const app = new Hono();
		app.use('*', conditionalJsonEtag());
		app.get(
			'/',
			() =>
				new Response(
					new ReadableStream({
						start(stream) {
							controller = stream;
							for (let offset = 0; offset < body.length; offset += 64 * 1024)
								stream.enqueue(new TextEncoder().encode(body.slice(offset, offset + 64 * 1024)));
						},
					}),
					{ headers: { 'Content-Type': 'application/json' } },
				),
		);
		let response: Response | undefined;
		const request = Promise.resolve(app.request('/')).then((value) => {
			response = value;
		});
		try {
			await vi.waitFor(() => expect(response).toBeDefined());
			expect(response!.headers.has('ETag')).toBe(false);
		} finally {
			controller.close();
			await request;
		}
		expect(await response!.text()).toBe(body);
	});

	it('does not read a body whose declared size exceeds the limit', async () => {
		const pull = vi.fn(() => {
			throw new Error('unexpected body read');
		});
		const app = new Hono();
		app.use('*', conditionalJsonEtag());
		app.get(
			'/',
			() =>
				new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), {
					headers: { 'Content-Type': 'application/json', 'Content-Length': String(256 * 1024 + 1) },
				}),
		);
		const response = await app.request('/', { headers: { 'If-None-Match': '*' } });
		expect(response.status).toBe(200);
		expect(pull).not.toHaveBeenCalled();
		await response.body!.cancel();
	});

	it('propagates a body read failure instead of issuing a validator or 304', async () => {
		const app = new Hono();
		app.use('*', conditionalJsonEtag());
		app.onError((error, c) => c.json({ error: error.message }, 500));
		app.get(
			'/',
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error('source failed'));
						},
					}),
					{ headers: { 'Content-Type': 'application/json' } },
				),
		);
		const response = await app.request('/', { headers: { 'If-None-Match': '*' } });
		expect(response.status).toBe(500);
		expect(response.headers.has('ETag')).toBe(false);
		expect(await response.json()).toEqual({ error: 'source failed' });
	});
});

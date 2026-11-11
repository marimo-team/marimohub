import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { conditionalJsonEtag } from './etag';
import { createTestApi } from './testing';
import { createApp, fail, sizedJsonResponses } from './shared';

function apiApp() {
	return createApp().use('/api/v1/*', sizedJsonResponses);
}

function etagApp() {
	return apiApp().use('*', conditionalJsonEtag());
}

async function expectSizedJson(response: Response, expected: unknown): Promise<void> {
	const bytes = await response.arrayBuffer();
	expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
	expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(expected);
}

describe('conditional GET (ETag)', () => {
	it('stamps an ETag + Cache-Control on reads and 304s a matching If-None-Match', async () => {
		const { app } = createTestApi();
		const res = await app.request('/api/v1/projects');
		expect(res.status).toBe(200);
		const etag = res.headers.get('etag');
		expect(etag).toBeTruthy();
		expect(res.headers.get('cache-control')).toBe('private, no-cache');

		const revalidated = await app.request('/api/v1/projects', {
			headers: { 'if-none-match': etag! },
		});
		expect(revalidated.status).toBe(304);
		expect(await revalidated.text()).toBe('');
		expect(revalidated.headers.get('etag')).toBe(etag);
		expect(revalidated.headers.get('cache-control')).toBe('private, no-cache');
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
		const app = etagApp();
		app.get(
			'/',
			() =>
				new Response(body, {
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': String(new TextEncoder().encode(body).byteLength),
						...headers,
					},
				}),
		);
		return app;
	}

	it.each([1023, 64 * 1024, 256 * 1024])(
		'hashes one bounded body copy independently of %i-byte stream chunks',
		async (chunkSize) => {
			const body = JSON.stringify('é'.repeat((256 * 1024 - 2) / 2));
			const bytes = new TextEncoder().encode(body);
			const app = etagApp();
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
						{
							headers: {
								'Content-Type': 'application/json',
								'Content-Length': String(bytes.length),
							},
						},
					),
			);
			using clone = vi.spyOn(Response.prototype, 'clone');
			const response = await app.request('/');
			expect(clone).toHaveBeenCalledTimes(1);
			expect(response.headers.get('ETag')).toBe(
				`W/"${createHash('sha1').update(bytes).digest('hex')}"`,
			);
			expect(response.headers.get('Content-Length')).toBe(String(bytes.length));
			expect(await response.text()).toBe(body);
		},
	);

	it.each([null, ''])('does not hash an empty response: %s', async (body) => {
		const app = etagApp();
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

	it('skips large JSON with an empty Content-Length and preserves the body', async () => {
		const body = JSON.stringify('x'.repeat(256 * 1024));
		const response = await appFor(body, { 'Content-Length': '' }).request('/');
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
		const app = etagApp();
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

	it('bounds reads even when a stream understates its Content-Length', async () => {
		const body = JSON.stringify('x'.repeat(256 * 1024));
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const app = etagApp();
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
					{ headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } },
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

	it.each([
		undefined,
		'',
		'invalid',
		'0',
		'-1',
		'1.5',
		'Infinity',
		'1e3',
		'0x10',
		'+100',
		'100.0',
		String(Number.MAX_SAFE_INTEGER + 1),
		String(256 * 1024 + 1),
	])('skips bodies without a valid, bounded length: %s', async (length) => {
		const pull = vi.fn(() => {
			throw new Error('unexpected body read');
		});
		const app = etagApp();
		app.get(
			'/',
			() =>
				new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), {
					headers: {
						'Content-Type': 'application/json',
						...(length === undefined ? {} : { 'Content-Length': length }),
					},
				}),
		);
		using clone = vi.spyOn(Response.prototype, 'clone');
		const response = await app.request('/', { headers: { 'If-None-Match': '*' } });
		expect(response.status).toBe(200);
		expect(clone).not.toHaveBeenCalled();
		expect(pull).not.toHaveBeenCalled();
		await response.body!.cancel();
	});

	it.each(['"storage-revision"', '"stale"'])(
		'uses a route ETag without reading an unknown-length stream: %s',
		async (validator) => {
			const pull = vi.fn(() => {
				throw new Error('unexpected body read');
			});
			const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
			const app = etagApp();
			app.get(
				'/',
				() =>
					new Response(body, {
						headers: { 'Content-Type': 'application/json', ETag: '"storage-revision"' },
					}),
			);
			using clone = vi.spyOn(Response.prototype, 'clone');
			try {
				const response = await app.request('/', { headers: { 'If-None-Match': validator } });
				expect(response.status).toBe(validator === '"stale"' ? 200 : 304);
				expect(response.headers.get('ETag')).toBe('"storage-revision"');
				expect(clone).not.toHaveBeenCalled();
				expect(pull).not.toHaveBeenCalled();
			} finally {
				await body.cancel();
			}
		},
	);

	it('propagates a body read failure instead of issuing a validator or 304', async () => {
		const app = etagApp();
		app.onError((error, c) => c.json({ error: error.message }, 500));
		app.get(
			'/api/v1/example',
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error('source failed'));
						},
					}),
					{ headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } },
				),
		);
		const response = await app.request('/api/v1/example', { headers: { 'If-None-Match': '*' } });
		expect(response.status).toBe(500);
		expect(response.headers.has('ETag')).toBe(false);
		await expectSizedJson(response, { error: 'source failed' });
	});
});

describe('serialized API JSON', () => {
	it.each(['circular reference', 'bigint', 'throwing toJSON'])(
		'preserves the error body and length after serialization fails: %s',
		async (scenario) => {
			const payload: Record<string, unknown> = {};
			if (scenario === 'circular reference') payload.self = payload;
			if (scenario === 'bigint') payload.value = 1n;
			if (scenario === 'throwing toJSON')
				payload.toJSON = () => {
					throw new Error('serialization failed');
				};
			const app = etagApp();
			app.onError((_error, c) => fail(c, 'INTERNAL_ERROR', 'Could not serialize response', 500));
			app.get('/api/v1/example', (c) => c.json(payload));
			using clone = vi.spyOn(Response.prototype, 'clone');
			const response = await app.request('/api/v1/example', { headers: { 'If-None-Match': '*' } });
			expect(response.status).toBe(500);
			expect(response.headers.get('Content-Type')).toBe('application/json');
			expect(response.headers.has('ETag')).toBe(false);
			expect(clone).not.toHaveBeenCalled();
			await expectSizedJson(response, {
				success: false,
				error: { code: 'INTERNAL_ERROR', message: 'Could not serialize response' },
			});
		},
	);

	it.each([null, '', false, 0])('preserves a scalar JSON body: %j', async (payload) => {
		const app = apiApp();
		app.get('/api/v1/example', (c) => c.json(payload));
		const response = await app.request('/api/v1/example');
		await expectSizedJson(response, payload);
	});

	it('replaces stale length headers while retaining cookies and custom JSON content types', async () => {
		const app = apiApp();
		app.get('/api/v1/example', (c) => {
			c.header('Content-Length', '999');
			c.header('Set-Cookie', 'first=1; HttpOnly', { append: true });
			c.header('Set-Cookie', 'second=2; HttpOnly', { append: true });
			return c.json({ message: 'café' }, 422, {
				'Content-Length': '888',
				'Content-Type': 'application/problem+json',
			});
		});
		const response = await app.request('/api/v1/example');
		expect(response.status).toBe(422);
		expect(response.headers.get('Content-Type')).toBe('application/problem+json');
		expect(response.headers.getSetCookie()).toEqual(['first=1; HttpOnly', 'second=2; HttpOnly']);
		await expectSizedJson(response, { message: 'café' });
	});

	it.each([1_000_000, 10_000_000])('does not tee a %i-byte JSON payload', async (size) => {
		const payload = { data: 'x'.repeat(size) };
		const app = etagApp();
		app.get('/api/v1/roster', (c) => c.json(payload));
		using clone = vi.spyOn(Response.prototype, 'clone');
		const response = await app.request('/api/v1/roster?limit=500');
		expect(clone).not.toHaveBeenCalled();
		expect(response.headers.has('ETag')).toBe(false);
		await expectSizedJson(response, payload);
	});

	it('serializes once and preserves status, headers, and UTF-8 bytes', async () => {
		const toJSON = vi.fn(() => ({ message: 'café 😀' }));
		const app = apiApp();
		app.post('/api/v1/example', (c) => {
			c.header('X-Prepared', 'prepared');
			return c.json({ toJSON }, 201, { 'X-Route': 'route' });
		});
		const response = await app.request('/api/v1/example', { method: 'POST' });
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(201);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		expect(response.headers.get('X-Prepared')).toBe('prepared');
		expect(response.headers.get('X-Route')).toBe('route');
		await expectSizedJson(response, { message: 'café 😀' });
	});

	it('preserves the ResponseInit overload', async () => {
		const app = apiApp();
		app.get('/api/v1/example', (c) =>
			c.json(
				{ ok: true },
				{
					status: 202,
					headers: { 'X-Route': 'route' },
				},
			),
		);
		const response = await app.request('/api/v1/example');
		expect(response.status).toBe(202);
		expect(response.headers.get('X-Route')).toBe('route');
		await expectSizedJson(response, { ok: true });
	});
});

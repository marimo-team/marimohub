import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import { createApp } from '@marimo-hub/api';
import { createTestApi } from '@marimo-hub/api/testing';
import { describe, expect, it, vi } from 'vitest';
import { compressResponse } from './compression';

function compressionApp() {
	return createApp().use('*', compressResponse());
}

describe('response compression', () => {
	it.each([
		['Origin', 'Origin, Accept-Encoding'],
		['*', '*'],
		['Origin, accept-encoding', 'Origin, accept-encoding'],
	])('preserves encoding variation on 304 responses: %s', async (vary, expected) => {
		const app = compressionApp();
		app.get('/', () => new Response(null, { status: 304, headers: { Vary: vary } }));
		const response = await app.request('/', { headers: { 'Accept-Encoding': 'gzip' } });
		expect(response.status).toBe(304);
		expect(response.headers.get('Vary')).toBe(expected);
		expect(response.headers.has('Content-Encoding')).toBe(false);
		expect(await response.text()).toBe('');
	});

	it.each([undefined, 'identity', 'gzip;q=0, deflate;q=0', 'gzip;q=0, deflate;q=0, *;q=1'])(
		'does not wait for an open body when compression is declined: %s',
		async (encoding) => {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const app = compressionApp();
			app.get(
				'/',
				() =>
					new Response(
						new ReadableStream({
							start(stream) {
								controller = stream;
								stream.enqueue(new TextEncoder().encode('first'));
							},
						}),
						{ headers: { 'Content-Type': 'text/plain' } },
					),
			);
			let response: Response | undefined;
			const request = Promise.resolve(
				app.request('/', {
					headers: encoding === undefined ? {} : { 'Accept-Encoding': encoding },
				}),
			).then((value) => {
				response = value;
			});
			try {
				await vi.waitFor(() => expect(response).toBeDefined());
				expect(response!.headers.has('Content-Encoding')).toBe(false);
				expect(response!.headers.get('Vary')).toContain('Accept-Encoding');
			} finally {
				controller.close();
				await request;
				await response!.body!.cancel();
			}
		},
	);

	it.each([
		['text/plain', ''],
		['text/plain', 'first'],
		['text/html', ''],
		['text/html', '<p>first</p>'],
	])('returns headers before an open %s stream ends: %j', async (contentType, body) => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const app = compressionApp();
		app.get(
			'/',
			() =>
				new Response(
					new ReadableStream({
						start(stream) {
							controller = stream;
							if (body) stream.enqueue(new TextEncoder().encode(body));
						},
					}),
					{ headers: { 'Content-Type': contentType } },
				),
		);
		let response: Response | undefined;
		const request = Promise.resolve(
			app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }),
		).then((value) => {
			response = value;
		});
		try {
			await vi.waitFor(() => expect(response).toBeDefined());
			expect(response!.headers.get('Content-Encoding')).toBe('gzip');
			expect(response!.headers.has('Content-Length')).toBe(false);
		} finally {
			controller.close();
			await request;
		}
		expect(gunzipSync(Buffer.from(await response!.arrayBuffer())).toString()).toBe(body);
	});

	it.each([1023, 1024, 1025])(
		'uses the declared byte threshold for a %i-byte body',
		async (size) => {
			const body = 'é'.repeat(Math.floor(size / 2)) + (size % 2 ? 'a' : '');
			const app = compressionApp();
			app.get('/', (c) => c.text(body, 200, { 'Content-Length': String(size) }));
			const response = await app.request('/', { headers: { 'Accept-Encoding': 'gzip' } });
			expect(response.headers.get('Content-Encoding')).toBe(size < 1024 ? null : 'gzip');
			const bytes = Buffer.from(await response.arrayBuffer());
			expect((size < 1024 ? bytes : gunzipSync(bytes)).toString()).toBe(body);
		},
	);

	it.each<Record<string, string>>([
		{ 'Cache-Control': 'private, No-Transform' },
		{ 'Content-Type': 'application/octet-stream' },
		{ 'Transfer-Encoding': 'chunked' },
	])('does not read excluded streaming responses: %j', async (headers) => {
		const pull = vi.fn(() => {
			throw new Error('unexpected body read');
		});
		const app = compressionApp();
		app.get(
			'/',
			() =>
				new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), {
					headers: { 'Content-Type': 'text/plain', ...headers },
				}),
		);
		const response = await app.request('/', { headers: { 'Accept-Encoding': 'gzip' } });
		expect(response.status).toBe(200);
		expect(response.headers.has('Content-Encoding')).toBe(false);
		expect(pull).not.toHaveBeenCalled();
		await response.body!.cancel();
	});

	it('preserves byte ranges without compressing the selected bytes', async () => {
		const body = 'partial '.repeat(200);
		const app = compressionApp();
		app.get('/', (c) =>
			c.text(body, 206, {
				'Content-Length': String(body.length),
				'Content-Range': `bytes 0-${body.length - 1}/${body.length * 2}`,
			}),
		);
		const response = await app.request('/', { headers: { 'Accept-Encoding': 'gzip' } });
		expect(response.status).toBe(206);
		expect(response.headers.has('Content-Encoding')).toBe(false);
		expect(response.headers.get('Content-Length')).toBe(String(body.length));
		expect(response.headers.get('Content-Range')).toBe(
			`bytes 0-${body.length - 1}/${body.length * 2}`,
		);
		expect(await response.text()).toBe(body);
	});

	it('preserves HEAD metadata without adding an encoding to an absent body', async () => {
		const app = compressionApp();
		app.get('/', (c) => c.text('body '.repeat(300), 200, { 'Content-Length': '1500' }));
		const response = await app.request('/', {
			method: 'HEAD',
			headers: { 'Accept-Encoding': 'gzip' },
		});
		expect(response.headers.has('Content-Encoding')).toBe(false);
		expect(response.headers.get('Content-Length')).toBe('1500');
		expect(await response.text()).toBe('');
	});

	it('honors explicit refusal over a wildcard and preserves an error response', async () => {
		const body = 'unavailable '.repeat(200);
		const app = compressionApp();
		app.get('/', (c) =>
			c.text(body, 503, { ETag: '"revision"', Vary: 'Origin', 'Retry-After': '5' }),
		);
		const response = await app.request('/', {
			headers: { 'Accept-Encoding': 'gzip;q=0, *;q=0.5' },
		});
		expect(response.status).toBe(503);
		expect(response.headers.get('Content-Encoding')).toBe('deflate');
		expect(response.headers.get('ETag')).toBe('W/"revision"');
		expect(response.headers.get('Vary')).toBe('Origin, Accept-Encoding');
		expect(response.headers.get('Retry-After')).toBe('5');
		expect(inflateSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(body);
	});

	const payload = { value: 'data'.repeat(1024) };
	it.each(['gzip', 'identity', 'gzip;q=0'])('negotiates API JSON: %s', async (encoding) => {
		const app = compressionApp();
		app.get('/', (c) => c.json(payload));
		const response = await app.request('/', { headers: { 'Accept-Encoding': encoding } });
		expect(response.headers.get('Content-Encoding')).toBe(encoding === 'gzip' ? 'gzip' : null);
		expect(response.headers.get('Vary')).toContain('Accept-Encoding');
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(JSON.parse((encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString())).toEqual(
			payload,
		);
	});

	it.each(['GET', 'POST', 'PUT', 'DELETE'])('skips small API JSON for %s', async (method) => {
		const app = compressionApp();
		app.on(method, '/api/v1/example', (c) => c.json({ ok: true }));
		using compression = vi.spyOn(globalThis, 'CompressionStream');
		const response = await app.request('/api/v1/example', {
			method,
			headers: { 'Accept-Encoding': 'gzip' },
		});
		expect(compression).not.toHaveBeenCalled();
		expect(response.headers.has('Content-Encoding')).toBe(false);
		expect(response.headers.get('Content-Length')).toBe('11');
		expect(await response.json()).toEqual({ ok: true });
	});

	it.each([1023, 1024, 1025])('uses serialized UTF-8 JSON length at %i bytes', async (size) => {
		const payload = 'é'.repeat(Math.floor((size - 2) / 2)) + (size % 2 ? 'a' : '');
		const app = compressionApp();
		app.post('/api/v1/example', (c) => c.json(payload));
		const response = await app.request('/api/v1/example', {
			method: 'POST',
			headers: { 'Accept-Encoding': 'gzip' },
		});
		expect(response.headers.get('Content-Encoding')).toBe(size < 1024 ? null : 'gzip');
		expect(response.headers.get('Content-Length')).toBe(size < 1024 ? String(size) : null);
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(JSON.parse((size < 1024 ? bytes : gunzipSync(bytes)).toString())).toBe(payload);
	});

	it('skips compression for small API errors', async () => {
		const app = compressionApp();
		app.onError((error, c) => c.json({ error: error.message }, 500));
		app.get('/api/v1/example', () => {
			throw new Error('failed');
		});
		const response = await app.request('/api/v1/example', {
			headers: { 'Accept-Encoding': 'gzip' },
		});
		expect(response.status).toBe(500);
		expect(response.headers.has('Content-Encoding')).toBe(false);
		expect(response.headers.get('Content-Length')).toBe('18');
		expect(await response.json()).toEqual({ error: 'failed' });
	});

	it('preserves JSON HEAD and 304 metadata through the API and compression stack', async () => {
		const { app: api } = createTestApi();
		const app = compressionApp().route('/', api);
		const headers = { 'Accept-Encoding': 'gzip' };
		const get = await app.request('/api/v1/projects', { headers });
		expect(get.status).toBe(200);
		const etag = get.headers.get('ETag');
		expect(etag).toBeTruthy();
		const bytes = await get.arrayBuffer();
		expect(get.headers.get('Content-Length')).toBe(String(bytes.byteLength));
		const head = await app.request('/api/v1/projects', { method: 'HEAD', headers });
		expect(head.status).toBe(200);
		expect(head.headers.get('ETag')).toBe(etag);
		expect(head.headers.get('Content-Length')).toBe(String(bytes.byteLength));
		expect(head.headers.has('Content-Encoding')).toBe(false);
		expect(await head.text()).toBe('');
		for (const method of ['GET', 'HEAD']) {
			const response = await app.request('/api/v1/projects', {
				method,
				headers: { ...headers, 'If-None-Match': etag! },
			});
			expect(response.status).toBe(304);
			expect(response.headers.get('ETag')).toBe(etag);
			expect(response.headers.has('Content-Length')).toBe(false);
			expect(response.headers.has('Content-Encoding')).toBe(false);
			expect(response.headers.get('Vary')).toContain('Accept-Encoding');
			expect(await response.text()).toBe('');
		}
	});

	it.each([401, 422, 429, 503] as const)(
		'leaves small JSON errors uncompressed: %i',
		async (status) => {
			const app = compressionApp();
			app.post('/api/v1/example', (c) =>
				c.json({ error: 'request failed' }, status, { 'Retry-After': '5' }),
			);
			using compression = vi.spyOn(globalThis, 'CompressionStream');
			const response = await app.request('/api/v1/example', {
				method: 'POST',
				headers: { 'Accept-Encoding': 'gzip' },
			});
			expect(response.status).toBe(status);
			expect(compression).not.toHaveBeenCalled();
			expect(response.headers.has('Content-Encoding')).toBe(false);
			expect(response.headers.get('Retry-After')).toBe('5');
			const bytes = await response.arrayBuffer();
			expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
			expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ error: 'request failed' });
		},
	);

	it('leaves already-encoded bodies untouched', async () => {
		const bytes = gzipSync(JSON.stringify(payload));
		const app = compressionApp();
		app.get(
			'/',
			() =>
				new Response(bytes, {
					headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
				}),
		);
		const response = await app.request('/', { headers: { 'Accept-Encoding': 'gzip' } });
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
	});

	it.each(['/api/v1/projects/p/conversations/c/stream', '/api/host/v1/events'])(
		'does not buffer an open SSE stream: %s',
		async (path) => {
			const app = compressionApp();
			app.get(
				path,
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('data: first\n\n'));
							},
						}),
						{ headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
					),
			);
			const response = await app.request(path, { headers: { 'Accept-Encoding': 'gzip' } });
			expect(response.headers.has('Content-Encoding')).toBe(false);
			const reader = response.body!.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
			await reader.cancel();
		},
	);
});

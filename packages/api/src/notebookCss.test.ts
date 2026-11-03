import { afterEach, expect, it, vi } from 'vitest';
import { NotebookCssCache, notebookCssCacheFor, notebookCssUrl } from './notebookCss';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { UnavailableError } from '@marimo-hub/core/errors';

afterEach(() => vi.unstubAllGlobals());
function css(body: BodyInit | null, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'text/css; charset=utf-8');
	return new Response(body, { ...init, headers });
}
it('coalesces requests, reuses fresh CSS, and revalidates with its ETag', async () => {
	let now = 0;
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(css('body {}', { headers: { ETag: 'v1' } }))
		.mockResolvedValueOnce(new Response(null, { status: 304 }))
		.mockResolvedValueOnce(css('body {color:red}', { headers: { ETag: 'v2' } }));
	vi.stubGlobal('fetch', fetch);
	const cache = new NotebookCssCache(() => now);
	expect(
		await Promise.all([
			cache.get('https://example.com/a.css'),
			cache.get('https://example.com/a.css'),
		]),
	).toEqual(['body {}', 'body {}']);
	expect(await cache.get('https://example.com/a.css')).toBe('body {}');
	expect(fetch).toHaveBeenCalledTimes(1);
	now = 60_001;
	expect(await cache.get('https://example.com/a.css')).toBe('body {}');
	expect(fetch.mock.calls[1][1].headers).toEqual({ 'If-None-Match': 'v1' });
	now += 60_001;
	expect(await cache.get('https://example.com/a.css')).toBe('body {color:red}');
});
it.each([
	css('x'.repeat(65537)),
	css('é'.repeat(32769)),
	css('no', { status: 500 }),
	new Response(null, { status: 304 }),
	new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
	new Response('body {}', { headers: { 'content-type': 'text/cssx' } }),
])('rejects invalid CSS responses and permits retries', async (response) => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(css('ok')));
	const cache = new NotebookCssCache();
	await expect(cache.get('https://example.com/css')).rejects.toThrow(
		'MARIMOHUB_THEME_NOTEBOOK_CSS',
	);
	expect(await cache.get('https://example.com/css')).toBe('ok');
});
it('accepts exactly 64 KiB', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => css('x'.repeat(65536))),
	);
	expect((await new NotebookCssCache().get('https://example.com/css')).length).toBe(65536);
});
it('reuses deployment CSS without sharing cached content across deployments', async () => {
	const theme = { ...DEFAULT_THEME_CONFIG };
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(css('first deployment'))
		.mockResolvedValueOnce(css('second deployment'));
	vi.stubGlobal('fetch', fetch);
	const url = 'https://example.com/brand.css';
	expect(await notebookCssCacheFor(theme).get(url)).toBe('first deployment');
	expect(await notebookCssCacheFor(theme).get(url)).toBe('first deployment');
	expect(await notebookCssCacheFor({ ...theme }).get(url)).toBe('second deployment');
	expect(fetch).toHaveBeenCalledTimes(2);
});

it('resolves root-relative CSS only against a configured origin', () => {
	expect(() => notebookCssUrl('/brand.css')).toThrow('MARIMOHUB_APP_BASE_URL');
	expect(notebookCssUrl('/brand.css', 'https://hub.example.com/team')).toBe(
		'https://hub.example.com/brand.css',
	);
	expect(notebookCssUrl('https://cdn.example.com/brand.css')).toBe(
		'https://cdn.example.com/brand.css',
	);
});

it.each([undefined, '', ' ', 'not-a-url'])(
	'resolves absolute CSS without using the base URL %j',
	(appBaseUrl) => {
		expect(notebookCssUrl('https://cdn.example.com/brand.css', appBaseUrl)).toBe(
			'https://cdn.example.com/brand.css',
		);
	},
);

it.each(['not-a-url', '//hub.example.com', 'https://hub.example.com:99999'])(
	'normalizes malformed base URL %j without losing the parsing cause',
	(appBaseUrl) => {
		let error: unknown;
		try {
			notebookCssUrl('/brand.css', appBaseUrl);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(UnavailableError);
		expect(error).toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
			status: 503,
			cause: expect.any(TypeError),
		});
		expect(String(error)).toContain('MARIMOHUB_APP_BASE_URL');
		expect(String(error)).not.toContain(appBaseUrl);
	},
);

it('releases the reader after a response stream fails', async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error('connection reset with private upstream details'));
		},
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(body)),
	);
	await expect(new NotebookCssCache().get('https://example.com/css')).rejects.toThrow(
		'Unable to load deployment notebook CSS',
	);
	expect(body.locked).toBe(false);
});

it('cancels a chunked response as soon as it exceeds the byte limit', async () => {
	const cancel = vi.fn();
	let reads = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				reads++;
				controller.enqueue(new Uint8Array(reads === 1 ? 65536 : 1));
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(body, { headers: { 'content-length': '1' } })),
	);
	await expect(new NotebookCssCache().get('https://example.com/css')).rejects.toThrow('64 KiB');
	expect(reads).toBe(2);
	expect(cancel).toHaveBeenCalledOnce();
	expect(body.locked).toBe(false);
});

it('rejects malformed UTF-8 and retries without caching the invalid response', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])))
		.mockResolvedValueOnce(css('valid'));
	vi.stubGlobal('fetch', fetch);
	const cache = new NotebookCssCache();
	await expect(cache.get('https://example.com/css')).rejects.toThrow('UTF-8');
	expect(await cache.get('https://example.com/css')).toBe('valid');
	expect(fetch).toHaveBeenCalledTimes(2);
});

it('propagates a timeout to concurrent callers and permits a later retry', async () => {
	const controller = new AbortController();
	const timeoutError = new DOMException('private upstream URL', 'TimeoutError');
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
	const fetch = vi
		.fn()
		.mockImplementationOnce(
			(_url, { signal }: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					signal!.addEventListener('abort', () => reject(timeoutError), { once: true });
				}),
		)
		.mockResolvedValueOnce(css('recovered'));
	vi.stubGlobal('fetch', fetch);
	try {
		const cache = new NotebookCssCache();
		const first = cache.get('https://example.com/css');
		const second = cache.get('https://example.com/css');
		const results = Promise.allSettled([first, second]);
		controller.abort(timeoutError);
		for (const result of await results) {
			expect(result.status).toBe('rejected');
			if (result.status === 'rejected') {
				expect(result.reason.message).toContain('MARIMOHUB_THEME_NOTEBOOK_CSS');
				expect(result.reason.message).not.toContain('private upstream URL');
			}
		}
		expect(timeout).toHaveBeenCalledWith(5000);
		expect(fetch).toHaveBeenCalledOnce();
		expect(await cache.get('https://example.com/css')).toBe('recovered');
	} finally {
		timeout.mockRestore();
	}
});

it('serves stale CSS after failed revalidation and retries on the next request', async () => {
	let now = 0;
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(css('original', { headers: { etag: 'v1' } }))
		.mockRejectedValueOnce(new Error('DNS failure'))
		.mockResolvedValueOnce(css(null, { status: 304 }));
	vi.stubGlobal('fetch', fetch);
	const cache = new NotebookCssCache(() => now);
	expect(await cache.get('https://example.com/css')).toBe('original');
	now = 60_000;
	expect(await cache.get('https://example.com/css')).toBe('original');
	expect(await cache.get('https://example.com/css')).toBe('original');
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.calls[2][1].headers).toEqual({ 'If-None-Match': 'v1' });
});

it('serves the last fetched CSS when revalidation fails after a recovery', async () => {
	let now = 0;
	const fetch = vi
		.fn()
		.mockRejectedValueOnce(new Error('DNS failure'))
		.mockResolvedValueOnce(css('recovered'))
		.mockResolvedValueOnce(new Response('upstream error', { status: 502 }));
	vi.stubGlobal('fetch', fetch);
	const cache = new NotebookCssCache(() => now);
	await expect(cache.get('https://example.com/css')).rejects.toThrow('Unable to load');
	expect(await cache.get('https://example.com/css')).toBe('recovered');
	now = 60_000;
	expect(await cache.get('https://example.com/css')).toBe('recovered');
	expect(fetch).toHaveBeenCalledTimes(3);
});

it('re-fetches expired CSS without an ETag and keeps URLs isolated', async () => {
	let now = 0;
	const fetch = vi.fn().mockImplementation(async (url) => css(String(url)));
	vi.stubGlobal('fetch', fetch);
	const cache = new NotebookCssCache(() => now);
	expect(await cache.get('https://example.com/a.css')).toBe('https://example.com/a.css');
	expect(await cache.get('https://example.com/b.css')).toBe('https://example.com/b.css');
	now = 60_000;
	await cache.get('https://example.com/a.css');
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.calls[2][1].headers).toEqual({});
});

it('cancels an unsuccessful response body instead of consuming it', async () => {
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({ cancel });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(body, { status: 503 })),
	);
	await expect(new NotebookCssCache().get('https://example.com/css')).rejects.toThrow(
		'Unable to load',
	);
	expect(cancel).toHaveBeenCalledOnce();
});

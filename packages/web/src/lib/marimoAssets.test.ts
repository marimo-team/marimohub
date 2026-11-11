import { afterEach, expect, it, vi } from 'vitest';
import { marimoAssetHints, prefetchMarimoAssets } from './marimoAssets';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.head
		.querySelectorAll('link[rel="prefetch"], link[rel="preconnect"]')
		.forEach((link) => link.remove());
});

it('preconnects templates without guessing an installed runtime version', async () => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await prefetchMarimoAssets('https://template.example/frontend@{version}/dist');
	expect(document.querySelector('link[rel="preconnect"]')).toHaveAttribute(
		'href',
		'https://template.example',
	);
	expect(fetch).not.toHaveBeenCalled();
});

it('prefetches only hashed modules and styles under the exact version base', () => {
	const base = new URL('https://cdn.example/frontend@0.24.2/dist/');
	expect(
		marimoAssetHints(
			`
		<script type="module" src="http://["></script>
		<script type="module" src="./assets/index-AbCd1234.js"></script>
		<link rel="modulepreload" href="./assets/index-AbCd1234.js">
		<link rel="stylesheet" href="./assets/index-EfGh5678.css">
		<script src="./assets/plain-AbCd1234.js"></script>
		<script type="module" src="https://evil.example/index-AbCd1234.js"></script>
		<script type="module" src="https://user:secret@cdn.example/frontend@0.24.2/dist/index-AbCd1234.js"></script>
		<link rel="stylesheet" href="../../other/index-EfGh5678.css">
		<link rel="stylesheet" href="./assets/plain.css">
	`,
			base,
		),
	).toEqual([
		'https://cdn.example/frontend@0.24.2/dist/assets/index-AbCd1234.js',
		'https://cdn.example/frontend@0.24.2/dist/assets/index-EfGh5678.css',
	]);
	expect(
		marimoAssetHints(
			Array.from(
				{ length: 100 },
				(_, i) => `<link rel="stylesheet" href="./index-abcdef${i}.css">`,
			).join(''),
			base,
		),
	).toHaveLength(32);
});

it('starts one bounded index request per pinned version and expires hints', async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(
		async (..._args: Parameters<typeof globalThis.fetch>) =>
			new Response('<script type="module" src="./assets/index-AbCd1234.js"></script>'),
	);
	vi.stubGlobal('fetch', fetch);
	await Promise.all([
		prefetchMarimoAssets('https://pinned.example/frontend@0.24.2/dist'),
		prefetchMarimoAssets('https://pinned.example/frontend@0.24.2/dist'),
	]);
	expect(fetch).toHaveBeenCalledOnce();
	expect(String(fetch.mock.calls[0]?.[0])).toBe(
		'https://pinned.example/frontend@0.24.2/dist/index.html',
	);
	expect(document.querySelector('link[rel="prefetch"]')).toHaveAttribute(
		'href',
		'https://pinned.example/frontend@0.24.2/dist/assets/index-AbCd1234.js',
	);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(document.querySelector('link[rel="prefetch"]')).toBeNull();
});

it.each([
	'http://unsafe.example/0.24.2/',
	'https://user:pass@unsafe.example/0.24.2/',
	'https://unsafe.example/0.24.2/?token=secret',
	'hub',
])('ignores unsafe asset origins: %s', async (url) => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await prefetchMarimoAssets(url);
	expect(fetch).not.toHaveBeenCalled();
	expect(document.querySelector('link[rel="preconnect"]')).toBeNull();
});

it('ignores oversized and failed indexes without blocking session admission', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(new Response('x'.repeat(512 * 1024 + 1)))
		.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
		.mockRejectedValueOnce(new TypeError('Network unavailable'));
	vi.stubGlobal('fetch', fetch);
	for (let attempt = 0; attempt < 3; attempt++)
		await expect(
			prefetchMarimoAssets('https://failure.example/frontend@0.24.2/dist'),
		).resolves.toBeUndefined();
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(document.querySelector('link[rel="prefetch"]')).toBeNull();
});

it.each(['', '/'])('prefetches a pinned hub version with suffix %s', async (suffix) => {
	const fetch = vi.fn(
		async (..._args: Parameters<typeof globalThis.fetch>) =>
			new Response('<link rel="stylesheet" href="./assets/index-AbCd1234.css">'),
	);
	vi.stubGlobal('fetch', fetch);
	const origin = suffix ? 'https://slash.example' : 'https://no-slash.example';
	await prefetchMarimoAssets(`${origin}/_marimo/0.25.2${suffix}`);
	expect(fetch).toHaveBeenCalledOnce();
	expect(String(fetch.mock.calls[0]?.[0])).toBe(`${origin}/_marimo/0.25.2/index.html`);
});

it.each(['0.25.2.dev0', '0.25.2rc1', '0.25.2.post1', '0.25.2-beta.1'])(
	'prefetches staged prerelease version %s',
	async (version) => {
		const fetch = vi.fn(async () => new Response(''));
		vi.stubGlobal('fetch', fetch);
		await prefetchMarimoAssets(`https://prerelease.example/_marimo/${version}`);
		expect(fetch).toHaveBeenCalledWith(
			new URL(`https://prerelease.example/_marimo/${version}/index.html`),
			expect.objectContaining({ credentials: 'omit' }),
		);
	},
);

it.each(['0.25.2-', '0.25.2..', 'latest'])(
	'does not prefetch a malformed version segment %s',
	async (version) => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		await prefetchMarimoAssets(`https://malformed.example/_marimo/${version}`);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it('cancels a stalled asset index at the deadline and allows a retry', async () => {
	vi.useFakeTimers();
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	const response = new Response(new ReadableStream({ cancel }));
	const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(''));
	vi.stubGlobal('fetch', fetch);
	const base = 'https://stalled.example/frontend@0.24.2/dist';
	const pending = prefetchMarimoAssets(base);
	await vi.advanceTimersByTimeAsync(5_000);
	await expect(pending).resolves.toBeUndefined();
	expect(cancel).toHaveBeenCalledOnce();
	expect(response.body?.locked).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	await prefetchMarimoAssets(base);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['load', 'error'])(
	'removes completed prefetch hints and their timer on %s',
	async (event) => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('<script type="module" src="./assets/index-abcdef12.js"></script>'),
			),
		);
		await prefetchMarimoAssets(`https://${event}-cleanup.example/_marimo/0.25.2`);
		const link = document.querySelector('link[rel="prefetch"]');
		expect(link).not.toBeNull();
		link!.dispatchEvent(new Event(event));
		expect(document.querySelector('link[rel="prefetch"]')).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	},
);

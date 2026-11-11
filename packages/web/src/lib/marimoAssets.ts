import { parseAssetBaseUrl } from '@marimo-hub/core/url';
import { readResponseBytes } from '@marimo-hub/core/response-body';

const MAX_INDEX_BYTES = 512 * 1024;
const MAX_ASSETS = 32;
const prefetched = new Set<string>();
const preconnections = new Map<string, HTMLLinkElement>();

export function marimoAssetHints(html: string, base: URL): string[] {
	const document = new DOMParser().parseFromString(html, 'text/html');
	const assets = new Set<string>();
	for (const element of document.querySelectorAll(
		'script[type="module"][src], link[rel="modulepreload"][href], link[rel="stylesheet"][href]',
	)) {
		let url: URL;
		try {
			url = new URL(element.getAttribute('src') ?? element.getAttribute('href')!, base);
		} catch {
			continue;
		}
		if (
			url.username ||
			url.password ||
			url.origin !== base.origin ||
			!url.pathname.startsWith(base.pathname) ||
			url.search ||
			url.hash
		)
			continue;
		if (!/[-_][a-zA-Z0-9_-]{6,}\.(?:js|css)$/.test(url.pathname)) continue;
		assets.add(url.href);
		if (assets.size === MAX_ASSETS) break;
	}
	return [...assets];
}

async function readIndex(response: Response, signal: AbortSignal): Promise<string> {
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw new Error('Asset index unavailable');
	}
	return new TextDecoder().decode(await readResponseBytes(response, MAX_INDEX_BYTES, signal));
}

export async function prefetchMarimoAssets(value: string | undefined): Promise<void> {
	const base = parseAssetBaseUrl(value);
	if (!base) return;
	if (!preconnections.has(base.origin)) {
		const link = document.createElement('link');
		link.rel = 'preconnect';
		link.href = base.origin;
		link.crossOrigin = 'anonymous';
		document.head.append(link);
		preconnections.set(base.origin, link);
		if (preconnections.size > 8) {
			const first = preconnections.keys().next().value!;
			preconnections.get(first)?.remove();
			preconnections.delete(first);
		}
	}
	base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
	// The sandbox resolves {version}; notebook metadata does not establish its installed version.
	if (value?.includes('{') || !/(?:\/|@)\d+\.\d+\.\d+[a-zA-Z0-9.-]*\//.test(base.pathname)) return;
	if (prefetched.has(base.href) || prefetched.size >= 16) return;
	prefetched.add(base.href);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const response = await fetch(new URL('index.html', base), {
			credentials: 'omit',
			signal: controller.signal,
		});
		const html = await readIndex(response, controller.signal);
		for (const href of marimoAssetHints(html, base)) {
			const link = document.createElement('link');
			link.rel = 'prefetch';
			link.as = href.endsWith('.css') ? 'style' : 'script';
			link.href = href;
			link.crossOrigin = 'anonymous';
			document.head.append(link);
			const cleanup = () => {
				clearTimeout(timer);
				link.remove();
			};
			const timer = setTimeout(cleanup, 60_000);
			link.onload = cleanup;
			link.onerror = cleanup;
		}
	} catch {
		prefetched.delete(base.href);
	} finally {
		clearTimeout(timeout);
	}
}

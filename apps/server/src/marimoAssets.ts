import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import { appendVary } from '@marimo-hub/api';
import { HASHED_ASSET_PATTERN, MARIMO_VERSION_PATTERN } from '@marimo-hub/core/url';
import { IMMUTABLE_ASSET_CACHE_CONTROL, REVALIDATE_STATIC_CACHE_CONTROL } from './staticCache';

const VERSIONED_ASSET = new RegExp(
	String.raw`^/_marimo/${MARIMO_VERSION_PATTERN}/(?:[a-zA-Z0-9_@.-]+/)*[a-zA-Z0-9_@.-]+$`,
);
// marimo's index.html must never run as a document on the cookie-bearing hub origin.
const HTML_FILE = /\.(?:html?|xhtml)$/i;
const HASHED_FILE = new RegExp(
	String.raw`${HASHED_ASSET_PATTERN}\.(?:js|mjs|css|wasm|woff2?|ttf|otf|svg|png|jpe?g|webp|avif)$`,
);

export function serveMarimoAssets(staticRoot: string): MiddlewareHandler {
	const serve = serveStatic({ root: staticRoot, precompressed: true });
	return async (c) => {
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
			c.header('Allow', 'GET, HEAD');
			return c.text('Method not allowed', 405, { 'Cache-Control': 'no-store' });
		}
		const path = c.req.path;
		if (
			!VERSIONED_ASSET.test(path) ||
			HTML_FILE.test(path) ||
			path.split('/').some((part) => part === '.' || part === '..')
		)
			return c.text('Asset not found', 404, { 'Cache-Control': 'no-store' });
		const result = await serve(c, async () => {
			c.res = await c.notFound();
		});
		const response = result instanceof Response ? result : c.res;
		response.headers.set('Access-Control-Allow-Origin', '*');
		response.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
		response.headers.set('X-Content-Type-Options', 'nosniff');
		appendVary(response.headers, 'Accept-Encoding');
		response.headers.set(
			'Cache-Control',
			response.ok || response.status === 304
				? HASHED_FILE.test(path)
					? IMMUTABLE_ASSET_CACHE_CONTROL
					: REVALIDATE_STATIC_CACHE_CONTROL
				: 'no-store',
		);
		return response;
	};
}

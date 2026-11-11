import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import { IMMUTABLE_ASSET_CACHE_CONTROL, REVALIDATE_STATIC_CACHE_CONTROL } from './staticCache';

const VERSIONED_ASSET =
	/^\/_marimo\/\d+\.\d+\.\d+[a-zA-Z0-9.-]*\/(?:[a-zA-Z0-9_@.-]+\/)*[a-zA-Z0-9_@.-]+$/;
const HASHED_FILE =
	/[-_][a-zA-Z0-9_-]{6,}\.(?:js|mjs|css|wasm|woff2?|ttf|otf|svg|png|jpe?g|webp|avif)$/;

export function serveMarimoAssets(staticRoot: string): MiddlewareHandler {
	const serve = serveStatic({ root: staticRoot, precompressed: true });
	return async (c) => {
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
			c.header('Allow', 'GET, HEAD');
			return c.text('Method not allowed', 405);
		}
		const path = c.req.path;
		if (
			!VERSIONED_ASSET.test(path) ||
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
		response.headers.set('Vary', 'Accept-Encoding');
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

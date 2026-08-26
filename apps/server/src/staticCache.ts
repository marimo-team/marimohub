import { serveStatic } from '@hono/node-server/serve-static';
import type { ServeStaticOptions } from '@hono/node-server/serve-static';
import { baseHrefFromUrl } from '@marimo-hub/core/url';
import type { MiddlewareHandler } from 'hono';

export const REVALIDATE_STATIC_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function isAssetPath(requestPath: string): boolean {
	return requestPath === '/assets' || requestPath.startsWith('/assets/');
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

export function injectAppBaseHref(html: string, baseHref: string): string {
	const marker = /<base\s+href=["']\/["']\s*\/?>/gi;
	if ([...html.matchAll(marker)].length !== 1) {
		throw new Error('SPA index.html must contain exactly one <base href="/" /> marker');
	}
	return html.replace(marker, `<base href="${escapeHtmlAttribute(baseHref)}" />`);
}

/**
 * Return the cache policy for a file served by the SPA.
 *
 * Vite fingerprints files under `assets/`, so those files can be retained for
 * the lifetime of the URL. The HTML shell and other stable URLs must revalidate
 * after a deploy so they cannot keep pointing at an older asset manifest.
 */
export function cacheControlForStaticPath(filePath: string): string {
	const normalizedPath = filePath.replaceAll('\\', '/');
	return normalizedPath.includes('/assets/') && !normalizedPath.endsWith('/index.html')
		? IMMUTABLE_ASSET_CACHE_CONTROL
		: REVALIDATE_STATIC_CACHE_CONTROL;
}

export function serveStaticWithCache(options: ServeStaticOptions): MiddlewareHandler {
	const handler = serveStatic(options);
	return async (context, next) => {
		const response = await handler(context, next);
		if (response instanceof Response) {
			const requestPath = options.path ?? context.req.path;
			const isCacheableResponse =
				(response.status >= 200 && response.status < 300) || response.status === 304;
			response.headers.set(
				'Cache-Control',
				isCacheableResponse
					? cacheControlForStaticPath(requestPath)
					: REVALIDATE_STATIC_CACHE_CONTROL,
			);
		}
		return response;
	};
}

export function serveSpaFallback(staticRoot: string, appBaseUrl?: string): MiddlewareHandler {
	const handler = serveStaticWithCache({ path: `${staticRoot}/index.html` });
	const baseHref = appBaseUrl?.trim() ? baseHrefFromUrl(appBaseUrl) : '/';
	return async (context, next) => {
		if (isAssetPath(context.req.path)) return next();
		const response = await handler(context, next);
		if (!(response instanceof Response) || response.status !== 200) {
			return response;
		}
		if (baseHref === '/') return response;
		const headers = new Headers(response.headers);
		headers.delete('Content-Length');
		if (context.req.method === 'HEAD') {
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}
		return new Response(injectAppBaseHref(await response.text(), baseHref), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

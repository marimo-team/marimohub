import type { MiddlewareHandler } from 'hono';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { responseSizeBelow } from './responseUtils';

const MAX_ETAG_BYTES = 256 * 1024;
const jsonContentType = /^application\/(?:json|[^;\s]+\+json)(?:\s*;|$)/i;

export function conditionalJsonEtag(): MiddlewareHandler {
	const conditionalGet = etag({ weak: true });
	return async (c, next) => {
		await next();
		const response = c.res;
		if (
			!['GET', 'HEAD'].includes(c.req.method) ||
			response.status !== 200 ||
			/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '') ||
			!jsonContentType.test(response.headers.get('Content-Type') ?? '')
		)
			return;

		if (!response.headers.get('ETag')) {
			if (Number(response.headers.get('Content-Length')) > MAX_ETAG_BYTES || !response.body) return;
			// Most JSON routes omit Content-Length. Bound the read before Hono hashes the body.
			const size = await responseSizeBelow(response, MAX_ETAG_BYTES + 1);
			if (size === undefined) return;
			response.headers.set('Content-Length', String(size));
		}
		await conditionalGet(c, async () => {});
		if (c.res.status === 304) {
			for (const key of RETAINED_304_HEADERS) {
				const value = response.headers.get(key);
				if (value !== null) c.res.headers.set(key, value);
			}
		}
	};
}

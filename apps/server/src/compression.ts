import type { MiddlewareHandler } from 'hono';
import { compress, COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';
import { appendVary, hasCacheDirective } from '@marimo-hub/api';

const MIN_COMPRESSION_BYTES = 1024;

function isCompressible(type: string): boolean {
	return (
		!/^\s*text\/event-stream(?:[;\s]|$)/i.test(type) && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)
	);
}

export function compressResponse(): MiddlewareHandler {
	const compressBody = compress({
		contentTypeFilter: isCompressible,
		threshold: MIN_COMPRESSION_BYTES,
	});
	return async (c, next) => {
		await next();
		const response = c.res;
		if (response.status === 304) {
			// Revalidation must describe the same encoding variants as the cached response.
			appendVary(response.headers, 'Accept-Encoding');
			return;
		}
		if (
			c.req.method === 'HEAD' ||
			response.status === 206 ||
			!response.body ||
			response.headers.has('Content-Encoding') ||
			response.headers.has('Transfer-Encoding') ||
			hasCacheDirective(response.headers.get('Cache-Control'), 'no-transform') ||
			!isCompressible(response.headers.get('Content-Type') ?? '')
		)
			return;
		// Unknown-length bodies can be open streams; never read ahead to measure them.
		await compressBody(c, async () => {});
	};
}

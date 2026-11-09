import type { MiddlewareHandler } from 'hono';
import { compress, COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';
import { parseAccept } from 'hono/utils/accept';
import { appendVary, responseSizeBelow } from '@marimo-hub/api';

const MIN_COMPRESSION_BYTES = 1024;

function isCompressible(type: string): boolean {
	return (
		!/^\s*text\/event-stream(?:[;\s]|$)/i.test(type) && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)
	);
}

function acceptsCompression(header: string | undefined): boolean {
	const accepted = parseAccept(header ?? '');
	const wildcard = accepted.find((entry) => entry.type === '*')?.q ?? 0;
	return ['gzip', 'deflate'].some(
		(encoding) =>
			(accepted.find((entry) => entry.type.toLowerCase() === encoding)?.q ?? wildcard) > 0,
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
			/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '') ||
			!isCompressible(response.headers.get('Content-Type') ?? '')
		)
			return;
		if (
			!response.headers.has('Content-Length') &&
			acceptsCompression(c.req.header('Accept-Encoding'))
		) {
			const size = await responseSizeBelow(response, MIN_COMPRESSION_BYTES);
			if (size !== undefined) response.headers.set('Content-Length', String(size));
		}
		await compressBody(c, async () => {});
	};
}

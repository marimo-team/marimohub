import type { MiddlewareHandler } from 'hono';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';

const MAX_ETAG_BYTES = 256 * 1024;
const jsonContentType = /^application\/(?:json|[^;\s]+\+json)(?:\s*;|$)/i;

async function readEtagBody(response: Response): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const reader = response.clone().body!.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_ETAG_BYTES) return;
			chunks.push(value);
		}
	} finally {
		// A tee's cancel waits for the original body, which the server has yet to send.
		void reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

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
			const body = await readEtagBody(response);
			if (!body?.byteLength) return;
			const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
			const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
			response.headers.set('ETag', `W/"${hash}"`);
			response.headers.set('Content-Length', String(body.byteLength));
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

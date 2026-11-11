import { withAbortSignal } from './async';

export class ResponseBodyError extends Error {
	constructor(readonly reason: 'too_large' | 'missing_body') {
		super(reason === 'too_large' ? 'Response body exceeds byte limit' : 'Response has no body');
		this.name = 'ResponseBodyError';
	}
}

/** Content-Length is an early rejection hint; streamed bytes enforce the limit. */
export async function readResponseBytes(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new RangeError('Response byte limit must be a nonnegative safe integer');
	if (Number(response.headers.get('content-length')) > maxBytes) {
		void response.body?.cancel().catch(() => {});
		throw new ResponseBodyError('too_large');
	}
	if (!response.body) throw new ResponseBodyError('missing_body');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await withAbortSignal(reader.read(), signal);
			signal?.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new ResponseBodyError('too_large');
			chunks.push(value);
		}
	} finally {
		// A stalled cancellation must not extend the caller's deadline or mask its error.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

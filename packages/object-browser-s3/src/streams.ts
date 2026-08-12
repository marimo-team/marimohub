import { Readable } from 'node:stream';
import { ObjectBrowseError } from '@marimo-hub/core';

export function toWebStream(body: unknown): ReadableStream<Uint8Array> {
	if (body instanceof ReadableStream) return body;
	if (
		body &&
		typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function'
	) {
		return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
	}
	if (body instanceof Readable) {
		return Readable.toWeb(body) as ReadableStream<Uint8Array>;
	}
	const iterable = body as AsyncIterable<Uint8Array> | undefined;
	if (!iterable?.[Symbol.asyncIterator]) {
		throw new ObjectBrowseError('unavailable', 'The object store returned an invalid body.');
	}
	const iterator = iterable[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await iterator.next();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		async cancel(reason) {
			await iterator.return?.(reason);
		},
	});
}

export async function readBoundedBody(body: unknown, maxBytes: number): Promise<Uint8Array> {
	const reader = toWebStream(body).getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new ObjectBrowseError('unsupported', 'The object exceeded the read limit.');
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

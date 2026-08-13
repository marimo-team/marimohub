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
	let finished = false;
	const closeIterator = async (reason?: unknown) => {
		if (finished) return;
		finished = true;
		await iterator.return?.(reason);
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					finished = true;
					controller.close();
				} else {
					controller.enqueue(next.value);
				}
			} catch (error) {
				try {
					await closeIterator(error);
				} catch {}
				controller.error(error);
			}
		},
		async cancel(reason) {
			await closeIterator(reason);
		},
	});
}

export function guardObjectStream(
	body: unknown,
	signal: AbortSignal | undefined,
	mapError: (error: unknown) => Error,
): { body: ReadableStream<Uint8Array>; close(): void } {
	const reader = toWebStream(body).getReader();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let upstreamClosed = false;
	let readerReleased = false;
	let aborted = signal?.aborted ?? false;
	const abortedError = () => new ObjectBrowseError('aborted', 'The request was canceled.');
	const releaseReader = () => {
		if (readerReleased) return;
		readerReleased = true;
		reader.releaseLock();
	};
	const cancelUpstream = async (reason?: unknown): Promise<void> => {
		if (upstreamClosed) return;
		upstreamClosed = true;
		signal?.removeEventListener('abort', abortStream);
		try {
			await reader.cancel(reason);
		} finally {
			releaseReader();
		}
	};
	function abortStream() {
		aborted = true;
		try {
			controller?.error(abortedError());
		} finally {
			void cancelUpstream(signal?.reason).catch(() => {});
		}
	}
	return {
		body: new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				if (signal?.aborted) abortStream();
				else signal?.addEventListener('abort', abortStream, { once: true });
			},
			async pull(value) {
				if (aborted) return;
				try {
					const next = await reader.read();
					if (aborted) return;
					if (next.done) {
						upstreamClosed = true;
						signal?.removeEventListener('abort', abortStream);
						releaseReader();
						value.close();
					} else {
						value.enqueue(next.value);
					}
				} catch (error) {
					if (aborted) return;
					upstreamClosed = true;
					signal?.removeEventListener('abort', abortStream);
					releaseReader();
					value.error(mapError(error));
				}
			},
			async cancel(reason) {
				await cancelUpstream(reason);
			},
		}),
		close() {
			void cancelUpstream().catch(() => {});
		},
	};
}

export async function readBoundedBody(body: unknown, maxBytes: number): Promise<Uint8Array> {
	const reader = toWebStream(body).getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let completed = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				completed = true;
				break;
			}
			total += next.value.byteLength;
			if (total > maxBytes) {
				throw new ObjectBrowseError('unsupported', 'The object exceeded the read limit.');
			}
			chunks.push(next.value);
		}
	} finally {
		if (!completed) {
			try {
				await reader.cancel();
			} catch {
				// Preserve the original read or limit error.
			}
		}
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

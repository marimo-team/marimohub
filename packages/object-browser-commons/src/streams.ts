import { Readable } from 'node:stream';
import { ObjectBrowseError } from '@marimo-hub/core/ports/object-browser';

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
	onFinalize?: () => void,
): { body: ReadableStream<Uint8Array>; close(): void } {
	const reader = toWebStream(body).getReader();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let stopped = false;
	let finalized = false;
	const finish = () => {
		if (finalized) return;
		finalized = true;
		onFinalize?.();
	};
	const stop = () => {
		stopped = true;
		signal?.removeEventListener('abort', abortStream);
	};
	const cancelUpstream = async (reason?: unknown): Promise<void> => {
		if (stopped) return;
		stop();
		try {
			await reader.cancel(reason);
		} finally {
			try {
				reader.releaseLock();
			} finally {
				finish();
			}
		}
	};
	function abortStream() {
		if (stopped) return;
		controller?.error(new ObjectBrowseError('aborted', 'The request was canceled.'));
		void cancelUpstream(signal?.reason).catch(() => {});
		// Abort and explicit close release provider resources even if cancellation stalls.
		finish();
	}
	return {
		body: new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
				if (signal?.aborted) abortStream();
				else signal?.addEventListener('abort', abortStream, { once: true });
			},
			async pull(value) {
				if (stopped) return;
				let next: ReadableStreamReadResult<Uint8Array>;
				try {
					next = await reader.read();
				} catch (error) {
					if (stopped) return;
					stop();
					try {
						reader.releaseLock();
						value.error(mapError(error));
					} finally {
						finish();
					}
					return;
				}
				if (stopped) return;
				if (next.done) {
					stop();
					try {
						reader.releaseLock();
						value.close();
					} finally {
						finish();
					}
				} else {
					value.enqueue(next.value);
				}
			},
			async cancel(reason) {
				await cancelUpstream(reason);
			},
		}),
		close() {
			if (!stopped) {
				controller?.close();
				void cancelUpstream().catch(() => {});
			}
			finish();
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

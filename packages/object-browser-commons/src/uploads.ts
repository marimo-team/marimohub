import { MAX_UPLOAD_BYTES, UPLOAD_PART_BYTES } from '@marimo-hub/core/uploads';
import { ObjectBrowseError } from '@marimo-hub/core/ports/object-browser';

export async function* objectUploadChunks(
	body: ReadableStream<Uint8Array> | Uint8Array,
	size: number,
): AsyncGenerator<Uint8Array> {
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES)
		throw new ObjectBrowseError('unsupported', 'Object uploads must be at most 5 GiB');
	const reader = body instanceof Uint8Array ? undefined : body.getReader();
	let used = 0;
	let seen = 0;
	let buffer = new Uint8Array(Math.min(size, UPLOAD_PART_BYTES));
	try {
		let first = true;
		while (true) {
			const next = reader
				? await reader.read()
				: first
					? { done: false, value: body as Uint8Array }
					: { done: true, value: undefined };
			first = false;
			if (next.done) break;
			const chunk = next.value!;
			seen += chunk.byteLength;
			if (seen > size)
				throw new ObjectBrowseError('unsupported', 'Upload exceeds its declared size');
			for (let offset = 0; offset < chunk.length; ) {
				if (used === buffer.length) {
					yield buffer;
					buffer = new Uint8Array(buffer.length);
					used = 0;
				}
				const length = Math.min(buffer.length - used, chunk.length - offset);
				buffer.set(chunk.subarray(offset, offset + length), used);
				offset += length;
				used += length;
			}
		}
		if (seen !== size)
			throw new ObjectBrowseError('unsupported', 'Upload does not match its declared size');
		if (used) yield buffer.subarray(0, used);
	} finally {
		if (reader) {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
}

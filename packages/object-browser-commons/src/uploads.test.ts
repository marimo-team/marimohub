import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_PART_BYTES } from '@marimo-hub/core/uploads';
import { objectUploadChunks } from './uploads';

const partSize = UPLOAD_PART_BYTES;
async function collect(chunks: AsyncIterable<Uint8Array>) {
	const result: Uint8Array[] = [];
	for await (const chunk of chunks) result.push(chunk);
	return result;
}

describe('object upload streams', () => {
	it.each([0, 1, partSize, partSize + 1, 2 * partSize])(
		'preserves bytes at the %i-byte boundary',
		async (size) => {
			const body = Uint8Array.from({ length: size }, (_, i) => i % 251);
			const chunks = await collect(objectUploadChunks(body, size));
			expect(chunks.every((chunk) => chunk.length <= partSize)).toBe(true);
			expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(size);
			expect(Buffer.concat(chunks).equals(body)).toBe(true);
		},
	);

	it('preserves order across uneven source chunks and part boundaries', async () => {
		const body = Uint8Array.from({ length: partSize + 23 }, (_, i) => i % 251);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const [start, end] of [
					[0, 7],
					[7, partSize - 3],
					[partSize - 3, partSize + 2],
					[partSize + 2, body.length],
				]) {
					controller.enqueue(body.subarray(start, end));
				}
				controller.close();
			},
		});
		expect(Buffer.concat(await collect(objectUploadChunks(stream, body.length))).equals(body)).toBe(
			true,
		);
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5 * 1024 ** 3 + 1])(
		'rejects invalid declared size %s',
		async (size) => {
			await expect(collect(objectUploadChunks(new Uint8Array(), size))).rejects.toThrow(
				'at most 5 GiB',
			);
		},
	);

	it.each([1, 3])('rejects a stream whose declared size is %i instead of 2', async (size) => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(2));
				controller.close();
			},
		});
		await expect(collect(objectUploadChunks(body, size))).rejects.toThrow('declared size');
		expect(body.locked).toBe(false);
	});

	it('cancels and unlocks the source when a provider stops consuming', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(partSize + 1));
			},
			cancel,
		});
		const chunks = objectUploadChunks(body, partSize + 1);
		expect((await chunks.next()).value).toHaveLength(partSize);
		await chunks.return(undefined);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
	});

	it('propagates read failures and releases the reader', async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error('source failed'));
			},
		});
		await expect(collect(objectUploadChunks(body, 1))).rejects.toThrow('source failed');
		expect(body.locked).toBe(false);
	});
});

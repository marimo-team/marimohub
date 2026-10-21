import { describe, expect, it, vi } from 'vitest';
import { objectUploadChunks } from './uploads';

const partSize = 8 * 1024 * 1024;
async function collect(chunks: AsyncIterable<Uint8Array>) {
	const result: Uint8Array[] = [];
	for await (const chunk of chunks) result.push(chunk);
	return result;
}

describe('object upload streams', () => {
	it.each([0, 1, partSize, partSize + 1, 2 * partSize])(
		'preserves bytes at the %i-byte boundary',
		async (size) => {
			const body = new Uint8Array(size).fill(7);
			const chunks = await collect(objectUploadChunks(body, size));
			expect(chunks.every((chunk) => chunk.length <= partSize)).toBe(true);
			expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(size);
			expect(chunks.every((chunk) => chunk.every((byte) => byte === 7))).toBe(true);
		},
	);

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

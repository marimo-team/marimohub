import { describe, expect, it, vi } from 'vitest';
import { readResponseBytes, ResponseBodyError } from './responseBody';

describe('readResponseBytes', () => {
	it('accepts the exact byte limit and preserves UTF-8 split across chunks', async () => {
		const text = 'A😀é';
		const bytes = new TextEncoder().encode(text);
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(bytes.subarray(0, 3));
					controller.enqueue(bytes.subarray(3, 6));
					controller.enqueue(bytes.subarray(6));
					controller.close();
				},
			}),
		);
		const result = await readResponseBytes(response, bytes.byteLength);
		expect(result).toEqual(bytes);
		expect(new TextDecoder('utf-8', { fatal: true }).decode(result)).toBe(text);
		expect(response.body?.locked).toBe(false);
	});

	it('leaves invalid UTF-8 handling to the caller', async () => {
		const bytes = await readResponseBytes(new Response(new Uint8Array([0xff])), 1);
		expect(new TextDecoder().decode(bytes)).toBe('�');
		expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
	});

	it.each([undefined, '1', 'invalid'])(
		'enforces actual bytes with Content-Length %s',
		async (length) => {
			const cancel = vi.fn();
			const response = new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(4));
					},
					cancel,
				}),
				{ headers: length === undefined ? undefined : { 'content-length': length } },
			);
			await expect(readResponseBytes(response, 3)).rejects.toMatchObject({ reason: 'too_large' });
			expect(cancel).toHaveBeenCalledOnce();
			expect(response.body?.locked).toBe(false);
		},
	);

	it('rejects a declared oversized body without starting a read', async () => {
		const pull = vi.fn();
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
			headers: { 'content-length': '4' },
		});
		await expect(readResponseBytes(response, 3)).rejects.toMatchObject({ reason: 'too_large' });
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
		expect(response.body?.locked).toBe(false);
	});

	it('distinguishes empty bytes from a missing body', async () => {
		await expect(readResponseBytes(new Response(''), 0)).resolves.toEqual(new Uint8Array());
		await expect(readResponseBytes(new Response(null), 0)).rejects.toMatchObject({
			reason: 'missing_body',
		});
	});

	it.each([-1, 1.5, Number.NaN, Infinity])(
		'rejects invalid byte limit %s before consuming',
		async (limit) => {
			const response = new Response('body');
			await expect(readResponseBytes(response, limit)).rejects.toBeInstanceOf(RangeError);
			expect(response.bodyUsed).toBe(false);
		},
	);

	it('propagates a read failure instead of returning partial bytes', async () => {
		const failure = new Error('read failed');
		let chunks = 0;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					if (chunks++ === 0) controller.enqueue(new Uint8Array([1]));
					else controller.error(failure);
				},
			}),
		);
		await expect(readResponseBytes(response, 3)).rejects.toBe(failure);
		expect(response.body?.locked).toBe(false);
	});

	it.each(['throws', 'stalls'] as const)(
		'aborts a stalled read even when cancellation %s',
		async (cleanup) => {
			const controller = new AbortController();
			const cancel = vi.fn(() => {
				if (cleanup === 'throws') throw new Error('cleanup failed');
				return new Promise<void>(() => {});
			});
			const response = new Response(new ReadableStream({ cancel }));
			const reading = readResponseBytes(response, 3, controller.signal);
			controller.abort(new Error('disconnected'));
			await expect(reading).rejects.toBe(controller.signal.reason);
			expect(cancel).toHaveBeenCalledOnce();
			expect(response.body?.locked).toBe(false);
		},
	);

	it.each([false, true])(
		'keeps the size error if cancellation stalls (declared: %s)',
		async (declared) => {
			const cancel = vi.fn(() => new Promise<void>(() => {}));
			const response = new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(4));
					},
					cancel,
				}),
				{ headers: declared ? { 'content-length': '4' } : undefined },
			);
			await expect(readResponseBytes(response, 3)).rejects.toBeInstanceOf(ResponseBodyError);
			expect(cancel).toHaveBeenCalledOnce();
			expect(response.body?.locked).toBe(false);
		},
	);

	it('cancels without reading when the caller already aborted', async () => {
		const cancel = vi.fn();
		const pull = vi.fn();
		const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
		const signal = AbortSignal.abort(new Error('cancelled'));
		await expect(readResponseBytes(response, 3, signal)).rejects.toBe(signal.reason);
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
		expect(response.body?.locked).toBe(false);
	});
});

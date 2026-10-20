import { describe, expect, it, vi } from 'vitest';
import { guardObjectStream } from './streams';

const mapError = (error: unknown) => new Error('mapped', { cause: error });

describe('guardObjectStream', () => {
	it('forwards chunks with bounded read-ahead, finalizes at EOF, and releases the reader', async () => {
		const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
			if (pull.mock.calls.length === 1) controller.enqueue(new Uint8Array([1]));
			else controller.close();
		});
		const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
		const finalize = vi.fn();
		const guarded = guardObjectStream(source, undefined, mapError, finalize);
		await Promise.resolve();
		await Promise.resolve();
		expect(pull).toHaveBeenCalledOnce();
		expect(finalize).not.toHaveBeenCalled();
		const reader = guarded.body.getReader();
		expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1]) });
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		guarded.close();
		guarded.close();
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});

	it('maps read failures and finalizes once', async () => {
		const failure = new Error('provider');
		const source = new ReadableStream<Uint8Array>({
			pull() {
				throw failure;
			},
		});
		const finalize = vi.fn();
		const map = vi.fn(mapError);
		const guarded = guardObjectStream(source, undefined, map, finalize);
		await expect(guarded.body.getReader().read()).rejects.toMatchObject({
			message: 'mapped',
			cause: failure,
		});
		guarded.close();
		expect(map).toHaveBeenCalledExactlyOnceWith(failure);
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});

	it.each([false, true])(
		'settles pending reads on cancellation and finalizes after cleanup (failure: %s)',
		async (fail) => {
			const cleanup = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const cancel = vi.fn(() => cleanup.promise);
			const source = new ReadableStream<Uint8Array>({
				pull() {
					started.resolve();
					return new Promise<void>(() => {});
				},
				cancel,
			});
			const finalize = vi.fn();
			const guarded = guardObjectStream(source, undefined, mapError, finalize);
			const reader = guarded.body.getReader();
			const read = reader.read();
			await started.promise;
			const reason = new Error('consumer canceled');
			const cancellation = reader.cancel(reason);
			const failure = new Error('cleanup failed');
			const settled = fail
				? expect(cancellation).rejects.toBe(failure)
				: expect(cancellation).resolves.toBeUndefined();
			expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
			expect(finalize).not.toHaveBeenCalled();
			expect(await read).toEqual({ done: true, value: undefined });
			if (fail) cleanup.reject(failure);
			else cleanup.resolve();
			await settled;
			guarded.close();
			expect(finalize).toHaveBeenCalledOnce();
			expect(source.locked).toBe(false);
		},
	);

	it.each([false, true])(
		'handles abort before or during a pending read (already aborted: %s)',
		async (alreadyAborted) => {
			const abort = new AbortController();
			const reason = new Error('disconnect');
			const cleanup = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const cancel = vi.fn(() => cleanup.promise);
			const source = new ReadableStream<Uint8Array>({
				pull() {
					started.resolve();
					return new Promise<void>(() => {});
				},
				cancel,
			});
			if (alreadyAborted) abort.abort(reason);
			const finalize = vi.fn();
			const guarded = guardObjectStream(source, abort.signal, mapError, finalize);
			const read = guarded.body.getReader().read();
			const rejected = expect(read).rejects.toMatchObject({ code: 'aborted' });
			if (!alreadyAborted) {
				await started.promise;
				abort.abort(reason);
			}
			await rejected;
			expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
			expect(finalize).toHaveBeenCalledOnce();
			guarded.close();
			cleanup.resolve();
			await vi.waitFor(() => expect(source.locked).toBe(false));
			expect(finalize).toHaveBeenCalledOnce();
		},
	);

	it('explicit close settles a pending read and finalizes even when cancellation fails', async () => {
		const cleanup = Promise.withResolvers<void>();
		const cancel = vi.fn(() => cleanup.promise);
		const source = new ReadableStream<Uint8Array>({ cancel });
		const finalize = vi.fn();
		const guarded = guardObjectStream(source, undefined, mapError, finalize);
		const pending = guarded.body.getReader().read();
		guarded.close();
		guarded.close();
		await expect(pending).resolves.toEqual({ done: true, value: undefined });
		expect(finalize).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		cleanup.reject(new Error('cleanup failed'));
		await vi.waitFor(() => expect(source.locked).toBe(false));
		expect(finalize).toHaveBeenCalledOnce();
	});

	it('explicit close finalizes immediately when consumer cancellation is already pending', async () => {
		const cleanup = Promise.withResolvers<void>();
		const cancel = vi.fn(() => cleanup.promise);
		const source = new ReadableStream<Uint8Array>({ cancel });
		const finalize = vi.fn();
		const guarded = guardObjectStream(source, undefined, mapError, finalize);
		const cancellation = guarded.body.cancel();
		expect(finalize).not.toHaveBeenCalled();
		guarded.close();
		guarded.close();
		expect(finalize).toHaveBeenCalledOnce();
		cleanup.resolve();
		await cancellation;
		expect(cancel).toHaveBeenCalledOnce();
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});

	it('does not repeat a failing finalizer or retain the reader', async () => {
		const failure = new Error('finalize failed');
		const source = new ReadableStream<Uint8Array>();
		const finalize = vi.fn(() => {
			throw failure;
		});
		const guarded = guardObjectStream(source, undefined, mapError, finalize);
		await expect(guarded.body.cancel()).rejects.toBe(failure);
		guarded.close();
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});

	it.each(['eof', 'error', 'close'] as const)(
		'detaches abort handling after %s',
		async (terminal) => {
			const abort = new AbortController();
			const removeListener = vi.spyOn(abort.signal, 'removeEventListener');
			const cancel = vi.fn();
			const source = new ReadableStream<Uint8Array>({
				start(controller) {
					if (terminal === 'eof') controller.close();
					if (terminal === 'error') controller.error(new Error('provider failed'));
				},
				cancel,
			});
			const finalize = vi.fn();
			const guarded = guardObjectStream(source, abort.signal, mapError, finalize);
			const reader = guarded.body.getReader();
			if (terminal === 'close') guarded.close();
			if (terminal === 'error') await expect(reader.read()).rejects.toThrow('mapped');
			else await expect(reader.read()).resolves.toMatchObject({ done: true });
			const cancellations = cancel.mock.calls.length;
			abort.abort(new Error('late abort'));
			guarded.close();
			expect(cancel).toHaveBeenCalledTimes(cancellations);
			expect(removeListener).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
			expect(finalize).toHaveBeenCalledOnce();
			expect(source.locked).toBe(false);
		},
	);

	it('ignores a pull failure that arrives after consumer cancellation', async () => {
		const pull = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const source = new ReadableStream<Uint8Array>({
			pull() {
				started.resolve();
				return pull.promise;
			},
		});
		const map = vi.fn(mapError);
		const finalize = vi.fn();
		const guarded = guardObjectStream(source, undefined, map, finalize);
		const reader = guarded.body.getReader();
		const pending = reader.read();
		await started.promise;
		await reader.cancel('no longer needed');
		pull.reject(new Error('late network failure'));
		await expect(pending).resolves.toMatchObject({ done: true });
		await expect(reader.closed).resolves.toBeUndefined();
		guarded.close();
		expect(map).not.toHaveBeenCalled();
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});

	it('discards buffered data when aborted before the next consumer read', async () => {
		const abort = new AbortController();
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel,
		});
		const finalize = vi.fn();
		const guarded = guardObjectStream(source, abort.signal, mapError, finalize);
		await Promise.resolve();
		await Promise.resolve();
		const reason = new Error('disconnected');
		abort.abort(reason);
		await expect(guarded.body.getReader().read()).rejects.toMatchObject({ code: 'aborted' });
		expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});
});

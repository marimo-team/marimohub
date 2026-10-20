import { describe, expect, it, vi } from 'vitest';
import { guardObjectStream } from './streams';

const mapError = (error: unknown) => new Error('mapped', { cause: error });

function guard(source: ReadableStream<Uint8Array>, signal?: AbortSignal) {
	const map = vi.fn(mapError);
	const finalize = vi.fn();
	return { ...guardObjectStream(source, signal, map, finalize), map, finalize };
}

function pendingStream() {
	const started = Promise.withResolvers<void>();
	const pull = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const cancel = vi.fn(() => cleanup.promise);
	const source = new ReadableStream<Uint8Array>({
		pull() {
			started.resolve();
			return pull.promise;
		},
		cancel,
	});
	return { source, started: started.promise, pull, cleanup, cancel };
}

describe('guardObjectStream', () => {
	it('forwards chunks with bounded read-ahead, finalizes at EOF, and releases the reader', async () => {
		const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
			if (pull.mock.calls.length === 1) controller.enqueue(new Uint8Array([1]));
			else controller.close();
		});
		const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
		const { body, close, finalize } = guard(source);
		await Promise.resolve();
		await Promise.resolve();
		expect(pull).toHaveBeenCalledOnce();
		expect(finalize).not.toHaveBeenCalled();
		const reader = body.getReader();
		expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1]) });
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		close();
		close();
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
		const { body, close, map, finalize } = guard(source);
		await expect(body.getReader().read()).rejects.toMatchObject({
			message: 'mapped',
			cause: failure,
		});
		close();
		expect(map).toHaveBeenCalledExactlyOnceWith(failure);
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});

	it.each([false, true])(
		'settles pending reads on cancellation and finalizes after cleanup (failure: %s)',
		async (fail) => {
			const { source, started, cleanup, cancel } = pendingStream();
			const { body, close, finalize } = guard(source);
			const reader = body.getReader();
			const read = reader.read();
			await started;
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
			close();
			expect(finalize).toHaveBeenCalledOnce();
			expect(source.locked).toBe(false);
		},
	);

	it.each([false, true])(
		'handles abort before or during a pending read (already aborted: %s)',
		async (alreadyAborted) => {
			const abort = new AbortController();
			const reason = new Error('disconnect');
			const { source, started, cleanup, cancel } = pendingStream();
			if (alreadyAborted) abort.abort(reason);
			const { body, close, finalize } = guard(source, abort.signal);
			const read = body.getReader().read();
			const rejected = expect(read).rejects.toMatchObject({ code: 'aborted' });
			if (!alreadyAborted) {
				await started;
				abort.abort(reason);
			}
			await rejected;
			expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
			expect(finalize).toHaveBeenCalledOnce();
			close();
			cleanup.resolve();
			await vi.waitFor(() => expect(source.locked).toBe(false));
			expect(finalize).toHaveBeenCalledOnce();
		},
	);

	it('explicit close settles a pending read and finalizes even when cancellation fails', async () => {
		const { source, cleanup, cancel } = pendingStream();
		const { body, close, finalize } = guard(source);
		const pending = body.getReader().read();
		close();
		close();
		await expect(pending).resolves.toEqual({ done: true, value: undefined });
		expect(finalize).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		cleanup.reject(new Error('cleanup failed'));
		await vi.waitFor(() => expect(source.locked).toBe(false));
		expect(finalize).toHaveBeenCalledOnce();
	});

	it('explicit close finalizes immediately when consumer cancellation is already pending', async () => {
		const { source, cleanup, cancel } = pendingStream();
		const { body, close, finalize } = guard(source);
		const cancellation = body.cancel();
		expect(finalize).not.toHaveBeenCalled();
		close();
		close();
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
			const { body, close, finalize } = guard(source, abort.signal);
			const reader = body.getReader();
			if (terminal === 'close') close();
			if (terminal === 'error') await expect(reader.read()).rejects.toThrow('mapped');
			else await expect(reader.read()).resolves.toMatchObject({ done: true });
			const cancellations = cancel.mock.calls.length;
			abort.abort(new Error('late abort'));
			close();
			expect(cancel).toHaveBeenCalledTimes(cancellations);
			expect(removeListener).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
			expect(finalize).toHaveBeenCalledOnce();
			expect(source.locked).toBe(false);
		},
	);

	it('ignores a pull failure that arrives after consumer cancellation', async () => {
		const { source, started, pull, cleanup } = pendingStream();
		const { body, close, map, finalize } = guard(source);
		const reader = body.getReader();
		const pending = reader.read();
		await started;
		cleanup.resolve();
		await reader.cancel('no longer needed');
		pull.reject(new Error('late network failure'));
		await expect(pending).resolves.toMatchObject({ done: true });
		await expect(reader.closed).resolves.toBeUndefined();
		close();
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
		const { body, finalize } = guard(source, abort.signal);
		await Promise.resolve();
		await Promise.resolve();
		const reason = new Error('disconnected');
		abort.abort(reason);
		await expect(body.getReader().read()).rejects.toMatchObject({ code: 'aborted' });
		expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
		expect(finalize).toHaveBeenCalledOnce();
		expect(source.locked).toBe(false);
	});
});

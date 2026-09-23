import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	collectBoundedOutput,
	readBoundedFile,
	readBoundedStream,
	waitWithSignal,
} from './boundedRead';

function streamOf(chunks: (string | Uint8Array)[], close = true, cancel = vi.fn()) {
	return new ReadableStream<string | Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			if (close) controller.close();
		},
		cancel,
	});
}

const pending = () => new Promise<never>(() => {});

afterEach(() => vi.useRealTimers());

describe('bounded sandbox reads', () => {
	it.each([Number.NaN, Infinity, -Infinity, -1, 0.5])(
		'rejects an invalid byte cap before locking the stream: %s',
		async (budget) => {
			const stream = streamOf(['output']);
			const getReader = vi.spyOn(stream, 'getReader');
			await expect(readBoundedStream(stream, budget, new AbortController().signal)).rejects.toThrow(
				'byte limit',
			);
			expect(getReader).not.toHaveBeenCalled();
		},
	);

	it('cancels on byte overflow before retaining the offending chunk', async () => {
		const cancel = vi.fn();
		const stream = streamOf(['1234', '5'], false, cancel);
		await expect(readBoundedStream(stream, 4, new AbortController().signal)).rejects.toThrow(
			'byte limit',
		);
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
	});

	it('cancels an idle transport on deadline', async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream({ cancel });
		await expect(readBoundedStream(stream, 4, AbortSignal.timeout(10))).rejects.toThrow();
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
	});

	it('cancels without consuming buffered data when already aborted', async () => {
		const cancel = vi.fn();
		const error = new Error('cancelled before read');
		const stream = streamOf(['data'], false, cancel);
		await expect(readBoundedStream(stream, 4, AbortSignal.abort(error))).rejects.toBe(error);
		expect(cancel).toHaveBeenCalledWith(error);
		expect(stream.locked).toBe(false);
	});

	it.each([
		{ chunks: [], maxBytes: 0, expected: '' },
		{ chunks: ['é'], maxBytes: 2, expected: 'é' },
		{ chunks: [new Uint8Array([0xc3]), new Uint8Array([0xa9])], maxBytes: 2, expected: 'é' },
		{ chunks: [new Uint8Array([0xc3]), 'x'], maxBytes: 2, expected: '\ufffdx' },
	])(
		'preserves text at the exact byte boundary: $expected',
		async ({ chunks, maxBytes, expected }) => {
			expect(
				await readBoundedStream(streamOf(chunks), maxBytes, new AbortController().signal),
			).toBe(expected);
		},
	);

	it.each([
		['é', 1],
		['x', 0],
	] as const)('counts bytes rather than characters: %s', async (chunk, limit) => {
		await expect(
			readBoundedStream(streamOf([chunk]), limit, new AbortController().signal),
		).rejects.toThrow('byte limit');
	});

	it('preserves the overflow error when transport cancellation rejects', async () => {
		const cancel = vi.fn().mockRejectedValue(new Error('disconnect failed'));
		await expect(
			readBoundedStream(streamOf(['xx'], false, cancel), 1, new AbortController().signal),
		).rejects.toThrow('byte limit');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('propagates a stream failure and releases its lock', async () => {
		const error = new Error('connection reset');
		const stream = new ReadableStream({ start: (controller) => controller.error(error) });
		await expect(readBoundedStream(stream, 4, new AbortController().signal)).rejects.toBe(error);
		expect(stream.locked).toBe(false);
	});

	it.each([
		{ maxBytes: -1, timeoutMs: 100 },
		{ maxBytes: 1.5, timeoutMs: 100 },
		{ maxBytes: Number.NaN, timeoutMs: 100 },
		{ maxBytes: Infinity, timeoutMs: 100 },
		{ maxBytes: 10, timeoutMs: 0 },
		{ maxBytes: 10, timeoutMs: -1 },
		{ maxBytes: 10, timeoutMs: Number.NaN },
		{ maxBytes: 10, timeoutMs: Infinity },
		{ maxBytes: 10, timeoutMs: 2 ** 31 },
		{ maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 100 },
		{ maxBytes: 3 * Math.floor(Number.MAX_SAFE_INTEGER / 4) + 1, timeoutMs: 100 },
	])('rejects invalid budgets before starting a command: %j', async (options) => {
		const execute = vi.fn();
		expect(await readBoundedFile('/workspace/file', options, execute)).toMatchObject({
			success: false,
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([0.1, 100.5, 2 ** 31 - 1])('normalizes supported read timeout %s', async (timeoutMs) => {
		const execute = vi.fn(async () => ({ success: true, stdout: '' }));
		const maxBytes = 3 * Math.floor(Number.MAX_SAFE_INTEGER / 4);
		expect(
			await readBoundedFile('/workspace/file', { maxBytes, timeoutMs }, execute),
		).toMatchObject({ success: true });
		expect(execute).toHaveBeenCalledWith(expect.any(String), {
			maxOutputBytes: 4 * Math.floor(Number.MAX_SAFE_INTEGER / 4),
			timeout: Math.ceil(timeoutMs),
		});
	});

	it.each([
		{ stdout: btoa('12345'), success: true },
		{ stdout: btoa('1234567'), success: true },
		{ stdout: '!!!!', success: true },
		{ stdout: btoa('1234'), success: false },
	])('refuses invalid or failed command output: %j', async (result) => {
		const execute = vi.fn(async () => result);
		expect(
			await readBoundedFile('/workspace/file', { maxBytes: 4, timeoutMs: 100 }, execute),
		).toMatchObject({ success: false });
		expect(execute.mock.calls).toHaveLength(1);
		expect(execute).toHaveBeenCalledWith(expect.any(String), { maxOutputBytes: 8, timeout: 100 });
	});

	it.each(['', '\x00\xff\x80x'])('accepts binary content at the exact limit', async (content) => {
		const result = await readBoundedFile(
			'/workspace/file',
			{ maxBytes: content.length, timeoutMs: 100 },
			async () => ({ success: true, stdout: btoa(content) }),
		);
		expect(result).toEqual({ success: true, content: btoa(content), encoding: 'base64' });
	});

	it('returns a refused read when command startup fails', async () => {
		expect(
			await readBoundedFile('/workspace/file', { maxBytes: 4, timeoutMs: 100 }, async () => {
				throw new Error('offline');
			}),
		).toMatchObject({ success: false });
	});
});

describe('collectBoundedOutput', () => {
	it.each([Number.NaN, Infinity, -Infinity, -1, 0.5])(
		'rejects an invalid budget before consuming output: %s',
		async (maxOutputBytes) => {
			const stdout = streamOf(['output']);
			const getReader = vi.spyOn(stdout, 'getReader');
			const wait = vi.fn(async () => 0);
			await expect(
				collectBoundedOutput({ stdout, stderr: streamOf([]), wait }, { maxOutputBytes }),
			).rejects.toThrow('byte limit');
			expect(getReader).not.toHaveBeenCalled();
			expect(wait).not.toHaveBeenCalled();
		},
	);

	it('treats a zero timeout as no deadline', async () => {
		vi.useFakeTimers();
		let finish!: (code: number) => void;
		const result = collectBoundedOutput(
			{
				stdout: streamOf([]),
				stderr: streamOf([]),
				wait: () =>
					new Promise<number>((resolve) => {
						finish = resolve;
					}),
			},
			{ maxOutputBytes: 0, timeout: 0 },
		);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(vi.getTimerCount()).toBe(0);
		finish(0);
		await expect(result).resolves.toEqual({ stdout: '', stderr: '', result: 0 });
	});

	it('accepts combined output exactly at the limit and clears its timer', async () => {
		vi.useFakeTimers();
		const result = await collectBoundedOutput(
			{ stdout: streamOf(['12']), stderr: streamOf(['é']), wait: async () => 0 },
			{ maxOutputBytes: 4, timeout: 100 },
		);
		expect(result).toEqual({ stdout: '12', stderr: 'é', result: 0 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('shares the byte budget between stdout and stderr and cancels both', async () => {
		const cancel = vi.fn();
		await expect(
			collectBoundedOutput(
				{
					stdout: streamOf(['123'], false, cancel),
					stderr: streamOf(['45'], false, cancel),
					wait: pending,
				},
				{ maxOutputBytes: 4 },
			),
		).rejects.toThrow('byte limit');
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it('bounds the exit wait even after both streams close', async () => {
		vi.useFakeTimers();
		const result = collectBoundedOutput(
			{ stdout: streamOf([]), stderr: streamOf([]), wait: pending },
			{ maxOutputBytes: 4, timeout: 20 },
		);
		const assertion = expect(result).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(20);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['sync', 'async'] as const)(
		'cancels open streams when waiting fails (%s)',
		async (mode) => {
			vi.useFakeTimers();
			const cancel = vi.fn();
			const error = new Error('exit wait failed');
			const wait = () => {
				if (mode === 'sync') throw error;
				return Promise.reject(error);
			};
			await expect(
				collectBoundedOutput(
					{ stdout: streamOf([], false, cancel), stderr: streamOf([], false, cancel), wait },
					{ maxOutputBytes: 4 },
				),
			).rejects.toBe(error);
			expect(cancel).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('cancels the sibling stream and aborts the wait when one stream fails', async () => {
		const error = new Error('stdout disconnected');
		const cancel = vi.fn();
		let waitSignal: AbortSignal | undefined;
		await expect(
			collectBoundedOutput(
				{
					stdout: new ReadableStream({ start: (controller) => controller.error(error) }),
					stderr: streamOf([], false, cancel),
					wait: (signal) => {
						waitSignal = signal;
						return pending();
					},
				},
				{ maxOutputBytes: 4 },
			),
		).rejects.toBe(error);
		expect(cancel).toHaveBeenCalledOnce();
		expect(waitSignal?.aborted).toBe(true);
	});
});

describe('waitWithSignal', () => {
	it('prefers an existing abort over an already-resolved result', async () => {
		const error = new Error('already aborted');
		await expect(waitWithSignal(Promise.resolve(0), AbortSignal.abort(error))).rejects.toBe(error);
	});

	it.each(['success', 'failure', 'abort'] as const)(
		'removes the abort listener after %s',
		async (outcome) => {
			const abort = new AbortController();
			const remove = vi.spyOn(abort.signal, 'removeEventListener');
			const error = new Error('failed');
			const promise =
				outcome === 'success'
					? Promise.resolve(1)
					: outcome === 'failure'
						? Promise.reject(error)
						: pending();
			const result = waitWithSignal(promise, abort.signal);
			if (outcome === 'abort') abort.abort(error);
			if (outcome === 'success') await expect(result).resolves.toBe(1);
			else await expect(result).rejects.toBe(error);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
		},
	);
});

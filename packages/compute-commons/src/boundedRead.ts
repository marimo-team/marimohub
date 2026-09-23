import { shellQuote } from './shell';

export interface BoundedReadOptions {
	maxBytes: number;
	timeoutMs: number;
}

// Open every path component without following links, and use O_NONBLOCK so a
// swapped-in FIFO cannot block before fstat rejects it.
const READ_FILE = `import os, stat, sys, base64, signal
signal.setitimer(signal.ITIMER_REAL, float(sys.argv[3]) / 1000)
path, limit = sys.argv[1], int(sys.argv[2])
parts = path.split('/')
if not path.startswith('/') or '..' in parts:
    sys.exit(1)
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    names = [p for p in parts if p and p != '.']
    for i, name in enumerate(names):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if i < len(names) - 1:
            flags |= os.O_DIRECTORY
        next_fd = os.open(name, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        sys.exit(1)
    with os.fdopen(fd, 'rb', closefd=False) as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        sys.exit(1)
    sys.stdout.write(base64.b64encode(data).decode('ascii'))
finally:
    os.close(fd)`;

export async function readBoundedFile(
	path: string,
	options: BoundedReadOptions,
	execute: (
		command: string,
		options: { timeout: number; maxOutputBytes: number },
	) => Promise<{ success: boolean; stdout: string }>,
): Promise<
	| { success: true; content: string; encoding: 'base64' }
	| { success: false; content: ''; error: { code: 'READ_FAILED' } }
> {
	const failure = { success: false, content: '', error: { code: 'READ_FAILED' } } as const;
	if (
		!Number.isSafeInteger(options.maxBytes) ||
		options.maxBytes < 0 ||
		!Number.isFinite(options.timeoutMs) ||
		options.timeoutMs <= 0
	)
		return failure;
	try {
		const maxOutputBytes = 4 * Math.ceil(options.maxBytes / 3);
		const command = `python3 -I -c ${shellQuote(READ_FILE)} ${shellQuote(path)} ${options.maxBytes} ${options.timeoutMs}`;
		const result = await execute(command, { timeout: options.timeoutMs, maxOutputBytes });
		if (
			!result.success ||
			result.stdout.length > maxOutputBytes ||
			atob(result.stdout).length > options.maxBytes
		)
			return failure;
		return { success: true, content: result.stdout, encoding: 'base64' };
	} catch {
		return failure;
	}
}

export function validateOutputBudget(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new RangeError('Sandbox output byte limit must be a nonnegative safe integer');
}

/** Cancel the reader on overflow or deadline, including an idle stream. */
export async function readBoundedStream(
	stream: ReadableStream<string | Uint8Array>,
	maxBytes: number,
	signal: AbortSignal,
): Promise<string> {
	validateOutputBudget(maxBytes);
	return collectStream(stream, { remaining: maxBytes }, signal);
}

export async function collectBoundedOutput<T>(
	process: {
		stdout: ReadableStream<string | Uint8Array>;
		stderr: ReadableStream<string | Uint8Array>;
		wait: (signal: AbortSignal) => Promise<T>;
	},
	options: { maxOutputBytes: number; timeout?: number },
): Promise<{ stdout: string; stderr: string; result: T }> {
	validateOutputBudget(options.maxOutputBytes);
	const timeout = options.timeout ?? 10_000;
	if (!Number.isFinite(timeout) || timeout < 0)
		throw new RangeError('Sandbox output timeout must be finite and nonnegative');
	const abort = new AbortController();
	const timer =
		timeout > 0
			? setTimeout(() => abort.abort(new Error('Sandbox read timed out')), timeout)
			: undefined;
	const budget = { remaining: options.maxOutputBytes };
	try {
		const [stdout, stderr, result] = await Promise.all([
			collectStream(process.stdout, budget, abort.signal),
			collectStream(process.stderr, budget, abort.signal),
			waitWithSignal(
				Promise.resolve().then(() => process.wait(abort.signal)),
				abort.signal,
			),
		]);
		return { stdout, stderr, result };
	} finally {
		abort.abort();
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function collectStream(
	stream: ReadableStream<string | Uint8Array>,
	budget: { remaining: number },
	signal: AbortSignal,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const cancel = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener('abort', cancel, { once: true });
	try {
		signal.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			budget.remaining -=
				typeof value === 'string' ? encoder.encode(value).byteLength : value.byteLength;
			if (budget.remaining < 0) throw new Error('Sandbox output exceeded byte limit');
			chunks.push(
				typeof value === 'string'
					? decoder.decode() + value
					: decoder.decode(value, { stream: true }),
			);
		}
		chunks.push(decoder.decode());
		return chunks.join('');
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener('abort', cancel);
		reader.releaseLock();
	}
}

export async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => {};
	try {
		return await Promise.race([
			new Promise<never>((_resolve, reject) => {
				onAbort = () =>
					reject(
						signal.reason instanceof Error ? signal.reason : new Error('Sandbox read aborted'),
					);
				if (signal.aborted) onAbort();
				else signal.addEventListener('abort', onAbort, { once: true });
			}),
			promise,
		]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

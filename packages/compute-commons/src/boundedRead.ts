import { shellQuote } from './shell';

export interface BoundedReadOptions {
	maxBytes: number;
	timeoutMs: number;
}

export interface BoundedBatchReadOptions extends BoundedReadOptions {
	maxTotalBytes: number;
}

const DIAGNOSTIC_LIMIT = 2048;
const FAILURE_PREFIX = 'MARIMOHUB_BOUNDED_READ:';
const READER_REASONS = new Set([
	'not_found',
	'invalid_path',
	'not_regular',
	'size_limit',
	'timeout',
	'permission_denied',
	'io_error',
]);

// O_NOFOLLOW on every component rejects symlink parents; O_NONBLOCK prevents FIFO hangs.
const SAFE_READER = `import os, stat, sys, base64, signal

class ReadFailure(Exception):
    pass

class BatchLimit(Exception):
    pass

def timeout(*_):
    print('${FAILURE_PREFIX}timeout', file=sys.stderr, flush=True)
    sys.exit(1)

def read_file(path, limit, budget=None):
    parts = path.split('/')
    if not path.startswith('/') or '..' in parts:
        raise ReadFailure('invalid_path')
    fd = None
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        names = [p for p in parts if p and p != '.']
        for i, name in enumerate(names):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if i < len(names) - 1:
                flags |= os.O_DIRECTORY
            next_fd = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ReadFailure('not_regular')
        if info.st_size > limit:
            raise ReadFailure('size_limit')
        if budget is not None and info.st_size > budget:
            raise BatchLimit()
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(min(limit, budget) + 1 if budget is not None else limit + 1)
        if len(data) > limit:
            raise ReadFailure('size_limit')
        if budget is not None and len(data) > budget:
            raise BatchLimit()
        return data
    except FileNotFoundError:
        raise ReadFailure('not_found') from None
    except PermissionError:
        raise ReadFailure('permission_denied') from None
    except OSError:
        raise ReadFailure('io_error') from None
    finally:
        if fd is not None:
            os.close(fd)

signal.signal(signal.SIGALRM, timeout)`;

const READ_FILE = `${SAFE_READER}
signal.setitimer(signal.ITIMER_REAL, float(sys.argv[3]) / 1000)
try:
    sys.stdout.write(base64.b64encode(read_file(sys.argv[1], int(sys.argv[2]))).decode('ascii'))
except ReadFailure as error:
    print('${FAILURE_PREFIX}' + str(error), file=sys.stderr, flush=True)
    sys.exit(1)`;

// Stream each result instead of retaining every raw and encoded file in the container.
const READ_FILES = `${SAFE_READER}
import json
paths, limit, budget = json.loads(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
signal.setitimer(signal.ITIMER_REAL, float(sys.argv[4]) / 1000)
sys.stdout.write('[')
try:
    for index, path in enumerate(paths):
        if index:
            sys.stdout.write(',')
        try:
            data = read_file(path, limit, budget)
        except ReadFailure as error:
            json.dump({'reason': str(error)}, sys.stdout, separators=(',', ':'))
            continue
        budget -= len(data)
        sys.stdout.write('{"content":"')
        sys.stdout.write(base64.b64encode(data).decode('ascii'))
        sys.stdout.write('"}')
        del data
    sys.stdout.write(']')
except BatchLimit:
    print('${FAILURE_PREFIX}batch_size_limit', file=sys.stderr, flush=True)
    sys.exit(1)`;

interface ReadExecResult {
	success: boolean;
	stdout: string;
	stderr: string;
	error?: { code: 'COMMAND_FAILED' | 'SPAWN_FAILED' | 'BACKEND_ERROR' };
}

function executionFailureReason(message: string, fallback: string): string {
	if (/timed out|timeout|deadline exceeded/i.test(message)) return 'timeout';
	if (/output.*(?:limit|cap)|(?:limit|cap).*output|(?:wire|frame) limit exceeded/i.test(message))
		return 'output_limit';
	return fallback;
}

function boundedReadFailure(reason: string, result?: ReadExecResult) {
	return {
		success: false,
		content: '',
		error: {
			code: reason === 'not_found' ? 'NOT_FOUND' : 'READ_FAILED',
			reason,
			...(result && {
				exec_code: result.error?.code,
				stdout_bytes: new TextEncoder().encode(result.stdout).byteLength,
				stderr: result.stderr.slice(0, DIAGNOSTIC_LIMIT),
			}),
		},
	} as const;
}

/** Each result corresponds to its input path; all encoded output shares one transport budget. */
export async function readBoundedFiles(
	paths: readonly string[],
	options: BoundedBatchReadOptions,
	execute: (
		command: string,
		options: { timeout: number; maxOutputBytes: number },
	) => Promise<ReadExecResult>,
): Promise<Awaited<ReturnType<typeof readBoundedFile>>[]> {
	if (paths.length === 0) return [];
	const failed = (reason: string) => paths.map(() => boundedReadFailure(reason));
	const encodedBytes = 4 * Math.ceil(options.maxBytes / 3);
	const totalBudget = Math.min(options.maxTotalBytes, paths.length * options.maxBytes);
	const maxOutputBytes = 4 * Math.ceil(totalBudget / 3) + paths.length * 128 + 2;
	if (
		paths.length > 16 ||
		paths.some((path) => typeof path !== 'string' || path.length > 4096) ||
		!Number.isSafeInteger(options.maxBytes) ||
		options.maxBytes < 0 ||
		!Number.isSafeInteger(options.maxTotalBytes) ||
		options.maxTotalBytes < 0 ||
		!Number.isSafeInteger(encodedBytes) ||
		!Number.isSafeInteger(maxOutputBytes) ||
		!Number.isFinite(options.timeoutMs) ||
		options.timeoutMs <= 0 ||
		options.timeoutMs > 2 ** 31 - 1
	)
		return failed('invalid_options');
	let result: ReadExecResult;
	try {
		const timeout = Math.ceil(options.timeoutMs);
		result = await execute(
			`python3 -I -c ${shellQuote(READ_FILES)} ${shellQuote(JSON.stringify(paths))} ${options.maxBytes} ${options.maxTotalBytes} ${timeout}`,
			{ timeout, maxOutputBytes },
		);
	} catch (error) {
		return failed(
			executionFailureReason(error instanceof Error ? error.message : '', 'transport_error'),
		);
	}
	if (!result.success) {
		if (
			result.error?.code === 'COMMAND_FAILED' &&
			result.stderr.trim() === `${FAILURE_PREFIX}batch_size_limit`
		)
			return failed('size_limit');
		return failed(executionFailureReason(result.stderr, 'exec_failed'));
	}
	if (result.stdout.length + new TextEncoder().encode(result.stderr).byteLength > maxOutputBytes)
		return failed('output_limit');
	if (/\P{ASCII}/u.test(result.stdout)) return failed('invalid_batch');
	let entries: unknown;
	try {
		entries = JSON.parse(result.stdout);
	} catch {
		return failed('invalid_batch');
	}
	if (!Array.isArray(entries) || entries.length !== paths.length) return failed('invalid_batch');
	const files: Awaited<ReturnType<typeof readBoundedFile>>[] = [];
	const batch: unknown[] = entries;
	let totalBytes = 0;
	for (const entry of batch) {
		if (entry === null || typeof entry !== 'object' || Object.keys(entry).length !== 1)
			return failed('invalid_batch');
		if ('reason' in entry && typeof entry.reason === 'string' && READER_REASONS.has(entry.reason)) {
			files.push(boundedReadFailure(entry.reason));
		} else if ('content' in entry && typeof entry.content === 'string') {
			if (entry.content.length > encodedBytes) return failed('output_limit');
			try {
				const bytes = atob(entry.content).length;
				if (bytes > options.maxBytes) return failed('size_limit');
				totalBytes += bytes;
				if (totalBytes > options.maxTotalBytes) return failed('size_limit');
			} catch {
				return failed('invalid_base64');
			}
			files.push({ success: true, content: entry.content, encoding: 'base64' });
		} else return failed('invalid_batch');
	}
	return files;
}

export async function readBoundedFile(
	path: string,
	options: BoundedReadOptions,
	execute: (
		command: string,
		options: { timeout: number; maxOutputBytes: number },
	) => Promise<ReadExecResult>,
): Promise<
	{ success: true; content: string; encoding: 'base64' } | ReturnType<typeof boundedReadFailure>
> {
	const maxOutputBytes = 4 * Math.ceil(options.maxBytes / 3);
	if (
		!Number.isSafeInteger(options.maxBytes) ||
		options.maxBytes < 0 ||
		!Number.isSafeInteger(maxOutputBytes) ||
		!Number.isFinite(options.timeoutMs) ||
		options.timeoutMs <= 0 ||
		options.timeoutMs > 2 ** 31 - 1
	)
		return boundedReadFailure('invalid_options');
	let result: ReadExecResult;
	try {
		const timeout = Math.ceil(options.timeoutMs);
		const command = `python3 -I -c ${shellQuote(READ_FILE)} ${shellQuote(path)} ${options.maxBytes} ${timeout}`;
		// Failed reads emit diagnostics instead of file bytes, even with a zero-byte file cap.
		result = await execute(command, {
			timeout,
			maxOutputBytes: Math.max(maxOutputBytes, DIAGNOSTIC_LIMIT),
		});
	} catch (error) {
		return boundedReadFailure(
			executionFailureReason(error instanceof Error ? error.message : '', 'transport_error'),
		);
	}
	if (!result.success) {
		const marker = result.stderr.trim();
		const reason = marker.startsWith(FAILURE_PREFIX) ? marker.slice(FAILURE_PREFIX.length) : '';
		if (result.error?.code === 'COMMAND_FAILED' && READER_REASONS.has(reason))
			return boundedReadFailure(reason, result);
		return boundedReadFailure(executionFailureReason(result.stderr, 'exec_failed'), result);
	}
	if (result.stdout.length + new TextEncoder().encode(result.stderr).byteLength > maxOutputBytes)
		return boundedReadFailure('output_limit', result);
	try {
		if (atob(result.stdout).length > options.maxBytes)
			return boundedReadFailure('size_limit', result);
	} catch {
		return boundedReadFailure('invalid_base64', result);
	}
	return { success: true, content: result.stdout, encoding: 'base64' };
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

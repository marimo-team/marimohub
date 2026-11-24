import type { SandboxStartupSnapshot } from '@marimo-hub/core/ports/sandbox';
import type { ErrorCode } from '../shared';
import type { SessionCreateResult } from './sessionStart';

const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 30 * 60_000;

export function sessionStartupStream(
	run: (callbacks: {
		onAuthorized: () => void;
		onProgress: (progress: SandboxStartupSnapshot) => void;
	}) => Promise<SessionCreateResult>,
	publicError: (error: unknown) => {
		code: string;
		message: string;
		status: number;
		retry_after_ms?: number;
	},
	signal?: AbortSignal,
) {
	const started = Promise.withResolvers<void>();
	let opened = false;
	let disconnected = false;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let pending: SandboxStartupSnapshot | undefined;
	let terminal: string | undefined;
	let lastProgress: SandboxStartupSnapshot | undefined;
	let lastSent = 0;
	let lastProgressAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const encoder = new TextEncoder();
	const frame = (event: string, data: unknown) =>
		`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const canWrite = () => !disconnected && opened && (controller.desiredSize ?? 0) > 0;
	const write = (chunk: string) => {
		lastSent = Date.now();
		controller.enqueue(encoder.encode(chunk));
	};
	const flush = () => {
		if (!canWrite()) return;
		if (
			pending &&
			(terminal ||
				pending.phase !== lastProgress?.phase ||
				pending.attempt !== lastProgress.attempt ||
				Date.now() - lastProgressAt >= 1000)
		) {
			lastProgress = pending;
			pending = undefined;
			lastProgressAt = Date.now();
			write(frame('progress', lastProgress));
		}
		if (terminal && canWrite()) {
			const final = terminal;
			stopObserving();
			write(final);
			controller.close();
		}
	};
	const finish = (event: string, data: unknown) => {
		clearInterval(timer);
		if (disconnected || terminal) return;
		if (event === 'error') pending = undefined;
		terminal = frame(event, data);
		flush();
	};
	const stopObserving = () => {
		disconnected = true;
		pending = undefined;
		terminal = undefined;
		clearInterval(timer);
		signal?.removeEventListener('abort', abort);
	};
	const abort = () => {
		if (disconnected) return;
		stopObserving();
		controller.close();
	};
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
		pull() {
			flush();
		},
		cancel: stopObserving,
	});
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) abort();
	const done = Promise.resolve()
		.then(() =>
			run({
				onAuthorized() {
					if (opened) return;
					opened = true;
					started.resolve();
					if (disconnected) return;
					const openedAt = Date.now();
					write(': connected\n\n');
					timer = setInterval(() => {
						if (Date.now() - openedAt >= MAX_STREAM_MS) {
							finish('error', {
								success: false,
								error: {
									code: 'STREAM_EXPIRED' satisfies ErrorCode,
									message: 'Startup observation expired. Reload to check the session.',
									status: 408,
								},
							});
							return;
						}
						flush();
						if (!terminal && canWrite() && Date.now() - lastSent >= HEARTBEAT_MS)
							write(': keepalive\n\n');
					}, 1000);
				},
				onProgress(progress) {
					if (!disconnected && !terminal) {
						pending = progress;
						flush();
					}
				},
			}),
		)
		.then(
			(data) => {
				finish('result', { success: true, data });
			},
			(error: unknown) => {
				if (!opened) {
					started.reject(error);
					abort();
					return;
				}
				finish('error', { success: false, error: publicError(error) });
			},
		);
	return {
		started: started.promise,
		done,
		response: new Response(body, {
			headers: {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'private, no-store, no-transform',
				'X-Accel-Buffering': 'no',
				Vary: 'Accept',
			},
		}),
	};
}

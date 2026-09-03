import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	executeInKernel,
	kernelBaseUrl,
	KernelHttpError,
	listKernelSessions,
} from './kernelExecute';
import type { Session } from '../../schema';

function sse(body: string): Response {
	return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function chunkedSse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { 'Content-Type': 'text/event-stream' } },
	);
}

afterEach(() => vi.useRealTimers());

describe('kernel execution', () => {
	it('builds subdomain and proxy kernel URLs', () => {
		expect(kernelBaseUrl({ sandbox_url: 'https://kernel.example/' } as Session)).toBe(
			'https://kernel.example',
		);
		expect(
			kernelBaseUrl({
				sandbox_url: 'https://hub.example/proxy/secret/',
				sandbox_origin_url: 'http://sandbox:2718',
			} as Session),
		).toBe('http://sandbox:2718/proxy/secret');
	});

	it('lists kernel sessions', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ sessions: [{ id: 'one', path: '/notebook.py' }] }), {
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		await expect(listKernelSessions('https://kernel', { fetchImpl })).resolves.toEqual([
			{ id: 'one', path: '/notebook.py' },
		]);
	});

	it('collects SSE output and terminal results', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				sse(
					': ping\r\nevent: stdout\r\ndata: {"data":"hello\\n"}\r\n\r\n' +
						'event: stderr\ndata: {"data":"warning"}\n\n' +
						'event: done\ndata: {"success":true,"output":{"mimetype":"text/plain","data":"2"}}\n\n',
				),
			);
		await expect(
			executeInKernel('https://kernel', { sessionId: 'one', code: '1+1' }, { fetchImpl }),
		).resolves.toEqual({
			completed: true,
			success: true,
			stdout: 'hello\n',
			stderr: 'warning',
			output: { mimetype: 'text/plain', data: '2' },
			truncated: false,
			timedOut: false,
		});
	});

	it('parses multiline data across CRLF chunk boundaries', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				chunkedSse([
					'event: stdout\r',
					'\ndata: {"data":"hello"}\r\n\r',
					'\nevent: done\ndata: {"success":true,\n',
					'data: "output":{"mimetype":"text/plain","data":"ok"}}\n\n',
				]),
			);
		await expect(
			executeInKernel('https://kernel', { sessionId: 'one', code: '1+1' }, { fetchImpl }),
		).resolves.toMatchObject({
			completed: true,
			success: true,
			stdout: 'hello',
			output: { mimetype: 'text/plain', data: 'ok' },
		});
	});

	it('reports truncation and an incomplete stream', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(sse('event: stdout\ndata: {"data":"abcdef"}\n\n'));
		await expect(
			executeInKernel(
				'https://kernel',
				{ sessionId: 'one', code: 'print()', maxStdoutBytes: 3 },
				{ fetchImpl },
			),
		).resolves.toMatchObject({ completed: false, stdout: 'abc', truncated: true });
	});

	it('reports a completed kernel failure', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(sse('event: done\ndata: {"success":false}\n\n'));
		await expect(
			executeInKernel(
				'https://kernel',
				{ sessionId: 'one', code: 'raise ValueError()' },
				{
					fetchImpl,
				},
			),
		).resolves.toMatchObject({ completed: true, success: false, timedOut: false });
	});

	it('surfaces JSON error details', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ detail: 'edit scope required' }), {
				status: 403,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		await expect(listKernelSessions('https://kernel', { fetchImpl })).rejects.toEqual(
			new KernelHttpError(403, 'edit scope required'),
		);
	});

	it('interrupts execution when the timeout elapses', async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('Aborted', 'AbortError')),
					);
				}),
		);
		const execution = executeInKernel(
			'https://kernel',
			{ sessionId: 'one', code: 'while True: pass' },
			{ fetchImpl, timeoutMs: 100 },
		);
		await vi.advanceTimersByTimeAsync(100);
		await expect(execution).resolves.toMatchObject({
			completed: false,
			success: false,
			timedOut: true,
		});
	});
});

import { SandboxClient } from '@coreweave/cwsandbox';
import type {
	CommandProcess,
	LogStream,
	ProcessResult,
	SandboxStatus,
	SandboxTransport,
} from '@coreweave/cwsandbox';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createSandboxId } from '@marimo-hub/core';
import { CoreWeaveCompute } from './index';
import { fakeProcess, makeWorld, procResult } from './testWorld';
import { instrumentCoreWeaveTransport } from './tracing';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

afterEach(() => exporter.reset());
afterAll(() => {
	trace.disable();
	context.disable();
});

function emptyLogStream(): LogStream {
	return {
		closed: false,
		offset: undefined,
		sessionId: undefined,
		cancel: async () => {},
		close: async () => {},
		async *[Symbol.asyncIterator]() {},
	};
}

function fakeTransport() {
	return {
		start: vi.fn(async () => ({ sandboxId: 'cw-1', status: 'creating' as const })),
		get: vi.fn(async ({ sandboxId }) => ({ sandboxId, status: 'running' as SandboxStatus })),
		list: vi.fn(async () => ({ sandboxes: [] })),
		delete: vi.fn(async () => {}),
		exec: vi.fn(async () => procResult()),
		startCommand: vi.fn(async () => fakeProcess()),
		streamLogs: vi.fn(async () => emptyLogStream()),
		stop: vi.fn(async () => {}),
		writeFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => ({ content: new Uint8Array() })),
	} satisfies SandboxTransport;
}

const SANDBOX_ID = 'cw-1';
const GATEWAY = 'coreweave.sandbox.v1beta2.GatewayService';
const STREAMING = 'coreweave.sandbox.v1beta2.GatewayStreamingService';

describe('instrumentCoreWeaveTransport', () => {
	it('spans every transport request with RPC and endpoint attributes', async () => {
		const transport = instrumentCoreWeaveTransport(
			fakeTransport(),
			'https://gateway.example:8443/api',
		);

		await transport.start({ command: ['sleep', 'infinity'] });
		await transport.get({ sandboxId: SANDBOX_ID });
		await transport.list({});
		await transport.delete({ sandboxId: SANDBOX_ID });
		await transport.exec({ sandboxId: SANDBOX_ID, command: ['true'] });
		await transport.startCommand({ sandboxId: SANDBOX_ID, command: ['marimo'] });
		const logStream = await transport.streamLogs({ sandboxId: SANDBOX_ID, mode: 'lines' });
		await logStream[Symbol.asyncIterator]().next();
		await transport.stop({ sandboxId: SANDBOX_ID });
		await transport.writeFile({
			sandboxId: SANDBOX_ID,
			path: '/workspace/private.txt',
			content: new Uint8Array([1]),
		});
		await transport.readFile({ sandboxId: SANDBOX_ID, path: '/workspace/private.txt' });

		const spans = exporter.getFinishedSpans();
		expect(spans.map((span) => span.name)).toEqual([
			`${GATEWAY}/Start`,
			`${GATEWAY}/Get`,
			`${GATEWAY}/List`,
			`${GATEWAY}/Delete`,
			`${GATEWAY}/Exec`,
			`${STREAMING}/StreamExec`,
			`${STREAMING}/StreamLogs`,
			`${GATEWAY}/Stop`,
			`${GATEWAY}/AddFile`,
			`${GATEWAY}/RetrieveFile`,
		]);
		for (const span of spans) {
			expect(span.kind).toBe(SpanKind.CLIENT);
			expect(span.attributes).toMatchObject({
				'rpc.system.name': 'grpc',
				'rpc.method': span.name,
				'server.address': 'gateway.example',
				'server.port': 8443,
			});
		}
		expect(spans[0]?.attributes['coreweave.sandbox_id']).toBe(SANDBOX_ID);
		expect(spans[2]?.attributes).not.toHaveProperty('coreweave.sandbox_id');
		expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('private.txt');
		expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('marimo');
	});

	it('captures the SDK request fan-out from boot polling and multi-file writes', async () => {
		const raw = fakeTransport();
		raw.get
			.mockResolvedValueOnce({ sandboxId: SANDBOX_ID, status: 'creating' })
			.mockResolvedValueOnce({ sandboxId: SANDBOX_ID, status: 'running' });
		const client = new SandboxClient({
			transport: instrumentCoreWeaveTransport(raw, 'https://gateway.example'),
		});
		const sandbox = await client.create({ waitUntilRunning: false });

		await sandbox.wait({ intervalMs: 1 });
		await sandbox.files.write([
			{ path: '/workspace/a.txt', content: 'a' },
			{ path: '/workspace/b.txt', content: 'b' },
		]);

		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
			`${GATEWAY}/Start`,
			`${GATEWAY}/Get`,
			`${GATEWAY}/Get`,
			`${GATEWAY}/AddFile`,
			`${GATEWAY}/AddFile`,
		]);
	});

	it('inherits the active compute span and records request failures', async () => {
		const raw = fakeTransport();
		raw.get.mockRejectedValueOnce(new Error('gateway unavailable'));
		const transport = instrumentCoreWeaveTransport(raw, 'https://gateway.example');
		let parentSpanId = '';

		await provider.getTracer('test').startActiveSpan('SandboxInstance.ready', async (parent) => {
			parentSpanId = parent.spanContext().spanId;
			await expect(transport.get({ sandboxId: SANDBOX_ID })).rejects.toThrow('gateway unavailable');
			parent.end();
		});

		const requestSpan = exporter.getFinishedSpans().find((span) => span.name === `${GATEWAY}/Get`);
		expect(requestSpan?.parentSpanContext?.spanId).toBe(parentSpanId);
		expect(requestSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(requestSpan?.attributes['error.type']).toBe('Error');
		expect(requestSpan?.events.some((event) => event.name === 'exception')).toBe(true);
	});

	it('correlates the ensure event with the active trace', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await provider.getTracer('test').startActiveSpan('session-provision', async (span) => {
				try {
					const world = makeWorld();
					const instance = new CoreWeaveCompute(
						{ apiKey: 'key', image: 'image' },
						world.client,
					).create(createSandboxId(), { reuse: false });
					await instance.ready?.();

					const event = warn.mock.calls
						.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
						.find((record) => record.event === 'coreweave_ensure');
					expect(event).toMatchObject({
						trace_id: span.spanContext().traceId,
						span_id: span.spanContext().spanId,
					});
				} finally {
					span.end();
				}
			});
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps a command span open and records a failure after the handshake', async () => {
		let rejectWait!: (error: Error) => void;
		const wait = new Promise<ProcessResult>((_resolve, reject) => {
			rejectWait = reject;
		});
		const process: CommandProcess = { ...fakeProcess(), wait: () => wait };
		const raw = fakeTransport();
		raw.startCommand.mockResolvedValueOnce(process);
		const transport = instrumentCoreWeaveTransport(raw, 'https://gateway.example');

		await expect(
			transport.startCommand({ sandboxId: SANDBOX_ID, command: ['marimo'] }),
		).resolves.toBe(process);
		expect(exporter.getFinishedSpans()).toHaveLength(0);

		rejectWait(new Error('stream reset'));
		await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));

		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe(`${STREAMING}/StreamExec`);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('Error');
		expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
	});

	it('keeps a log span open and records an iterator failure after the handshake', async () => {
		const failure = new Error('log stream reset');
		const stream: LogStream = {
			...emptyLogStream(),
			async *[Symbol.asyncIterator]() {
				yield 'ready';
				throw failure;
			},
		};
		const raw = fakeTransport();
		raw.streamLogs.mockResolvedValueOnce(stream);
		const transport = instrumentCoreWeaveTransport(raw, 'https://gateway.example');

		const observed = await transport.streamLogs({ sandboxId: SANDBOX_ID, mode: 'lines' });
		expect(exporter.getFinishedSpans()).toHaveLength(0);
		const iterator = observed[Symbol.asyncIterator]();
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ready' });
		expect(exporter.getFinishedSpans()).toHaveLength(0);
		await expect(iterator.next()).rejects.toBe(failure);

		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe(`${STREAMING}/StreamLogs`);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('Error');
		expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
	});

	it('ends a log span and closes the iterator when consumption stops early', async () => {
		let iteratorClosed = false;
		const stream: LogStream = {
			...emptyLogStream(),
			async *[Symbol.asyncIterator]() {
				try {
					yield 'first';
					yield 'second';
				} finally {
					iteratorClosed = true;
				}
			},
		};
		const raw = fakeTransport();
		raw.streamLogs.mockResolvedValueOnce(stream);
		const transport = instrumentCoreWeaveTransport(raw, 'https://gateway.example');

		const observed = await transport.streamLogs({ sandboxId: SANDBOX_ID, mode: 'lines' });
		for await (const line of observed) {
			expect(line).toBe('first');
			break;
		}

		expect(iteratorClosed).toBe(true);
		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe(`${STREAMING}/StreamLogs`);
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});
});

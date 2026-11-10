import type { CommandProcess, ProcessResult } from '@coreweave/cwsandbox';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreWeaveClient, CoreWeaveSandbox } from './index';
import { fakeProcess, procResult } from './testWorld';
import { instrumentCoreWeaveClient } from './tracing';

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

const SANDBOX_ID = 'cw-1';
const CLIENT = 'cwsandbox.SandboxClient';
const SANDBOX = 'cwsandbox.Sandbox';

function fakeSandbox(over: Partial<CoreWeaveSandbox> = {}): CoreWeaveSandbox {
	return {
		sandboxId: SANDBOX_ID,
		getStatus: vi.fn(async () => 'running' as const),
		commands: {
			run: vi.fn(async () => procResult()),
			start: vi.fn(async () => fakeProcess({ exitCode: 0 })),
		},
		files: {
			readText: vi.fn(async () => 'content'),
			write: vi.fn(async () => {}),
		},
		delete: vi.fn(async () => {}),
		...over,
	};
}

function fakeClient(sandbox: CoreWeaveSandbox = fakeSandbox()) {
	return {
		create: vi.fn(async () => sandbox),
		runFromTemplate: vi.fn(async () => sandbox),
		fromId: vi.fn(async () => sandbox),
		list: vi.fn(async () => ({ sandboxes: [] })),
		delete: vi.fn(async () => {}),
	} satisfies CoreWeaveClient;
}

describe('instrumentCoreWeaveClient', () => {
	it.each([true, false])('traces preconnection and forwards its result (%s)', async (result) => {
		const preconnect = vi.fn<NonNullable<CoreWeaveClient['preconnect']>>(async () => result);
		const raw = { ...fakeClient(), preconnect };
		const client = instrumentCoreWeaveClient(raw, 'https://gateway.example:8443/api');
		const options = { timeoutMs: 1234, signal: new AbortController().signal };
		let parentSpanId = '';

		await provider.getTracer('test').startActiveSpan('warm_pool_preconnect', async (parent) => {
			parentSpanId = parent.spanContext().spanId;
			await expect(client.preconnect!(SANDBOX_ID, options)).resolves.toBe(result);
			parent.end();
		});

		expect(preconnect).toHaveBeenCalledExactlyOnceWith(SANDBOX_ID, options);
		expect(preconnect.mock.calls[0][1]).toBe(options);
		expect(preconnect.mock.contexts).toEqual([raw]);
		const spans = exporter
			.getFinishedSpans()
			.filter((span) => span.name === `${CLIENT}/preconnect`);
		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.kind).toBe(SpanKind.CLIENT);
		expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
		expect(span.attributes).toEqual({
			'server.address': 'gateway.example',
			'server.port': 8443,
			'coreweave.sandbox_id': SANDBOX_ID,
		});
		expect(span.status.code).toBe(SpanStatusCode.UNSET);
		expect(span.events).toEqual([]);
	});

	it('records preconnection failures and preserves the original error', async () => {
		const failure = new Error('connection unavailable');
		const preconnect = vi.fn<NonNullable<CoreWeaveClient['preconnect']>>(async () => {
			throw failure;
		});
		const client = instrumentCoreWeaveClient(
			{ ...fakeClient(), preconnect },
			'https://gateway.example',
		);
		await expect(
			client.preconnect!(SANDBOX_ID, { timeoutMs: 1234, signal: new AbortController().signal }),
		).rejects.toBe(failure);

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.name).toBe(`${CLIENT}/preconnect`);
		expect(span.attributes['coreweave.sandbox_id']).toBe(SANDBOX_ID);
		expect(span.attributes['error.type']).toBe('Error');
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.events).toContainEqual(
			expect.objectContaining({
				name: 'exception',
				attributes: expect.objectContaining({ 'exception.message': failure.message }),
			}),
		);
	});

	it('omits preconnection when the client does not support it', () => {
		const client = instrumentCoreWeaveClient(fakeClient(), 'https://gateway.example');
		expect(client).not.toHaveProperty('preconnect');
		expect(exporter.getFinishedSpans()).toEqual([]);
	});

	it('spans every client and sandbox operation with endpoint attributes', async () => {
		const client = instrumentCoreWeaveClient(fakeClient(), 'https://gateway.example:8443/api');

		const sandbox = await client.create({});
		await sandbox.getStatus();
		await sandbox.commands.run(['sh', '-lc', 'run-marimo-secret']);
		await sandbox.files.readText('/workspace/private.txt');
		await sandbox.files.write([{ path: '/workspace/private.txt', content: 'secret' }]);
		await sandbox.delete();
		await client.fromId(SANDBOX_ID);
		await client.list({});
		await client.delete(SANDBOX_ID);

		const spans = exporter.getFinishedSpans();
		expect(spans.map((span) => span.name)).toEqual([
			`${CLIENT}/create`,
			`${SANDBOX}/getStatus`,
			`${SANDBOX}/exec`,
			`${SANDBOX}/readFile`,
			`${SANDBOX}/writeFiles`,
			`${SANDBOX}/delete`,
			`${CLIENT}/fromId`,
			`${CLIENT}/list`,
			`${CLIENT}/delete`,
		]);
		for (const span of spans) {
			expect(span.kind).toBe(SpanKind.CLIENT);
			expect(span.attributes).toMatchObject({
				'server.address': 'gateway.example',
				'server.port': 8443,
			});
		}
		expect(spans[0]?.attributes['coreweave.sandbox_id']).toBe(SANDBOX_ID);
		expect(spans[1]?.attributes['coreweave.sandbox_id']).toBe(SANDBOX_ID);
		expect(spans[7]?.attributes).not.toHaveProperty('coreweave.sandbox_id');
		// Command argv and file paths/contents are user data — never attributes.
		const attributes = JSON.stringify(spans.map((span) => span.attributes));
		expect(attributes).not.toContain('private.txt');
		expect(attributes).not.toContain('run-marimo-secret');
	});

	it.each([false, true])(
		'spans streaming file writes and records failures (rejects: %s)',
		async (rejects) => {
			const failure = new Error('stream reset');
			const writeStream = vi.fn(async () => {
				if (rejects) throw failure;
			});
			const raw = fakeSandbox();
			raw.files.writeStream = writeStream;
			const client = instrumentCoreWeaveClient(fakeClient(raw), 'https://gateway.example:8443/api');
			const sandbox = await client.create({});
			exporter.reset();
			const content = new TextEncoder().encode('private-content');
			const writing = sandbox.files.writeStream!('/workspace/private.txt', content, {
				timeoutMs: 123,
			});
			if (rejects) await expect(writing).rejects.toBe(failure);
			else await expect(writing).resolves.toBeUndefined();
			expect(writeStream).toHaveBeenCalledExactlyOnceWith('/workspace/private.txt', content, {
				timeoutMs: 123,
			});
			const spans = exporter.getFinishedSpans();
			expect(spans).toHaveLength(1);
			const span = spans[0];
			expect(span.name).toBe(`${SANDBOX}/writeFileStream`);
			expect(span.kind).toBe(SpanKind.CLIENT);
			expect(span.attributes).toMatchObject({
				'server.address': 'gateway.example',
				'server.port': 8443,
				'coreweave.sandbox_id': SANDBOX_ID,
			});
			expect(JSON.stringify(span.attributes)).not.toMatch(/private\.txt|private-content/);
			if (rejects) {
				expect(span.status.code).toBe(SpanStatusCode.ERROR);
				expect(span.attributes['error.type']).toBe('Error');
				expect(span.events).toContainEqual(
					expect.objectContaining({
						name: 'exception',
						attributes: expect.objectContaining({ 'exception.message': failure.message }),
					}),
				);
			} else {
				expect(span.status.code).toBe(SpanStatusCode.UNSET);
				expect(span.events).toEqual([]);
			}
		},
	);

	it('preserves handle metadata (sandboxId, serviceUrls) through the wrapper', async () => {
		const urls = [{ name: 'kernel', port: 2718, url: 'http://166.19.118.62:2718' }];
		const client = instrumentCoreWeaveClient(
			fakeClient(fakeSandbox({ serviceUrls: urls })),
			'https://gateway.example',
		);
		const sandbox = await client.create({});
		expect(sandbox.sandboxId).toBe(SANDBOX_ID);
		expect(sandbox.serviceUrls).toEqual(urls);
	});

	it('inherits the active compute span and records request failures', async () => {
		const raw = fakeClient();
		raw.fromId.mockRejectedValueOnce(new Error('gateway unavailable'));
		const client = instrumentCoreWeaveClient(raw, 'https://gateway.example');
		let parentSpanId = '';

		await provider.getTracer('test').startActiveSpan('SandboxInstance.ready', async (parent) => {
			parentSpanId = parent.spanContext().spanId;
			await expect(client.fromId(SANDBOX_ID)).rejects.toThrow('gateway unavailable');
			parent.end();
		});

		const requestSpan = exporter
			.getFinishedSpans()
			.find((span) => span.name === `${CLIENT}/fromId`);
		expect(requestSpan?.parentSpanContext?.spanId).toBe(parentSpanId);
		expect(requestSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(requestSpan?.attributes['error.type']).toBe('Error');
		expect(requestSpan?.events.some((event) => event.name === 'exception')).toBe(true);
	});

	it('keeps a command span open and records a failure after the handshake', async () => {
		let rejectWait!: (error: Error) => void;
		const wait = new Promise<ProcessResult>((_resolve, reject) => {
			rejectWait = reject;
		});
		const process: CommandProcess = { ...fakeProcess(), wait: () => wait };
		const inner = fakeSandbox();
		vi.mocked(inner.commands.start).mockResolvedValueOnce(process);
		const client = instrumentCoreWeaveClient(fakeClient(inner), 'https://gateway.example');
		const sandbox = await client.create({});
		exporter.reset();

		await expect(sandbox.commands.start(['sh', '-lc', 'marimo'])).resolves.toBe(process);
		expect(exporter.getFinishedSpans()).toHaveLength(0);

		rejectWait(new Error('stream reset'));
		await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));

		const span = exporter.getFinishedSpans()[0];
		expect(span?.name).toBe(`${SANDBOX}/startCommand`);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('Error');
		expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
	});
});

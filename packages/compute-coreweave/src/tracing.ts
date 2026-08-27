/**
 * OTEL client spans for the CoreWeave Sandbox SDK, wrapped around the
 * `CoreWeaveClient` / `CoreWeaveSandbox` seam. The published v1 SDK exports no
 * transport to intercept (unlike the vendored v1beta2 build this replaced), so
 * spans cover the adapter's client operations rather than individual gRPC
 * requests — `Sandbox/wait` is one span over the whole poll loop, and
 * `Sandbox/writeFiles` one span over the batched AddFile fan-out.
 *
 * Attribute hygiene: spans carry the endpoint and sandbox id but never command
 * argv or file paths/contents (notebook names and code are user data).
 */
import type { CommandProcess } from '@coreweave/cwsandbox';
import type { Attributes, Span } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { CoreWeaveClient, CoreWeaveSandbox } from './index';

const CLIENT_SCOPE = 'cwsandbox.SandboxClient';
const SANDBOX_SCOPE = 'cwsandbox.Sandbox';

function endpointAttributes(baseUrl: string): Attributes {
	try {
		const url = new URL(baseUrl);
		return {
			'server.address': url.hostname,
			...(url.port ? { 'server.port': Number(url.port) } : {}),
		};
	} catch {
		return {};
	}
}

function errorType(error: unknown): string {
	if (error instanceof Error) return error.name;
	return typeof error;
}

interface SpanLifecycle {
	end(): void;
	fail(error: unknown): void;
}

function spanLifecycle(span: Span): SpanLifecycle {
	let ended = false;
	return {
		end() {
			if (ended) return;
			ended = true;
			span.end();
		},
		fail(error) {
			if (ended) return;
			span.recordException(error instanceof Error ? error : String(error));
			span.setAttribute('error.type', errorType(error));
			span.setStatus({ code: SpanStatusCode.ERROR });
			this.end();
		},
	};
}

function startClientSpan<T>(
	name: string,
	attributes: Attributes,
	request: (span: Span) => Promise<T>,
): Promise<T> {
	const tracer = trace.getTracer('@marimo-hub/compute-coreweave');
	return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT, attributes }, request);
}

async function opRequest<T>(
	name: string,
	attributes: Attributes,
	request: () => Promise<T>,
	onResult?: (span: Span, result: T) => void,
): Promise<T> {
	return startClientSpan(name, attributes, async (span) => {
		const lifecycle = spanLifecycle(span);
		try {
			const result = await request();
			onResult?.(span, result);
			return result;
		} catch (error) {
			lifecycle.fail(error);
			throw error;
		} finally {
			lifecycle.end();
		}
	});
}

/**
 * `commands.start` returns after the stream handshake but the command keeps
 * running; the span stays open until the process settles so a mid-stream
 * fault (e.g. a gRPC reset) is recorded on it.
 */
function streamingOpRequest(
	name: string,
	attributes: Attributes,
	request: () => Promise<CommandProcess>,
): Promise<CommandProcess> {
	return startClientSpan(name, attributes, async (span) => {
		const lifecycle = spanLifecycle(span);
		try {
			const process = await request();
			void process.wait().then(
				() => lifecycle.end(),
				(error: unknown) => lifecycle.fail(error),
			);
			return process;
		} catch (error) {
			lifecycle.fail(error);
			throw error;
		}
	});
}

function instrumentSandbox(sandbox: CoreWeaveSandbox, endpoint: Attributes): CoreWeaveSandbox {
	const attributes = { ...endpoint, 'coreweave.sandbox_id': sandbox.sandboxId };
	const op = (method: string) => `${SANDBOX_SCOPE}/${method}`;
	return {
		get sandboxId() {
			return sandbox.sandboxId;
		},
		get serviceUrls() {
			return sandbox.serviceUrls;
		},
		wait: () => opRequest(op('wait'), attributes, () => sandbox.wait()),
		commands: {
			run: (command, options) =>
				opRequest(op('exec'), attributes, () => sandbox.commands.run(command, options)),
			start: (command, options) =>
				streamingOpRequest(op('startCommand'), attributes, () =>
					sandbox.commands.start(command, options),
				),
		},
		files: {
			readText: (path) => opRequest(op('readFile'), attributes, () => sandbox.files.readText(path)),
			write: (files) => opRequest(op('writeFiles'), attributes, () => sandbox.files.write(files)),
		},
		delete: () => opRequest(op('delete'), attributes, () => sandbox.delete()),
	};
}

export function instrumentCoreWeaveClient(
	client: CoreWeaveClient,
	baseUrl: string,
): CoreWeaveClient {
	const endpoint = endpointAttributes(baseUrl);
	const op = (method: string) => `${CLIENT_SCOPE}/${method}`;
	return {
		create: (options) =>
			opRequest(
				op('create'),
				endpoint,
				() => client.create(options),
				(span, sandbox) => span.setAttribute('coreweave.sandbox_id', sandbox.sandboxId),
			).then((sandbox) => instrumentSandbox(sandbox, endpoint)),
		fromId: (sandboxId) =>
			opRequest(op('fromId'), { ...endpoint, 'coreweave.sandbox_id': sandboxId }, () =>
				client.fromId(sandboxId),
			).then((sandbox) => instrumentSandbox(sandbox, endpoint)),
		list: (options) => opRequest(op('list'), endpoint, () => client.list(options)),
		delete: (sandboxId) =>
			opRequest(op('delete'), { ...endpoint, 'coreweave.sandbox_id': sandboxId }, () =>
				client.delete(sandboxId),
			),
	};
}

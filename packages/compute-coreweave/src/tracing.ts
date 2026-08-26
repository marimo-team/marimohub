import type {
	CommandProcess,
	DeleteSandboxRequest,
	ExecRequest,
	GetSandboxRequest,
	ListSandboxesResult,
	LogEntryStream,
	LogRawStream,
	LogStream,
	ProcessResult,
	ReadFileRequest,
	ReadFileResult,
	SandboxTransport,
	StartCommandRequest,
	StartSandboxRequest,
	StartSandboxResult,
	StopSandboxRequest,
	StreamLogsRequest,
	WriteFileRequest,
} from '@coreweave/cwsandbox';
import type { Attributes, Span } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const GATEWAY_SERVICE = 'coreweave.sandbox.v1beta2.GatewayService';
const STREAMING_SERVICE = 'coreweave.sandbox.v1beta2.GatewayStreamingService';

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

function startRpcSpan<T>(
	method: string,
	endpoint: Attributes,
	attributes: Attributes,
	request: (span: Span) => Promise<T>,
): Promise<T> {
	const tracer = trace.getTracer('@marimo-hub/compute-coreweave');
	return tracer.startActiveSpan(
		method,
		{
			kind: SpanKind.CLIENT,
			attributes: {
				'rpc.system.name': 'grpc',
				'rpc.method': method,
				...endpoint,
				...attributes,
			},
		},
		request,
	);
}

async function rpcRequest<T>(
	method: string,
	endpoint: Attributes,
	request: () => Promise<T>,
	attributes: Attributes = {},
	onResult?: (span: Span, result: T) => void,
): Promise<T> {
	return startRpcSpan(method, endpoint, attributes, async (span) => {
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

function streamingRpcRequest<T>(
	method: string,
	endpoint: Attributes,
	request: () => Promise<T>,
	attributes: Attributes,
	observe: (result: T, lifecycle: SpanLifecycle) => T,
): Promise<T> {
	return startRpcSpan(method, endpoint, attributes, async (span) => {
		const lifecycle = spanLifecycle(span);
		try {
			return observe(await request(), lifecycle);
		} catch (error) {
			lifecycle.fail(error);
			throw error;
		}
	});
}

function observeCommandProcess(process: CommandProcess, lifecycle: SpanLifecycle): CommandProcess {
	void process.wait().then(
		() => lifecycle.end(),
		(error: unknown) => lifecycle.fail(error),
	);
	return process;
}

function observeIterator(
	iterator: AsyncIterator<unknown>,
	lifecycle: SpanLifecycle,
): AsyncIterator<unknown> & AsyncIterable<unknown> {
	return {
		async next() {
			try {
				const result = await iterator.next();
				if (result.done) lifecycle.end();
				return result;
			} catch (error) {
				lifecycle.fail(error);
				throw error;
			}
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

type CoreWeaveLogStream = LogEntryStream | LogRawStream | LogStream;

function observeLogStream<T extends CoreWeaveLogStream>(stream: T, lifecycle: SpanLifecycle): T {
	return new Proxy(stream, {
		get(target, property) {
			if (property === Symbol.asyncIterator) {
				return () => observeIterator(target[Symbol.asyncIterator](), lifecycle);
			}
			const value: unknown = Reflect.get(target, property, target);
			if ((property === 'cancel' || property === 'close') && typeof value === 'function') {
				return (...args: unknown[]) => {
					let pending: Promise<unknown>;
					try {
						pending = Reflect.apply(value, target, args);
					} catch (error) {
						lifecycle.fail(error);
						throw error;
					}
					return pending.then(
						(result) => {
							lifecycle.end();
							return result;
						},
						(error: unknown) => {
							lifecycle.fail(error);
							throw error;
						},
					);
				};
			}
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

function sandboxAttributes(sandboxId: string): Attributes {
	return { 'coreweave.sandbox_id': sandboxId };
}

export function instrumentCoreWeaveTransport(
	transport: SandboxTransport,
	baseUrl: string,
): SandboxTransport {
	const endpoint = endpointAttributes(baseUrl);
	const gateway = (method: string) => `${GATEWAY_SERVICE}/${method}`;
	const streaming = (method: string) => `${STREAMING_SERVICE}/${method}`;

	return {
		start(request: StartSandboxRequest): Promise<StartSandboxResult> {
			return rpcRequest(
				gateway('Start'),
				endpoint,
				() => transport.start(request),
				{},
				(span, result) => span.setAttribute('coreweave.sandbox_id', result.sandboxId),
			);
		},
		get(request: GetSandboxRequest) {
			return rpcRequest(
				gateway('Get'),
				endpoint,
				() => transport.get(request),
				sandboxAttributes(request.sandboxId),
			);
		},
		list(options): Promise<ListSandboxesResult> {
			return rpcRequest(gateway('List'), endpoint, () => transport.list(options));
		},
		delete(request: DeleteSandboxRequest): Promise<void> {
			return rpcRequest(
				gateway('Delete'),
				endpoint,
				() => transport.delete(request),
				sandboxAttributes(request.sandboxId),
			);
		},
		exec(request: ExecRequest): Promise<ProcessResult> {
			return rpcRequest(
				gateway('Exec'),
				endpoint,
				() => transport.exec(request),
				sandboxAttributes(request.sandboxId),
			);
		},
		startCommand(request: StartCommandRequest): Promise<CommandProcess> {
			return streamingRpcRequest(
				streaming('StreamExec'),
				endpoint,
				() => transport.startCommand(request),
				sandboxAttributes(request.sandboxId),
				observeCommandProcess,
			);
		},
		streamLogs(request: StreamLogsRequest): Promise<LogEntryStream | LogRawStream | LogStream> {
			return streamingRpcRequest(
				streaming('StreamLogs'),
				endpoint,
				() => transport.streamLogs(request),
				sandboxAttributes(request.sandboxId),
				observeLogStream,
			);
		},
		stop(request: StopSandboxRequest): Promise<void> {
			return rpcRequest(
				gateway('Stop'),
				endpoint,
				() => transport.stop(request),
				sandboxAttributes(request.sandboxId),
			);
		},
		writeFile(request: WriteFileRequest): Promise<void> {
			return rpcRequest(
				gateway('AddFile'),
				endpoint,
				() => transport.writeFile(request),
				sandboxAttributes(request.sandboxId),
			);
		},
		readFile(request: ReadFileRequest): Promise<ReadFileResult> {
			return rpcRequest(
				gateway('RetrieveFile'),
				endpoint,
				() => transport.readFile(request),
				sandboxAttributes(request.sandboxId),
			);
		},
	};
}

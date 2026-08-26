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

async function rpcRequest<T>(
	method: string,
	endpoint: Attributes,
	request: () => Promise<T>,
	attributes: Attributes = {},
	onResult?: (span: Span, result: T) => void,
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
		async (span) => {
			try {
				const result = await request();
				onResult?.(span, result);
				return result;
			} catch (error) {
				span.recordException(error instanceof Error ? error : String(error));
				span.setAttribute('error.type', errorType(error));
				span.setStatus({ code: SpanStatusCode.ERROR });
				throw error;
			} finally {
				span.end();
			}
		},
	);
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
			return rpcRequest(
				streaming('StreamExec'),
				endpoint,
				() => transport.startCommand(request),
				sandboxAttributes(request.sandboxId),
			);
		},
		streamLogs(request: StreamLogsRequest): Promise<LogEntryStream | LogRawStream | LogStream> {
			return rpcRequest(
				streaming('StreamLogs'),
				endpoint,
				() => transport.streamLogs(request),
				sandboxAttributes(request.sandboxId),
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

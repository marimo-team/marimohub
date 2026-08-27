import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
	DataQueryExecution,
	DataQueryExecutorFactory,
	DataQueryResult,
	DuckDBHttpAccess,
	DuckDBPreviewProgram,
	DuckDBWasmRuntime,
	DuckDBWasmRuntimeFactory,
	Metrics,
	TablePreview,
} from '@marimo-hub/core';
import { DataQueryUserError, noopMetrics } from '@marimo-hub/core';
import { ICEBERG_HTTP_UNAVAILABLE } from './networkPolicy';
import { isHttpBridgeRequestMessage, rejectHttpBridge, resolveHttpBridge } from './httpBridge';
import type { HttpBridgeRequestMessage } from './httpBridge';
import { IcebergHttpBrokerError } from './icebergHttpBroker';
import type { IcebergHttpBrokerRequest, IcebergHttpBrokerResponse } from './icebergHttpBroker';
import { isRuntimeResponse } from './protocol';
import type { RuntimeRequestInput, RuntimeResponse } from './protocol';

export {
	IcebergHttpBroker,
	IcebergHttpBrokerError,
	type IcebergHttpBrokerCapability,
	type IcebergHttpBrokerErrorCode,
	type IcebergHttpBrokerMethod,
	type IcebergHttpBrokerRequest,
	type IcebergHttpBrokerObservedResponse,
	type IcebergHttpBrokerResponse,
	type IcebergHttpBrokerResponseObserver,
	type IcebergHttpBrokerRoute,
	type IcebergHttpBrokerRouteInstaller,
	type IcebergHttpBrokerTransport,
	type IcebergHttpBrokerTransportRequest,
} from './icebergHttpBroker';
export { HTTP_BRIDGE_BODY_BYTES } from './httpBridge';

export type DuckDBWasmRuntimeMode = 'auto' | 'worker' | 'inline';

export interface NodeDuckDBWasmCapabilities {
	features: DuckDBWasmRuntime['features'];
	unavailable: Readonly<Partial<Record<DuckDBWasmRuntime['features'][number], string>>>;
}

export interface DuckDBHttpSession {
	fetch(
		request: IcebergHttpBrokerRequest,
		signal?: AbortSignal,
	): Promise<IcebergHttpBrokerResponse>;
	close(): void;
}

export interface DuckDBHttpSessionOptions {
	expiresAtMs: number;
}

export type DuckDBHttpSessionFactory = (
	access: Readonly<DuckDBHttpAccess>,
	options: DuckDBHttpSessionOptions,
) => DuckDBHttpSession;

const CAPABILITIES: NodeDuckDBWasmCapabilities = Object.freeze({
	features: Object.freeze([]),
	unavailable: Object.freeze({
		'guarded-http': ICEBERG_HTTP_UNAVAILABLE,
		'iceberg-http': ICEBERG_HTTP_UNAVAILABLE,
		'vended-s3-routes': ICEBERG_HTTP_UNAVAILABLE,
	}),
});

const HTTP_CAPABILITIES: NodeDuckDBWasmCapabilities = Object.freeze({
	features: Object.freeze(['guarded-http', 'iceberg-http', 'vended-s3-routes'] as const),
	unavailable: Object.freeze({}),
});

export const DUCKDB_WORKER_RESOURCE_LIMITS = Object.freeze({
	maxOldGenerationSizeMb: 256,
	maxYoungGenerationSizeMb: 32,
	stackSizeMb: 4,
});

export function nodeDuckDBWasmCapabilities(): NodeDuckDBWasmCapabilities {
	return CAPABILITIES;
}

export function createNodeDuckDBWasmRuntimeFactory(
	mode: DuckDBWasmRuntimeMode = 'auto',
	httpSessionFactory?: DuckDBHttpSessionFactory,
	httpSessionTimeoutMs = 60_000,
	metrics: Metrics = noopMetrics,
): DuckDBWasmRuntimeFactory {
	return async () => {
		if (mode === 'inline') throw inlineRuntimeUnavailable();
		try {
			return new WorkerRuntime(httpSessionFactory, httpSessionTimeoutMs, metrics);
		} catch (error) {
			if (mode === 'worker' || !isStructuralWorkerError(error)) throw error;
			throw inlineRuntimeUnavailable();
		}
	};
}

export function createNodeDataQueryExecutorFactory(options: {
	memoryLimitMb: number;
	httpSessionFactory?: DuckDBHttpSessionFactory;
	metrics?: Metrics;
}): DataQueryExecutorFactory {
	return {
		async create(signal) {
			if (signal.aborted) throw abortError();
			const runtime = new WorkerRuntime(
				options.httpSessionFactory,
				60_000,
				options.metrics ?? noopMetrics,
			);
			const onAbort = () => {
				void runtime.close().catch(() => {});
			};
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				await runtime.initialize({ memoryLimitMb: options.memoryLimitMb });
				if (signal.aborted) throw abortError();
			} catch (error) {
				await runtime.close().catch(() => {});
				throw error;
			} finally {
				signal.removeEventListener('abort', onAbort);
			}
			return {
				runtime: 'worker',
				execute: (request: DataQueryExecution, executionSignal: AbortSignal) =>
					runtime.executeQuery(request, executionSignal),
				terminate: () => {
					void runtime.close().catch(() => {});
				},
			};
		},
	};
}

function inlineRuntimeUnavailable(): Error {
	return new Error(
		'DuckDB-Wasm inline execution is disabled because blocking queries cannot be preempted.',
	);
}

class WorkerRuntime implements DuckDBWasmRuntime {
	readonly mode = 'worker' as const;
	private readonly worker: Worker;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private nextId = 1;
	private closed = false;
	private httpReady = false;
	private activeHttpSession: DuckDBHttpSession | undefined;
	private activeHttpNonce: string | undefined;

	constructor(
		private readonly httpSessionFactory?: DuckDBHttpSessionFactory,
		private readonly httpSessionTimeoutMs = 60_000,
		private readonly metrics: Metrics = noopMetrics,
	) {
		this.worker = new Worker(resolveWorkerUrl(), {
			resourceLimits: DUCKDB_WORKER_RESOURCE_LIMITS,
		});
		this.worker.on('message', (message: unknown) => this.onMessage(message));
		this.worker.on('error', (error: Error) => this.fail(error));
		this.worker.on('exit', (code) => {
			if (!this.closed) this.fail(new Error(`DuckDB-Wasm worker exited with code ${code}.`));
		});
	}

	get features(): DuckDBWasmRuntime['features'] {
		return this.httpReady ? HTTP_CAPABILITIES.features : CAPABILITIES.features;
	}

	async initialize(options: { memoryLimitMb: number }): Promise<void> {
		await this.request({
			type: 'initialize',
			memoryLimitMb: options.memoryLimitMb,
			httpEnabled: this.httpSessionFactory !== undefined,
		});
		this.httpReady = this.httpSessionFactory !== undefined;
	}

	async execute(program: DuckDBPreviewProgram, signal?: AbortSignal): Promise<TablePreview> {
		assertSupported(program, this.features);
		const { httpAccess, ...workerProgram } = program;
		return this.withHttpAccess(httpAccess, signal, this.httpSessionTimeoutMs, (executionNonce) =>
			this.request({ type: 'execute', program: workerProgram, executionNonce }),
		);
	}

	async executeQuery(request: DataQueryExecution, signal: AbortSignal): Promise<DataQueryResult> {
		if (signal.aborted) throw abortError();
		const httpAccess = request.connection.plan?.httpAccess;
		let workerRequest = request;
		if (httpAccess && request.connection.plan) {
			const { httpAccess: _parentOnly, ...workerPlan } = request.connection.plan;
			workerRequest = {
				...request,
				connection: { ...request.connection, files: [], vars: {}, plan: workerPlan },
			};
		}
		return this.withHttpAccess(httpAccess, signal, request.limits.deadlineMs, (executionNonce) =>
			this.request<DataQueryResult>({
				type: 'execute-query',
				request: workerRequest,
				executionNonce,
			}),
		);
	}

	ping(): Promise<void> {
		return this.request({ type: 'ping' });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.httpReady = false;
		this.activeHttpSession?.close();
		this.activeHttpSession = undefined;
		this.activeHttpNonce = undefined;
		this.metrics.increment('duckdb_wasm.worker_termination', 1, { reason: 'requested' });
		try {
			await this.worker.terminate();
		} finally {
			this.rejectAll(new Error('DuckDB-Wasm worker is closed.'));
		}
	}

	private request<T>(request: RuntimeRequestInput): Promise<T> {
		if (this.closed) return Promise.reject(new Error('DuckDB-Wasm worker is closed.'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			try {
				this.worker.postMessage({ ...request, id });
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private onMessage(message: unknown): void {
		if (isHttpBridgeEnvelope(message)) {
			if (!isHttpBridgeRequestMessage(message)) {
				this.metrics.increment('duckdb_http_broker.bridge_failure', 1, {
					reason: 'invalid_message',
				});
				this.fail(new Error('DuckDB HTTP bridge message is invalid.'));
				return;
			}
			void this.onHttpRequest(message).catch((error) => this.fail(asError(error)));
			return;
		}
		if (!isRuntimeResponse(message)) {
			this.fail(new Error('DuckDB-Wasm worker response is invalid.'));
			return;
		}
		this.onResponse(message);
	}

	private onResponse(response: RuntimeResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (response.ok) pending.resolve(response.value);
		else if (response.kind === 'user-sql') pending.reject(new DataQueryUserError(response.error));
		else pending.reject(new Error(response.error));
	}

	private async onHttpRequest(message: HttpBridgeRequestMessage): Promise<void> {
		const session = this.activeHttpSession;
		if (!session || message.executionNonce !== this.activeHttpNonce) {
			const reason = session ? 'execution_mismatch' : 'no_active_session';
			this.metrics.increment('duckdb_http_broker.bridge_failure', 1, {
				reason,
			});
			rejectHttpBridge(message, 'DuckDB HTTP bridge execution capability is invalid.');
			this.fail(new Error('DuckDB HTTP bridge execution capability is invalid.'));
			return;
		}
		try {
			resolveHttpBridge(message, await session.fetch(message.request));
		} catch (error) {
			const code = error instanceof IcebergHttpBrokerError ? error.code : 'transport_failed';
			this.metrics.increment('duckdb_http_broker.bridge_failure', 1, { reason: code });
			try {
				const detail =
					error instanceof IcebergHttpBrokerError
						? error.message
						: 'The approved remote endpoint was not reachable. Make sure that DNS, TLS, and network access are available.';
				rejectHttpBridge(message, `DuckDB remote read failed [${code}]: ${detail}`);
			} catch (bridgeError) {
				this.fail(asError(bridgeError));
			}
		}
	}

	private async withHttpAccess<T>(
		access: Readonly<DuckDBHttpAccess> | undefined,
		signal: AbortSignal | undefined,
		deadlineMs: number,
		work: (executionNonce?: string) => Promise<T>,
	): Promise<T> {
		if (signal?.aborted) throw abortError();
		if (!access) return abortable(work(), signal);
		if (!this.httpSessionFactory) throw new Error(ICEBERG_HTTP_UNAVAILABLE);
		if (this.activeHttpSession) throw new Error('DuckDB HTTP broker session is already active.');
		if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
			throw new Error('DuckDB HTTP broker deadline is invalid.');
		}
		const session = this.httpSessionFactory(access, { expiresAtMs: Date.now() + deadlineMs });
		const executionNonce = randomUUID();
		this.activeHttpSession = session;
		this.activeHttpNonce = executionNonce;
		const onAbort = () => session.close();
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			return await abortable(work(executionNonce), signal);
		} finally {
			signal?.removeEventListener('abort', onAbort);
			session.close();
			if (this.activeHttpSession === session) {
				this.activeHttpSession = undefined;
				this.activeHttpNonce = undefined;
			}
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.httpReady = false;
		this.activeHttpSession?.close();
		this.activeHttpSession = undefined;
		this.activeHttpNonce = undefined;
		this.metrics.increment('duckdb_wasm.worker_termination', 1, { reason: 'failure' });
		this.rejectAll(error);
		try {
			void this.worker.terminate().catch(() => {});
		} catch {}
	}
}

function isHttpBridgeEnvelope(message: unknown): boolean {
	return (
		typeof message === 'object' &&
		message !== null &&
		'type' in message &&
		message.type === 'http-request'
	);
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error('DuckDB-Wasm worker failed.');
}

function abortError(): Error {
	return Object.assign(new Error('Data query cancelled.'), { name: 'AbortError' });
}

function assertSupported(
	program: DuckDBPreviewProgram,
	features: DuckDBWasmRuntime['features'],
): void {
	for (const feature of program.requires ?? []) {
		if (features.includes(feature)) continue;
		const reason = CAPABILITIES.unavailable[feature];
		throw new Error(
			`DuckDB-Wasm runtime does not support required feature ${feature}.${reason ? ` ${reason}` : ''}`,
		);
	}
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) throw abortError();
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => rejectAbort(abortError());
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

/**
 * The worker filename depends on who built us: the server bundle emits the
 * entry as duckdbWorker.mjs next to the main bundle; the package's own build
 * emits worker.mjs. Resolve by existence — sniffing import.meta.url for a repo
 * path fails in the Docker image, where the bundle lives at /app/dist and the
 * missing file otherwise only surfaces as an async worker "error" event.
 */
function resolveWorkerUrl(): URL {
	if (import.meta.url.endsWith('.ts')) return new URL('./worker.ts', import.meta.url);
	for (const candidate of ['./duckdbWorker.mjs', './worker.mjs']) {
		const url = new URL(candidate, import.meta.url);
		if (existsSync(fileURLToPath(url))) return url;
	}
	throw new Error('DuckDB-Wasm worker file not found next to the runtime module.');
}

function isStructuralWorkerError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'NotSupportedError' ||
			error.message.includes('worker_threads is not supported'))
	);
}

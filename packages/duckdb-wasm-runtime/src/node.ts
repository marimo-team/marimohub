import { Worker } from 'node:worker_threads';
import type {
	DataQueryExecution,
	DataQueryExecutorFactory,
	DataQueryResult,
	DuckDBPreviewProgram,
	DuckDBWasmRuntime,
	DuckDBWasmRuntimeFactory,
	TablePreview,
} from '@marimo-hub/core';
import { BlockingDuckDBEngine } from './engine';
import { ICEBERG_HTTP_UNAVAILABLE } from './networkPolicy';
import type { RuntimeRequestInput, RuntimeResponse } from './protocol';

export type DuckDBWasmRuntimeMode = 'auto' | 'worker' | 'inline';

export interface NodeDuckDBWasmCapabilities {
	features: DuckDBWasmRuntime['features'];
	unavailable: Readonly<Partial<Record<DuckDBWasmRuntime['features'][number], string>>>;
}

const CAPABILITIES: NodeDuckDBWasmCapabilities = Object.freeze({
	features: Object.freeze([]),
	unavailable: Object.freeze({ 'iceberg-http': ICEBERG_HTTP_UNAVAILABLE }),
});

export function nodeDuckDBWasmCapabilities(): NodeDuckDBWasmCapabilities {
	return CAPABILITIES;
}

export function createNodeDuckDBWasmRuntimeFactory(
	mode: DuckDBWasmRuntimeMode = 'auto',
): DuckDBWasmRuntimeFactory {
	return async () => {
		if (mode === 'inline') return new InlineRuntime();
		try {
			return new WorkerRuntime();
		} catch (error) {
			if (mode === 'worker' || !isStructuralWorkerError(error)) throw error;
			return new InlineRuntime();
		}
	};
}

export function createNodeDataQueryExecutorFactory(options: {
	memoryLimitMb: number;
}): DataQueryExecutorFactory {
	return {
		async create(signal) {
			if (signal.aborted)
				throw Object.assign(new Error('Data query cancelled.'), { name: 'AbortError' });
			const runtime = new WorkerRuntime();
			const onAbort = () => {
				void runtime.close().catch(() => {});
			};
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				await runtime.initialize({ memoryLimitMb: options.memoryLimitMb });
				if (signal.aborted) {
					throw Object.assign(new Error('Data query cancelled.'), { name: 'AbortError' });
				}
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
					void runtime.close();
				},
			};
		},
	};
}

class InlineRuntime implements DuckDBWasmRuntime {
	readonly mode = 'inline' as const;
	readonly features = CAPABILITIES.features;
	private readonly engine = new BlockingDuckDBEngine();

	initialize(options: { memoryLimitMb: number }): Promise<void> {
		return this.engine.initialize(options.memoryLimitMb);
	}

	async execute(program: DuckDBPreviewProgram): Promise<TablePreview> {
		assertSupported(program);
		return this.engine.execute(program);
	}

	async ping(): Promise<void> {
		this.engine.ping();
	}

	close(): Promise<void> {
		this.engine.close();
		return Promise.resolve();
	}
}

class WorkerRuntime implements DuckDBWasmRuntime {
	readonly mode = 'worker' as const;
	readonly features = CAPABILITIES.features;
	private readonly worker: Worker;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private nextId = 1;
	private closed = false;

	constructor() {
		const source = import.meta.url.endsWith('.ts')
			? './worker.ts'
			: import.meta.url.includes('/apps/server/dist/')
				? './duckdbWorker.mjs'
				: './worker.mjs';
		this.worker = new Worker(new URL(source, import.meta.url));
		this.worker.on('message', (response: RuntimeResponse) => this.onResponse(response));
		this.worker.on('error', (error: Error) => this.fail(error));
		this.worker.on('exit', (code) => {
			if (!this.closed) this.fail(new Error(`DuckDB-Wasm worker exited with code ${code}.`));
		});
	}

	initialize(options: { memoryLimitMb: number }): Promise<void> {
		return this.request({ type: 'initialize', memoryLimitMb: options.memoryLimitMb });
	}

	async execute(program: DuckDBPreviewProgram): Promise<TablePreview> {
		assertSupported(program);
		return this.request({ type: 'execute', program });
	}

	async executeQuery(request: DataQueryExecution, signal: AbortSignal): Promise<DataQueryResult> {
		if (signal.aborted)
			throw Object.assign(new Error('Data query cancelled.'), { name: 'AbortError' });
		const work = this.request<DataQueryResult>({ type: 'execute-query', request });
		let rejectAbort!: (error: Error) => void;
		const abort = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () =>
			rejectAbort(Object.assign(new Error('Data query cancelled.'), { name: 'AbortError' }));
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			return await Promise.race([work, abort]);
		} finally {
			signal.removeEventListener('abort', onAbort);
		}
	}

	ping(): Promise<void> {
		return this.request({ type: 'ping' });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
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

	private onResponse(response: RuntimeResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (response.ok) pending.resolve(response.value);
		else pending.reject(new Error(response.error));
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.rejectAll(error);
	}
}

function assertSupported(program: DuckDBPreviewProgram): void {
	for (const feature of program.requires ?? []) {
		if (CAPABILITIES.features.includes(feature)) continue;
		const reason = CAPABILITIES.unavailable[feature];
		throw new Error(
			`DuckDB-Wasm runtime does not support required feature ${feature}.${reason ? ` ${reason}` : ''}`,
		);
	}
}

function isStructuralWorkerError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'NotSupportedError' ||
			error.message.includes('worker_threads is not supported'))
	);
}

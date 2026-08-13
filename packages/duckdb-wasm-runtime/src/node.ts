import { Worker } from 'node:worker_threads';
import type {
	DuckDBPreviewProgram,
	DuckDBWasmRuntime,
	DuckDBWasmRuntimeFactory,
	TablePreview,
} from '@marimo-hub/core';
import { BlockingDuckDBEngine } from './engine';
import type { RuntimeRequestInput, RuntimeResponse } from './protocol';

export type DuckDBWasmRuntimeMode = 'auto' | 'worker' | 'inline';

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

class InlineRuntime implements DuckDBWasmRuntime {
	readonly mode = 'inline' as const;
	readonly features = [];
	private readonly engine = new BlockingDuckDBEngine();

	initialize(options: { memoryLimitMb: number }): Promise<void> {
		return this.engine.initialize(options.memoryLimitMb);
	}

	async execute(program: DuckDBPreviewProgram): Promise<TablePreview> {
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
	readonly features = [];
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

	execute(program: DuckDBPreviewProgram): Promise<TablePreview> {
		return this.request({ type: 'execute', program });
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

function isStructuralWorkerError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'NotSupportedError' ||
			error.message.includes('worker_threads is not supported'))
	);
}

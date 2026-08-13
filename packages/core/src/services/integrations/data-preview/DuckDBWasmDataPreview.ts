import { UnavailableError } from '../../../errors';
import { withDeadline } from '../../../internal/async';
import { assertPositiveInteger } from '../../../internal/validation';
import type { TablePreview } from '../../../ports/integrations';
import type {
	DuckDBPreviewProgram,
	DuckDBWasmRuntime,
	DuckDBWasmRuntimeFactory,
	PreviewExecutorStatus,
	PreviewRuntimeFeature,
} from './programs';

export interface DuckDBWasmDataPreviewOptions {
	memoryLimitMb: number;
	startupTimeoutMs: number;
	executionTimeoutMs: number;
}

export class DuckDBWasmDataPreview {
	private runtime: DuckDBWasmRuntime | undefined;
	private checking: Promise<void> | undefined;
	private previewQueue = Promise.resolve();
	private closing: Promise<void> | undefined;
	private readyForTraffic = false;
	private closed = false;

	constructor(
		private readonly runtimeFactory: DuckDBWasmRuntimeFactory,
		private readonly options: DuckDBWasmDataPreviewOptions,
	) {
		assertPositiveInteger('memoryLimitMb', options.memoryLimitMb);
		assertPositiveInteger('startupTimeoutMs', options.startupTimeoutMs);
		assertPositiveInteger('executionTimeoutMs', options.executionTimeoutMs);
	}

	available(): boolean {
		return this.readyForTraffic && !this.closed;
	}

	status(): PreviewExecutorStatus {
		return {
			available: this.available(),
			...(this.runtime ? { runtime: this.runtime.mode, features: this.runtime.features } : {}),
		};
	}

	supportsFeatures(features: readonly PreviewRuntimeFeature[]): boolean {
		if (!this.available() || !this.runtime) return false;
		const runtime = this.runtime;
		return features.every((feature) => runtime.features.includes(feature));
	}

	supports(program: DuckDBPreviewProgram): boolean {
		return this.supportsFeatures(program.requires ?? []);
	}

	check(): Promise<void> {
		if (this.available()) return Promise.resolve();
		if (this.closed) return Promise.reject(new UnavailableError('DuckDB-Wasm is closed.'));
		if (this.checking) return this.checking;
		this.checking = this.initialize().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	preview(program: DuckDBPreviewProgram): Promise<TablePreview> {
		const result = this.previewQueue.then(() => this.executePreview(program));
		this.previewQueue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.readyForTraffic = false;
		this.closing = this.closeAfterPreviews();
		return this.closing;
	}

	private async executePreview(program: DuckDBPreviewProgram): Promise<TablePreview> {
		if (!this.supports(program) || !this.runtime) {
			throw new UnavailableError('DuckDB-Wasm cannot execute this preview program.');
		}
		const runtime = this.runtime;
		try {
			return await withDeadline(runtime.execute(program), {
				timeoutMs: this.options.executionTimeoutMs,
				timeoutError: () => new UnavailableError('DuckDB-Wasm preview timed out.'),
			});
		} catch {
			await this.poison();
			throw new UnavailableError('DuckDB-Wasm could not preview this table.');
		}
	}

	private async closeAfterPreviews(): Promise<void> {
		await this.previewQueue;
		const runtime = this.runtime;
		this.runtime = undefined;
		await runtime?.close();
	}

	private async initialize(): Promise<void> {
		let runtime: DuckDBWasmRuntime | undefined;
		let abandoned = false;
		let disposed = false;
		const dispose = async (): Promise<void> => {
			if (!runtime || disposed) return;
			disposed = true;
			await runtime.close().catch(() => {});
		};
		const ensureNotAbandoned = async (): Promise<void> => {
			if (!abandoned) return;
			await dispose();
			throw new UnavailableError('DuckDB-Wasm initialization was abandoned.');
		};
		const startup = (async (): Promise<DuckDBWasmRuntime> => {
			runtime = await this.runtimeFactory();
			await ensureNotAbandoned();
			await runtime.initialize({ memoryLimitMb: this.options.memoryLimitMb });
			await ensureNotAbandoned();
			await runtime.ping();
			await ensureNotAbandoned();
			return runtime;
		})();
		try {
			const initialized = await withDeadline(startup, {
				timeoutMs: this.options.startupTimeoutMs,
				timeoutError: () => new UnavailableError('DuckDB-Wasm initialization timed out.'),
			});
			if (this.closed) {
				await dispose();
				throw new UnavailableError('DuckDB-Wasm was closed during initialization.');
			}
			this.runtime = initialized;
			this.readyForTraffic = true;
		} catch (error) {
			abandoned = true;
			await dispose();
			throw error;
		}
	}

	private async poison(): Promise<void> {
		this.readyForTraffic = false;
		const runtime = this.runtime;
		this.runtime = undefined;
		await runtime?.close().catch(() => {});
	}
}

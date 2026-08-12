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

	async preview(program: DuckDBPreviewProgram): Promise<TablePreview> {
		if (!this.supports(program) || !this.runtime) {
			throw new UnavailableError('DuckDB-Wasm cannot execute this preview program.');
		}
		try {
			return await withDeadline(this.runtime.execute(program), {
				timeoutMs: this.options.executionTimeoutMs,
				timeoutError: () => new UnavailableError('DuckDB-Wasm preview timed out.'),
			});
		} catch {
			await this.poison();
			throw new UnavailableError('DuckDB-Wasm could not preview this table.');
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.readyForTraffic = false;
		const runtime = this.runtime;
		this.runtime = undefined;
		await runtime?.close();
	}

	private async initialize(): Promise<void> {
		const runtime = await this.runtimeFactory();
		try {
			await withDeadline(
				(async () => {
					await runtime.initialize({ memoryLimitMb: this.options.memoryLimitMb });
					await runtime.ping();
				})(),
				{
					timeoutMs: this.options.startupTimeoutMs,
					timeoutError: () => new UnavailableError('DuckDB-Wasm initialization timed out.'),
				},
			);
			if (this.closed) {
				await runtime.close();
				throw new UnavailableError('DuckDB-Wasm was closed during initialization.');
			}
			this.runtime = runtime;
			this.readyForTraffic = true;
		} catch (error) {
			await runtime.close().catch(() => {});
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

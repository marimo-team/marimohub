import { ResourceExhaustedError, UnavailableError, ValidationError } from '../../../errors';
import { InFlightWork, KeyedAdmission } from '../../../concurrency';
import type { UserId } from '../../../ids';
import type { TablePreview } from '../../../ports/integrations';
import type { DuckDBWasmDataPreview } from './DuckDBWasmDataPreview';
import type { SandboxDataPreview } from './SandboxDataPreview';
import type {
	PreviewExecutorStatus,
	PreviewProgramAvailability,
	PreviewPrograms,
} from './programs';

export interface DataPreviewServiceOptions {
	duckdbWasm?: Pick<
		DuckDBWasmDataPreview,
		'available' | 'supports' | 'supportsFeatures' | 'status' | 'check' | 'preview' | 'close'
	>;
	sandbox?: Pick<SandboxDataPreview, 'available' | 'check' | 'preview' | 'close'>;
	maxConcurrent: number;
	maxConcurrentPerUser: number;
}

export class DataPreviewService {
	private readonly admission: KeyedAdmission<UserId>;
	private readonly inFlight = new InFlightWork();
	private closed = false;

	constructor(private readonly options: DataPreviewServiceOptions) {
		this.admission = new KeyedAdmission(options.maxConcurrent, options.maxConcurrentPerUser, {
			global: () =>
				new ResourceExhaustedError('The deployment data-preview limit is currently full.'),
			perKey: () => new ResourceExhaustedError('A data preview is already running for this user.'),
		});
	}

	available(programs: PreviewProgramAvailability): boolean {
		return (
			(programs.duckdbWasm !== undefined &&
				this.options.duckdbWasm?.supportsFeatures(programs.duckdbWasm) === true) ||
			(programs.python === true && this.options.sandbox?.available() === true)
		);
	}

	status(): PreviewExecutorStatus[] {
		return [
			...(this.options.duckdbWasm ? [this.options.duckdbWasm.status()] : []),
			...(this.options.sandbox
				? [{ available: this.options.sandbox.available(), runtime: 'sandbox' as const }]
				: []),
		];
	}

	async check(): Promise<void> {
		const executors = [this.options.duckdbWasm, this.options.sandbox].filter(
			(executor) => executor !== undefined,
		);
		if (executors.length === 0) return;
		const results = await Promise.allSettled(executors.map((executor) => executor.check()));
		if (results.every((result) => result.status === 'rejected')) {
			throw new UnavailableError('No data-preview runtime is available.');
		}
	}

	async preview(userId: UserId, programs: PreviewPrograms): Promise<TablePreview> {
		if (this.closed) throw new UnavailableError('The data-preview service is closed.');
		return this.inFlight.track(
			this.admission.run(userId, () => this.executeAvailableProgram(programs)),
		);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.inFlight.drain();
		await Promise.allSettled([this.options.duckdbWasm?.close(), this.options.sandbox?.close()]);
	}

	private async executeAvailableProgram(programs: PreviewPrograms): Promise<TablePreview> {
		if (programs.duckdbWasm && this.options.duckdbWasm?.supports(programs.duckdbWasm)) {
			return this.options.duckdbWasm.preview(programs.duckdbWasm);
		}
		if (programs.python && this.options.sandbox?.available()) {
			return this.options.sandbox.preview(programs.python);
		}
		throw new ValidationError('This integration does not support row preview on this deployment.');
	}
}

import { UnavailableError } from '../../../errors';
import { createSandboxId } from '../../../ids';
import { withDeadline } from '../../../internal/async';
import { assertPositiveInteger } from '../../../internal/validation';
import { logOperationalError } from '../../../operationalLog';
import type { TablePreview } from '../../../ports/integrations';
import type { SandboxInstance, SandboxProvider } from '../../../ports/sandbox';
import { bundleIntegrations } from '../bundle';
import type { PythonPreviewProgram } from './programs';
import { parseTablePreviewJson } from './previewResult';

const SCRIPT_PATH = '/tmp/marimohub-data-preview.py';
const REQUEST_PATH = '/tmp/marimohub-data-preview-request.json';
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const PREFLIGHT_COMMAND = `python3 -c 'import pyarrow, pyiceberg'`;

export interface SandboxDataPreviewOptions {
	image: string;
	startupTimeoutMs: number;
	executionTimeoutMs: number;
	destroyTimeoutMs?: number;
}

export class SandboxDataPreview {
	private readyForTraffic = false;
	private checking: Promise<void> | undefined;
	private closed = false;

	constructor(
		private readonly compute: SandboxProvider,
		private readonly options: SandboxDataPreviewOptions,
	) {
		for (const [name, value] of [
			['startupTimeoutMs', options.startupTimeoutMs],
			['executionTimeoutMs', options.executionTimeoutMs],
		] as const) {
			assertPositiveInteger(name, value);
		}
	}

	available(): boolean {
		return this.readyForTraffic && !this.closed;
	}

	check(): Promise<void> {
		if (this.available()) return Promise.resolve();
		if (this.closed) return Promise.reject(new UnavailableError('The preview sandbox is closed.'));
		if (this.checking) return this.checking;
		this.checking = this.checkRuntime().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	async preview(program: PythonPreviewProgram): Promise<TablePreview> {
		if (!this.available()) throw new UnavailableError('The data-preview runtime is unavailable.');
		const sandbox = this.createSandbox();
		try {
			await sandboxDeadline(ready(sandbox), this.options.startupTimeoutMs, 'start');
			const bundle = bundleIntegrations(
				[
					{
						...program.integration,
						output: program.render,
					},
				],
				program.sessionId,
			);
			await sandboxDeadline(
				Promise.all([
					sandbox.writeFiles([
						...bundle.files,
						{ path: SCRIPT_PATH, content: program.script },
						{ path: REQUEST_PATH, content: JSON.stringify(program.input) },
					]),
					sandbox.setEnvVars({ ...bundle.vars, ...program.credentialVars }),
				]),
				this.options.startupTimeoutMs,
				'prepare',
			);
			const result = await sandboxDeadline(
				sandbox.exec(`python3 ${SCRIPT_PATH}`),
				this.options.executionTimeoutMs,
				'finish',
			);
			if (
				!result.success ||
				new TextEncoder().encode(result.stdout).byteLength > MAX_STDOUT_BYTES
			) {
				throw new UnavailableError('The preview sandbox could not read this table.');
			}
			return parseTablePreviewJson(result.stdout, program.maxRows);
		} finally {
			await this.destroy(sandbox);
		}
	}

	close(): Promise<void> {
		this.closed = true;
		this.readyForTraffic = false;
		return Promise.resolve();
	}

	private async checkRuntime(): Promise<void> {
		const sandbox = this.createSandbox();
		try {
			await sandboxDeadline(ready(sandbox), this.options.startupTimeoutMs, 'start');
			const result = await sandboxDeadline(
				sandbox.exec(PREFLIGHT_COMMAND),
				this.options.executionTimeoutMs,
				'verify its runtime',
			);
			if (!result.success) {
				throw new UnavailableError('The preview image does not provide PyIceberg and PyArrow.');
			}
			this.readyForTraffic = true;
		} finally {
			await this.destroy(sandbox);
		}
	}

	private createSandbox(): SandboxInstance {
		return this.compute.create(createSandboxId(), { reuse: false, image: this.options.image });
	}

	private async destroy(sandbox: SandboxInstance): Promise<void> {
		try {
			await sandboxDeadline(
				sandbox.destroy(),
				this.options.destroyTimeoutMs ?? this.options.executionTimeoutMs,
				'destroy',
			);
		} catch (error) {
			logOperationalError('data_preview_sandbox_destroy_failed', {}, error);
		}
	}
}

async function ready(sandbox: SandboxInstance): Promise<void> {
	if (sandbox.ready) return sandbox.ready();
	const result = await sandbox.exec('true');
	if (!result.success) throw new UnavailableError('The preview sandbox could not start.');
}

function sandboxDeadline<T>(work: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
	return withDeadline(work, {
		timeoutMs,
		timeoutError: () => new UnavailableError(`The preview sandbox did not ${phase} in time.`),
	});
}

import { UnavailableError } from '../../../errors';
import { createSandboxId } from '../../../ids';
import { withDeadline } from '../../../internal/async';
import { assertPositiveIntegers } from '../../../internal/validation';
import { logOperationalError } from '../../../operationalLog';
import type { TablePreview } from '../../../ports/integrations';
import type { SandboxInstance, SandboxProvider } from '../../../ports/sandbox';
import { bundleIntegrations } from '../bundle';
import type { PythonPreviewProgram } from './programs';
import { parseTablePreviewJson } from './previewResult';
import { DrainableService } from '../DrainableService';
import { utf8Tail } from '../../../text';

const SCRIPT_PATH = '/tmp/marimohub-data-preview.py';
const REQUEST_PATH = '/tmp/marimohub-data-preview-request.json';
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export interface SandboxDataPreviewOptions {
	image: string;
	startupTimeoutMs: number;
	executionTimeoutMs: number;
	destroyTimeoutMs?: number;
}

export class SandboxDataPreview extends DrainableService {
	constructor(
		private readonly compute: SandboxProvider,
		private readonly options: SandboxDataPreviewOptions,
	) {
		super();
		assertPositiveIntegers({
			startupTimeoutMs: options.startupTimeoutMs,
			executionTimeoutMs: options.executionTimeoutMs,
		});
	}

	available(): boolean {
		return !this.closed;
	}

	async preview(program: PythonPreviewProgram): Promise<TablePreview> {
		if (!this.available()) throw new UnavailableError('The data-preview runtime is unavailable.');
		return this.track(this.runPreview(program));
	}

	close(): Promise<void> {
		return this.closeOnce(() => this.inFlight.drain());
	}

	private async runPreview(program: PythonPreviewProgram): Promise<TablePreview> {
		const credentialVars = await withDeadline(resolveCredentialVars(program), {
			timeoutMs: this.options.executionTimeoutMs,
			timeoutError: () => new UnavailableError('The preview credentials did not resolve in time.'),
		});
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
				{ kind: 'session', id: program.sessionId },
			);
			await sandboxDeadline(
				Promise.all([
					sandbox.writeFiles([
						...bundle.files,
						{ path: SCRIPT_PATH, content: program.script },
						{ path: REQUEST_PATH, content: JSON.stringify(program.input) },
					]),
					sandbox.setEnvVars({ ...bundle.vars, ...credentialVars }),
				]),
				this.options.startupTimeoutMs,
				'prepare',
			);
			const result = await sandboxDeadline(
				sandbox.exec(`python3 ${SCRIPT_PATH}`),
				this.options.executionTimeoutMs,
				'finish',
			);
			if (!result.success) throw previewExecutionError(result.stderr);
			if (new TextEncoder().encode(result.stdout).byteLength > MAX_STDOUT_BYTES) {
				throw new UnavailableError('The preview sandbox could not read this table.');
			}
			return parseTablePreviewJson(result.stdout, program.maxRows);
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

function previewExecutionError(stderr: string): UnavailableError {
	// Tracebacks can contain credentials. Expose only import names, never arbitrary stderr.
	const importError = utf8Tail(stderr, 4096).match(
		/^(?:ModuleNotFoundError|ImportError): (?:No module named ['"][a-zA-Z_][\w.]*['"]|cannot import name ['"][a-zA-Z_]\w*['"] from ['"][a-zA-Z_][\w.]*['"])/m,
	);
	return new UnavailableError(
		importError
			? `The preview image has incompatible Python dependencies (${importError[0]}). Check MARIMOHUB_DATA_PREVIEW_IMAGE.`
			: 'The preview sandbox could not read this table.',
	);
}

async function resolveCredentialVars(
	program: PythonPreviewProgram,
): Promise<Record<string, string> | undefined> {
	return typeof program.credentialVars === 'function'
		? program.credentialVars()
		: program.credentialVars;
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

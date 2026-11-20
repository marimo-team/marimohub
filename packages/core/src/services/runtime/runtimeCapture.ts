import { CaptureTelemetry } from '../../internal/captureTelemetry';
import { z } from 'zod';
import { NotFoundError } from '../../errors';
import type { SandboxId } from '../../ids';
import type { SandboxInstance } from '../../ports/sandbox';
import { notebookBridgePaths } from './notebookBridgePaths';
import { shellQuote } from './shell';

export interface RuntimeCheckpoint {
	token: string;
	directory: string;
}

// Only the provider can confirm runtime absence.
export class RuntimeMissingError extends NotFoundError {
	override readonly name = 'RuntimeMissingError';
}

export class RuntimeCaptureError extends Error {
	constructor(
		readonly code: string,
		readonly runtimeState: 'running' | 'unknown' = 'unknown',
	) {
		super(code);
		this.name = 'RuntimeCaptureError';
	}
}

const replySchema = z.object({
	ok: z.boolean(),
	code: z.string().optional(),
	state: z.string().optional(),
	token: z.uuid().optional(),
	generation: z.number().int().nonnegative().optional(),
	checkpoint: z.string().optional(),
	supported: z.boolean().optional(),
});

export class RuntimeCaptureClient {
	private readonly bridgeDirectory: string;

	constructor(
		private readonly sandbox: SandboxInstance,
		sandboxId: SandboxId,
		private readonly telemetry = new CaptureTelemetry(),
	) {
		this.bridgeDirectory = notebookBridgePaths(sandboxId, 'marimo-bridge.py').directory;
	}

	private async transport<T>(
		transport: 'native' | 'exec',
		operation: () => Promise<T>,
	): Promise<T> {
		this.telemetry.histogram('transport_operations', 1, { transport });
		return this.telemetry.time(`transport_${transport}`, async () => {
			try {
				return await operation();
			} catch (cause) {
				if (cause instanceof NotFoundError) throw new RuntimeMissingError(cause.message);
				throw cause;
			}
		});
	}

	private request(request: Record<string, unknown> & { action: string }) {
		return this.telemetry.time(`runtime_${request.action}`, () => this.send(request));
	}

	private async send(request: Record<string, unknown>) {
		let stdout: string | undefined;
		if (this.sandbox.requestLifecycle) {
			stdout = await this.transport('native', () =>
				this.sandbox.requestLifecycle!(`${this.bridgeDirectory}/lifecycle`, request),
			);
		}
		if (stdout === undefined) {
			const path = `${this.bridgeDirectory}/lifecycle_client.py`;
			const client = this.sandbox.resolveProcessPath?.(path) ?? path;
			const result = await this.transport('exec', () =>
				this.sandbox.exec(`python3 ${shellQuote(client)} ${shellQuote(JSON.stringify(request))}`, {
					timeout: 60_000,
					maxOutputBytes: 1024 * 1024,
				}),
			);
			if (!result.success) throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
			stdout = result.stdout;
		}
		let reply;
		try {
			reply = replySchema.parse(JSON.parse(stdout));
		} catch {
			throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
		}
		if (!reply.ok)
			throw new RuntimeCaptureError(
				reply.code ?? 'CAPTURE_UNAVAILABLE',
				reply.state === 'running' ? 'running' : 'unknown',
			);
		return reply;
	}

	async prepare(workdir: string, entry: string): Promise<RuntimeCheckpoint> {
		const status = await this.request({ action: 'status' });
		if (status.supported === false)
			throw new RuntimeCaptureError(
				'CAPTURE_RUNTIME_UNSUPPORTED',
				status.state === 'running' ? 'running' : 'unknown',
			);
		const token = crypto.randomUUID();
		// Sandbox file APIs use sandbox paths, whereas the local adapter remaps process paths.
		const directory = `${this.bridgeDirectory}/lifecycle/captures/${token}`;
		try {
			const reply = await this.request({
				action: 'prepare',
				token,
				generation: status.generation,
				workdir: this.sandbox.resolveProcessPath?.(workdir) ?? workdir,
				entry,
			});
			if (reply.state !== 'paused' || reply.token !== token || !reply.checkpoint)
				throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
			return { token, directory };
		} catch (cause) {
			if (cause instanceof RuntimeMissingError) throw cause;
			const resumed = await this.resume({ token, directory }).then(
				() => true,
				(error: unknown) => {
					if (error instanceof RuntimeMissingError) throw error;
					return false;
				},
			);
			throw new RuntimeCaptureError(
				cause instanceof RuntimeCaptureError ? cause.code : 'CAPTURE_UNAVAILABLE',
				resumed ? 'running' : 'unknown',
			);
		}
	}

	status() {
		return this.request({ action: 'status' });
	}

	async resume(checkpoint: RuntimeCheckpoint): Promise<void> {
		try {
			const reply = await this.request({ action: 'abort', token: checkpoint.token });
			if (reply.state !== 'running') throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
		} catch (cause) {
			if (cause instanceof RuntimeMissingError) throw cause;
			if ((await this.status()).state !== 'running') throw cause;
		}
	}

	async commitStop(checkpoint: RuntimeCheckpoint): Promise<void> {
		const reply = await this.request({ action: 'commit-stop', token: checkpoint.token });
		if (reply.state !== 'stopped' || reply.token !== checkpoint.token)
			throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
	}
}

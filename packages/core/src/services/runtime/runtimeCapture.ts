import { z } from 'zod';
import type { SandboxId } from '../../ids';
import type { SandboxInstance } from '../../ports/sandbox';
import { notebookBridgePaths } from './notebookBridgePaths';
import { shellQuote } from './shell';

export interface RuntimeCheckpoint {
	token: string;
	directory: string;
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
	constructor(
		private readonly sandbox: SandboxInstance,
		private readonly sandboxId: SandboxId,
	) {}

	private async request(request: Record<string, unknown>) {
		const path = `${notebookBridgePaths(this.sandboxId, 'marimo-bridge.py').directory}/lifecycle_client.py`;
		const client = this.sandbox.resolveProcessPath?.(path) ?? path;
		const result = await this.sandbox.exec(
			`python ${shellQuote(client)} ${shellQuote(JSON.stringify(request))}`,
			{ timeout: 60_000 },
		);
		if (!result.success) throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
		let reply;
		try {
			reply = replySchema.parse(JSON.parse(result.stdout));
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
		const directory = `${notebookBridgePaths(this.sandboxId, 'marimo-bridge.py').directory}/lifecycle/captures/${token}`;
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
			const resumed = await this.resume({ token, directory }).then(
				() => true,
				() => false,
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
			if ((await this.status()).state !== 'running') throw cause;
		}
	}

	async commitStop(checkpoint: RuntimeCheckpoint): Promise<void> {
		const reply = await this.request({ action: 'commit-stop', token: checkpoint.token });
		if (reply.state !== 'stopped' || reply.token !== checkpoint.token)
			throw new RuntimeCaptureError('CAPTURE_UNAVAILABLE');
	}
}

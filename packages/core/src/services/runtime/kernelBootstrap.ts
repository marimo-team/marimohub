import { z } from 'zod';
import { withDeadline } from '../../async';
import { MARIMO_PORT } from '../../constants';
import { sleep } from '../../duration';
import type { SandboxInstance } from '../../ports/sandbox';
import { kernelBootstrapCommand } from './kernelBootstrap/command';
import { notebookBridgePaths } from './notebookBridgePaths';

const DiagnosticCount = z.number().int().nonnegative().max(1_000_000).optional().catch(undefined);

const BootstrapDiagnostics = z.object({
	stage: z
		.enum([
			'discovery',
			'client',
			'lock',
			'sessions',
			'configure',
			'websocket',
			'instantiate',
			'kernel_status',
			'exec',
		])
		.optional()
		.catch(undefined),
	reason: z
		.enum([
			'runtime_not_found',
			'missing_dependency',
			'incompatible_runtime',
			'http_error',
			'connection_error',
			'timeout',
			'client_exit',
			'invalid_output',
			'launcher_error',
			'client_error',
			'exec_failed',
		])
		.optional()
		.catch(undefined),
	runtime_kind: z.enum(['marimo', 'bridge']).optional().catch(undefined),
	authenticated: z.boolean().optional().catch(undefined),
	http_status: z.number().int().min(100).max(599).optional().catch(undefined),
	processes_scanned: DiagnosticCount,
	port_matches: DiagnosticCount,
});

const BootstrapResult = z.object({
	status: z.enum(['ready', 'initializing', 'awaiting_client', 'unavailable']),
	// Sandbox output must never introduce free-form text into telemetry.
	diagnostics: BootstrapDiagnostics.optional().catch(undefined),
});
export type KernelBootstrapResult = z.infer<typeof BootstrapResult>;

interface BootstrapOptions {
	timeoutMs: number;
	inspectOnly?: boolean;
	signal?: AbortSignal;
	sandboxId?: string;
}

// Leave time for another probe when a startup attempt stalls.
const PROBE_TIMEOUT_MS = 2_000;
const RETRY_PAUSE_MS = 500;

class BootstrapTimeoutError extends Error {
	constructor() {
		super('Kernel bootstrap timed out');
		this.name = 'BootstrapTimeoutError';
	}
}

function execFailure(reason: 'exec_failed' | 'invalid_output' | 'timeout'): KernelBootstrapResult {
	return {
		status: reason === 'timeout' ? 'initializing' : 'unavailable',
		diagnostics: { stage: 'exec', reason },
	};
}

function parseBootstrapResult(stdout: string): KernelBootstrapResult {
	try {
		return BootstrapResult.parse(JSON.parse(stdout));
	} catch {
		return execFailure('invalid_output');
	}
}

async function bootstrapOnce(
	sandbox: SandboxInstance,
	options: BootstrapOptions,
): Promise<KernelBootstrapResult> {
	try {
		const kernelUrl = `http://127.0.0.1:${MARIMO_PORT}`;
		const processUrl = new URL(sandbox.resolveProcessUrl?.(kernelUrl) ?? kernelUrl);
		const mappedPort = Number(processUrl.port || (processUrl.protocol === 'https:' ? 443 : 80));
		const port =
			Number.isInteger(mappedPort) && mappedPort > 0 && mappedPort <= 65535
				? mappedPort
				: MARIMO_PORT;
		const bridgePath = options.sandboxId
			? notebookBridgePaths(options.sandboxId).launcher
			: undefined;
		const bridgeLauncher = bridgePath
			? (sandbox.resolveProcessPath?.(bridgePath) ?? bridgePath)
			: undefined;
		const executed = await withDeadline(
			() =>
				sandbox.exec(
					kernelBootstrapCommand(
						Math.max(1, options.timeoutMs - Math.min(250, options.timeoutMs / 10)),
						options.inspectOnly,
						port,
						bridgeLauncher,
					),
					{
						// The request deadline must win over adapter process termination.
						timeout: options.timeoutMs + 1_000,
					},
				),
			{
				timeoutMs: options.timeoutMs,
				timeoutError: () => new BootstrapTimeoutError(),
				signal: options.signal,
			},
		);
		return executed.success ? parseBootstrapResult(executed.stdout) : execFailure('exec_failed');
	} catch (error) {
		if (error instanceof BootstrapTimeoutError) return execFailure('timeout');
		if (options.signal?.aborted) throw options.signal.reason;
		return execFailure('exec_failed');
	}
}

export async function bootstrapKernel(
	sandbox: SandboxInstance,
	options: BootstrapOptions,
): Promise<KernelBootstrapResult> {
	options.signal?.throwIfAborted();
	if (options.timeoutMs <= 0) return { status: 'initializing' };
	const deadline = Date.now() + options.timeoutMs;
	let budget = options.timeoutMs;
	let result: KernelBootstrapResult = { status: 'initializing' };
	while (budget > 0) {
		result = await bootstrapOnce(sandbox, {
			timeoutMs: options.inspectOnly ? budget : Math.min(PROBE_TIMEOUT_MS, budget),
			inspectOnly: options.inspectOnly,
			signal: options.signal,
			sandboxId: options.sandboxId,
		});
		if (options.inspectOnly || result.status !== 'initializing') return result;
		const pause = Math.min(RETRY_PAUSE_MS, deadline - Date.now());
		if (pause <= 0) break;
		await sleep(pause, options.signal);
		budget = deadline - Date.now();
	}
	return result;
}

import { z } from 'zod';
import { withDeadline } from '../../async';
import { sleep } from '../../duration';
import type { SandboxInstance } from '../../ports/sandbox';
import { kernelBootstrapCommand } from './kernelBootstrap/command';

const BootstrapResult = z.object({
	status: z.enum(['ready', 'initializing', 'awaiting_client', 'unavailable']),
});
export type KernelBootstrapResult = z.infer<typeof BootstrapResult>;

// Leave time for another probe when a startup attempt stalls.
const PROBE_TIMEOUT_MS = 2_000;
const RETRY_PAUSE_MS = 500;

class BootstrapTimeoutError extends Error {
	constructor() {
		super('Kernel bootstrap timed out');
		this.name = 'BootstrapTimeoutError';
	}
}

async function bootstrapOnce(
	sandbox: SandboxInstance,
	options: { timeoutMs: number; inspectOnly?: boolean; signal?: AbortSignal },
): Promise<KernelBootstrapResult> {
	try {
		const executed = await withDeadline(
			() =>
				sandbox.exec(
					kernelBootstrapCommand(
						Math.max(1, options.timeoutMs - Math.min(250, options.timeoutMs / 10)),
						options.inspectOnly,
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
		if (!executed.success) return { status: 'unavailable' };
		const parsed = BootstrapResult.safeParse(JSON.parse(executed.stdout));
		return parsed.success ? parsed.data : { status: 'unavailable' };
	} catch (error) {
		if (error instanceof BootstrapTimeoutError) return { status: 'initializing' };
		if (options.signal?.aborted) throw options.signal.reason;
		return { status: 'unavailable' };
	}
}

export async function bootstrapKernel(
	sandbox: SandboxInstance,
	options: { timeoutMs: number; inspectOnly?: boolean; signal?: AbortSignal },
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
		});
		if (options.inspectOnly || result.status !== 'initializing') return result;
		const pause = Math.min(RETRY_PAUSE_MS, deadline - Date.now());
		if (pause <= 0) break;
		await sleep(pause, options.signal);
		budget = deadline - Date.now();
	}
	return result;
}

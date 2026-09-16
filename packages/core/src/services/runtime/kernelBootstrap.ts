import { z } from 'zod';
import { withDeadline } from '../../async';
import type { SandboxInstance } from '../../ports/sandbox';
import { kernelBootstrapCommand } from './kernelBootstrap/command';

const BootstrapResult = z.object({
	status: z.enum(['ready', 'initializing', 'awaiting_client', 'unavailable']),
});
export type KernelBootstrapResult = z.infer<typeof BootstrapResult>;

class BootstrapTimeoutError extends Error {
	constructor() {
		super('Kernel bootstrap timed out');
		this.name = 'BootstrapTimeoutError';
	}
}

export async function bootstrapKernel(
	sandbox: SandboxInstance,
	options: { timeoutMs: number; inspectOnly?: boolean; signal?: AbortSignal },
): Promise<KernelBootstrapResult> {
	if (options.timeoutMs <= 0) return { status: 'initializing' };
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

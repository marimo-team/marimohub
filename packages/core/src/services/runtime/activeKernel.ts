import { withDeadline } from '../../async';
import { executeInKernel, KernelHttpError, listKernelSessions } from './kernelExecute';
import type { KernelExecuteResult, KernelRequestOptions } from './kernelExecute';

export class KernelDiscoveryTimeoutError extends Error {
	constructor() {
		super('Kernel session discovery timed out');
		this.name = 'KernelDiscoveryTimeoutError';
	}
}

function remainingTime(deadlineAt: number, signal?: AbortSignal): number {
	signal?.throwIfAborted();
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) throw new KernelDiscoveryTimeoutError();
	return remaining;
}

function rejectedSession(error: unknown, sessionId: string): boolean {
	// Marimo raises this exact error before scratchpad dispatch. Other failures
	// may have executed code and must never trigger a replay.
	return (
		error instanceof KernelHttpError &&
		error.status === 500 &&
		error.detail === `Invalid session id: ${sessionId}`
	);
}

export async function executeInActiveKernel(
	baseUrl: string,
	input: Omit<Parameters<typeof executeInKernel>[1], 'sessionId'>,
	options: KernelRequestOptions & { deadlineAt: number },
): Promise<{ sessionId: string; executed: KernelExecuteResult } | undefined> {
	const discover = async () => {
		const sessions = await withDeadline(
			(signal) => listKernelSessions(baseUrl, { ...options, signal }),
			{
				timeoutMs: remainingTime(options.deadlineAt, options.signal),
				timeoutError: () => new KernelDiscoveryTimeoutError(),
				signal: options.signal,
			},
		);
		return sessions[0];
	};
	const execute = async (sessionId: string) => ({
		sessionId,
		executed: await executeInKernel(
			baseUrl,
			{ ...input, sessionId },
			{
				...options,
				timeoutMs: remainingTime(options.deadlineAt, options.signal),
			},
		),
	});

	const session = await discover();
	if (!session) return undefined;
	try {
		return await execute(session.id);
	} catch (error) {
		if (!rejectedSession(error, session.id)) throw error;
		const replacement = await discover();
		if (!replacement) return undefined;
		if (replacement.id === session.id) throw error;
		return execute(replacement.id);
	}
}

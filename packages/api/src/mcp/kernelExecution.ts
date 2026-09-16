import {
	executeInActiveKernel,
	kernelBaseUrl,
	KernelDiscoveryTimeoutError,
	withAbortSignal,
} from '@marimo-hub/core';
import type { KernelExecuteResult, Session } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { failureResult, result } from './results';
import type { ToolResult } from './results';

function kernelFetch(deps: ApiDeps): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const response = await withAbortSignal(deps.compute.proxy(request), request.signal);
		return response ?? globalThis.fetch(request);
	};
}

function executionText(executed: KernelExecuteResult): string {
	const output = executed.output;
	return [
		executed.stdout,
		executed.stderr ? `stderr:\n${executed.stderr}` : '',
		output
			? `${output.mimetype}:\n${typeof output.data === 'string' ? output.data : JSON.stringify(output.data)}`
			: '',
		executed.timedOut ? 'TIMED OUT' : executed.success ? 'success' : 'FAILED',
	]
		.filter(Boolean)
		.join('\n\n');
}

export async function executeMcpCode(
	deps: ApiDeps,
	session: Session,
	code: string,
	options: {
		deadlineAt: number;
		signal: AbortSignal;
		timeoutSeconds: number;
		startedAt: number;
		appBaseUrl: string;
	},
): Promise<ToolResult> {
	try {
		const active = await executeInActiveKernel(
			kernelBaseUrl(session),
			{ code },
			{
				fetchImpl: kernelFetch(deps),
				kernelAuthToken: session.kernel_auth_token,
				deadlineAt: options.deadlineAt,
				signal: options.signal,
			},
		);
		if (!active) {
			return failureResult({
				code: 'NO_KERNEL_SESSION',
				message:
					'The live kernel is missing and its state may be lost. Call start_session for this notebook before retrying execute_code.',
				notebook_url: `${options.appBaseUrl}/projects/${session.project_id}/notebooks/${session.notebook_id}`,
			});
		}
		const { sessionId, executed } = active;
		return {
			...result(
				{
					project_id: session.project_id,
					notebook_id: session.notebook_id,
					session_id: session.session_id,
					kernel_session_id: sessionId,
					...executed,
					duration_ms: Date.now() - options.startedAt,
				},
				executionText(executed),
			),
			...(!executed.completed || !executed.success ? { isError: true } : {}),
		};
	} catch (error) {
		if (!(error instanceof KernelDiscoveryTimeoutError)) throw error;
		return failureResult({
			code: 'KERNEL_DISCOVERY_TIMEOUT',
			message: `Kernel session discovery exceeded ${options.timeoutSeconds} seconds`,
			timedOut: true,
		});
	}
}

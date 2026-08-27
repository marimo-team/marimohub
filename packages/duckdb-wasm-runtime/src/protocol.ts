import type { DataQueryExecution, DuckDBPreviewProgram } from '@marimo-hub/core';
import type { HttpBridgeRequestMessage } from './httpBridge';

export type RuntimeRequest =
	| { id: number; type: 'initialize'; memoryLimitMb: number; httpEnabled: boolean }
	| { id: number; type: 'execute'; program: DuckDBPreviewProgram; executionNonce?: string }
	| { id: number; type: 'execute-query'; request: DataQueryExecution; executionNonce?: string }
	| { id: number; type: 'ping' };

export type RuntimeResponse =
	| { id: number; ok: true; value?: unknown }
	| { id: number; ok: false; error: string; kind?: 'user-sql' };

export type WorkerMessage = RuntimeResponse | HttpBridgeRequestMessage;

export type RuntimeRequestInput =
	| { type: 'initialize'; memoryLimitMb: number; httpEnabled: boolean }
	| { type: 'execute'; program: DuckDBPreviewProgram; executionNonce?: string }
	| { type: 'execute-query'; request: DataQueryExecution; executionNonce?: string }
	| { type: 'ping' };

export function isRuntimeResponse(value: unknown): value is RuntimeResponse {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<RuntimeResponse>;
	if (!Number.isSafeInteger(candidate.id) || (candidate.id ?? 0) < 1) return false;
	if (candidate.ok === true) return !('error' in candidate);
	return (
		candidate.ok === false &&
		typeof candidate.error === 'string' &&
		(candidate.kind === undefined || candidate.kind === 'user-sql')
	);
}

import type { DataQueryExecution, DuckDBPreviewProgram } from '@marimo-hub/core';
import type { HttpBridgeRequestMessage } from './httpBridge';

export type RuntimeRequestInput =
	| { type: 'initialize'; memoryLimitMb: number; httpEnabled: boolean }
	| { type: 'execute'; program: DuckDBPreviewProgram; executionNonce?: string }
	| { type: 'execute-query'; request: DataQueryExecution; executionNonce?: string }
	| { type: 'ping' };

type WithRequestId<T> = T extends RuntimeRequestInput ? T & { id: number } : never;

export type RuntimeRequest = WithRequestId<RuntimeRequestInput>;

export type RuntimeResponse =
	| { id: number; ok: true; value?: unknown }
	| { id: number; ok: false; error: string; kind?: 'user-sql' };

export type WorkerMessage = RuntimeResponse | HttpBridgeRequestMessage;

export function runtimeRequestId(value: unknown): number | undefined {
	if (typeof value !== 'object' || value === null) return;
	const id = (value as { id?: unknown }).id;
	return Number.isSafeInteger(id) && (id as number) > 0 ? (id as number) : undefined;
}

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
	const id = runtimeRequestId(value);
	if (id === undefined) return false;
	const candidate = value as Record<string, unknown>;
	const validNonce =
		candidate.executionNonce === undefined || typeof candidate.executionNonce === 'string';
	switch (candidate.type) {
		case 'initialize':
			return (
				typeof candidate.memoryLimitMb === 'number' &&
				Number.isFinite(candidate.memoryLimitMb) &&
				typeof candidate.httpEnabled === 'boolean'
			);
		case 'execute':
			return validNonce && typeof candidate.program === 'object' && candidate.program !== null;
		case 'execute-query':
			return validNonce && typeof candidate.request === 'object' && candidate.request !== null;
		case 'ping':
			return true;
		default:
			return false;
	}
}

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

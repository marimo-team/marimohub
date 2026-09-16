import { DomainError } from '@marimo-hub/core';
import { errorMetadataChain, logEvent } from '../log';
import type { StartRequestContext } from './server';

export type ToolResult = {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

export function result(
	data: Record<string, unknown>,
	text = JSON.stringify(data, null, 2),
): ToolResult {
	return { content: [{ type: 'text', text }], structuredContent: data };
}

export function failureResult(data: Record<string, unknown>): ToolResult {
	return { ...result(data), isError: true };
}

export function toolError(
	error: unknown,
	context: StartRequestContext & { userId: string; tool: string },
): ToolResult {
	if (!(error instanceof DomainError)) {
		logEvent({
			level: 'error',
			event: 'mcp_tool_error',
			request_id: context.requestId ?? null,
			method: context.method,
			path: context.path,
			user: context.userId,
			tool: context.tool,
			error: errorMetadataChain(error),
		});
	}
	const data =
		error instanceof DomainError
			? { code: error.code, message: error.message }
			: { code: 'INTERNAL_ERROR', message: 'Internal error' };
	return failureResult(data);
}

import { DomainError } from '@marimo-hub/core';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { HostEvent } from '@marimo-hub/core/host-bridge';

export const HOST_PREFIX = '/api/host/v1';
export const RUNTIME_ROUTES = [
	{ method: 'PUT', path: '/runtime', operation: 'runtime.start', event: 'runtime' },
	{ method: 'POST', path: '/edits', operation: 'notebook.edit', event: 'edit' },
	{ method: 'POST', path: '/save', operation: 'notebook.save', event: 'edit' },
	{ method: 'POST', path: '/runtime/runs', operation: 'runtime.run', event: 'run' },
	{ method: 'DELETE', path: '/runtime/runs/:run', operation: 'runtime.interrupt', event: 'run' },
] as const;
export const RUNTIME_OPERATIONS = RUNTIME_ROUTES.map((route) => route.operation);
export const OPERATIONS = ['notebook.create', 'notebook.update', ...RUNTIME_OPERATIONS];
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HostDecision {
	id: string;
	prompt: string;
	options: { id: string; label: string }[];
}

export class HostProblemError extends Error {
	private constructor(
		readonly status: number,
		readonly type: string,
		message: string,
		readonly decisions?: HostDecision[],
	) {
		super(message);
		this.name = 'HostProblemError';
	}

	static invalidRequest(message: string): HostProblemError {
		return new HostProblemError(400, 'invalid-request', message);
	}

	static unauthorized(message: string): HostProblemError {
		return new HostProblemError(401, 'unauthorized', message);
	}

	static forbidden(message: string): HostProblemError {
		return new HostProblemError(403, 'forbidden', message);
	}

	static notFound(message: string): HostProblemError {
		return new HostProblemError(404, 'not-found', message);
	}

	static methodNotAllowed(message: string): HostProblemError {
		return new HostProblemError(405, 'method-not-allowed', message);
	}

	static conflict(message: string): HostProblemError {
		return new HostProblemError(409, 'conflict', message);
	}

	static noRuntime(message: string): HostProblemError {
		return new HostProblemError(409, 'no-runtime', message);
	}

	static payloadTooLarge(message: string): HostProblemError {
		return new HostProblemError(413, 'invalid-request', message);
	}

	static unsupportedOperation(message: string): HostProblemError {
		return new HostProblemError(501, 'unsupported-operation', message);
	}

	static unavailable(message: string): HostProblemError {
		return new HostProblemError(503, 'unavailable', message);
	}

	static decisionRequired(message: string, decisions: HostDecision[]): HostProblemError {
		return new HostProblemError(409, 'decision-required', message, decisions);
	}

	toResponse(): Response {
		return problem(this.status, this.type, this.message, this.decisions);
	}
}

function problem(
	status: number,
	type: string,
	detail: string,
	decisions?: HostDecision[],
): Response {
	return problemResponse(
		{
			type: `tag:marimo.io,2026:host/${type}`,
			title: type,
			status,
			detail,
			...(decisions ? { decisions } : {}),
		},
		status,
	);
}

export function problemResponse(body: unknown, status: number): Response {
	return Response.json(body, {
		status,
		headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
	});
}

export function errorResponse(error: unknown): Response {
	if (error instanceof HostProblemError) return error.toResponse();
	if (error instanceof z.ZodError || error instanceof SyntaxError)
		return HostProblemError.invalidRequest('Invalid request body or parameters').toResponse();
	const status =
		error instanceof DomainError
			? error.status
			: error instanceof HTTPException
				? error.status
				: 500;
	const factories: Record<number, (message: string) => HostProblemError> = {
		400: HostProblemError.invalidRequest,
		401: HostProblemError.unauthorized,
		403: HostProblemError.forbidden,
		404: HostProblemError.notFound,
		405: HostProblemError.methodNotAllowed,
		409: HostProblemError.conflict,
		412: HostProblemError.conflict,
		422: HostProblemError.invalidRequest,
		503: HostProblemError.unavailable,
	};
	const detail =
		status >= 500 ? 'The host could not complete the request' : (error as Error).message;
	return factories[status]?.(detail).toResponse() ?? problem(status, 'internal', detail);
}

export function sse(event: HostEvent): string {
	return `${event.id ? `id: ${event.id}\n` : ''}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function acceptsEvent(types: string | undefined, kind: string): boolean {
	return (
		kind === 'ready' ||
		kind === 'reset' ||
		types === undefined ||
		types.split(',').includes(kind.replace(/\.removed$/, ''))
	);
}

export function mapRuntimeEvent(
	event: HostEvent,
	notebookId: string,
	sessionId: string,
): HostEvent {
	const value = event.data[event.event];
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		if (event.event === 'runtime.removed' && typeof event.data.id === 'string')
			return { ...event, data: { ...event.data, id: `${sessionId}:${event.data.id}` } };
		return event;
	}
	const record: Record<string, unknown> = { ...value };
	if (event.event === 'edit' && record.document && typeof record.document === 'object')
		record.document = { ...record.document, notebook_id: notebookId };
	if ('notebook_id' in record) record.notebook_id = notebookId;
	if (typeof record.runtime_id === 'string')
		record.runtime_id = `${sessionId}:${record.runtime_id}`;
	if (event.event === 'runtime' && typeof record.id === 'string')
		record.id = `${sessionId}:${record.id}`;
	return { ...event, data: { ...event.data, [event.event]: record } };
}

export function mapRuntimeProblem(body: unknown, notebookId: string): unknown {
	if (!body || typeof body !== 'object' || !('edit' in body)) return body;
	const edit = body.edit;
	if (!edit || typeof edit !== 'object') return body;
	return {
		...body,
		edit: Object.fromEntries(
			Object.entries(edit).map(([key, value]) => [
				key,
				(key === 'document' || key === 'cell') && value && typeof value === 'object'
					? { ...value, notebook_id: notebookId }
					: value,
			]),
		),
	};
}

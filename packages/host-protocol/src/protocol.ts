import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { HostEvent } from './events';

// `provision` routes start a runtime on demand; the others only reach a runtime that exists.
export const RUNTIME_ROUTES = [
	{
		method: 'PUT',
		path: '/runtime',
		operation: 'runtime.start',
		event: 'runtime',
		provision: true,
	},
	{ method: 'POST', path: '/edits', operation: 'notebook.edit', event: 'edit', provision: true },
	{ method: 'POST', path: '/save', operation: 'notebook.save', event: 'edit', provision: true },
	{
		method: 'POST',
		path: '/runtime/runs',
		operation: 'runtime.run',
		event: 'run',
		provision: true,
	},
	{
		method: 'DELETE',
		path: '/runtime/runs/:run',
		operation: 'runtime.interrupt',
		event: 'run',
		provision: false,
	},
	{
		method: 'POST',
		path: '/runtime/inputs/:input/reply',
		operation: 'runtime.input',
		event: 'input',
		provision: false,
	},
] as const;
export type RuntimeOperation = (typeof RUNTIME_ROUTES)[number]['operation'];
export const RUNTIME_OPERATIONS: readonly RuntimeOperation[] = RUNTIME_ROUTES.map(
	(route) => route.operation,
);
export const OPERATIONS: readonly string[] = [
	'notebook.create',
	'notebook.update',
	...RUNTIME_OPERATIONS,
];
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const CATALOG_KINDS = ['host', 'project', 'notebook', 'runtime', 'attachment'] as const;
export const NOTEBOOK_KINDS = [
	'notebook',
	'document',
	'cell',
	'runtime',
	'attachment',
	'run',
	'execution',
	'console',
	'display',
	'input',
	'variable',
	'custom',
] as const;
export type EventKinds = ReadonlySet<string> | undefined;

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

/** A failure reported by the runtime itself, relayed with its own status and problem body. */
export class UpstreamProblemError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown,
	) {
		super('The runtime rejected the request');
		this.name = 'UpstreamProblemError';
	}
}

export function problemResponse(body: unknown, status: number): Response {
	return Response.json(body, {
		status,
		headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
	});
}

/** The HTTP status a platform assigns to one of its own errors; `undefined` means 500. */
export type ErrorStatus = (error: unknown) => number | undefined;
export type ErrorResponder = (error: unknown) => Response;

export function errorResponse(error: unknown, statusOf?: ErrorStatus): Response {
	if (error instanceof HostProblemError) return error.toResponse();
	if (error instanceof UpstreamProblemError)
		return error.body === undefined
			? HostProblemError.unavailable('Runtime event stream unavailable').toResponse()
			: problemResponse(error.body, error.status);
	if (error instanceof z.ZodError || error instanceof SyntaxError)
		return HostProblemError.invalidRequest('Invalid request body or parameters').toResponse();
	const status = error instanceof HTTPException ? error.status : (statusOf?.(error) ?? 500);
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

// Runtime-supplied names and IDs must not be able to open a new SSE field.
const sseField = (value: string) => value.replaceAll(/[\r\n]/g, '');

export function sse(event: HostEvent): string {
	const id = event.id ? `id: ${sseField(event.id)}\n` : '';
	return `${id}event: ${sseField(event.event)}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function parseTypes(raw: string | undefined, kinds: readonly string[]): EventKinds {
	const asked = new Set((raw ?? '').split(',').filter((kind) => kind !== ''));
	if (asked.size === 0) return undefined;
	const unknown = [...asked].filter((kind) => !kinds.includes(kind)).sort();
	if (unknown.length > 0)
		throw HostProblemError.invalidRequest(`types has no kind named ${unknown.join(', ')}`);
	return asked;
}

export function acceptsEvent(types: EventKinds, kind: string): boolean {
	return (
		kind === 'ready' ||
		kind === 'reset' ||
		types === undefined ||
		types.has(kind.replace(/\.removed$/, ''))
	);
}

/**
 * Rewrite a runtime's event so its notebook ID is the platform's and its runtime IDs are
 * prefixed with the runtime key, since one platform notebook may see several runtimes over time.
 */
export function mapRuntimeEvent(
	event: HostEvent,
	notebookId: string,
	runtimeKey: string,
): HostEvent {
	const value = event.data[event.event];
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		if (event.event === 'runtime.removed' && typeof event.data.id === 'string')
			return { ...event, data: { ...event.data, id: `${runtimeKey}:${event.data.id}` } };
		return event;
	}
	const record: Record<string, unknown> = { ...value };
	if (event.event === 'edit' && record.document && typeof record.document === 'object')
		record.document = { ...record.document, notebook_id: notebookId };
	if ('notebook_id' in record) record.notebook_id = notebookId;
	if (typeof record.runtime_id === 'string')
		record.runtime_id = `${runtimeKey}:${record.runtime_id}`;
	if (event.event === 'runtime' && typeof record.id === 'string')
		record.id = `${runtimeKey}:${record.id}`;
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

import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import {
	acceptsEvent,
	CATALOG_KINDS,
	errorResponse,
	HostProblemError,
	mapRuntimeEvent,
	mapRuntimeProblem,
	parseTypes,
	sse,
	UpstreamProblemError,
} from './protocol';

class PlatformError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'PlatformError';
	}
}
const statusOf = (error: unknown) => (error instanceof PlatformError ? error.status : undefined);

describe('stream kind filters', () => {
	it('parses and validates kinds and matches removal events', () => {
		expect(parseTypes(undefined, CATALOG_KINDS)).toBeUndefined();
		expect(parseTypes(',', CATALOG_KINDS)).toBeUndefined();
		const types = parseTypes('notebook,runtime', CATALOG_KINDS);
		expect(acceptsEvent(types, 'runtime.removed')).toBe(true);
		expect(acceptsEvent(types, 'host')).toBe(false);
		expect(acceptsEvent(types, 'ready')).toBe(true);
		expect(acceptsEvent(undefined, 'attachment')).toBe(true);
		expect(() => parseTypes('cell,bogus', CATALOG_KINDS)).toThrow(
			'types has no kind named bogus, cell',
		);
	});
});

describe('server-sent event framing', () => {
	it('keeps runtime-supplied names and ids on one line', () => {
		expect(
			sse({ event: 'cell\nevent: reset', id: 'u1\r\ndata: {}', data: { cell: { id: 'c\n1' } } }),
		).toBe('id: u1data: {}\nevent: cellevent: reset\ndata: {"cell":{"id":"c\\n1"}}\n\n');
	});
});

describe('runtime identity mapping', () => {
	it('rewrites notebook and runtime identifiers and leaves cell data alone', () => {
		const mapped = mapRuntimeEvent(
			{
				event: 'run',
				data: { run: { id: 'r1', notebook_id: 'local', runtime_id: 'k1', cells: ['c1'] } },
			},
			'proj:nb',
			'sess',
		);
		expect(mapped.data.run).toEqual({
			id: 'r1',
			notebook_id: 'proj:nb',
			runtime_id: 'sess:k1',
			cells: ['c1'],
		});
		expect(
			mapRuntimeEvent({ event: 'runtime', data: { runtime: { id: 'k1' } } }, 'proj:nb', 'sess').data
				.runtime,
		).toEqual({ id: 'sess:k1' });
		expect(
			mapRuntimeEvent({ event: 'runtime.removed', data: { id: 'k1' } }, 'proj:nb', 'sess').data,
		).toEqual({ id: 'sess:k1' });
		expect(
			mapRuntimeEvent(
				{ event: 'edit', data: { edit: { document: { notebook_id: 'local', etag: 'e' } } } },
				'proj:nb',
				'sess',
			).data.edit,
		).toEqual({ document: { notebook_id: 'proj:nb', etag: 'e' } });
		expect(
			mapRuntimeProblem(
				{ status: 409, edit: { document: { notebook_id: 'local' }, reason: 'stale' } },
				'proj:nb',
			),
		).toEqual({ status: 409, edit: { document: { notebook_id: 'proj:nb' }, reason: 'stale' } });
	});
});

describe('host problem responses', () => {
	it('keeps decision-required distinct from other 409 responses', async () => {
		const decisions = [
			{ id: 'editor', prompt: 'Take over?', options: [{ id: 'cancel', label: 'Cancel' }] },
		];
		const responses = [
			HostProblemError.conflict('Editor changed').toResponse(),
			errorResponse(HostProblemError.noRuntime('Runtime stopped')),
			errorResponse(HostProblemError.decisionRequired('Choose an editor', decisions)),
		];
		for (const response of responses) {
			expect(response.status).toBe(409);
			expect(response.headers.get('Content-Type')).toBe('application/problem+json');
			expect(response.headers.get('Cache-Control')).toBe('no-store');
		}
		expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
			{
				type: 'tag:marimo.io,2026:host/conflict',
				title: 'conflict',
				status: 409,
				detail: 'Editor changed',
			},
			{
				type: 'tag:marimo.io,2026:host/no-runtime',
				title: 'no-runtime',
				status: 409,
				detail: 'Runtime stopped',
			},
			{
				type: 'tag:marimo.io,2026:host/decision-required',
				title: 'decision-required',
				status: 409,
				detail: 'Choose an editor',
				decisions,
			},
		]);
	});

	it('preserves the body-limit status without changing ordinary validation errors', async () => {
		const tooLarge = errorResponse(HostProblemError.payloadTooLarge('Body exceeds limit'));
		expect(tooLarge.status).toBe(413);
		expect(await tooLarge.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/invalid-request',
			status: 413,
		});
		const invalid = errorResponse(new SyntaxError('private parser details'));
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/invalid-request',
			status: 400,
			detail: 'Invalid request body or parameters',
		});
	});

	it('relays a runtime problem with its own status and falls back without a body', async () => {
		const relayed = errorResponse(new UpstreamProblemError(403, { type: 'x', detail: 'denied' }));
		expect(relayed.status).toBe(403);
		expect(await relayed.json()).toEqual({ type: 'x', detail: 'denied' });
		const empty = errorResponse(new UpstreamProblemError(502, undefined));
		expect(empty.status).toBe(503);
	});

	it.each([
		[new PlatformError(412, 'Stale version'), 409, 'conflict', 'Stale version'],
		[new HTTPException(422, { message: 'Invalid field' }), 400, 'invalid-request', 'Invalid field'],
		[new PlatformError(429, 'Rate limit exceeded'), 429, 'unavailable', 'Rate limit exceeded'],
		[new PlatformError(410, 'Upload expired'), 410, 'invalid-request', 'Upload expired'],
		[
			new PlatformError(503, 'private upstream details'),
			503,
			'unavailable',
			'The host could not complete the request',
		],
		[
			new HTTPException(503, { message: 'private adapter details' }),
			503,
			'unavailable',
			'The host could not complete the request',
		],
		[
			new Error('private exception details'),
			500,
			'internal',
			'The host could not complete the request',
		],
	] as const)(
		'normalizes and sanitizes external errors: %s',
		async (error, status, type, detail) => {
			const response = errorResponse(error, statusOf);
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({
				type: `tag:marimo.io,2026:host/${type}`,
				title: type,
				status,
				detail,
			});
		},
	);
});

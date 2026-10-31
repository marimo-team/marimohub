import { PreconditionFailedError, UnavailableError } from '@marimo-hub/core';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { errorResponse, HostProblemError } from './protocol';

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

	it.each([
		[new PreconditionFailedError('Stale version'), 409, 'conflict', 'Stale version'],
		[new HTTPException(422, { message: 'Invalid field' }), 400, 'invalid-request', 'Invalid field'],
		[
			new UnavailableError('private upstream details'),
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
			const response = errorResponse(error);
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

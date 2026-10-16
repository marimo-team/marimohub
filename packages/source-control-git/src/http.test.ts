import { describe, expect, it, vi } from 'vitest';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core/errors';
import { providerHttpError, readResponseBytes, responseFields, retryAfterSeconds } from './http';
const boundedBytes = (response: Response, limit: number, signal?: AbortSignal) =>
	readResponseBytes(response, limit, 'Provider', signal);
function openStream(chunk: string, failCancel = false) {
	const cancel = vi.fn(() => {
		if (failCancel) throw new Error('private cleanup details');
	});
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(chunk));
		},
		cancel,
	});
	return { body, cancel };
}

describe('bounded source-control responses', () => {
	it.each([undefined, '1', 'not-a-number', '4'])(
		'counts actual bytes with content-length %s',
		async (length) => {
			const { body, cancel } = openStream('four');
			const headers = length === undefined ? undefined : { 'content-length': length };
			await expect(boundedBytes(new Response(body, { headers }), 3)).rejects.toBeInstanceOf(
				BadRequestError,
			);
			expect(cancel).toHaveBeenCalledOnce();
		},
	);
	it('accepts exactly the byte limit across multiple chunks', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0, 255]));
				controller.enqueue(new Uint8Array([42]));
				controller.close();
			},
		});
		await expect(boundedBytes(new Response(stream), 3)).resolves.toEqual(
			new Uint8Array([0, 255, 42]),
		);
	});
	it('distinguishes an empty file from a missing response body', async () => {
		await expect(boundedBytes(new Response(new Uint8Array()), 0)).resolves.toEqual(
			new Uint8Array(),
		);
		await expect(boundedBytes(new Response(null), 10)).rejects.toBeInstanceOf(UnavailableError);
	});
	it('preserves the size-limit error when cleanup fails', async () => {
		const { body, cancel } = openStream('four', true);
		await expect(
			boundedBytes(new Response(body, { headers: { 'content-length': '4' } }), 3),
		).rejects.toBeInstanceOf(BadRequestError);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('does not return partial data or expose details after a stream failure', async () => {
		let pulls = 0;
		const cause = new Error('private connection details');
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls++ === 0) controller.enqueue(new Uint8Array([1]));
				else controller.error(cause);
			},
		});
		const error = await boundedBytes(new Response(body), 10).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(UnavailableError);
		expect(error).toHaveProperty('cause', cause);
		expect(String(error)).not.toContain('private connection details');
	});
	it('aborts a stalled body and cancels its stream', async () => {
		const cancel = vi.fn();
		const controller = new AbortController();
		const reading = readResponseBytes(
			new Response(new ReadableStream({ cancel })),
			10,
			'Provider',
			controller.signal,
		);
		controller.abort(new Error('Stop reading Git response'));
		await expect(reading).rejects.toBe(controller.signal.reason);
		expect(cancel).toHaveBeenCalledOnce();
	});
});

describe('providerHttpError', () => {
	it.each([
		{ status: 400, type: BadRequestError },
		{ status: 401, type: ForbiddenError },
		{ status: 403, type: ForbiddenError },
		{ status: 404, type: NotFoundError },
		{ status: 409, type: ConflictError },
		{ status: 412, type: ConflictError },
		{ status: 422, type: ValidationError },
		{ status: 429, type: UnavailableError },
		{ status: 302, type: UnavailableError },
		{ status: 503, type: UnavailableError },
	])('maps $status', ({ status, type }) => {
		const error = providerHttpError('Provider', status);
		expect(error).toBeInstanceOf(type);
		expect(error.providerStatus).toBe(status);
		expect(error).not.toHaveProperty('retryAfterSeconds');
	});

	it('reports a semantically rejected request as a validation error', () => {
		const error = providerHttpError('Provider', 422);
		expect(error).toBeInstanceOf(ValidationError);
		expect(error.message).toBe('Provider rejected the request');
	});

	it('carries Retry-After seconds or dates on rate limits', () => {
		expect(
			providerHttpError('Provider', 429, { headers: new Headers({ 'retry-after': '30' }) }),
		).toMatchObject({ retryAfterSeconds: 30 });
		expect(retryAfterSeconds(new Date(61_000).toUTCString(), 1_000)).toBe(60);
		expect(retryAfterSeconds('soon')).toBeUndefined();
	});

	it('validates provider response fields', () => {
		const { record, stringField } = responseFields('Provider');
		expect(() => record([])).toThrow('Invalid Provider response');
		expect(() => stringField({ id: '' }, 'id')).toThrow('Invalid Provider id');
		expect(stringField({ id: 'x' }, 'id')).toBe('x');
	});
});

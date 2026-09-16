import { ForbiddenError, NotFoundError, withAbortSignal } from '@marimo-hub/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolError } from './results';

const context = {
	requestId: 'request-1',
	method: 'POST',
	path: '/mcp',
	hostname: 'localhost',
	appBaseUrl: 'http://localhost',
	userId: 'user-1',
	tool: 'start_session',
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('toolError', () => {
	it.each([undefined, new Error('Client disconnected'), 'Client cancelled'])(
		'reports cancellation thrown by the request signal with reason %s',
		(reason) => {
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const signal = AbortSignal.abort(reason);
			let error: unknown;
			try {
				signal.throwIfAborted();
			} catch (caught) {
				error = caught;
			}

			expect(toolError(error, { ...context, signal })).toMatchObject({
				isError: true,
				structuredContent: { code: 'REQUEST_CANCELLED' },
			});
			expect(log).not.toHaveBeenCalled();
		},
	);

	it('recognizes the AbortError produced by withAbortSignal for a non-error reason', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const signal = AbortSignal.abort('Client cancelled');
		const error = await withAbortSignal(Promise.resolve(), signal).catch((caught) => caught);

		expect(toolError(error, { ...context, signal })).toMatchObject({
			isError: true,
			structuredContent: { code: 'REQUEST_CANCELLED' },
		});
		expect(log).not.toHaveBeenCalled();
	});

	it.each([new NotFoundError('Notebook missing'), new ForbiddenError('Access denied')])(
		'preserves %s when the request is also aborted',
		(error) => {
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});

			expect(toolError(error, { ...context, signal: AbortSignal.abort() })).toMatchObject({
				isError: true,
				structuredContent: { code: error.code, message: error.message },
			});
			expect(log).not.toHaveBeenCalled();
		},
	);

	it('logs an unrelated internal failure when the request is also aborted', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = new TypeError('Private provider details');

		expect(toolError(error, { ...context, signal: AbortSignal.abort() })).toMatchObject({
			isError: true,
			structuredContent: { code: 'INTERNAL_ERROR', message: 'Internal error' },
		});
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
			level: 'error',
			event: 'mcp_tool_error',
			request_id: context.requestId,
			tool: context.tool,
			error: { error_name: 'TypeError' },
		});
		expect(log.mock.calls[0][0]).not.toContain(error.message);
	});

	it('does not treat an AbortError as request cancellation if the request is active', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = new DOMException('Upstream aborted', 'AbortError');

		expect(toolError(error, { ...context, signal: new AbortController().signal })).toMatchObject({
			isError: true,
			structuredContent: { code: 'INTERNAL_ERROR', message: 'Internal error' },
		});
		expect(log).toHaveBeenCalledTimes(1);
	});
});

import { expect, it, vi } from 'vitest';
import { readSessionStart } from './sessionStartupStream';
import { retrySessionAdmission } from './sessionRetry';

const session = { session_id: 'sess-1', status: 'running' };
const progress = {
	phase: 'allocating',
	detail: 'Queued ☁',
	started_at: new Date().toISOString(),
	attempt: 1,
	observed: ['allocating'],
};
const resultEvent = `event: result\ndata: ${JSON.stringify({ success: true, data: session })}\n\n`;
const progressEvent = `event: progress\ndata: ${JSON.stringify(progress)}\n\n`;

function response(
	text: string,
	{
		chunked = false,
		close = true,
		cancel,
	}: {
		chunked?: boolean;
		close?: boolean;
		cancel?: UnderlyingSource<Uint8Array>['cancel'];
	} = {},
) {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream({
			start(controller) {
				if (chunked) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				else controller.enqueue(bytes);
				if (close) controller.close();
			},
			cancel,
		}),
		{ headers: { 'Content-Type': 'text/event-stream' } },
	);
}

it('parses split UTF-8 and CRLF frames, ignores comments, and returns the normal result', async () => {
	const onProgress = vi.fn();
	const body = `: keepalive\n\n${progressEvent}${resultEvent}`.replaceAll('\n', '\r\n');
	expect(
		await readSessionStart(
			Promise.resolve({ response: response(body, { chunked: true }) }),
			onProgress,
		),
	).toEqual(session);
	expect(onProgress).toHaveBeenCalledWith(progress);
});

it('accepts a JSON response from a server without streaming', async () => {
	const res = Response.json({ success: true, data: session });
	expect(await readSessionStart(Promise.resolve({ response: res }), vi.fn())).toEqual(session);
});

it('rejects a JSON fallback without a valid session', async () => {
	await expect(
		readSessionStart(Promise.resolve({ response: Response.json({ success: true, data: null }) })),
	).rejects.toMatchObject({ code: 'PARSE_ERROR' });
});

it('preserves the result after malformed progress or a failing observer', async () => {
	const onProgress = vi.fn(() => {
		throw new Error('Observer failed');
	});
	const body = `event: progress\ndata: invalid json\n\n${progressEvent}${resultEvent}`;
	expect(await readSessionStart(Promise.resolve({ response: response(body) }), onProgress)).toEqual(
		session,
	);
	expect(onProgress).toHaveBeenCalledOnce();
});

it('preserves safe terminal error codes and status', async () => {
	const body = `event: error\ndata: ${JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Access expired', status: 403 } })}\n\n`;
	await expect(
		readSessionStart(Promise.resolve({ response: response(body) })),
	).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, message: 'Access expired' });
});

it('reports a truncated stream as a transport error, not a sandbox failure', async () => {
	await expect(
		readSessionStart(Promise.resolve({ response: response(progressEvent) })),
	).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
});

it('stops reading after the result and cancels the response', async () => {
	const cancel = vi.fn();
	const res = response(resultEvent, { close: false, cancel });
	expect(await readSessionStart(Promise.resolve({ response: res }))).toEqual(session);
	expect(cancel).toHaveBeenCalledOnce();
});

it.each([
	['invalid JSON', 'event: result\ndata: {invalid}\n\n', 'PARSE_ERROR'],
	['invalid envelope', 'event: result\ndata: {}\n\n', 'PARSE_ERROR'],
	['missing session', 'event: result\ndata: {"success":true}\n\n', 'PARSE_ERROR'],
	['null session', 'event: result\ndata: {"success":true,"data":null}\n\n', 'PARSE_ERROR'],
	[
		'invalid error status',
		'event: error\ndata: {"success":false,"error":{"code":"FORBIDDEN","message":"Denied","status":200}}\n\n',
		'NETWORK_ERROR',
	],
	[
		'unterminated event',
		`event: result\ndata: ${JSON.stringify({ success: true, data: session })}`,
		'NETWORK_ERROR',
	],
])('rejects %s without replaying the POST', async (_name, body, code) => {
	const request = vi.fn(async () => ({ response: response(body) }));
	await expect(retrySessionAdmission(() => readSessionStart(request()))).rejects.toMatchObject({
		code,
	});
	expect(request).toHaveBeenCalledOnce();
});

it('bounds an oversized incomplete event and cancels the reader', async () => {
	const cancel = vi.fn();
	const res = response(`data: ${'x'.repeat(1024 * 1024 + 1)}`, { close: false, cancel });
	await expect(readSessionStart(Promise.resolve({ response: res }))).rejects.toMatchObject({
		code: 'NETWORK_ERROR',
	});
	expect(cancel).toHaveBeenCalledOnce();
	expect(res.body!.locked).toBe(false);
});

it('preserves HTTP authorization failures before a stream opens', async () => {
	const error = { success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } };
	await expect(
		readSessionStart(Promise.resolve({ response: Response.json(error, { status: 403 }), error })),
	).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
});

it.each(['missing', 'errored'] as const)('rejects a %s response body', async (kind) => {
	const body =
		kind === 'missing'
			? null
			: new ReadableStream({
					start(controller) {
						controller.error(new Error('Connection reset'));
					},
				});
	const res = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
	await expect(readSessionStart(Promise.resolve({ response: res }))).rejects.toMatchObject({
		code: 'NETWORK_ERROR',
	});
	expect(res.body?.locked ?? false).toBe(false);
});

it('keeps the first terminal result, including its app assignment, if later events arrive', async () => {
	const data = { ...session, app_assignment: { visit_id: 'visit', generation: 'generation' } };
	const onProgress = vi.fn();
	const body = `event: result\ndata: ${JSON.stringify({ success: true, data })}\n\nevent: error\ndata: invalid json\n\nevent: progress\ndata: ${JSON.stringify(progress)}\n\n`;
	expect(await readSessionStart(Promise.resolve({ response: response(body) }), onProgress)).toEqual(
		data,
	);
	expect(onProgress).not.toHaveBeenCalled();
});

it('preserves a completed result even when cancelling the reader rejects', async () => {
	const res = response(resultEvent, {
		close: false,
		cancel() {
			throw new Error('Connection already closed');
		},
	});
	expect(await readSessionStart(Promise.resolve({ response: res }))).toEqual(session);
	expect(res.body!.locked).toBe(false);
});

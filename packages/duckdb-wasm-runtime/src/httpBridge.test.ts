import { describe, expect, it } from 'vitest';
import {
	createHttpBridgeBuffers,
	isHttpBridgeRequestMessage,
	rejectHttpBridge,
	resolveHttpBridge,
	waitForHttpBridge,
} from './httpBridge';
import type { HttpBridgeRequestMessage } from './httpBridge';

function message(): HttpBridgeRequestMessage {
	const { control, response } = createHttpBridgeBuffers();
	return {
		type: 'http-request',
		executionNonce: 'execution-nonce-1',
		request: { url: 'https://catalog.example.test/v1/config', method: 'GET' },
		control,
		response,
	};
}

describe('HTTP bridge buffers', () => {
	it('moves a binary response through shared memory', () => {
		const request = message();
		resolveHttpBridge(request, {
			status: 206,
			headers: { 'content-range': 'bytes 0-2/10' },
			body: new Uint8Array([0, 127, 255]),
		});

		expect(waitForHttpBridge(request.control, request.response, 1)).toEqual({
			status: 206,
			headers: { 'content-range': 'bytes 0-2/10' },
			body: new Uint8Array([0, 127, 255]),
		});
	});

	it('returns a sanitized bridge error', () => {
		const request = message();
		rejectHttpBridge(request, 'target denied');

		expect(() => waitForHttpBridge(request.control, request.response, 1)).toThrow('target denied');
	});

	it('rejects oversized response bodies before notifying the worker', () => {
		const request = message();
		resolveHttpBridge(request, {
			status: 200,
			headers: {},
			body: new Uint8Array(request.response.byteLength),
		});

		expect(() => waitForHttpBridge(request.control, request.response, 1)).toThrow(
			'response body is too large',
		);
	});

	it('rejects buffers with unexpected sizes', () => {
		const request = message();
		request.response = new SharedArrayBuffer(8);

		expect(() => rejectHttpBridge(request, 'error')).toThrow(/buffers are invalid/);
		expect(() => waitForHttpBridge(request.control, request.response, 1)).toThrow(
			/buffers are invalid/,
		);
	});

	it('validates the complete parent-side message before accessing shared memory', () => {
		const request = message();
		expect(isHttpBridgeRequestMessage(request)).toBe(true);
		expect(isHttpBridgeRequestMessage({ ...request, control: new SharedArrayBuffer(1) })).toBe(
			false,
		);
		expect(isHttpBridgeRequestMessage({ ...request, executionNonce: 'short' })).toBe(false);
		expect(
			isHttpBridgeRequestMessage({
				...request,
				request: { ...request.request, headers: { range: 42 } },
			}),
		).toBe(false);
	});
});

import type { IcebergHttpBrokerRequest, IcebergHttpBrokerResponse } from './icebergHttpBroker';

export const HTTP_BRIDGE_HEADER_BYTES = 64 * 1024;
export const HTTP_BRIDGE_BODY_BYTES = 16 * 1024 * 1024;
export const HTTP_BRIDGE_TIMEOUT_MS = 35_000;

export const HttpBridgeState = Object.freeze({ Pending: 0, Success: 1, Error: 2 });

const ControlIndex = Object.freeze({ State: 0, Status: 1, HeaderBytes: 2, BodyBytes: 3 });

export interface HttpBridgeRequestMessage {
	type: 'http-request';
	executionNonce: string;
	request: IcebergHttpBrokerRequest;
	control: SharedArrayBuffer;
	response: SharedArrayBuffer;
}

export interface HttpBridgeResult {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export function isHttpBridgeRequestMessage(value: unknown): value is HttpBridgeRequestMessage {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<HttpBridgeRequestMessage>;
	if (
		candidate.type !== 'http-request' ||
		typeof candidate.executionNonce !== 'string' ||
		!/^[0-9A-Za-z_-]{16,128}$/.test(candidate.executionNonce) ||
		!(candidate.control instanceof SharedArrayBuffer) ||
		candidate.control.byteLength !== Int32Array.BYTES_PER_ELEMENT * 4 ||
		!(candidate.response instanceof SharedArrayBuffer) ||
		candidate.response.byteLength !== HTTP_BRIDGE_HEADER_BYTES + HTTP_BRIDGE_BODY_BYTES ||
		typeof candidate.request !== 'object' ||
		candidate.request === null
	) {
		return false;
	}
	const request = candidate.request as Partial<IcebergHttpBrokerRequest>;
	if (
		typeof request.url !== 'string' ||
		(request.method !== 'GET' && request.method !== 'HEAD') ||
		(request.headers !== undefined &&
			(typeof request.headers !== 'object' || request.headers === null))
	) {
		return false;
	}
	return Object.entries(request.headers ?? {}).every(
		([name, header]) => typeof name === 'string' && typeof header === 'string',
	);
}

export function createHttpBridgeBuffers(): {
	control: SharedArrayBuffer;
	response: SharedArrayBuffer;
} {
	return {
		control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
		response: new SharedArrayBuffer(HTTP_BRIDGE_HEADER_BYTES + HTTP_BRIDGE_BODY_BYTES),
	};
}

export function waitForHttpBridge(
	controlBuffer: SharedArrayBuffer,
	responseBuffer: SharedArrayBuffer,
	timeoutMs = HTTP_BRIDGE_TIMEOUT_MS,
): HttpBridgeResult {
	const control = new Int32Array(controlBuffer);
	if (
		controlBuffer.byteLength !== Int32Array.BYTES_PER_ELEMENT * 4 ||
		responseBuffer.byteLength !== HTTP_BRIDGE_HEADER_BYTES + HTTP_BRIDGE_BODY_BYTES
	) {
		throw new Error('DuckDB HTTP bridge buffers are invalid.');
	}
	const waited = Atomics.wait(control, ControlIndex.State, HttpBridgeState.Pending, timeoutMs);
	if (waited === 'timed-out') throw new Error('DuckDB HTTP bridge request timed out.');
	const state = Atomics.load(control, ControlIndex.State);
	const headerLength = Atomics.load(control, ControlIndex.HeaderBytes);
	const bodyLength = Atomics.load(control, ControlIndex.BodyBytes);
	if (
		headerLength < 0 ||
		headerLength > HTTP_BRIDGE_HEADER_BYTES ||
		bodyLength < 0 ||
		bodyLength > HTTP_BRIDGE_BODY_BYTES
	) {
		throw new Error('DuckDB HTTP bridge response lengths are invalid.');
	}
	const response = new Uint8Array(responseBuffer);
	const headerText = new TextDecoder().decode(response.subarray(0, headerLength));
	if (state === HttpBridgeState.Error) {
		throw new Error(headerText || 'DuckDB HTTP bridge request failed.');
	}
	if (state !== HttpBridgeState.Success) {
		throw new Error('DuckDB HTTP bridge returned an invalid state.');
	}
	let headers: Record<string, string>;
	try {
		headers = JSON.parse(headerText) as Record<string, string>;
	} catch {
		throw new Error('DuckDB HTTP bridge returned invalid headers.');
	}
	return {
		status: Atomics.load(control, ControlIndex.Status),
		headers,
		body: response.slice(HTTP_BRIDGE_HEADER_BYTES, HTTP_BRIDGE_HEADER_BYTES + bodyLength),
	};
}

export function resolveHttpBridge(
	message: HttpBridgeRequestMessage,
	result: IcebergHttpBrokerResponse,
): void {
	const { control, response } = bridgeViews(message);
	const headers = new TextEncoder().encode(JSON.stringify(result.headers));
	if (headers.byteLength > HTTP_BRIDGE_HEADER_BYTES) {
		rejectHttpBridge(message, 'DuckDB HTTP bridge response headers are too large.');
		return;
	}
	if (result.body.byteLength > HTTP_BRIDGE_BODY_BYTES) {
		rejectHttpBridge(message, 'DuckDB HTTP bridge response body is too large.');
		return;
	}
	response.set(headers, 0);
	response.set(result.body, HTTP_BRIDGE_HEADER_BYTES);
	Atomics.store(control, ControlIndex.Status, result.status);
	Atomics.store(control, ControlIndex.HeaderBytes, headers.byteLength);
	Atomics.store(control, ControlIndex.BodyBytes, result.body.byteLength);
	Atomics.store(control, ControlIndex.State, HttpBridgeState.Success);
	Atomics.notify(control, ControlIndex.State);
}

export function rejectHttpBridge(message: HttpBridgeRequestMessage, error: string): void {
	const { control, response } = bridgeViews(message);
	const encoded = new TextEncoder().encode(error);
	const length = Math.min(encoded.byteLength, HTTP_BRIDGE_HEADER_BYTES);
	response.set(encoded.subarray(0, length), 0);
	Atomics.store(control, ControlIndex.HeaderBytes, length);
	Atomics.store(control, ControlIndex.BodyBytes, 0);
	Atomics.store(control, ControlIndex.State, HttpBridgeState.Error);
	Atomics.notify(control, ControlIndex.State);
}

function bridgeViews(message: HttpBridgeRequestMessage): {
	control: Int32Array;
	response: Uint8Array;
} {
	if (
		!(message.control instanceof SharedArrayBuffer) ||
		message.control.byteLength !== Int32Array.BYTES_PER_ELEMENT * 4 ||
		!(message.response instanceof SharedArrayBuffer) ||
		message.response.byteLength !== HTTP_BRIDGE_HEADER_BYTES + HTTP_BRIDGE_BODY_BYTES
	) {
		throw new Error('DuckDB HTTP bridge buffers are invalid.');
	}
	return {
		control: new Int32Array(message.control),
		response: new Uint8Array(message.response),
	};
}

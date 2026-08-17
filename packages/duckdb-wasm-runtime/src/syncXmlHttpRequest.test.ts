import { describe, expect, it, vi } from 'vitest';
import type { MessagePort } from 'node:worker_threads';
import { resolveHttpBridge } from './httpBridge';
import type { HttpBridgeRequestMessage } from './httpBridge';
import { DUCKDB_EXTENSION_MANIFEST, DUCKDB_EXTENSION_ORIGIN } from './extensionManifest';
import { createSyncXmlHttpRequest } from './syncXmlHttpRequest';

function setup() {
	const requests: HttpBridgeRequestMessage[] = [];
	const postMessage = vi.fn((message: HttpBridgeRequestMessage) => {
		requests.push(message);
		resolveHttpBridge(message, {
			status: 206,
			headers: { 'content-range': 'bytes 0-1/10' },
			body: new Uint8Array([1, 2]),
		});
	});
	const XMLHttpRequest = createSyncXmlHttpRequest({
		port: { postMessage } as unknown as MessagePort,
		executionNonce: 'execution-nonce-1',
		timeoutMs: 1,
	});
	return { XMLHttpRequest, postMessage, requests };
}

describe('synchronous DuckDB XMLHttpRequest', () => {
	it('forwards only safe read headers and returns binary data', () => {
		const { XMLHttpRequest, requests } = setup();
		const request = new XMLHttpRequest();
		request.open('GET', 'https://objects.example.test/warehouse/data.parquet', false);
		request.setRequestHeader('Range', 'bytes=0-1');
		request.setRequestHeader('Authorization', 'Bearer worker-secret');
		request.setRequestHeader('X-Amz-Date', '20260814T120000Z');
		request.setRequestHeader('X-Iceberg-Access-Delegation', 'vended-credentials');
		request.responseType = 'arraybuffer';
		request.send(null);

		expect(requests[0].request).toEqual({
			url: 'https://objects.example.test/warehouse/data.parquet',
			method: 'GET',
			headers: { range: 'bytes=0-1' },
		});
		expect(requests[0].executionNonce).toBe('execution-nonce-1');
		expect(request.status).toBe(206);
		expect(new Uint8Array(request.response)).toEqual(new Uint8Array([1, 2]));
		expect(request.getResponseHeader('Content-Range')).toBe('bytes 0-1/10');
	});

	it('rejects asynchronous, write, and request-body traffic', () => {
		const { XMLHttpRequest, postMessage } = setup();
		const asyncRequest = new XMLHttpRequest();
		expect(() => asyncRequest.open('GET', 'https://example.test', true)).toThrow(
			'synchronous requests only',
		);

		const write = new XMLHttpRequest();
		write.open('POST', 'https://example.test', false);
		expect(() => write.send(null)).toThrow('method is not allowed');

		const body = new XMLHttpRequest();
		body.open('GET', 'https://example.test', false);
		expect(() => body.send('payload')).toThrow('request bodies are not allowed');
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('rejects remote requests outside an active execution capability', () => {
		const postMessage = vi.fn();
		const XMLHttpRequest = createSyncXmlHttpRequest({
			port: { postMessage } as unknown as MessagePort,
		});
		const request = new XMLHttpRequest();
		request.open('GET', 'https://catalog.example.test/v1/config', false);

		expect(() => request.send(null)).toThrow('no active execution capability');
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('denies extension names outside the pinned allowlist', () => {
		const { XMLHttpRequest, postMessage } = setup();
		const request = new XMLHttpRequest();
		request.open(
			'GET',
			'https://extensions.duckdb.org/v1.4.3/wasm_eh/spatial.duckdb_extension.wasm',
			false,
		);

		expect(() => request.send(null)).toThrow('extension is not allowlisted');
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('rejects a corrupt allowlisted extension before returning bytes', () => {
		const postMessage = vi.fn();
		const XMLHttpRequest = createSyncXmlHttpRequest({
			port: { postMessage } as unknown as MessagePort,
			loadExtension: () => new Uint8Array([1, 2, 3]),
		});
		const request = new XMLHttpRequest();
		request.open(
			'GET',
			`${DUCKDB_EXTENSION_ORIGIN}${DUCKDB_EXTENSION_MANIFEST.iceberg.file}`,
			false,
		);

		expect(() => request.send(null)).toThrow('checksum mismatch');
		expect(postMessage).not.toHaveBeenCalled();
	});
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MessagePort } from 'node:worker_threads';
import { DUCKDB_EXTENSION_MANIFEST, DUCKDB_EXTENSION_ORIGIN } from './extensionManifest.ts';
import type { DuckDBExtensionAsset } from './extensionManifest.ts';
import { createHttpBridgeBuffers, waitForHttpBridge } from './httpBridge.ts';
import type { HttpBridgeRequestMessage } from './httpBridge.ts';

const FORWARDED_HEADERS = new Set([
	'accept',
	'authorization',
	'content-type',
	'if-match',
	'if-modified-since',
	'if-none-match',
	'if-unmodified-since',
	'range',
	'x-amz-content-sha256',
	'x-amz-date',
	'x-amz-security-token',
]);

export interface SyncXmlHttpRequestOptions {
	port: MessagePort;
	executionNonce?: string;
	loadExtension?: (asset: DuckDBExtensionAsset) => Uint8Array;
	timeoutMs?: number;
}

export interface SyncXmlHttpRequest {
	status: number;
	responseType: XMLHttpRequestResponseType;
	response: ArrayBuffer;
	responseText: string;
	open(method: string, url: string | URL, async?: boolean): void;
	setRequestHeader(name: string, value: string): void;
	send(body?: unknown): void;
	getResponseHeader(name: string): string | null;
	getAllResponseHeaders(): string;
}

export type SyncXmlHttpRequestConstructor = new () => SyncXmlHttpRequest;

export function createSyncXmlHttpRequest(
	options: SyncXmlHttpRequestOptions,
): SyncXmlHttpRequestConstructor {
	const extensionCache = new Map<string, Uint8Array>();
	const loadExtension = options.loadExtension ?? defaultExtensionLoader;

	return class implements SyncXmlHttpRequest {
		status = 0;
		responseType: XMLHttpRequestResponseType = '';
		response: ArrayBuffer = new ArrayBuffer(0);
		responseText = '';
		private method = '';
		private url = '';
		private requestHeaders: Record<string, string> = {};
		private responseHeaders: Record<string, string> = {};

		open(method: string, url: string | URL, async = true): void {
			if (async) throw new Error('DuckDB HTTP bridge supports synchronous requests only.');
			this.method = method.toUpperCase();
			this.url = String(url);
		}

		setRequestHeader(name: string, value: string): void {
			const normalized = name.trim().toLowerCase();
			if (!normalized || /[\r\n]/.test(value)) {
				throw new Error('DuckDB HTTP bridge request header is invalid.');
			}
			if (FORWARDED_HEADERS.has(normalized)) this.requestHeaders[normalized] = value;
		}

		send(body?: unknown): void {
			const extension = extensionForUrl(this.url);
			if (extension) {
				if (this.method !== 'GET' || body != null) {
					throw new Error('DuckDB extension request is invalid.');
				}
				let bytes = extensionCache.get(extension.file);
				if (!bytes) {
					bytes = loadExtension(extension);
					assertChecksum(bytes, extension.sha256);
					extensionCache.set(extension.file, bytes);
				}
				this.status = 200;
				this.responseHeaders = { 'content-length': String(bytes.byteLength) };
				this.setResponse(bytes);
				return;
			}
			if (this.method !== 'GET' && this.method !== 'HEAD') {
				throw new Error('DuckDB HTTP bridge method is not allowed.');
			}
			if (body != null) throw new Error('DuckDB HTTP bridge request bodies are not allowed.');
			if (!options.executionNonce) {
				throw new Error('DuckDB HTTP bridge has no active execution capability.');
			}
			const { control, response } = createHttpBridgeBuffers();
			const message: HttpBridgeRequestMessage = {
				type: 'http-request',
				executionNonce: options.executionNonce,
				request: {
					url: this.url,
					method: this.method,
					headers: this.requestHeaders,
				},
				control,
				response,
			};
			options.port.postMessage(message);
			const result = waitForHttpBridge(control, response, options.timeoutMs);
			this.status = result.status;
			this.responseHeaders = result.headers;
			this.setResponse(result.body);
		}

		getResponseHeader(name: string): string | null {
			return this.responseHeaders[name.trim().toLowerCase()] ?? null;
		}

		getAllResponseHeaders(): string {
			return Object.entries(this.responseHeaders)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join('');
		}

		private setResponse(bytes: Uint8Array): void {
			this.response = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer;
			this.responseText = new TextDecoder().decode(bytes);
		}
	};
}

function extensionForUrl(url: string): DuckDBExtensionAsset | undefined {
	if (!url.startsWith(DUCKDB_EXTENSION_ORIGIN)) return undefined;
	const name = url.slice(DUCKDB_EXTENSION_ORIGIN.length).replace(/\.duckdb_extension\.wasm$/, '');
	const extension = DUCKDB_EXTENSION_MANIFEST[name];
	if (!extension || url !== `${DUCKDB_EXTENSION_ORIGIN}${extension.file}`) {
		throw new Error('DuckDB extension is not allowlisted.');
	}
	return extension;
}

function defaultExtensionLoader(asset: DuckDBExtensionAsset): Uint8Array {
	const url = import.meta.url.endsWith('.ts')
		? new URL(`../assets/extensions/${asset.file}`, import.meta.url)
		: new URL(`./${asset.file}`, import.meta.url);
	return readFileSync(fileURLToPath(url));
}

function assertChecksum(bytes: Uint8Array, expected: string): void {
	const actual = createHash('sha256').update(bytes).digest('hex');
	if (actual !== expected) throw new Error('DuckDB extension checksum mismatch.');
}

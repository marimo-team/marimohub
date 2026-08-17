import { createHmac, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DuckDBHttpAccess, Metrics } from '@marimo-hub/core';
import {
	HTTP_BRIDGE_BODY_BYTES,
	IcebergHttpBroker,
	IcebergHttpBrokerError,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import type {
	DuckDBHttpSessionFactory,
	IcebergHttpBrokerRequest,
	IcebergHttpBrokerTransport,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { createPinnedLookup } from '@marimo-hub/object-browser-commons';
import type { GuardedHostResolver } from '@marimo-hub/object-browser-commons';
import { createGuardedHostResolver } from './integrationProbe';

const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUESTS = 512;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_REDIRECTS = 8;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface DuckDBHttpBrokerOptions {
	allowPrivate?: boolean;
	metrics?: Metrics;
	now?: () => number;
	transport?: IcebergHttpBrokerTransport;
}

export function createDuckDBHttpSessionFactory(
	options: DuckDBHttpBrokerOptions = {},
): DuckDBHttpSessionFactory {
	const now = options.now ?? Date.now;
	const transport =
		options.transport ??
		createGuardedBinaryTransport({ allowPrivate: options.allowPrivate ?? false });
	return (access, sessionOptions) => {
		const broker = new IcebergHttpBroker(transport, now, undefined, options.metrics);
		const id = broker.open({
			expiresAtMs: sessionOptions.expiresAtMs,
			routes: routesFor(access, now),
			limits: {
				maxRequests: DEFAULT_MAX_REQUESTS,
				maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
				maxRedirects: DEFAULT_MAX_REDIRECTS,
				maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
				maxSingleResponseBytes: HTTP_BRIDGE_BODY_BYTES,
			},
		});
		return {
			fetch: (request, signal) => broker.fetch(id, request, signal),
			close: () => broker.close(id),
		};
	};
}

function routesFor(access: Readonly<DuckDBHttpAccess>, now: () => number) {
	if (access.kind !== 'iceberg-rest' || access.storage.kind !== 's3') {
		throw new IcebergHttpBrokerError(
			'invalid_capability',
			'DuckDB HTTP access specification is unsupported.',
		);
	}
	const endpoint = parseEndpoint(access.storage.endpoint);
	const credentials = access.storage.credentials;
	const prepareStorageHeaders =
		credentials.method === 'static'
			? (request: Readonly<IcebergHttpBrokerRequest>) =>
					Promise.resolve(
						signS3Request(request, {
							...credentials,
							region: access.storage.region,
							now: now(),
						}),
					)
			: undefined;
	return [
		{
			kind: 'catalog' as const,
			url: routePrefixUrl(access.catalog.url),
			match: 'prefix' as const,
			methods: ['GET', 'HEAD'] as const,
			headers: access.catalog.authorization
				? { authorization: access.catalog.authorization }
				: undefined,
		},
		...access.storage.locations.map((location) => ({
			kind: 'storage' as const,
			url: storagePrefixUrl(endpoint, location.bucket, location.prefix),
			match: 'prefix' as const,
			methods: ['GET', 'HEAD'] as const,
			prepareHeaders: prepareStorageHeaders,
		})),
	];
}

export function createGuardedBinaryTransport(options: {
	allowPrivate: boolean;
	timeoutMs?: number;
	resolveHost?: GuardedHostResolver;
}): IcebergHttpBrokerTransport {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
	const resolveHost =
		options.resolveHost ??
		createGuardedHostResolver({
			allowPrivate: options.allowPrivate,
			timeoutMs,
		});
	return async (request) => {
		const url = new URL(request.url);
		const deadlineMs = Math.min(request.deadlineMs, Date.now() + timeoutMs);
		const dnsSignal = deadlineSignal(request.signal, deadlineMs);
		const pinned = await resolveHost(url.hostname, dnsSignal);
		const signal = deadlineSignal(request.signal, deadlineMs);
		return new Promise((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				fn();
			};
			const requestOptions: RequestOptions & { autoSelectFamily?: boolean } = {
				method: request.method,
				headers: request.headers,
				lookup: createPinnedLookup(pinned),
				autoSelectFamily: true,
				agent: false,
				signal,
			};
			const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
				url,
				requestOptions,
				(response) => {
					const declared = Number(response.headers['content-length']);
					if (
						request.method !== 'HEAD' &&
						Number.isFinite(declared) &&
						declared > request.maxResponseBytes
					) {
						response.destroy();
						settle(() => reject(responseTooLarge()));
						return;
					}
					const chunks: Buffer[] = [];
					let total = 0;
					response.on('data', (chunk: Buffer) => {
						total += chunk.byteLength;
						if (total > request.maxResponseBytes) {
							response.destroy();
							settle(() => reject(responseTooLarge()));
							return;
						}
						chunks.push(chunk);
					});
					response.on('end', () =>
						settle(() =>
							resolve({
								status: response.statusCode ?? 0,
								headers: Object.fromEntries(
									Object.entries(response.headers).flatMap(([name, value]) =>
										value === undefined
											? []
											: [[name, Array.isArray(value) ? value.join(', ') : value]],
									),
								),
								body: new Uint8Array(Buffer.concat(chunks)),
							}),
						),
					);
					response.on('error', (error) => settle(() => reject(error)));
				},
			);
			outgoing.on('error', (error) => settle(() => reject(error)));
			outgoing.end();
		});
	};
}

interface StaticS3SigningOptions {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region: string;
	now: number;
}

export function signS3Request(
	request: Readonly<IcebergHttpBrokerRequest>,
	options: StaticS3SigningOptions,
): Record<string, string> {
	const url = new URL(request.url);
	const date = new Date(options.now).toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
	const day = date.slice(0, 8);
	const payloadHash = createHash('sha256').update('').digest('hex');
	const canonicalHeaders: Record<string, string> = {
		host: url.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': date,
		...(options.sessionToken ? { 'x-amz-security-token': options.sessionToken } : {}),
	};
	const signedHeaders = Object.keys(canonicalHeaders).sort();
	const canonicalRequest = [
		request.method,
		canonicalPath(url),
		canonicalQuery(url),
		signedHeaders.map((name) => `${name}:${canonicalHeaders[name].trim()}\n`).join(''),
		signedHeaders.join(';'),
		payloadHash,
	].join('\n');
	const scope = `${day}/${options.region}/s3/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		date,
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex'),
	].join('\n');
	const dateKey = hmac(`AWS4${options.secretAccessKey}`, day);
	const regionKey = hmac(dateKey, options.region);
	const serviceKey = hmac(regionKey, 's3');
	const signingKey = hmac(serviceKey, 'aws4_request');
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
	return {
		authorization:
			`AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
			`SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': date,
		...(options.sessionToken ? { 'x-amz-security-token': options.sessionToken } : {}),
	};
}

function parseEndpoint(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new IcebergHttpBrokerError('invalid_capability', 'S3 endpoint is invalid.');
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new IcebergHttpBrokerError('invalid_capability', 'S3 endpoint is invalid.');
	}
	return url;
}

function routePrefixUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new IcebergHttpBrokerError('invalid_capability', 'Catalog endpoint is invalid.');
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.search
	) {
		throw new IcebergHttpBrokerError('invalid_capability', 'Catalog endpoint is invalid.');
	}
	url.hash = '';
	return url.toString();
}

function storagePrefixUrl(endpoint: URL, bucket: string, prefix: string): string {
	const normalizedPrefix = prefix.replaceAll(/^\/+|\/+$/g, '');
	const segments = normalizedPrefix.split('/');
	if (
		!normalizedPrefix ||
		bucket.includes('/') ||
		bucket === '.' ||
		bucket === '..' ||
		segments.some((segment) => segment === '.' || segment === '..')
	) {
		throw new IcebergHttpBrokerError('invalid_capability', 'S3 read location is invalid.');
	}
	const url = new URL(endpoint);
	url.pathname = [
		url.pathname.replace(/\/$/, ''),
		encodeSegment(bucket),
		...segments.map(encodeSegment),
	].join('/');
	return url.toString();
}

function canonicalPath(url: URL): string {
	return url.pathname
		.split('/')
		.map((segment) => encodeSegment(decodeURIComponent(segment)))
		.join('/');
}

function canonicalQuery(url: URL): string {
	return [...url.searchParams.entries()]
		.map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
		.sort(([leftName, leftValue], [rightName, rightValue]) => {
			if (leftName !== rightName) return leftName < rightName ? -1 : 1;
			if (leftValue === rightValue) return 0;
			return leftValue < rightValue ? -1 : 1;
		})
		.map(([name, value]) => `${name}=${value}`)
		.join('&');
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function hmac(key: string | Buffer, value: string): Buffer {
	return createHmac('sha256', key).update(value).digest();
}

function responseTooLarge(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'response_budget_exceeded',
		'DuckDB HTTP broker response exceeded its byte limit.',
	);
}

function deadlineSignal(signal: AbortSignal | undefined, deadlineMs: number): AbortSignal {
	const remainingMs = deadlineMs - Date.now();
	if (remainingMs <= 0)
		return AbortSignal.abort(new Error('DuckDB HTTP broker request timed out.'));
	const timeout = AbortSignal.timeout(remainingMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

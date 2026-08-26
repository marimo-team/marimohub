import { createHmac, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { noopMetrics } from '@marimo-hub/core';
import type { DuckDBHttpAccess, Metrics } from '@marimo-hub/core';
import {
	HTTP_BRIDGE_BODY_BYTES,
	IcebergHttpBroker,
	IcebergHttpBrokerError,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import type {
	DuckDBHttpSessionFactory,
	IcebergHttpBrokerRequest,
	IcebergHttpBrokerRoute,
	IcebergHttpBrokerTransport,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { createPinnedLookup } from '@marimo-hub/object-browser-commons';
import type { GuardedHostResolver } from '@marimo-hub/object-browser-commons';
import { createGuardedHostResolver, createGuardedProbe } from './integrationProbe';

const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUESTS = 512;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_REDIRECTS = 8;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_OAUTH_TOKEN_TIMEOUT_MS = 10_000;
const OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;
const OAUTH_MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60;
const OAUTH_REFRESH_RETRY_BACKOFF_MS = 1_000;
const VENDED_S3_REQUEST_HEADERS = [
	'authorization',
	'x-amz-content-sha256',
	'x-amz-date',
	'x-amz-security-token',
] as const;

export interface DuckDBHttpBrokerOptions {
	allowPrivate?: boolean;
	metrics?: Metrics;
	now?: () => number;
	transport?: IcebergHttpBrokerTransport;
	oauthTokenExchange?: OAuthTokenExchange;
}

export interface OAuthTokenExchangeRequest {
	tokenEndpoint: string;
	clientId: string;
	clientSecret: string;
	scope: string;
	fallbackExpiresInSeconds?: number;
	allowInsecureTransport?: boolean;
}

export interface OAuthTokenExchangeResult {
	accessToken: string;
	expiresInSeconds: number;
}

export type OAuthTokenExchange = (
	request: Readonly<OAuthTokenExchangeRequest>,
	signal?: AbortSignal,
) => Promise<OAuthTokenExchangeResult>;

export function createDuckDBHttpSessionFactory(
	options: DuckDBHttpBrokerOptions = {},
): DuckDBHttpSessionFactory {
	const now = options.now ?? Date.now;
	const transport =
		options.transport ??
		createGuardedBinaryTransport({ allowPrivate: options.allowPrivate ?? false });
	const oauthTokenExchange =
		options.oauthTokenExchange ??
		createGuardedOAuthTokenExchange({
			allowPrivate: options.allowPrivate ?? false,
			metrics: options.metrics,
		});
	return (access, sessionOptions) => {
		const oauthProvider =
			access.kind === 'iceberg-rest' && access.catalog.oauth2
				? createOAuthTokenProvider({
						auth: access.catalog.oauth2,
						exchange: oauthTokenExchange,
						metrics: options.metrics,
						now,
						sessionExpiresAtMs: sessionOptions.expiresAtMs,
						allowInsecureTransport: access.allowInsecureTransport === true,
					})
				: undefined;
		const broker = new IcebergHttpBroker(transport, now, undefined, options.metrics);
		const id = broker.open({
			expiresAtMs: sessionOptions.expiresAtMs,
			routes: routesFor(access, now, oauthProvider),
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
			close: () => {
				oauthProvider?.close();
				broker.close(id);
			},
		};
	};
}

interface OAuthTokenProvider {
	authorization(signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
	close(): void;
}

function routesFor(
	access: Readonly<DuckDBHttpAccess>,
	now: () => number,
	oauthProvider?: OAuthTokenProvider,
) {
	if (access.kind === 's3-object-store') {
		return s3RoutesFor(access, now, access.allowInsecureTransport === true);
	}
	if (access.kind !== 'iceberg-rest') {
		throw new IcebergHttpBrokerError(
			'invalid_capability',
			'DuckDB HTTP access is not supported. Use an S3 or Iceberg REST integration.',
		);
	}
	if (
		(access.catalog.authorization !== undefined && access.catalog.oauth2 !== undefined) ||
		(access.catalog.oauth2 !== undefined) !== (oauthProvider !== undefined)
	) {
		throw new IcebergHttpBrokerError(
			'invalid_capability',
			'Catalog authentication is invalid. Configure either a bearer token or OAuth2 client credentials, not both.',
		);
	}
	const catalogUrl = routePrefixUrl(access.catalog.url);
	assertCredentialTransport(
		catalogUrl,
		access.catalog.authorization !== undefined || access.catalog.oauth2 !== undefined,
		access.allowInsecureTransport === true,
		'Catalog',
	);
	const catalog: IcebergHttpBrokerRoute = {
		kind: 'catalog' as const,
		url: catalogUrl,
		match: 'prefix' as const,
		methods: ['GET', 'HEAD'] as const,
		headers: access.catalog.authorization
			? { authorization: access.catalog.authorization }
			: undefined,
		prepareHeaders: oauthProvider
			? (_request: Readonly<IcebergHttpBrokerRequest>, signal?: AbortSignal) =>
					oauthProvider.authorization(signal)
			: undefined,
		discardRequestHeaders: ['authorization'] as const,
	};
	const storage = access.storage;
	if (storage.kind === 'r2-catalog') {
		const endpoint = parseEndpoint(storage.endpoint);
		const pathStorageUrl = storagePrefixUrl(endpoint, storage.bucket, '', 'path', true);
		const r2Catalog: IcebergHttpBrokerRoute = {
			...catalog,
			headers: {
				...catalog.headers,
				'x-iceberg-access-delegation': 'vended-credentials',
			},
		};
		const storageRoutes: IcebergHttpBrokerRoute[] = [
			{
				kind: 'storage' as const,
				url: pathStorageUrl,
				match: 'prefix' as const,
				methods: ['GET', 'HEAD'] as const,
				forwardRequestHeaders: VENDED_S3_REQUEST_HEADERS,
			},
			...(isDnsCompatibleS3Bucket(storage.bucket) && !isIpAddressHost(endpoint.hostname)
				? [
						{
							kind: 'storage' as const,
							url: storagePrefixUrl(endpoint, storage.bucket, '', 'vhost', true),
							match: 'prefix' as const,
							methods: ['GET', 'HEAD'] as const,
							forwardRequestHeaders: VENDED_S3_REQUEST_HEADERS,
						},
					]
				: []),
		];
		return catalogAndStorageRoutes(r2Catalog, storageRoutes);
	}
	return catalogAndStorageRoutes(
		catalog,
		s3RoutesFor(storage, now, access.allowInsecureTransport === true),
	);
}

interface S3RouteAccess {
	endpoint: string;
	region: string;
	urlStyle: 'path' | 'vhost';
	credentials:
		| { method: 'anonymous' }
		| {
				method: 'static';
				accessKeyId: string;
				secretAccessKey: string;
				sessionToken?: string;
		  };
	locations: readonly { bucket: string; prefix: string }[];
}

function s3RoutesFor(
	storage: Readonly<S3RouteAccess>,
	now: () => number,
	allowInsecureTransport: boolean,
): IcebergHttpBrokerRoute[] {
	const endpoint = parseEndpoint(storage.endpoint);
	const credentials = storage.credentials;
	assertCredentialTransport(
		endpoint.toString(),
		credentials.method === 'static',
		allowInsecureTransport,
		'S3',
	);
	const prepareStorageHeaders =
		credentials.method === 'static'
			? (request: Readonly<IcebergHttpBrokerRequest>) =>
					Promise.resolve(
						signS3Request(request, {
							...credentials,
							region: storage.region,
							now: now(),
						}),
					)
			: undefined;
	return storage.locations.map((location) => ({
		kind: 'storage' as const,
		url: storagePrefixUrl(endpoint, location.bucket, location.prefix, storage.urlStyle),
		match: 'prefix' as const,
		methods: ['GET', 'HEAD'] as const,
		prepareHeaders: prepareStorageHeaders,
		discardRequestHeaders: VENDED_S3_REQUEST_HEADERS,
	}));
}

export function createGuardedOAuthTokenExchange(options: {
	allowPrivate: boolean;
	timeoutMs?: number;
	metrics?: Metrics;
}): OAuthTokenExchange {
	const metrics = options.metrics ?? noopMetrics;
	const probe = createGuardedProbe({
		allowPrivate: options.allowPrivate,
		timeoutMs: options.timeoutMs ?? DEFAULT_OAUTH_TOKEN_TIMEOUT_MS,
		maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
		maxProbesPerMinute: DEFAULT_MAX_REQUESTS,
	});
	return async (request, signal) => {
		try {
			const endpoint = parseOAuthEndpoint(
				request.tokenEndpoint,
				request.allowInsecureTransport === true,
			);
			const response = await probe.fetch(endpoint.toString(), {
				method: 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Basic ${Buffer.from(`${request.clientId}:${request.clientSecret}`).toString('base64')}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					...(request.scope ? { scope: request.scope } : {}),
				}).toString(),
				signal,
			});
			if (!response.ok) throw oauthFailure('status', response.status);
			const body = await response.json();
			if (typeof body !== 'object' || body === null || Array.isArray(body)) {
				throw oauthFailure('response');
			}
			const token = (body as Record<string, unknown>).access_token;
			const tokenType = (body as Record<string, unknown>).token_type;
			const rawExpiresIn = (body as Record<string, unknown>).expires_in;
			const expiresIn = rawExpiresIn ?? request.fallbackExpiresInSeconds;
			if (
				typeof token !== 'string' ||
				token.length === 0 ||
				(tokenType !== undefined &&
					(typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) ||
				typeof expiresIn !== 'number' ||
				!Number.isFinite(expiresIn) ||
				expiresIn < 1 ||
				expiresIn > OAUTH_MAX_EXPIRES_IN_SECONDS
			) {
				throw oauthFailure('response');
			}
			metrics.increment('duckdb_http_broker.oauth_exchange', 1, { outcome: 'success' });
			return { accessToken: token, expiresInSeconds: expiresIn };
		} catch (error) {
			const reason =
				error instanceof OAuthTokenError
					? error.reason
					: signal?.aborted
						? 'cancelled'
						: 'transport';
			metrics.increment('duckdb_http_broker.oauth_exchange', 1, {
				outcome: 'failure',
				reason,
			});
			if (error instanceof OAuthTokenError) throw error;
			throw oauthFailure(signal?.aborted ? 'cancelled' : 'transport');
		}
	};
}

type OAuthFailureReason =
	| 'cancelled'
	| 'endpoint'
	| 'insecure_transport'
	| 'response'
	| 'session'
	| 'status'
	| 'transport';

class OAuthTokenError extends IcebergHttpBrokerError {
	constructor(
		readonly reason: OAuthFailureReason,
		message: string,
	) {
		super('credential_failed', message);
		this.name = 'OAuthTokenError';
	}
}

function createOAuthTokenProvider(options: {
	auth: NonNullable<Extract<DuckDBHttpAccess, { kind: 'iceberg-rest' }>['catalog']['oauth2']>;
	exchange: OAuthTokenExchange;
	metrics?: Metrics;
	now: () => number;
	sessionExpiresAtMs: number;
	allowInsecureTransport: boolean;
}): OAuthTokenProvider {
	let cached: { token: string; expiresAtMs: number } | undefined;
	let refresh: Promise<string> | undefined;
	let retryAfterMs = 0;
	let closed = false;
	const controller = new AbortController();
	const metrics = options.metrics ?? noopMetrics;
	const tokenEndpoint = parseOAuthEndpoint(
		options.auth.tokenEndpoint,
		options.allowInsecureTransport,
	).toString();

	const exchange = async (signal?: AbortSignal): Promise<string> => {
		const remainingMs = options.sessionExpiresAtMs - options.now();
		if (closed || remainingMs <= 0) throw oauthFailure('session');
		const lifecycleSignal = signal
			? AbortSignal.any([signal, controller.signal])
			: controller.signal;
		const combinedSignal = deadlineSignal(
			lifecycleSignal,
			options.sessionExpiresAtMs,
			options.now(),
		);
		try {
			const result = await options.exchange(
				{
					tokenEndpoint,
					clientId: options.auth.clientId,
					clientSecret: options.auth.clientSecret,
					scope: options.auth.scope,
					fallbackExpiresInSeconds: options.auth.fallbackExpiresInSeconds,
					allowInsecureTransport: options.allowInsecureTransport,
				},
				combinedSignal,
			);
			if (closed || options.now() >= options.sessionExpiresAtMs) throw oauthFailure('session');
			const issuedAtMs = options.now();
			cached = {
				token: result.accessToken,
				expiresAtMs: Math.min(
					options.sessionExpiresAtMs,
					issuedAtMs + result.expiresInSeconds * 1000,
				),
			};
			retryAfterMs = 0;
			metrics.increment('duckdb_http_broker.oauth_refresh', 1, { outcome: 'success' });
			return cached.token;
		} catch (error) {
			retryAfterMs = Math.min(
				options.sessionExpiresAtMs,
				options.now() + OAUTH_REFRESH_RETRY_BACKOFF_MS,
			);
			metrics.increment('duckdb_http_broker.oauth_refresh', 1, { outcome: 'failure' });
			if (!closed && cached && options.now() < cached.expiresAtMs) {
				metrics.increment('duckdb_http_broker.oauth_token', 1, { source: 'stale-cache' });
				return cached.token;
			}
			if (error instanceof OAuthTokenError) throw error;
			if (combinedSignal.aborted) {
				throw oauthFailure(lifecycleSignal.aborted ? 'cancelled' : 'session');
			}
			throw oauthFailure('transport');
		}
	};

	return {
		async authorization(signal) {
			const currentTime = options.now();
			if (closed || currentTime >= options.sessionExpiresAtMs) throw oauthFailure('session');
			const refreshAtMs = (cached?.expiresAtMs ?? 0) - options.auth.refreshMarginSeconds * 1000;
			if (cached && currentTime < refreshAtMs) {
				metrics.increment('duckdb_http_broker.oauth_token', 1, { source: 'cache' });
				return { authorization: `Bearer ${cached.token}` };
			}
			if (currentTime < retryAfterMs) {
				if (cached && currentTime < cached.expiresAtMs) {
					metrics.increment('duckdb_http_broker.oauth_token', 1, { source: 'stale-cache' });
					return { authorization: `Bearer ${cached.token}` };
				}
				throw new OAuthTokenError(
					'transport',
					'OAuth2 token refresh failed recently. Retry the query in one second.',
				);
			}
			refresh ??= exchange(signal).finally(() => {
				refresh = undefined;
			});
			const token = await refresh;
			return { authorization: `Bearer ${token}` };
		},
		close() {
			closed = true;
			cached = undefined;
			retryAfterMs = 0;
			controller.abort();
		},
	};
}

function parseOAuthEndpoint(value: string, allowInsecureTransport: boolean): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw oauthFailure('endpoint');
	}
	if (url.protocol === 'http:' && !allowInsecureTransport) {
		throw oauthFailure('insecure_transport');
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw oauthFailure('endpoint');
	}
	return url;
}

function oauthFailure(reason: OAuthFailureReason, status?: number): OAuthTokenError {
	switch (reason) {
		case 'endpoint':
			return new OAuthTokenError(
				reason,
				'OAuth2 token endpoint is invalid. Use an HTTP or HTTPS URL without embedded credentials or a fragment.',
			);
		case 'insecure_transport':
			return new OAuthTokenError(
				reason,
				'OAuth2 token endpoint uses HTTP. Use HTTPS, or enable allow_insecure_transport for local development.',
			);
		case 'status':
			return new OAuthTokenError(reason, oauthStatusMessage(status));
		case 'response':
			return new OAuthTokenError(
				reason,
				'OAuth2 token endpoint returned an invalid response. Make sure that access_token is non-empty and the expiry is between 1 and 86400 seconds.',
			);
		case 'cancelled':
			return new OAuthTokenError(
				reason,
				'OAuth2 token request stopped because the DuckDB request ended or reached its deadline. Retry the query.',
			);
		case 'session':
			return new OAuthTokenError(
				reason,
				'OAuth2 token request did not finish before the DuckDB session ended. Retry the query.',
			);
		case 'transport':
			return new OAuthTokenError(
				reason,
				'OAuth2 token endpoint was not reachable. Make sure that DNS, TLS, and the integration egress policy are correct.',
			);
	}
}

function oauthStatusMessage(status: number | undefined): string {
	if (status === 401 || status === 403) {
		return `OAuth2 token endpoint returned HTTP ${status} for the credentials. Make sure that the client ID, client secret, and scope are correct.`;
	}
	if (status === 429) {
		return 'OAuth2 token endpoint returned HTTP 429. The identity service limited requests. Retry the query later.';
	}
	if (status !== undefined && status >= 500) {
		return `OAuth2 token endpoint returned HTTP ${status}. The identity service is unavailable. Retry the query later.`;
	}
	return `OAuth2 token endpoint returned HTTP ${status ?? 'error'}. Make sure that the endpoint and OAuth2 configuration are correct.`;
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
		throw invalidS3Endpoint();
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw invalidS3Endpoint();
	}
	return url;
}

function routePrefixUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidCatalogEndpoint();
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.search
	) {
		throw invalidCatalogEndpoint();
	}
	url.hash = '';
	return url.toString();
}

function catalogAndStorageRoutes(
	catalog: IcebergHttpBrokerRoute,
	storage: readonly IcebergHttpBrokerRoute[],
): IcebergHttpBrokerRoute[] {
	if (storage.some((route) => prefixRoutesOverlap(catalog.url, route.url))) {
		throw new IcebergHttpBrokerError(
			'invalid_capability',
			'Catalog and S3 routes overlap. Change the catalog path, S3 endpoint, bucket, or guarded read prefix.',
		);
	}
	return [catalog, ...storage];
}

function prefixRoutesOverlap(left: string, right: string): boolean {
	const leftUrl = new URL(left);
	const rightUrl = new URL(right);
	if (leftUrl.origin !== rightUrl.origin) return false;
	const leftPrefix = leftUrl.pathname.replace(/\/$/, '');
	const rightPrefix = rightUrl.pathname.replace(/\/$/, '');
	return (
		leftPrefix === rightPrefix ||
		leftPrefix.startsWith(`${rightPrefix}/`) ||
		rightPrefix.startsWith(`${leftPrefix}/`)
	);
}

function assertCredentialTransport(
	value: string,
	authenticated: boolean,
	allowInsecureTransport: boolean,
	label: 'Catalog' | 'S3',
): void {
	if (!authenticated || allowInsecureTransport || new URL(value).protocol === 'https:') return;
	throw new IcebergHttpBrokerError(
		'invalid_capability',
		`${label} credentials require HTTPS. Use HTTPS, or enable allow_insecure_transport for local development.`,
	);
}

function storagePrefixUrl(
	endpoint: URL,
	bucket: string,
	prefix: string,
	urlStyle: 'path' | 'vhost',
	allowEmptyPrefix = false,
): string {
	const normalizedPrefix = prefix.replaceAll(/^\/+|\/+$/g, '');
	const segments = normalizedPrefix ? normalizedPrefix.split('/') : [];
	if (
		(!normalizedPrefix && !allowEmptyPrefix) ||
		!bucket ||
		bucket.includes('/') ||
		bucket.includes('\\') ||
		bucket === '.' ||
		bucket === '..' ||
		segments.some((segment) => segment === '.' || segment === '..')
	) {
		throw new IcebergHttpBrokerError(
			'invalid_capability',
			'S3 read location is invalid. Use a valid bucket and a non-empty prefix without path traversal.',
		);
	}
	const url = new URL(endpoint);
	if (urlStyle === 'vhost') {
		if (!isDnsCompatibleS3Bucket(bucket) || isIpAddressHost(endpoint.hostname)) {
			throw new IcebergHttpBrokerError(
				'invalid_capability',
				'Virtual-hosted S3 requires a DNS bucket and endpoint. Use path-style addressing for IP endpoints or non-DNS buckets.',
			);
		}
		url.hostname = `${bucket}.${endpoint.hostname}`;
		url.pathname = [url.pathname.replace(/\/$/, ''), ...segments.map(encodeSegment)].join('/');
	} else if (urlStyle === 'path') {
		url.pathname = [
			url.pathname.replace(/\/$/, ''),
			encodeSegment(bucket),
			...segments.map(encodeSegment),
		].join('/');
	} else {
		throw new IcebergHttpBrokerError(
			'invalid_capability',
			'S3 URL style is invalid. Use path or vhost.',
		);
	}
	return url.toString();
}

function invalidS3Endpoint(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'invalid_capability',
		'S3 endpoint is invalid. Use an HTTP or HTTPS origin without credentials, a path, query parameters, or a fragment.',
	);
}

function invalidCatalogEndpoint(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'invalid_capability',
		'Catalog endpoint is invalid. Use an HTTP or HTTPS URL without embedded credentials or query parameters.',
	);
}

function isDnsCompatibleS3Bucket(bucket: string): boolean {
	return (
		bucket.length >= 3 &&
		bucket.length <= 63 &&
		/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) &&
		!bucket.includes('..') &&
		!isIpv4Address(bucket)
	);
}

function isIpAddressHost(hostname: string): boolean {
	return hostname.includes(':') || isIpv4Address(hostname);
}

function isIpv4Address(value: string): boolean {
	const octets = value.split('.');
	return (
		octets.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
	);
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

function deadlineSignal(
	signal: AbortSignal | undefined,
	deadlineMs: number,
	now = Date.now(),
): AbortSignal {
	const remainingMs = deadlineMs - now;
	if (remainingMs <= 0)
		return AbortSignal.abort(new Error('DuckDB HTTP broker request timed out.'));
	const timeout = AbortSignal.timeout(Math.min(remainingMs, 2_147_483_647));
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

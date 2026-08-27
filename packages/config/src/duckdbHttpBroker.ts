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
	IcebergHttpBrokerObservedResponse,
	IcebergHttpBrokerRequest,
	IcebergHttpBrokerRouteInstaller,
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
const DATABASE_FULL_RESPONSE_BYTES = 1024 * 1024;
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
const MAX_VENDED_CREDENTIALS = 32;
const MAX_CREDENTIAL_JSON_DEPTH = 64;
const MAX_CREDENTIAL_JSON_ITEMS = 100_000;
const MAX_CREDENTIAL_JSON_STRING_LENGTH = 1024 * 1024;

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
			routes: routesFor(access, now, oauthProvider, options.metrics ?? noopMetrics),
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
	authorization(): Promise<Readonly<Record<string, string>>>;
	close(): void;
}

function routesFor(
	access: Readonly<DuckDBHttpAccess>,
	now: () => number,
	oauthProvider?: OAuthTokenProvider,
	metrics: Metrics = noopMetrics,
) {
	if (access.kind === 'http-database') {
		return [databaseRouteFor(access, metrics)];
	}
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
		prepareHeaders: oauthProvider ? () => oauthProvider.authorization() : undefined,
		discardRequestHeaders: ['authorization'] as const,
	};
	const storage = access.storage;
	if (storage.kind === 'vended-s3') {
		const endpoint = parseEndpoint(storage.endpoint);
		assertCredentialTransport(endpoint.toString(), true, false, 'S3');
		const vendedCatalog: IcebergHttpBrokerRoute = {
			...catalog,
			headers: {
				...catalog.headers,
				'x-iceberg-access-delegation': 'vended-credentials',
			},
			observeResponse: createVendedS3ResponseObserver({
				endpoint,
				urlStyle: storage.urlStyle,
				allowedLocations: storage.allowedLocations,
				metrics,
			}),
		};
		return catalogAndStorageRoutes(vendedCatalog, []);
	}
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

function databaseRouteFor(
	access: Readonly<Extract<DuckDBHttpAccess, { kind: 'http-database' }>>,
	metrics: Metrics,
): IcebergHttpBrokerRoute {
	let url: URL;
	try {
		url = new URL(access.url);
	} catch {
		throw invalidDatabaseCapability();
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.toString() !== access.url
	) {
		throw invalidDatabaseCapability();
	}
	const policy = createDatabaseResponsePolicy(metrics);
	return {
		kind: 'storage',
		url: access.url,
		match: 'exact',
		methods: ['GET', 'HEAD'],
		...(access.authorization ? { headers: { authorization: access.authorization } } : {}),
		prepareHeaders: policy.prepareHeaders,
		discardRequestHeaders: ['authorization', 'if-match'],
		observeResponse: policy.observeResponse,
	};
}

function invalidDatabaseCapability(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'invalid_capability',
		'DuckDB database access requires one normalized exact HTTPS object URL.',
	);
}

function createDatabaseResponsePolicy(metrics: Metrics) {
	let strongEtag: string | undefined;
	return {
		prepareHeaders: (): Promise<Readonly<Record<string, string>>> => {
			const headers: Record<string, string> = strongEtag ? { 'if-match': strongEtag } : {};
			return Promise.resolve(headers);
		},
		observeResponse(response: Readonly<IcebergHttpBrokerObservedResponse>): void {
			if (isRedirectStatus(response.status)) {
				recordDatabasePolicy(metrics, 'redirect', 'denied');
				throw new IcebergHttpBrokerError(
					'redirect_denied',
					'The remote DuckDB database redirected to another URL. Use a stable direct object URL.',
				);
			}
			if (response.status === 412) {
				recordDatabasePolicy(metrics, 'etag', 'changed');
				throw objectChanged();
			}
			validateDatabaseRangeResponse(response, metrics);
			if (!isSuccessfulStatus(response.status)) return;
			const etag = response.headers.etag;
			if (!isStrongEtag(etag)) {
				recordDatabasePolicy(metrics, 'etag', etag?.startsWith('W/') ? 'weak' : 'missing');
				throw new IcebergHttpBrokerError(
					'strong_etag_required',
					'The remote DuckDB database did not return a strong ETag. Serve immutable snapshots with a strong ETag.',
				);
			}
			if (strongEtag === undefined) {
				strongEtag = etag;
				recordDatabasePolicy(metrics, 'etag', 'captured');
			} else if (strongEtag !== etag) {
				recordDatabasePolicy(metrics, 'etag', 'changed');
				throw objectChanged();
			} else {
				recordDatabasePolicy(metrics, 'etag', 'matched');
			}
		},
	};
}

function validateDatabaseRangeResponse(
	response: Readonly<IcebergHttpBrokerObservedResponse>,
	metrics: Metrics,
): void {
	if (!isSuccessfulStatus(response.status)) return;
	const contentType = response.headers['content-type']?.toLowerCase();
	if (contentType?.startsWith('multipart/byteranges')) {
		throw invalidRange(metrics, 'multipart');
	}
	const rawRange = response.request.headers?.range;
	if (rawRange === undefined) {
		if (response.status !== 200) throw invalidRange(metrics, 'status');
		if (response.request.method === 'GET') assertContentLength(response, metrics);
		return;
	}
	const requested = /^bytes=(\d+)-(\d*)$/.exec(rawRange);
	if (!requested) throw invalidRange(metrics, 'request');
	if (response.request.method === 'HEAD') {
		if (response.status !== 200 && response.status !== 206) {
			throw invalidRange(metrics, 'status');
		}
		if (response.status === 206) {
			assertRequestedContentRange(
				parseContentRange(response.headers['content-range'], metrics),
				requested,
				metrics,
			);
		}
		return;
	}
	if (response.status === 200) {
		assertContentLength(response, metrics);
		if (response.body.byteLength > DATABASE_FULL_RESPONSE_BYTES) {
			throw invalidRange(metrics, 'full_response');
		}
		recordDatabasePolicy(metrics, 'range', 'full_response');
		return;
	}
	if (response.status !== 206) throw invalidRange(metrics, 'status');
	const contentRange = parseContentRange(response.headers['content-range'], metrics);
	assertRequestedContentRange(contentRange, requested, metrics);
	if (response.body.byteLength !== contentRange.end - contentRange.start + 1) {
		throw invalidRange(metrics, 'content_range');
	}
	assertContentLength(response, metrics);
	recordDatabasePolicy(metrics, 'range', 'partial');
}

function assertRequestedContentRange(
	contentRange: { start: number; end: number; size: number },
	requested: RegExpExecArray,
	metrics: Metrics,
): void {
	const requestedStart = Number(requested[1]);
	const requestedEnd = requested[2] === '' ? undefined : Number(requested[2]);
	if (
		contentRange.start !== requestedStart ||
		(requestedEnd !== undefined && contentRange.end > requestedEnd) ||
		contentRange.end >= contentRange.size
	) {
		throw invalidRange(metrics, 'content_range');
	}
}

function parseContentRange(value: string | undefined, metrics: Metrics) {
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
	if (!match) throw invalidRange(metrics, 'content_range');
	const start = Number(match[1]);
	const end = Number(match[2]);
	const size = Number(match[3]);
	if (![start, end, size].every(Number.isSafeInteger) || start < 0 || end < start || size < 1) {
		throw invalidRange(metrics, 'content_range');
	}
	return { start, end, size };
}

function assertContentLength(
	response: Readonly<IcebergHttpBrokerObservedResponse>,
	metrics: Metrics,
): void {
	const raw = response.headers['content-length'];
	if (raw === undefined) return;
	const length = Number(raw);
	if (!Number.isSafeInteger(length) || length < 0 || length !== response.body.byteLength) {
		throw invalidRange(metrics, 'content_length');
	}
}

function invalidRange(metrics: Metrics, outcome: string): IcebergHttpBrokerError {
	recordDatabasePolicy(metrics, 'range', outcome);
	return new IcebergHttpBrokerError(
		'range_invalid',
		'The remote DuckDB database returned invalid byte-range metadata. Serve single byte ranges with consistent Content-Range and Content-Length headers.',
	);
}

function objectChanged(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'object_changed',
		'The remote DuckDB database changed during the query. Retry against an immutable versioned URL.',
	);
}

function isStrongEtag(value: string | undefined): boolean {
	return (
		value !== undefined && !value.startsWith('W/') && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)
	);
}

function isSuccessfulStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function recordDatabasePolicy(
	metrics: Metrics,
	policy: 'etag' | 'range' | 'redirect',
	outcome: string,
) {
	metrics.increment('duckdb_http_database.policy', 1, { policy, outcome });
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

function createVendedS3ResponseObserver(options: {
	endpoint: URL;
	urlStyle: 'path' | 'vhost';
	allowedLocations: readonly { bucket: string; prefix: string }[];
	metrics: Metrics;
}) {
	return (
		response: Readonly<IcebergHttpBrokerObservedResponse>,
		installer: IcebergHttpBrokerRouteInstaller,
	): void => {
		if (!isVendedCredentialResponse(response)) return;
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
			assertBoundedCredentialJson(body);
		} catch {
			recordDynamicRouteOutcome(options.metrics, 'malformed');
			return;
		}
		const credentials = asJsonRecord(body)?.['storage-credentials'];
		if (
			!Array.isArray(credentials) ||
			credentials.length === 0 ||
			credentials.length > MAX_VENDED_CREDENTIALS
		) {
			recordDynamicRouteOutcome(options.metrics, 'malformed');
			return;
		}

		const locations: { bucket: string; prefix: string }[] = [];
		for (const credential of credentials) {
			const prefix = asJsonRecord(credential)?.prefix;
			if (typeof prefix !== 'string') {
				recordDynamicRouteOutcome(options.metrics, 'malformed');
				return;
			}
			const parsed = parseVendedS3Location(prefix);
			if (parsed === 'unsupported') {
				recordDynamicRouteOutcome(options.metrics, 'unsupported_scheme');
				throw new IcebergHttpBrokerError(
					'target_denied',
					'The catalog returned credentials for an unsupported storage scheme.',
				);
			}
			if (parsed === undefined) {
				recordDynamicRouteOutcome(options.metrics, 'malformed');
				return;
			}
			if (!mostSpecificBound(parsed, options.allowedLocations)) {
				recordDynamicRouteOutcome(options.metrics, 'outside_bound');
				throw new IcebergHttpBrokerError(
					'target_denied',
					'The catalog returned an S3 location outside the administrator-owned storage bounds.',
				);
			}
			locations.push(parsed);
		}

		const styles: ('path' | 'vhost')[] =
			options.urlStyle === 'vhost' ? ['vhost', 'path'] : ['path', 'vhost'];
		const routes = locations.flatMap((location) =>
			styles.flatMap((urlStyle): IcebergHttpBrokerRoute[] => {
				if (urlStyle === 'vhost' && isIpAddressHost(options.endpoint.hostname)) return [];
				return [
					{
						kind: 'storage',
						url: storagePrefixUrl(
							options.endpoint,
							location.bucket,
							location.prefix,
							urlStyle,
							true,
						),
						match: 'prefix',
						methods: ['GET', 'HEAD'],
						forwardRequestHeaders: VENDED_S3_REQUEST_HEADERS,
					},
				];
			}),
		);
		installer.install(routes);
	};
}

function isVendedCredentialResponse(
	response: Readonly<IcebergHttpBrokerObservedResponse>,
): boolean {
	if (
		response.request.method !== 'GET' ||
		response.status < 200 ||
		response.status >= 300 ||
		!isJsonContentType(response.headers['content-type'])
	) {
		return false;
	}
	const path = new URL(response.request.url).pathname.replace(/\/$/, '');
	return /\/namespaces\/[^/]+\/tables\/[^/]+(?:\/credentials)?$/.test(path);
}

function isJsonContentType(value: string | undefined): boolean {
	const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
	return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

function assertBoundedCredentialJson(value: unknown): void {
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let items = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		items += 1;
		if (items > MAX_CREDENTIAL_JSON_ITEMS || current.depth > MAX_CREDENTIAL_JSON_DEPTH) {
			throw new Error('Credential response structure exceeds its limit.');
		}
		if (typeof current.value === 'string') {
			if (current.value.length > MAX_CREDENTIAL_JSON_STRING_LENGTH) {
				throw new Error('Credential response string exceeds its limit.');
			}
			continue;
		}
		if (Array.isArray(current.value)) {
			for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
			continue;
		}
		const record = asJsonRecord(current.value);
		if (!record) continue;
		for (const [key, child] of Object.entries(record)) {
			if (key.length > MAX_CREDENTIAL_JSON_STRING_LENGTH) {
				throw new Error('Credential response key exceeds its limit.');
			}
			pending.push({ value: child, depth: current.depth + 1 });
		}
	}
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseVendedS3Location(
	value: string,
): { bucket: string; prefix: string } | 'unsupported' | undefined {
	if (!value.toLowerCase().startsWith('s3:')) return 'unsupported';
	if (!value.startsWith('s3://') || value.includes('\\') || /%2f|%5c/i.test(value)) {
		return undefined;
	}
	if (hasUnpairedSurrogate(value)) return undefined;
	const withoutScheme = value.slice('s3://'.length);
	const separator = withoutScheme.search(/[/?#]/);
	const authority = separator === -1 ? withoutScheme : withoutScheme.slice(0, separator);
	if (!isDnsCompatibleS3Bucket(authority)) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (
		url.protocol !== 's3:' ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash ||
		url.hostname !== authority
	) {
		return undefined;
	}
	const rawPrefix =
		separator === -1 ? '' : withoutScheme.slice(separator).replaceAll(/^\/+|\/+$/g, '');
	const segments: string[] = [];
	try {
		for (const rawSegment of rawPrefix.split('/')) {
			const segment = decodeURIComponent(rawSegment);
			if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
				return undefined;
			}
			segments.push(segment);
		}
	} catch {
		return undefined;
	}
	return { bucket: authority, prefix: rawPrefix ? segments.join('/') : '' };
}

function mostSpecificBound(
	location: Readonly<{ bucket: string; prefix: string }>,
	bounds: readonly { bucket: string; prefix: string }[],
): { bucket: string; prefix: string } | undefined {
	return bounds
		.filter(
			(bound) =>
				bound.bucket === location.bucket &&
				(bound.prefix === '' ||
					location.prefix === bound.prefix ||
					location.prefix.startsWith(`${bound.prefix}/`)),
		)
		.sort((left, right) => right.prefix.length - left.prefix.length)[0];
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function recordDynamicRouteOutcome(
	metrics: Metrics,
	outcome: 'malformed' | 'outside_bound' | 'unsupported_scheme',
): void {
	metrics.increment('duckdb_http_broker.dynamic_route', 1, { outcome });
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
	let retryError: OAuthTokenError | undefined;
	let closed = false;
	const controller = new AbortController();
	const metrics = options.metrics ?? noopMetrics;
	const tokenEndpoint = parseOAuthEndpoint(
		options.auth.tokenEndpoint,
		options.allowInsecureTransport,
	).toString();

	const exchange = async (): Promise<string> => {
		const remainingMs = options.sessionExpiresAtMs - options.now();
		if (closed || remainingMs <= 0) throw oauthFailure('session');
		const combinedSignal = deadlineSignal(
			controller.signal,
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
			retryError = undefined;
			metrics.increment('duckdb_http_broker.oauth_refresh', 1, { outcome: 'success' });
			return cached.token;
		} catch (error) {
			const failure =
				error instanceof OAuthTokenError
					? error
					: combinedSignal.aborted
						? oauthFailure(controller.signal.aborted ? 'cancelled' : 'session')
						: oauthFailure('transport');
			if (failure.reason !== 'cancelled' && failure.reason !== 'session') {
				retryAfterMs = Math.min(
					options.sessionExpiresAtMs,
					options.now() + OAUTH_REFRESH_RETRY_BACKOFF_MS,
				);
				retryError = failure;
			} else {
				retryAfterMs = 0;
				retryError = undefined;
			}
			metrics.increment('duckdb_http_broker.oauth_refresh', 1, { outcome: 'failure' });
			if (!closed && cached && options.now() < cached.expiresAtMs) {
				metrics.increment('duckdb_http_broker.oauth_token', 1, { source: 'stale-cache' });
				return cached.token;
			}
			throw failure;
		}
	};

	return {
		async authorization() {
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
				if (retryError) throw retryError;
			}
			refresh ??= exchange().finally(() => {
				refresh = undefined;
			});
			const token = await refresh;
			return { authorization: `Bearer ${token}` };
		},
		close() {
			closed = true;
			cached = undefined;
			retryAfterMs = 0;
			retryError = undefined;
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
				'OAuth2 token endpoint returned an invalid response. Make sure that access_token is non-empty. If token_type is present, it must be bearer. The expiry must be between 1 and 86400 seconds.',
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

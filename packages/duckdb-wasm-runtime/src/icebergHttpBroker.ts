import { randomUUID } from 'node:crypto';

export type IcebergHttpBrokerMethod = 'GET' | 'HEAD';

export interface IcebergHttpBrokerRoute {
	kind: 'catalog' | 'storage';
	url: string;
	match: 'exact' | 'prefix';
	methods: readonly IcebergHttpBrokerMethod[];
	/** Parent-owned headers, including credentials. They are never sent by the worker. */
	headers?: Readonly<Record<string, string>>;
}

export interface IcebergHttpBrokerCapability {
	expiresAtMs: number;
	routes: readonly IcebergHttpBrokerRoute[];
	limits: {
		maxRequests: number;
		maxRedirects: number;
		maxResponseBytes: number;
	};
	forwardRequestHeaders?: readonly string[];
}

export interface IcebergHttpBrokerRequest {
	url: string;
	method: IcebergHttpBrokerMethod;
	headers?: Readonly<Record<string, string>>;
}

export interface IcebergHttpBrokerResponse {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
}

export interface IcebergHttpBrokerTransportRequest extends IcebergHttpBrokerRequest {
	/** The transport must stop reading before this limit and must not follow redirects. */
	maxResponseBytes: number;
	signal?: AbortSignal;
}

export type IcebergHttpBrokerTransport = (
	request: IcebergHttpBrokerTransportRequest,
) => Promise<IcebergHttpBrokerResponse>;

export type IcebergHttpBrokerErrorCode =
	| 'capability_expired'
	| 'capability_unknown'
	| 'header_denied'
	| 'invalid_capability'
	| 'invalid_request'
	| 'method_denied'
	| 'redirect_budget_exceeded'
	| 'request_budget_exceeded'
	| 'response_budget_exceeded'
	| 'target_denied';

export class IcebergHttpBrokerError extends Error {
	constructor(
		readonly code: IcebergHttpBrokerErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'IcebergHttpBrokerError';
	}
}

interface NormalizedRoute {
	kind: IcebergHttpBrokerRoute['kind'];
	url: URL;
	match: IcebergHttpBrokerRoute['match'];
	methods: ReadonlySet<IcebergHttpBrokerMethod>;
	headers: Readonly<Record<string, string>>;
}

interface Session {
	expiresAtMs: number;
	routes: readonly NormalizedRoute[];
	limits: IcebergHttpBrokerCapability['limits'];
	forwardRequestHeaders: ReadonlySet<string>;
	requests: number;
	responseBytes: number;
	tail: Promise<void>;
}

const DEFAULT_FORWARDED_REQUEST_HEADERS = [
	'accept',
	'content-type',
	'if-match',
	'if-modified-since',
	'if-none-match',
	'if-unmodified-since',
	'range',
	'x-iceberg-access-delegation',
] as const;

const FORBIDDEN_WORKER_HEADERS = new Set([
	'authorization',
	'cookie',
	'host',
	'proxy-authorization',
	'proxy-connection',
	'x-forwarded-for',
	'x-forwarded-host',
]);

const RESPONSE_HEADERS = new Set([
	'accept-ranges',
	'content-length',
	'content-range',
	'content-type',
	'etag',
	'last-modified',
	'location',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Parent-side policy mock for a future DuckDB-Wasm HTTP bridge. Opening a capability stores
 * credentials here; worker requests carry only the opaque ID and unprivileged request fields.
 */
export class IcebergHttpBroker {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly transport: IcebergHttpBrokerTransport,
		private readonly now: () => number = Date.now,
		private readonly createId: () => string = randomUUID,
	) {}

	open(capability: IcebergHttpBrokerCapability): string {
		const session = normalizeCapability(capability, this.now());
		const id = this.createId();
		if (!id || this.sessions.has(id)) {
			throw new IcebergHttpBrokerError(
				'invalid_capability',
				'Iceberg HTTP broker generated an invalid capability ID.',
			);
		}
		this.sessions.set(id, session);
		return id;
	}

	close(id: string): void {
		this.sessions.delete(id);
	}

	async fetch(
		id: string,
		request: IcebergHttpBrokerRequest,
		signal?: AbortSignal,
	): Promise<IcebergHttpBrokerResponse> {
		const session = this.requireSession(id);
		return exclusive(session, async () => {
			if (this.requireSession(id) !== session) throw unknownCapability();
			let current = normalizeRequest(request);
			let redirects = 0;

			for (;;) {
				const authorized = authorize(session, current);
				const remainingResponseBytes = session.limits.maxResponseBytes - session.responseBytes;
				const response = await this.transport({
					...authorized,
					maxResponseBytes: remainingResponseBytes,
					signal,
				});
				assertResponse(response);
				if (this.requireSession(id) !== session) throw unknownCapability();
				session.responseBytes += response.body.byteLength;
				if (session.responseBytes > session.limits.maxResponseBytes) {
					throw new IcebergHttpBrokerError(
						'response_budget_exceeded',
						'Iceberg HTTP broker response budget exceeded.',
					);
				}

				const headers = sanitizeResponseHeaders(response.headers);
				const location = REDIRECT_STATUSES.has(response.status) ? headers.location : undefined;
				if (!location) return { status: response.status, headers, body: response.body };
				if (redirects >= session.limits.maxRedirects) {
					throw new IcebergHttpBrokerError(
						'redirect_budget_exceeded',
						'Iceberg HTTP broker redirect budget exceeded.',
					);
				}
				redirects += 1;
				current = redirectRequest(current, location, response.status);
			}
		});
	}

	private requireSession(id: string): Session {
		const session = this.sessions.get(id);
		if (!session) throw unknownCapability();
		if (this.now() >= session.expiresAtMs) {
			this.sessions.delete(id);
			throw new IcebergHttpBrokerError(
				'capability_expired',
				'Iceberg HTTP broker capability expired.',
			);
		}
		return session;
	}
}

function normalizeCapability(capability: IcebergHttpBrokerCapability, now: number): Session {
	const limits = capability.limits;
	if (
		!Number.isSafeInteger(capability.expiresAtMs) ||
		capability.expiresAtMs <= now ||
		!Array.isArray(capability.routes) ||
		!limits ||
		capability.routes.length === 0
	) {
		throw invalidCapability();
	}
	for (const value of [limits.maxRequests, limits.maxRedirects, limits.maxResponseBytes]) {
		if (!Number.isSafeInteger(value) || value < 0) throw invalidCapability();
	}
	if (limits.maxRequests === 0 || limits.maxResponseBytes === 0) {
		throw invalidCapability();
	}
	if (
		capability.forwardRequestHeaders !== undefined &&
		!Array.isArray(capability.forwardRequestHeaders)
	) {
		throw invalidCapability();
	}
	const rawForwardedHeaders: readonly unknown[] =
		capability.forwardRequestHeaders ?? DEFAULT_FORWARDED_REQUEST_HEADERS;
	if (!rawForwardedHeaders.every((header): header is string => typeof header === 'string')) {
		throw invalidCapability();
	}
	const forwarded = new Set(rawForwardedHeaders.map(normalizeHeaderName));
	if ([...forwarded].some((header) => !header || FORBIDDEN_WORKER_HEADERS.has(header))) {
		throw invalidCapability();
	}
	return {
		expiresAtMs: capability.expiresAtMs,
		routes: capability.routes.map(normalizeRoute),
		limits: { ...limits },
		forwardRequestHeaders: forwarded,
		requests: 0,
		responseBytes: 0,
		tail: Promise.resolve(),
	};
}

function normalizeRoute(route: IcebergHttpBrokerRoute): NormalizedRoute {
	if (
		(route.kind !== 'catalog' && route.kind !== 'storage') ||
		(route.match !== 'exact' && route.match !== 'prefix') ||
		!Array.isArray(route.methods)
	) {
		throw invalidCapability();
	}
	const url = parseHttpUrl(route.url, 'invalid_capability');
	if (url.hash || (route.match === 'prefix' && url.search)) throw invalidCapability();
	if (route.methods.length === 0) throw invalidCapability();
	const rawMethods: readonly unknown[] = route.methods;
	const permittedMethods =
		route.kind === 'catalog'
			? new Set<IcebergHttpBrokerMethod>(['GET'])
			: new Set<IcebergHttpBrokerMethod>(['GET', 'HEAD']);
	if (rawMethods.some((method) => !permittedMethods.has(method as IcebergHttpBrokerMethod))) {
		throw invalidCapability();
	}
	const methods = new Set(rawMethods as IcebergHttpBrokerMethod[]);
	if (methods.size !== route.methods.length) throw invalidCapability();
	const headers = normalizeHeaders(route.headers ?? {}, 'invalid_capability');
	if (Object.keys(headers).some((header) => header === 'host' || header === 'content-length')) {
		throw invalidCapability();
	}
	return { kind: route.kind, url, match: route.match, methods, headers };
}

function normalizeRequest(request: IcebergHttpBrokerRequest): IcebergHttpBrokerRequest {
	const url = parseHttpUrl(request.url, 'invalid_request');
	if (url.hash) throw invalidRequest('Request URLs must not contain fragments.');
	return {
		url: url.toString(),
		method: request.method,
		headers: normalizeHeaders(request.headers ?? {}, 'invalid_request'),
	};
}

function authorize(session: Session, request: IcebergHttpBrokerRequest): IcebergHttpBrokerRequest {
	if (session.requests >= session.limits.maxRequests) {
		throw new IcebergHttpBrokerError(
			'request_budget_exceeded',
			'Iceberg HTTP broker request budget exceeded.',
		);
	}
	const target = new URL(request.url);
	const candidates = session.routes
		.filter((route) => routeMatches(route, target))
		.sort((left, right) => {
			if (left.match !== right.match) return left.match === 'exact' ? -1 : 1;
			return right.url.pathname.length - left.url.pathname.length;
		});
	const route = candidates[0];
	if (!route) {
		throw new IcebergHttpBrokerError(
			'target_denied',
			'Iceberg HTTP broker target is outside the execution capability.',
		);
	}
	if (!route.methods.has(request.method)) {
		throw new IcebergHttpBrokerError(
			'method_denied',
			'Iceberg HTTP broker method is not allowed for this target.',
		);
	}
	const workerHeaders = normalizeHeaders(request.headers ?? {}, 'invalid_request');
	for (const header of Object.keys(workerHeaders)) {
		if (FORBIDDEN_WORKER_HEADERS.has(header) || !session.forwardRequestHeaders.has(header)) {
			throw new IcebergHttpBrokerError(
				'header_denied',
				`Iceberg HTTP broker request header "${header}" is not allowed.`,
			);
		}
	}
	session.requests += 1;
	return {
		...request,
		headers: { ...workerHeaders, ...route.headers },
	};
}

function routeMatches(route: NormalizedRoute, target: URL): boolean {
	if (route.url.origin !== target.origin) return false;
	if (route.match === 'exact') {
		return route.url.pathname === target.pathname && route.url.search === target.search;
	}
	const prefix = route.url.pathname.replace(/\/$/, '');
	return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

function redirectRequest(
	request: IcebergHttpBrokerRequest,
	location: string,
	status: number,
): IcebergHttpBrokerRequest {
	let method = request.method;
	if (status === 303) {
		method = 'GET';
	}
	return normalizeRequest({
		url: new URL(location, request.url).toString(),
		method,
		headers: request.headers,
	});
}

function sanitizeResponseHeaders(
	headers: Readonly<Record<string, string>>,
): Record<string, string> {
	const normalized = normalizeHeaders(headers, 'invalid_request');
	return Object.fromEntries(
		Object.entries(normalized).filter(([name]) => RESPONSE_HEADERS.has(name)),
	);
}

function normalizeHeaders(
	headers: Readonly<Record<string, string>>,
	code: 'invalid_capability' | 'invalid_request',
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [rawName, value] of Object.entries(headers)) {
		const name = normalizeHeaderName(rawName);
		if (
			!name ||
			typeof value !== 'string' ||
			/[\r\n]/.test(value) ||
			Object.hasOwn(normalized, name)
		) {
			if (code === 'invalid_capability') throw invalidCapability();
			throw invalidRequest('Request contains an invalid header.');
		}
		normalized[name] = value;
	}
	return normalized;
}

function normalizeHeaderName(name: string): string {
	const normalized = name.trim().toLowerCase();
	return /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) ? normalized : '';
}

function parseHttpUrl(value: string, code: 'invalid_capability' | 'invalid_request'): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		if (code === 'invalid_capability') throw invalidCapability();
		throw invalidRequest('Request contains an invalid URL.');
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username !== '' ||
		url.password !== '' ||
		/%2f|%5c/i.test(url.pathname)
	) {
		if (code === 'invalid_capability') throw invalidCapability();
		throw invalidRequest('Request URL is not allowed.');
	}
	return url;
}

function assertResponse(response: IcebergHttpBrokerResponse): void {
	if (
		!Number.isSafeInteger(response.status) ||
		response.status < 100 ||
		response.status > 599 ||
		!(response.body instanceof Uint8Array)
	) {
		throw invalidRequest('Iceberg HTTP broker transport returned an invalid response.');
	}
}

function invalidCapability(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'invalid_capability',
		'Iceberg HTTP broker capability is invalid.',
	);
}

function invalidRequest(message: string): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError('invalid_request', message);
}

function unknownCapability(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'capability_unknown',
		'Iceberg HTTP broker capability is unknown.',
	);
}

async function exclusive<T>(session: Session, work: () => Promise<T>): Promise<T> {
	const previous = session.tail;
	let release!: () => void;
	session.tail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await work();
	} finally {
		release();
	}
}

import { randomUUID } from 'node:crypto';
import { noopMetrics, withAbortSignal } from '@marimo-hub/core';
import type { Metrics } from '@marimo-hub/core';

export type IcebergHttpBrokerMethod = 'GET' | 'HEAD';

export interface IcebergHttpBrokerRoute {
	kind: 'catalog' | 'storage';
	url: string;
	match: 'exact' | 'prefix';
	methods: readonly IcebergHttpBrokerMethod[];
	/** Parent-owned headers, including credentials. They are never sent by the worker. */
	headers?: Readonly<Record<string, string>>;
	/** The signal covers the capability lifetime; individual callers can stop waiting independently. */
	prepareHeaders?: (
		request: Readonly<IcebergHttpBrokerRequest>,
		signal?: AbortSignal,
	) => Promise<Readonly<Record<string, string>>>;
	forwardRequestHeaders?: readonly string[];
	discardRequestHeaders?: readonly string[];
	observeResponse?: IcebergHttpBrokerResponseObserver;
}

export interface IcebergHttpBrokerObservedResponse {
	request: IcebergHttpBrokerRequest;
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
}

export interface IcebergHttpBrokerRouteInstaller {
	install(routes: readonly IcebergHttpBrokerRoute[]): readonly ('installed' | 'duplicate')[];
}

export type IcebergHttpBrokerResponseObserver = (
	response: Readonly<IcebergHttpBrokerObservedResponse>,
	installer: IcebergHttpBrokerRouteInstaller,
) => void;

export interface IcebergHttpBrokerCapability {
	expiresAtMs: number;
	routes: readonly IcebergHttpBrokerRoute[];
	limits: {
		maxRequests: number;
		maxConcurrentRequests?: number;
		maxRedirects: number;
		maxResponseBytes: number;
		maxSingleResponseBytes?: number;
		maxDynamicRoutes?: number;
		maxDynamicRouteUrlBytes?: number;
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
	deadlineMs: number;
	signal?: AbortSignal;
}

export type IcebergHttpBrokerTransport = (
	request: IcebergHttpBrokerTransportRequest,
) => Promise<IcebergHttpBrokerResponse>;

export type IcebergHttpBrokerErrorCode =
	| 'capability_expired'
	| 'capability_unknown'
	| 'credential_failed'
	| 'dynamic_route_budget_exceeded'
	| 'header_denied'
	| 'invalid_capability'
	| 'invalid_request'
	| 'method_denied'
	| 'object_changed'
	| 'range_invalid'
	| 'redirect_denied'
	| 'redirect_budget_exceeded'
	| 'request_budget_exceeded'
	| 'response_budget_exceeded'
	| 'strong_etag_required'
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
	prepareHeaders?: IcebergHttpBrokerRoute['prepareHeaders'];
	forwardRequestHeaders: ReadonlySet<string>;
	discardRequestHeaders: ReadonlySet<string>;
	observeResponse?: IcebergHttpBrokerResponseObserver;
}

interface Session {
	expiresAtMs: number;
	routes: NormalizedRoute[];
	limits: NormalizedLimits;
	forwardRequestHeaders: ReadonlySet<string>;
	lifecycleController: AbortController;
	requests: number;
	activeRequests: number;
	responseBytes: number;
	reservedResponseBytes: number;
	dynamicRoutes: number;
	dynamicRouteUrlBytes: number;
	controllers: Set<AbortController>;
	requestWaiters: Set<() => void>;
	responseWaiters: Set<() => void>;
	metrics: Metrics;
}

interface NormalizedLimits {
	maxRequests: number;
	maxConcurrentRequests: number;
	maxRedirects: number;
	maxResponseBytes: number;
	maxSingleResponseBytes?: number;
	maxDynamicRoutes: number;
	maxDynamicRouteUrlBytes: number;
}

interface AuthorizedRequest {
	request: IcebergHttpBrokerRequest;
	redirectState: IcebergHttpBrokerRequest;
	routeKind: IcebergHttpBrokerRoute['kind'];
	observeResponse?: IcebergHttpBrokerResponseObserver;
}

const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_DYNAMIC_ROUTES = 512;
const DEFAULT_MAX_DYNAMIC_ROUTE_URL_BYTES = 512 * 1024;

const DEFAULT_FORWARDED_REQUEST_HEADERS = [
	'accept',
	'content-type',
	'if-match',
	'if-modified-since',
	'if-none-match',
	'if-unmodified-since',
	'range',
] as const;

const NEVER_FORWARDED_WORKER_HEADERS = new Set([
	'cookie',
	'host',
	'proxy-authorization',
	'proxy-connection',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-iceberg-access-delegation',
]);

const GLOBALLY_FORBIDDEN_WORKER_HEADERS = new Set([
	...NEVER_FORWARDED_WORKER_HEADERS,
	'authorization',
	'x-amz-content-sha256',
	'x-amz-date',
	'x-amz-security-token',
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

/** Credentials stay in these parent-owned sessions; the worker submits only unprivileged fields. */
export class IcebergHttpBroker {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly transport: IcebergHttpBrokerTransport,
		private readonly now: () => number = Date.now,
		private readonly createId: () => string = randomUUID,
		private readonly metrics: Metrics = noopMetrics,
	) {}

	open(capability: IcebergHttpBrokerCapability): string {
		const session = normalizeCapability(capability, this.now(), this.metrics);
		const id = this.createId();
		if (!id || this.sessions.has(id)) {
			throw new IcebergHttpBrokerError(
				'invalid_capability',
				'DuckDB HTTP broker could not create a session ID. Retry the query.',
			);
		}
		this.sessions.set(id, session);
		return id;
	}

	close(id: string): void {
		const session = this.sessions.get(id);
		this.sessions.delete(id);
		session?.lifecycleController.abort();
		for (const controller of session?.controllers ?? []) controller.abort();
		wakeAll(session?.requestWaiters);
		wakeAll(session?.responseWaiters);
	}

	async fetch(
		id: string,
		request: IcebergHttpBrokerRequest,
		signal?: AbortSignal,
	): Promise<IcebergHttpBrokerResponse> {
		const startedAtMs = this.now();
		try {
			return await this.fetchAuthorized(id, request, signal);
		} catch (error) {
			this.metrics.increment('duckdb_http_broker.request', 1, {
				outcome: error instanceof IcebergHttpBrokerError ? 'denied' : 'failed',
				reason: brokerFailureReason(error),
				method: metricMethod(request.method),
			});
			throw error;
		} finally {
			this.metrics.histogram?.(
				'duckdb_http_broker.request_latency_ms',
				Math.max(0, this.now() - startedAtMs),
				{ method: metricMethod(request.method) },
			);
		}
	}

	private async fetchAuthorized(
		id: string,
		request: IcebergHttpBrokerRequest,
		signal?: AbortSignal,
	): Promise<IcebergHttpBrokerResponse> {
		const session = this.requireSession(id);
		await acquireRequestSlot(session, signal);
		try {
			if (this.requireSession(id) !== session) throw unknownCapability();
			let current = normalizeRequest(request);
			const controller = new AbortController();
			session.controllers.add(controller);
			try {
				const transportSignal = signal
					? AbortSignal.any([signal, controller.signal])
					: controller.signal;
				let redirects = 0;
				for (;;) {
					const authorized = await authorize(session, current, transportSignal);
					const reservation = await reserveResponseBudget(session, transportSignal);
					let response: IcebergHttpBrokerResponse;
					let statusClass = 'failed';
					const transportStartedAtMs = this.now();
					try {
						if (this.requireSession(id) !== session) throw unknownCapability();
						response = await this.transport({
							...authorized.request,
							maxResponseBytes: reservation,
							deadlineMs: session.expiresAtMs,
							signal: transportSignal,
						});
						assertResponse(response);
						statusClass = responseStatusClass(response.status);
						if (this.requireSession(id) !== session) throw unknownCapability();
						commitResponseBudget(session, reservation, response.body.byteLength);
					} catch (error) {
						releaseResponseBudget(session, reservation);
						throw error;
					} finally {
						session.metrics.histogram?.(
							'duckdb_http_broker.transport_latency_ms',
							Math.max(0, this.now() - transportStartedAtMs),
							{
								route: authorized.routeKind,
								method: authorized.request.method,
								status_class: statusClass,
							},
						);
					}
					session.metrics.histogram?.(
						'duckdb_http_broker.response_bytes',
						response.body.byteLength,
						{
							route: authorized.routeKind,
							method: authorized.request.method,
							status_class: statusClass,
						},
					);

					const headers = sanitizeResponseHeaders(response.headers);
					authorized.observeResponse?.(
						{
							request: {
								url: authorized.request.url,
								method: authorized.request.method,
								headers: authorized.request.headers,
							},
							status: response.status,
							headers,
							body: response.body,
						},
						{
							install: (routes) => installDynamicRoutes(session, routes),
						},
					);
					const location = REDIRECT_STATUSES.has(response.status) ? headers.location : undefined;
					if (!location) return { status: response.status, headers, body: response.body };
					if (redirects >= session.limits.maxRedirects) {
						session.metrics.increment('duckdb_http_broker.budget_exhausted', 1, {
							budget: 'redirect',
						});
						throw new IcebergHttpBrokerError(
							'redirect_budget_exceeded',
							'The remote endpoint redirected too many times. Make sure that the integration endpoint is correct.',
						);
					}
					redirects += 1;
					session.metrics.increment('duckdb_http_broker.redirect', 1, {
						outcome: 'followed',
					});
					current = redirectRequest(authorized.redirectState, location, response.status);
				}
			} finally {
				session.controllers.delete(controller);
			}
		} finally {
			releaseRequestSlot(session);
		}
	}

	private requireSession(id: string): Session {
		const session = this.sessions.get(id);
		if (!session) throw unknownCapability();
		if (this.now() >= session.expiresAtMs) {
			this.close(id);
			throw new IcebergHttpBrokerError(
				'capability_expired',
				'The DuckDB remote-read session reached its deadline. Retry with a smaller query.',
			);
		}
		return session;
	}
}

function normalizeCapability(
	capability: IcebergHttpBrokerCapability,
	now: number,
	metrics: Metrics,
): Session {
	const limits = capability.limits;
	const maxConcurrentRequests = limits?.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
	const maxDynamicRoutes = limits?.maxDynamicRoutes ?? DEFAULT_MAX_DYNAMIC_ROUTES;
	const maxDynamicRouteUrlBytes =
		limits?.maxDynamicRouteUrlBytes ?? DEFAULT_MAX_DYNAMIC_ROUTE_URL_BYTES;
	if (
		!Number.isSafeInteger(capability.expiresAtMs) ||
		capability.expiresAtMs <= now ||
		!Array.isArray(capability.routes) ||
		!limits ||
		capability.routes.length === 0
	) {
		throw invalidCapability();
	}
	for (const value of [
		limits.maxRequests,
		maxConcurrentRequests,
		limits.maxRedirects,
		limits.maxResponseBytes,
		maxDynamicRoutes,
		maxDynamicRouteUrlBytes,
	]) {
		if (!Number.isSafeInteger(value) || value < 0) throw invalidCapability();
	}
	if (
		limits.maxSingleResponseBytes !== undefined &&
		(!Number.isSafeInteger(limits.maxSingleResponseBytes) || limits.maxSingleResponseBytes < 1)
	) {
		throw invalidCapability();
	}
	if (limits.maxRequests === 0 || maxConcurrentRequests === 0 || limits.maxResponseBytes === 0) {
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
	if ([...forwarded].some((header) => !header || GLOBALLY_FORBIDDEN_WORKER_HEADERS.has(header))) {
		throw invalidCapability();
	}
	return {
		expiresAtMs: capability.expiresAtMs,
		routes: capability.routes.map(normalizeRoute),
		limits: {
			...limits,
			maxConcurrentRequests,
			maxDynamicRoutes,
			maxDynamicRouteUrlBytes,
		},
		forwardRequestHeaders: forwarded,
		lifecycleController: new AbortController(),
		requests: 0,
		activeRequests: 0,
		responseBytes: 0,
		reservedResponseBytes: 0,
		dynamicRoutes: 0,
		dynamicRouteUrlBytes: 0,
		controllers: new Set(),
		requestWaiters: new Set(),
		responseWaiters: new Set(),
		metrics,
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
	const permittedMethods = new Set<IcebergHttpBrokerMethod>(['GET', 'HEAD']);
	if (rawMethods.some((method) => !permittedMethods.has(method as IcebergHttpBrokerMethod))) {
		throw invalidCapability();
	}
	const methods = new Set(rawMethods as IcebergHttpBrokerMethod[]);
	if (methods.size !== route.methods.length) throw invalidCapability();
	const headers = normalizeHeaders(route.headers ?? {}, 'invalid_capability');
	if (route.prepareHeaders !== undefined && typeof route.prepareHeaders !== 'function') {
		throw invalidCapability();
	}
	if (route.observeResponse !== undefined && typeof route.observeResponse !== 'function') {
		throw invalidCapability();
	}
	if (route.forwardRequestHeaders !== undefined && !Array.isArray(route.forwardRequestHeaders)) {
		throw invalidCapability();
	}
	const rawForwardedHeaders: readonly unknown[] = route.forwardRequestHeaders ?? [];
	if (!rawForwardedHeaders.every((header): header is string => typeof header === 'string')) {
		throw invalidCapability();
	}
	const forwardRequestHeaders = new Set(rawForwardedHeaders.map(normalizeHeaderName));
	if (
		[...forwardRequestHeaders].some(
			(header) => !header || NEVER_FORWARDED_WORKER_HEADERS.has(header),
		)
	) {
		throw invalidCapability();
	}
	if (route.discardRequestHeaders !== undefined && !Array.isArray(route.discardRequestHeaders)) {
		throw invalidCapability();
	}
	const rawDiscardedHeaders: readonly unknown[] = route.discardRequestHeaders ?? [];
	if (!rawDiscardedHeaders.every((header): header is string => typeof header === 'string')) {
		throw invalidCapability();
	}
	const discardRequestHeaders = new Set(rawDiscardedHeaders.map(normalizeHeaderName));
	if (
		[...discardRequestHeaders].some(
			(header) => !header || NEVER_FORWARDED_WORKER_HEADERS.has(header),
		) ||
		[...discardRequestHeaders].some((header) => forwardRequestHeaders.has(header))
	) {
		throw invalidCapability();
	}
	if (Object.keys(headers).some((header) => header === 'host' || header === 'content-length')) {
		throw invalidCapability();
	}
	return {
		kind: route.kind,
		url,
		match: route.match,
		methods,
		headers,
		prepareHeaders: route.prepareHeaders,
		forwardRequestHeaders,
		discardRequestHeaders,
		observeResponse: route.observeResponse,
	};
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

async function authorize(
	session: Session,
	request: IcebergHttpBrokerRequest,
	signal?: AbortSignal,
): Promise<AuthorizedRequest> {
	if (session.requests >= session.limits.maxRequests) {
		session.metrics.increment('duckdb_http_broker.budget_exhausted', 1, {
			budget: 'request',
		});
		throw new IcebergHttpBrokerError(
			'request_budget_exceeded',
			'The query made too many remote requests. Narrow the query or split it into smaller queries.',
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
			'The query tried to read outside the guarded locations. Make sure that catalog redirects and broker_read_locations are correct.',
		);
	}
	if (!route.methods.has(request.method)) {
		throw new IcebergHttpBrokerError(
			'method_denied',
			'The query tried an unsupported remote operation. Guarded reads permit only GET and HEAD requests.',
		);
	}
	const submittedHeaders = normalizeHeaders(request.headers ?? {}, 'invalid_request');
	const workerHeaders: Record<string, string> = {};
	for (const [header, value] of Object.entries(submittedHeaders)) {
		if (route.discardRequestHeaders.has(header)) continue;
		if (
			NEVER_FORWARDED_WORKER_HEADERS.has(header) ||
			(!session.forwardRequestHeaders.has(header) && !route.forwardRequestHeaders.has(header))
		) {
			throw new IcebergHttpBrokerError(
				'header_denied',
				`The query sent the unsupported remote header "${header}". Remove this header or use the sandbox runtime.`,
			);
		}
		workerHeaders[header] = value;
	}
	if (signal?.aborted) throw abortError();
	session.requests += 1;
	const preparation = route.prepareHeaders?.(request, session.lifecycleController.signal);
	const preparationSignal = signal
		? AbortSignal.any([signal, session.lifecycleController.signal])
		: session.lifecycleController.signal;
	const preparedHeaders = normalizeHeaders(
		preparation ? await withAbortSignal(preparation, preparationSignal, abortError) : {},
		'invalid_request',
	);
	session.metrics.increment('duckdb_http_broker.request', 1, {
		outcome: 'authorized',
		route: route.kind,
		method: request.method,
	});
	return {
		request: {
			...request,
			headers: { ...workerHeaders, ...route.headers, ...preparedHeaders },
		},
		redirectState: { ...request, headers: workerHeaders },
		routeKind: route.kind,
		observeResponse: route.observeResponse,
	};
}

function installDynamicRoutes(
	session: Session,
	routes: readonly IcebergHttpBrokerRoute[],
): readonly ('installed' | 'duplicate')[] {
	if (!Array.isArray(routes) || routes.length === 0) throw dynamicRouteConflict(session);
	let normalized: NormalizedRoute[];
	try {
		normalized = routes.map(normalizeRoute);
	} catch {
		throw dynamicRouteConflict(session);
	}
	if (
		normalized.some(
			(route) =>
				route.kind !== 'storage' ||
				Object.keys(route.headers).length > 0 ||
				route.prepareHeaders !== undefined ||
				route.observeResponse !== undefined,
		)
	) {
		throw dynamicRouteConflict(session);
	}

	const accepted = [...session.routes];
	const outcomes: ('installed' | 'duplicate')[] = [];
	for (const route of normalized) {
		if (
			accepted.some((candidate) => candidate.kind === 'catalog' && routesOverlap(candidate, route))
		) {
			throw dynamicRouteConflict(session);
		}
		const sameTarget = accepted.find(
			(candidate) =>
				candidate.kind === route.kind &&
				candidate.match === route.match &&
				candidate.url.toString() === route.url.toString(),
		);
		if (sameTarget) {
			if (!sameRoutePolicy(sameTarget, route)) throw dynamicRouteConflict(session);
			outcomes.push('duplicate');
			continue;
		}
		accepted.push(route);
		outcomes.push('installed');
	}
	const installed = normalized.filter((_route, index) => outcomes[index] === 'installed');
	const installedUrlBytes = installed.reduce(
		(total, route) => total + new TextEncoder().encode(route.url.toString()).byteLength,
		0,
	);
	if (session.dynamicRoutes + installed.length > session.limits.maxDynamicRoutes) {
		throw dynamicRouteBudgetExceeded(session, 'dynamic_route_count');
	}
	if (session.dynamicRouteUrlBytes + installedUrlBytes > session.limits.maxDynamicRouteUrlBytes) {
		throw dynamicRouteBudgetExceeded(session, 'dynamic_route_url_bytes');
	}
	session.routes.push(...installed);
	session.dynamicRoutes += installed.length;
	session.dynamicRouteUrlBytes += installedUrlBytes;
	for (const outcome of outcomes) {
		session.metrics.increment('duckdb_http_broker.dynamic_route', 1, { outcome });
	}
	return outcomes;
}

function dynamicRouteBudgetExceeded(
	session: Session,
	budget: 'dynamic_route_count' | 'dynamic_route_url_bytes',
): IcebergHttpBrokerError {
	session.metrics.increment('duckdb_http_broker.budget_exhausted', 1, { budget });
	return new IcebergHttpBrokerError(
		'dynamic_route_budget_exceeded',
		'The catalog response exceeded the dynamic storage-route budget.',
	);
}

function routesOverlap(left: NormalizedRoute, right: NormalizedRoute): boolean {
	if (left.url.origin !== right.url.origin) return false;
	if (left.match === 'exact' && right.match === 'exact') {
		return left.url.pathname === right.url.pathname && left.url.search === right.url.search;
	}
	const leftPrefix = left.url.pathname.replace(/\/$/, '');
	const rightPrefix = right.url.pathname.replace(/\/$/, '');
	if (left.match === 'exact') {
		return leftPrefix === rightPrefix || leftPrefix.startsWith(`${rightPrefix}/`);
	}
	if (right.match === 'exact') {
		return rightPrefix === leftPrefix || rightPrefix.startsWith(`${leftPrefix}/`);
	}
	return (
		leftPrefix === rightPrefix ||
		leftPrefix.startsWith(`${rightPrefix}/`) ||
		rightPrefix.startsWith(`${leftPrefix}/`)
	);
}

function sameRoutePolicy(left: NormalizedRoute, right: NormalizedRoute): boolean {
	return (
		setsEqual(left.methods, right.methods) &&
		recordsEqual(left.headers, right.headers) &&
		left.prepareHeaders === right.prepareHeaders &&
		left.observeResponse === right.observeResponse &&
		setsEqual(left.forwardRequestHeaders, right.forwardRequestHeaders) &&
		setsEqual(left.discardRequestHeaders, right.discardRequestHeaders)
	);
}

function recordsEqual(
	left: Readonly<Record<string, string>>,
	right: Readonly<Record<string, string>>,
): boolean {
	const entries = Object.entries(left);
	return (
		entries.length === Object.keys(right).length &&
		entries.every(([key, value]) => right[key] === value)
	);
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function dynamicRouteConflict(session: Session): IcebergHttpBrokerError {
	session.metrics.increment('duckdb_http_broker.dynamic_route', 1, {
		outcome: 'route_conflict',
	});
	return new IcebergHttpBrokerError(
		'invalid_capability',
		'The catalog response could not install a bounded storage route.',
	);
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
		throw invalidRequest(
			'The DuckDB HTTP transport returned an invalid response. Retry the query.',
		);
	}
}

function invalidCapability(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'invalid_capability',
		'DuckDB HTTP access is invalid. Review the integration endpoint and guarded read locations.',
	);
}

function invalidRequest(message: string): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError('invalid_request', message);
}

function unknownCapability(): IcebergHttpBrokerError {
	return new IcebergHttpBrokerError(
		'capability_unknown',
		'The DuckDB remote-read session ended before the request completed. Retry the query.',
	);
}

async function acquireRequestSlot(session: Session, signal?: AbortSignal): Promise<void> {
	const limit = session.limits.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
	while (session.activeRequests >= limit) await waitForAvailability(session.requestWaiters, signal);
	if (signal?.aborted) throw abortError();
	session.activeRequests += 1;
}

function releaseRequestSlot(session: Session): void {
	if (session.activeRequests > 0) session.activeRequests -= 1;
	wakeAll(session.requestWaiters);
}

async function reserveResponseBudget(session: Session, signal?: AbortSignal): Promise<number> {
	const maxSingle = session.limits.maxSingleResponseBytes ?? session.limits.maxResponseBytes;
	for (;;) {
		const totalRemaining = session.limits.maxResponseBytes - session.responseBytes;
		if (totalRemaining <= 0) throw responseBudgetExceeded(session);
		const available = totalRemaining - session.reservedResponseBytes;
		if (session.reservedResponseBytes === 0 || available >= maxSingle) {
			const reservation = Math.min(available, maxSingle);
			session.reservedResponseBytes += reservation;
			return reservation;
		}
		await waitForAvailability(session.responseWaiters, signal);
	}
}

function commitResponseBudget(session: Session, reservation: number, actual: number): void {
	if (actual > reservation) throw responseBudgetExceeded(session);
	session.reservedResponseBytes -= reservation;
	session.responseBytes += actual;
	wakeAll(session.responseWaiters);
}

function releaseResponseBudget(session: Session, reservation: number): void {
	if (session.reservedResponseBytes >= reservation) session.reservedResponseBytes -= reservation;
	wakeAll(session.responseWaiters);
}

function waitForAvailability(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise<void>((resolve, reject) => {
		const wake = () => {
			signal?.removeEventListener('abort', onAbort);
			waiters.delete(wake);
			resolve();
		};
		const onAbort = () => {
			waiters.delete(wake);
			reject(abortError());
		};
		waiters.add(wake);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function wakeAll(waiters?: Set<() => void>): void {
	for (const wake of waiters ?? []) wake();
}

function responseBudgetExceeded(session: Session): IcebergHttpBrokerError {
	session.metrics.increment('duckdb_http_broker.budget_exhausted', 1, {
		budget: 'response',
	});
	return new IcebergHttpBrokerError(
		'response_budget_exceeded',
		'Remote data exceeded the query byte limit. Select fewer columns or rows.',
	);
}

function brokerFailureReason(error: unknown): string {
	if (error instanceof IcebergHttpBrokerError) return error.code;
	if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
	return 'transport_failed';
}

function metricMethod(method: unknown): string {
	return method === 'GET' || method === 'HEAD' ? method : 'invalid';
}

function responseStatusClass(status: number): string {
	return `${Math.floor(status / 100)}xx`;
}

function abortError(): Error {
	return Object.assign(new Error('The DuckDB remote-read request was canceled.'), {
		name: 'AbortError',
	});
}

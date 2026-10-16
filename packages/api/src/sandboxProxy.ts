/**
 * HTTP and WebSocket proxies share admission checks. Each request keeps its own
 * path and query. The Node relay closes sockets at the returned authorization deadline.
 */
import type { MiddlewareHandler } from 'hono';
import {
	AppPoolService,
	LazyMap,
	sessionMode,
	sessionResourceNotebookId,
	NotFoundError,
	ProxyExposure,
	UnavailableError,
	verifyProxyToken,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, ProjectId, SessionId } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from './context';
import { errorMetadataChain, logEvent } from './log';
import { SANDBOX_PROXY_PREFIXES } from './proxyRoutes';
import {
	assertSessionPreviewActive,
	authorizationService,
	fail,
	resolvePublicBaseUrl,
} from './shared';
import {
	authorizeAppProxyRequest,
	appProxyResponse,
	APP_PROXY_PREFIX,
	APP_VISIT_HEADER,
	APP_GENERATION_HEADER,
	APP_STATUS_HEADER,
	APP_PROXY_HEADER,
} from './appProxy';
export {
	APP_PROXY_HEADER,
	APP_STATUS_HEADER,
	APP_VISIT_HEADER,
	APP_GENERATION_HEADER,
} from './appProxy';

/** Outcome of routing a `/proxy/<token>/…` request. */
export type ProxyDecision =
	| { kind: 'pass' } // Not a proxy path — let the normal app handle it.
	| { kind: 'starting' }
	| {
			kind: 'reject';
			status: 401 | 403 | 404 | 410 | 503;
			code:
				| 'UNAUTHORIZED'
				| 'USER_SUSPENDED'
				| 'FORBIDDEN'
				| 'NOT_FOUND'
				| 'GONE'
				| 'SERVICE_UNAVAILABLE';
			message: string;
	  }
	| {
			kind: 'forward';
			targetUrl: string;
			sessionId: string;
			kernelAuthToken?: string;
			authorizationDeadline?: number;
			appProxyBaseUrl?: string;
	  };

type Rejection = Extract<ProxyDecision, { kind: 'reject' }>;
type Admission = Omit<Extract<ProxyDecision, { kind: 'forward' }>, 'targetUrl'> & {
	originUrl: string;
	proxyPath: 'strip-prefix' | 'preserve-prefix';
	cacheable: boolean;
};
type CachedAdmission = { admission: Admission; expiresAt: number };
type AdmissionCache = LazyMap<string, CachedAdmission>;
type Session = Awaited<ReturnType<ApiDeps['services']['sessions']['getSession']>>;

const ADMISSION_CACHES = new WeakMap<ApiDeps, AdmissionCache>();
const ADMISSION_TTL_MS = 5_000;

class AdmissionRejectedError extends Error {
	constructor(readonly decision: Rejection) {
		super(decision.message);
		this.name = 'AdmissionRejectedError';
	}
}

function admissionCache(deps: ApiDeps): AdmissionCache {
	let cache = ADMISSION_CACHES.get(deps);
	if (!cache) {
		cache = new LazyMap(
			async () => {
				throw new Error('An admission load function is required.');
			},
			{ maxSize: 10_000 },
		);
		ADMISSION_CACHES.set(deps, cache);
	}
	return cache;
}

function getFreshAdmission(
	cache: AdmissionCache,
	key: string,
	now?: number,
): CachedAdmission | undefined {
	const cached = cache.getIfPresent(key);
	if (cached && cached.expiresAt <= (now ?? Date.now())) {
		cache.delete(key);
		return undefined;
	}
	return cached;
}

function rejectProxy(
	status: Rejection['status'],
	code: Rejection['code'],
	message: string,
): Rejection {
	return { kind: 'reject', status, code, message };
}

const PROXY_PREFIX = new RegExp(`^${SANDBOX_PROXY_PREFIXES.kernel}/([^/]+)`);
const SURFACE_PROXY_PREFIX = new RegExp(`^${SANDBOX_PROXY_PREFIXES.surface}/([^/]+)/([^/]+)`);

/** Strip a trailing slash so we can concatenate an origin with a path cleanly. */
function trimTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Token, authentication, and suspension checks run on every request.
 * Successful editor admissions expire after 5 s. Stops, role revocations,
 * project deletion, and label changes can take that long to block access.
 * Apps and previews require fresh checks. Suspension uses IdentityService's
 * stale-while-revalidate cache (`ACTIVE_SUSPENSION_FRESH_MS` fresh,
 * `ACTIVE_SUSPENSION_MAX_AGE_MS` maximum age). Session and subject-context
 * deadlines apply even on cache hits.
 */
export async function authorizeProxyRequest(
	request: Request,
	deps: ApiDeps,
): Promise<ProxyDecision> {
	const url = new URL(request.url);
	if (APP_PROXY_PREFIX.test(url.pathname)) {
		return authorizeAppProxyRequest(request, deps);
	}
	const kernelMatch = PROXY_PREFIX.exec(url.pathname);
	const surfaceMatch = SURFACE_PROXY_PREFIX.exec(url.pathname);
	if (!kernelMatch && !surfaceMatch) return { kind: 'pass' };

	// The proxy signing secret travels with the ProxyExposure (subdomain mode has none).
	const exposure = deps.sandbox.exposure;
	const secret = exposure instanceof ProxyExposure ? exposure.signingSecret : undefined;
	if (!secret) {
		// Proxy mode isn't configured (e.g. subdomain deployment) — a `/proxy/*` URL
		// here is not a kernel route; treat it as a normal (likely 404) app path.
		return { kind: 'pass' };
	}

	const token = (kernelMatch ?? surfaceMatch)![1];
	const verified = await verifyProxyToken(token, secret);
	if (!verified) {
		return rejectProxy(403, 'FORBIDDEN', 'Invalid sandbox token');
	}
	const { projectId, sessionId } = verified;

	const user = await deps.authenticator.authenticate(request);
	if (!user) {
		return rejectProxy(401, 'UNAUTHORIZED', 'Authentication required');
	}

	const surfaceId = surfaceMatch?.[2];
	const cache = admissionCache(deps);
	// Grants, groups, email-based admin policy, and context references can differ
	// between credentials belonging to the same user.
	const key = JSON.stringify([
		projectId,
		sessionId,
		surfaceId,
		user.id,
		user.email,
		user.credential,
		user.entitlements,
		user.groups,
		user.entitlementsExpiresAt,
	]);
	const startedAt = Date.now();
	const cached = getFreshAdmission(cache, key, startedAt);
	// A request joining an in-flight load reuses that load's session read.
	const sessionRead =
		cached || cache.hasPending(key)
			? undefined
			: deps.services.sessions.getSession(projectId, sessionId);
	// Suspension can return before this speculative read settles.
	void sessionRead?.catch(() => {});

	// Proxy traffic bypasses the API auth middleware, so both HTTP and WebSocket
	// forwarding enforce suspension here.
	try {
		if (await deps.services.identities.isSuspended(user.id)) {
			return rejectProxy(403, 'USER_SUSPENDED', 'User account is suspended');
		}
	} catch (err) {
		if (err instanceof UnavailableError) {
			return rejectProxy(503, 'SERVICE_UNAVAILABLE', 'Unable to verify account suspension status');
		}
		throw err;
	}

	// Suspension verification can outlast the cached admission.
	getFreshAdmission(cache, key);

	let admission: Admission;
	try {
		const loaded = await cache.getOrLoad(key, async () => {
			// Suspension latency must not extend the speculative read's freshness window.
			const freshSessionRead =
				sessionRead && Date.now() < startedAt + ADMISSION_TTL_MS
					? sessionRead
					: deps.services.sessions.getSession(projectId, sessionId);
			const result = await loadAdmission(
				deps,
				user,
				projectId,
				sessionId,
				surfaceId,
				freshSessionRead,
			);
			if (result.kind === 'reject') throw new AdmissionRejectedError(result);
			const principalDeadlines = [user.entitlementsExpiresAt, user.credential.expiresAt]
				.filter((expiry): expiry is string => expiry !== undefined)
				.map((expiry) => Date.parse(expiry))
				.filter(Number.isFinite);
			return {
				admission: result,
				expiresAt: Math.min(
					startedAt + (result.cacheable ? ADMISSION_TTL_MS : 0),
					...principalDeadlines,
				),
			};
		});
		admission = loaded.admission;
	} catch (error) {
		if (error instanceof AdmissionRejectedError) return error.decision;
		throw error;
	}
	if (
		admission.authorizationDeadline !== undefined &&
		Date.now() >= admission.authorizationDeadline
	) {
		cache.delete(key);
		return rejectProxy(410, 'GONE', 'Session authorization has expired');
	}
	const { originUrl, proxyPath, cacheable, ...forward } = admission;
	if (!cacheable) cache.delete(key);
	const upstreamPath =
		surfaceMatch && proxyPath === 'strip-prefix'
			? url.pathname.slice(surfaceMatch[0].length) || '/'
			: url.pathname;
	return { ...forward, targetUrl: `${trimTrailingSlash(originUrl)}${upstreamPath}${url.search}` };
}

async function loadAdmission(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	projectId: ProjectId,
	sessionId: SessionId,
	surfaceId: string | undefined,
	sessionRead: Promise<Session>,
): Promise<Admission | Rejection> {
	let session;
	try {
		session = await sessionRead;
	} catch {
		return rejectProxy(404, 'NOT_FOUND', 'Session not found');
	}

	if (session.status !== 'running') {
		return rejectProxy(410, 'GONE', 'Session is no longer running');
	}
	const authorizationDeadline = session.authorization_expires_at
		? Date.parse(session.authorization_expires_at)
		: undefined;
	if (authorizationDeadline !== undefined && Date.now() >= authorizationDeadline) {
		return rejectProxy(410, 'GONE', 'Session authorization has expired');
	}

	const surfaceState = surfaceId ? session.surfaces?.[surfaceId] : undefined;
	const originUrl = surfaceId
		? surfaceState?.status === 'ready'
			? surfaceState.origin_url
			: undefined
		: session.sandbox_origin_url;
	if (!originUrl) {
		// Running but no origin recorded — the session was provisioned under a
		// different exposure mode. Not reachable via the proxy.
		return rejectProxy(
			503,
			'SERVICE_UNAVAILABLE',
			surfaceId
				? 'Session surface is not reachable via the proxy'
				: 'Session is not reachable via the proxy',
		);
	}

	const projectRead = deps.services.projects.getProject(projectId, { consistency: 'validated' });
	// Handle notebook failures even when a project failure returns before this read settles.
	const notebookRead = (async () => {
		await assertSessionPreviewActive(deps, projectId, session);
		return deps.services.notebooks.getSecurityLabels(
			projectId,
			sessionResourceNotebookId(session),
			{ consistency: 'validated' },
		);
	})().then(
		(value) => ({ status: 'fulfilled' as const, value }),
		(reason: unknown) => ({ status: 'rejected' as const, reason }),
	);
	let project;
	try {
		project = await projectRead;
	} catch {
		// A session whose project is gone is unreachable, like a missing session.
		return rejectProxy(404, 'NOT_FOUND', 'Session not found');
	}
	// Storage outages must not look like missing notebooks.
	const notebookResult = await notebookRead;
	if (notebookResult.status === 'rejected') {
		if (notebookResult.reason instanceof NotFoundError) {
			return rejectProxy(404, 'NOT_FOUND', 'Session not found');
		}
		return rejectProxy(503, 'SERVICE_UNAVAILABLE', 'Session authorization could not be verified');
	}
	const notebookLabels = notebookResult.value;
	// Hide resource existence for lifecycle, label, and credential denials.
	const decision = await authorizationService(deps).authorize(
		user,
		surfaceId ? 'session.surface' : 'session.proxy',
		{ kind: 'session', project, session, notebookLabels },
	);
	if (!decision.allowed) {
		if (
			decision.category === 'lifecycle' ||
			decision.category === 'constraint' ||
			decision.category === 'credential-resource'
		) {
			return rejectProxy(404, 'NOT_FOUND', 'Session not found');
		}
		return rejectProxy(
			403,
			'FORBIDDEN',
			surfaceId
				? 'Not authorized to use this session surface'
				: 'Not authorized to attach this session',
		);
	}

	if (sessionMode(session) === 'app') {
		try {
			const allowed = await new AppPoolService(
				deps.bucket,
				deps.services.sessions,
				deps.policy.appPool,
				deps.metrics,
			).canAccess(projectId, session.notebook_id, user.id, sessionId, !session.app_pool);
			if (!allowed) {
				return rejectProxy(410, 'GONE', 'The app assignment expired. Open the app again.');
			}
		} catch {
			return rejectProxy(503, 'SERVICE_UNAVAILABLE', 'Session authorization could not be verified');
		}
	}
	// Sockets must close at the earlier session or subject-context deadline.
	const contextDeadline =
		decision.subjectContextExpiresAt !== undefined
			? Date.parse(decision.subjectContextExpiresAt)
			: undefined;
	const effectiveDeadline =
		authorizationDeadline !== undefined && contextDeadline !== undefined
			? Math.min(authorizationDeadline, contextDeadline)
			: (authorizationDeadline ?? contextDeadline);

	// Legacy records without proxy_path use the configured VS Code flavor.
	const proxyPath =
		surfaceState?.proxy_path ??
		(surfaceId === 'vscode' && deps.sandbox.surfaces?.vscode?.flavor === 'openvscode'
			? 'preserve-prefix'
			: 'strip-prefix');
	return {
		kind: 'forward',
		originUrl,
		proxyPath,
		cacheable: sessionMode(session) !== 'app' && session.origin?.type !== 'preview',
		sessionId,
		...(!surfaceId && session.kernel_auth_token
			? { kernelAuthToken: session.kernel_auth_token }
			: {}),
		...(effectiveDeadline !== undefined ? { authorizationDeadline: effectiveDeadline } : {}),
	};
}

/** Hop-by-hop headers that must not be copied across a proxy (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
]);

/**
 * Notebook code can read request headers. HTTP and WebSocket proxies strip hub
 * credentials, including Access assertions, service tokens, and cookies.
 * Only the session's kernel token reaches the notebook.
 */
export const CREDENTIAL_HEADERS = new Set([
	APP_PROXY_HEADER,
	APP_STATUS_HEADER,
	APP_VISIT_HEADER,
	APP_GENERATION_HEADER,
	'cookie',
	'authorization',
	'x-goog-iap-jwt-assertion',
	'x-forwarded-email',
	'x-forwarded-user',
	'cf-access-jwt-assertion',
	'cf-access-client-id',
	'cf-access-client-secret',
]);

/** Kernel cookies share the hub origin and can overwrite the caller's hub session. */
export const UNSAFE_RESPONSE_HEADERS = new Set([
	'set-cookie',
	'set-cookie2',
	APP_PROXY_HEADER,
	APP_STATUS_HEADER,
	APP_VISIT_HEADER,
	APP_GENERATION_HEADER,
]);

export function isCredentialHeader(name: string, additional: readonly string[] = []): boolean {
	const lower = name.toLowerCase();
	return (
		CREDENTIAL_HEADERS.has(lower) || additional.some((header) => header.toLowerCase() === lower)
	);
}

function requestHeaders(
	request: Request,
	targetUrl: string,
	kernelAuthToken?: string,
	credentialHeaders?: readonly string[],
): Headers {
	const out = new Headers();
	request.headers.forEach((value, key) => {
		const k = key.toLowerCase();
		if (!HOP_BY_HOP.has(k) && !isCredentialHeader(k, credentialHeaders)) out.set(key, value);
	});
	// marimo validates a request's Origin against its own host; present the kernel
	// origin so the proxied request reads as same-origin (Host is set by `fetch`).
	out.set('origin', new URL(targetUrl).origin);
	if (kernelAuthToken) out.set('authorization', `Bearer ${kernelAuthToken}`);
	return out;
}

function responseHeaders(headers: Headers): Headers {
	const out = new Headers();
	// The Node entrypoint requests identity upstream and compresses downstream.
	// If an upstream still encodes its body, fetch decodes it but retains these
	// headers; drop them to prevent double decoding or truncation.
	const decoded = headers.has('content-encoding');
	headers.forEach((value, key) => {
		const k = key.toLowerCase();
		if (HOP_BY_HOP.has(k) || UNSAFE_RESPONSE_HEADERS.has(k)) return;
		if (decoded && (k === 'content-encoding' || k === 'content-length')) return;
		out.set(key, value);
	});
	return out;
}

/** Upstream statuses that mean "a gateway between hub and kernel failed", not the kernel itself. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Stream HTTP responses. The Node entrypoint handles WebSocket upgrades.
 * GET and HEAD retry once after transport errors, such as closed keep-alive
 * connections. Other methods cannot retry because their body stream is consumed.
 */
export async function forwardHttp(
	request: Request,
	targetUrl: string,
	sessionId?: string,
	kernelAuthToken?: string,
	credentialHeaders?: readonly string[],
): Promise<Response> {
	const init: RequestInit = {
		method: request.method,
		headers: requestHeaders(request, targetUrl, kernelAuthToken, credentialHeaders),
		redirect: 'manual',
	};
	const retryable = request.method === 'GET' || request.method === 'HEAD';
	if (!retryable) {
		init.body = request.body;
		// Node's fetch requires this when streaming a request body.
		(init as { duplex?: string }).duplex = 'half';
	}
	// The token in the path routes to the session; keep it out of logs. That is
	// also why the error below is logged as metadata, not free-form text — a
	// fetch failure's message/stack can quote the target URL.
	const target = new URL(targetUrl).origin;
	let upstream: Response | undefined;
	const attempts = retryable ? 2 : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			upstream = await fetch(targetUrl, init);
			break;
		} catch (err) {
			logEvent({
				level: 'warn',
				event: 'sandbox_proxy_upstream_error',
				session_id: sessionId ?? null,
				method: request.method,
				target,
				attempt,
				will_retry: attempt < attempts,
				error: errorMetadataChain(err),
			});
		}
	}
	if (!upstream) {
		// Kernel unreachable (e.g. torn down mid-request) — a gateway failure, not a
		// server bug, so don't surface a 500 through the error handler.
		return Response.json(
			{
				success: false,
				error: { code: 'SERVICE_UNAVAILABLE', message: 'Kernel unavailable' },
			},
			{ status: 502 },
		);
	}
	if (GATEWAY_STATUSES.has(upstream.status)) {
		// Passed through verbatim, but a 502/503/504 minted between hub and kernel
		// (e.g. the sandbox-side ingress) is invisible without this line.
		logEvent({
			level: 'warn',
			event: 'sandbox_proxy_upstream_gateway_status',
			session_id: sessionId ?? null,
			method: request.method,
			target,
			status: upstream.status,
		});
	}
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders(upstream.headers),
	});
}

/** Mount before API and SPA routes so proxy requests cannot fall through to them. */
export function sandboxProxyMiddleware(deps: ApiDeps): MiddlewareHandler<HonoEnv> {
	return async (c, next) => {
		if (deps.sandbox.exposure?.mode !== 'proxy') return next();
		const appRoute = APP_PROXY_PREFIX.test(new URL(c.req.url).pathname);
		const decision = await authorizeProxyRequest(c.req.raw, deps);
		if (decision.kind === 'pass') return next();
		if (appRoute) c.header(APP_PROXY_HEADER, '1');
		if (decision.kind === 'reject') {
			return fail(c, decision.code, decision.message, decision.status);
		}
		if (decision.kind === 'starting') {
			c.header(APP_STATUS_HEADER, 'starting');
			return fail(c, 'SERVICE_UNAVAILABLE', 'App session is starting', 503);
		}
		const response = await forwardHttp(
			c.req.raw,
			decision.targetUrl,
			decision.sessionId,
			decision.kernelAuthToken,
			deps.sandbox.credentialHeaders,
		);
		if (!decision.appProxyBaseUrl) return response;
		const forwarded = await appProxyResponse(
			response,
			c.req.url,
			decision.targetUrl,
			decision.appProxyBaseUrl,
			resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
		);
		forwarded.headers.set(APP_PROXY_HEADER, '1');
		return forwarded;
	};
}

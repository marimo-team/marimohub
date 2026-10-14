/**
 * Request-time forwarding for `proxy` sandbox-exposure mode.
 *
 * The browser reaches a kernel via `…/proxy/<token>/…` on the app's origin. Each
 * HTTP request is authenticated and authorized per-session (the caller must hold
 * the project role that starting a session requires), then streamed to the
 * kernel's origin. The kernel runs under `--base-url=/proxy/<token>`, so the full
 * path is forwarded unchanged. `authorizeProxyRequest` is shared with the
 * WebSocket path (the Node entrypoint) so the two transports authorize
 * identically. Entitlement-backed sessions also return a fixed deadline that
 * the Node relay uses to close an established socket.
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
import { assertSessionPreviewActive, authorizationService, fail } from './shared';

/** Outcome of routing a `/proxy/<token>/…` request. */
export type ProxyDecision =
	| { kind: 'pass' } // Not a proxy path — let the normal app handle it.
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
	  };

type Rejection = Extract<ProxyDecision, { kind: 'reject' }>;
type Admission = Omit<Extract<ProxyDecision, { kind: 'forward' }>, 'targetUrl'> & {
	originUrl: string;
	proxyPath: 'strip-prefix' | 'preserve-prefix';
	cacheable: boolean;
};
type CachedAdmission = { admission: Admission; expiresAt: number };
type Session = Awaited<ReturnType<ApiDeps['services']['sessions']['getSession']>>;

const ADMISSION_CACHES = new WeakMap<ApiDeps, LazyMap<string, CachedAdmission>>();
const ADMISSION_TTL_MS = 5_000;

class AdmissionRejectedError extends Error {
	constructor(readonly decision: Rejection) {
		super(decision.message);
		this.name = 'AdmissionRejectedError';
	}
}

function admissionCache(deps: ApiDeps): LazyMap<string, CachedAdmission> {
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

const PROXY_PREFIX = /^\/proxy\/([^/]+)/;
const SURFACE_PROXY_PREFIX = /^\/surface-proxy\/([^/]+)\/([^/]+)/;

/** Strip a trailing slash so we can concatenate an origin with a path cleanly. */
function trimTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Resolve and authorize a possible `/proxy/<token>/…` request without forwarding
 * it. Returns `pass` when the path isn't a proxy path (caller continues normally),
 * `reject` with an HTTP status to deny, or `forward` with the kernel target.
 *
 * Order matters: token signature first (cheap, no I/O), then authentication, then
 * suspension, then session liveness and the per-session role check. Successful
 * editor admissions are cached for up to 5 s: stops, role revocations, project
 * deletion, and label changes can lag by that window. Apps and previews require
 * fresh checks for pool invalidation, label changes, and preview revocation.
 * Suspension has its own 10 s cache; explicit authorization deadlines never lag.
 */
export async function authorizeProxyRequest(
	request: Request,
	deps: ApiDeps,
): Promise<ProxyDecision> {
	const url = new URL(request.url);
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
		return { kind: 'reject', status: 403, code: 'FORBIDDEN', message: 'Invalid sandbox token' };
	}
	const { projectId, sessionId } = verified;

	const user = await deps.authenticator.authenticate(request);
	if (!user) {
		return {
			kind: 'reject',
			status: 401,
			code: 'UNAUTHORIZED',
			message: 'Authentication required',
		};
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
	let cached = cache.getIfPresent(key);
	if (cached && cached.expiresAt <= startedAt) {
		cache.delete(key);
		cached = undefined;
	}
	const sessionRead = cached ? undefined : deps.services.sessions.getSession(projectId, sessionId);
	// Suspension can return before this speculative read settles.
	void sessionRead?.catch(() => {});

	// Proxy traffic bypasses the API auth middleware, so both HTTP and WebSocket
	// forwarding enforce suspension here.
	try {
		if (await deps.services.identities.isSuspended(user.id)) {
			return {
				kind: 'reject',
				status: 403,
				code: 'USER_SUSPENDED',
				message: 'User account is suspended',
			};
		}
	} catch (err) {
		if (err instanceof UnavailableError) {
			return {
				kind: 'reject',
				status: 503,
				code: 'SERVICE_UNAVAILABLE',
				message: 'Unable to verify account suspension status',
			};
		}
		throw err;
	}

	const current = cache.getIfPresent(key);
	if (current && current.expiresAt <= Date.now()) cache.delete(key);

	let admission: Admission;
	try {
		const loaded = await cache.getOrLoad(key, async () => {
			const result = await loadAdmission(
				deps,
				user,
				projectId,
				sessionId,
				surfaceId,
				sessionRead ?? deps.services.sessions.getSession(projectId, sessionId),
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
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
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
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}

	if (session.status !== 'running') {
		return { kind: 'reject', status: 410, code: 'GONE', message: 'Session is no longer running' };
	}
	const authorizationDeadline = session.authorization_expires_at
		? Date.parse(session.authorization_expires_at)
		: undefined;
	if (authorizationDeadline !== undefined && Date.now() >= authorizationDeadline) {
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
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
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: surfaceId
				? 'Session surface is not reachable via the proxy'
				: 'Session is not reachable via the proxy',
		};
	}

	const projectRead = deps.services.projects.getProject(projectId);
	// Handle notebook failures even when a project failure returns before this read settles.
	const notebookRead = (async () => {
		await assertSessionPreviewActive(deps, projectId, session);
		return deps.services.notebooks.getSecurityLabels(projectId, sessionResourceNotebookId(session));
	})().then(
		(value) => ({ status: 'fulfilled' as const, value }),
		(reason: unknown) => ({ status: 'rejected' as const, reason }),
	);
	let project;
	try {
		project = await projectRead;
	} catch {
		// A session whose project is gone is unreachable, like a missing session.
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}
	// The notebook's label override rides on every proxy decision: a caller who
	// satisfies the project labels but not the override must not reach the
	// kernel. A missing notebook masks; a transient meta failure fails closed as
	// unavailable rather than pretending the session is gone.
	const notebookResult = await notebookRead;
	if (notebookResult.status === 'rejected') {
		if (notebookResult.reason instanceof NotFoundError) {
			return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
		}
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session authorization could not be verified',
		};
	}
	const notebookLabels = notebookResult.value;
	// Lifecycle and label denials mask as missing; membership denials remain 403.
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
			return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
		}
		return {
			kind: 'reject',
			status: 403,
			code: 'FORBIDDEN',
			message: surfaceId
				? 'Not authorized to use this session surface'
				: 'Not authorized to attach this session',
		};
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
				return {
					kind: 'reject',
					status: 410,
					code: 'GONE',
					message: 'The app assignment expired. Open the app again.',
				};
			}
		} catch {
			return {
				kind: 'reject',
				status: 503,
				code: 'SERVICE_UNAVAILABLE',
				message: 'Session authorization could not be verified',
			};
		}
	}
	// The CURRENT context expiry can be earlier than the deadline stamped at
	// session start — an established socket must not outlive either.
	const contextDeadline =
		decision.subjectContextExpiresAt !== undefined
			? Date.parse(decision.subjectContextExpiresAt)
			: undefined;
	const effectiveDeadline =
		authorizationDeadline !== undefined && contextDeadline !== undefined
			? Math.min(authorizationDeadline, contextDeadline)
			: (authorizationDeadline ?? contextDeadline);

	// Records written before `proxy_path` was persisted route by the configured
	// VS Code flavor; code-server (the default) strips the prefix.
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
 * Hub credentials must never reach the kernel. Notebook code can read request
 * headers (`mo.app_meta().request`), so forwarding them would expose each
 * caller's credential to the notebook author. The proxy adds only the
 * session-scoped marimo token after this filter.
 * `cf-access-jwt-assertion` is exactly that under the Cloudflare Access
 * authenticator (it is the whole proof of identity), and the `cf-access-client-*`
 * service-token pair mints one. Access's `CF_Authorization` cookie is covered by
 * `cookie`. The WS forwarder filters on this same set.
 */
export const CREDENTIAL_HEADERS = new Set([
	'cookie',
	'authorization',
	'x-goog-iap-jwt-assertion',
	'x-forwarded-email',
	'x-forwarded-user',
	'cf-access-jwt-assertion',
	'cf-access-client-id',
	'cf-access-client-secret',
]);

/**
 * In `proxy` exposure the kernel answers on the APP's origin, so a `Set-Cookie`
 * it emits is written for the hub — letting notebook-author code overwrite the
 * caller's hub session. The WS forwarder strips the same set from its 101.
 */
export const UNSAFE_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

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
 * Forward an authorized HTTP request to the kernel and return its response,
 * streaming the body. WebSocket upgrades are handled separately (the Node
 * entrypoint) since `fetch` can't carry them on every runtime.
 *
 * GET/HEAD get one immediate retry when the fetch itself throws: the common
 * cause is the kernel (uvicorn, ~5s keep-alive) closing a pooled connection
 * the hub is about to reuse — a race that bursts of parallel asset requests
 * hit, and that a fresh connection resolves. Requests with a body are never
 * retried (the stream is already consumed).
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

/**
 * Hono middleware that serves `proxy`-mode kernel traffic. A no-op in `subdomain`
 * mode (and for any non-`/proxy` path). Mounted on `*` ahead of the app's own
 * routes so kernel asset/API requests never fall through to the SPA or `/api`.
 */
export function sandboxProxyMiddleware(deps: ApiDeps): MiddlewareHandler<HonoEnv> {
	return async (c, next) => {
		if (deps.sandbox.exposure?.mode !== 'proxy') return next();
		const decision = await authorizeProxyRequest(c.req.raw, deps);
		if (decision.kind === 'pass') return next();
		if (decision.kind === 'reject') {
			return fail(c, decision.code, decision.message, decision.status);
		}
		return forwardHttp(
			c.req.raw,
			decision.targetUrl,
			decision.sessionId,
			decision.kernelAuthToken,
			deps.sandbox.credentialHeaders,
		);
	};
}

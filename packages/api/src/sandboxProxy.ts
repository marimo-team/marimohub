/**
 * Request-time forwarding for `proxy` sandbox-exposure mode.
 *
 * Token routes preserve `/proxy/<token>`; app routes map to that kernel base. Each
 * HTTP request is authenticated and authorized per-session (the caller must hold
 * the project role that starting a session requires), then streamed to the
 * kernel's origin. `authorizeProxyRequest` is shared with the
 * WebSocket path (the Node entrypoint) so the two transports authorize
 * identically. Entitlement-backed sessions also return a fixed deadline that
 * the Node relay uses to close an established socket.
 */
import type { MiddlewareHandler } from 'hono';
import {
	AppPoolService,
	AppVisitSchema,
	NotebookId,
	ProjectId,
	SessionId,
	isPastAuthorizationDeadline,
	sessionMode,
	sessionResourceNotebookId,
	NotFoundError,
	ProxyExposure,
	UnavailableError,
	verifyProxyToken,
	signProxyToken,
} from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from './context';
import { errorMetadataChain, logEvent } from './log';
import { assertSessionPreviewActive, authorizationService, fail } from './shared';

/** Outcome of routing a sandbox proxy request. */
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

const PROXY_PREFIX = /^\/proxy\/([^/]+)/;
const SURFACE_PROXY_PREFIX = /^\/surface-proxy\/([^/]+)\/([^/]+)/;
const APP_PROXY_PREFIX = /^\/app-proxy\/([^/]+)\/([^/]+)\/([^/]+)(?=\/|$)/;
export const APP_VISIT_HEADER = 'x-marimohub-app-visit-id';
export const APP_GENERATION_HEADER = 'x-marimohub-app-generation';
export const APP_STATUS_HEADER = 'x-marimohub-app-status';
export const APP_PROXY_HEADER = 'x-marimohub-app-proxy';

/** Strip a trailing slash so we can concatenate an origin with a path cleanly. */
function trimTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: 'fulfilled', value }),
		(reason: unknown) => ({ status: 'rejected', reason }),
	);
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
	if (result.status === 'rejected') throw result.reason;
	return result.value;
}

/**
 * Resolve and authorize a possible sandbox proxy request without forwarding
 * it. Returns `pass` when the path isn't a proxy path (caller continues normally),
 * `reject` with an HTTP status to deny, or `forward` with the kernel target.
 *
 * Validate the route proof before authentication; require live authorization
 * before app-pool renewal or forwarding.
 */
export async function authorizeProxyRequest(
	request: Request,
	deps: ApiDeps,
): Promise<ProxyDecision> {
	const url = new URL(request.url);
	const kernelMatch = PROXY_PREFIX.exec(url.pathname);
	const surfaceMatch = SURFACE_PROXY_PREFIX.exec(url.pathname);
	const appMatch = APP_PROXY_PREFIX.exec(url.pathname);
	if (!kernelMatch && !surfaceMatch && !appMatch) return { kind: 'pass' };

	// The proxy signing secret travels with the ProxyExposure (subdomain mode has none).
	const exposure = deps.sandbox.exposure;
	const secret = exposure instanceof ProxyExposure ? exposure.signingSecret : undefined;
	if (!secret) {
		// Proxy mode isn't configured (e.g. subdomain deployment) — a `/proxy/*` URL
		// here is not a kernel route; treat it as a normal (likely 404) app path.
		return { kind: 'pass' };
	}

	const visit = appMatch
		? AppVisitSchema.safeParse({
				visit_id: request.headers.get(APP_VISIT_HEADER),
				generation: request.headers.get(APP_GENERATION_HEADER),
			})
		: undefined;
	if (appMatch && (!visit?.success || !NotebookId.is(appMatch[2]))) {
		return { kind: 'reject', status: 403, code: 'FORBIDDEN', message: 'Invalid app visit' };
	}
	// The canonical app route is authenticated below and fenced by an exact visit;
	// it cannot fall back to the older proxy contract on a mixed-version rollout.
	const verified = appMatch
		? ProjectId.is(appMatch[1]) && SessionId.is(appMatch[3])
			? { projectId: appMatch[1], sessionId: appMatch[3] }
			: null
		: await verifyProxyToken((kernelMatch ?? surfaceMatch)![1], secret);
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

	// Handle speculative failures immediately; an earlier failure must not wait for later reads.
	const appMetadata = appMatch
		? {
				session: settle(deps.services.sessions.getSession(projectId, sessionId)),
				project: settle(deps.services.projects.getProject(projectId)),
				notebook: settle(
					deps.services.notebooks.getSecurityLabels(projectId, NotebookId.parse(appMatch[2])),
				),
			}
		: undefined;
	let session;
	try {
		session = appMetadata
			? settledValue(await appMetadata.session)
			: await deps.services.sessions.getSession(projectId, sessionId);
	} catch {
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}
	if (
		appMatch &&
		(sessionMode(session) !== 'app' ||
			!session.app_pool ||
			sessionResourceNotebookId(session) !== appMatch[2])
	) {
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}

	if (session.status !== 'running' && !(appMatch && session.status === 'starting')) {
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

	const surfaceId = surfaceMatch?.[2];
	const surfaceState = surfaceId ? session.surfaces?.[surfaceId] : undefined;
	const originUrl = surfaceId
		? surfaceState?.status === 'ready'
			? surfaceState.origin_url
			: undefined
		: session.sandbox_origin_url;
	if (!originUrl && !(appMatch && session.status === 'starting')) {
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

	const projectRead = appMetadata?.project ?? settle(deps.services.projects.getProject(projectId));
	const notebookRead = settle(
		(async () => {
			await assertSessionPreviewActive(deps, projectId, session);
			return appMetadata
				? settledValue(await appMetadata.notebook)
				: deps.services.notebooks.getSecurityLabels(projectId, sessionResourceNotebookId(session));
		})(),
	);
	let project;
	try {
		project = settledValue(await projectRead);
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
	// The proxy decision covers lifecycle (a soft-deleted project's
	// kernels go dark immediately — this is the only thing in the
	// browser→kernel path, and the sandbox may still be alive), session
	// admission (role re-checked per request, so a revoked membership cuts
	// kernel access), and the label constraints (project labels + notebook
	// override — one subject-context resolve and one adapter round-trip, not
	// one per gate). Lifecycle and constraint denials mask as a missing
	// session; membership and session denials keep the historical 403.
	const authorizer = authorizationService(deps);
	const resource = { kind: 'session' as const, project, session, notebookLabels };
	const decision = await authorizer.authorize(
		user,
		surfaceId ? 'session.surface' : 'session.proxy',
		resource,
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
	// Renewal needs attach permission as well as proxy permission, including
	// action-specific resource-security policy and scoped credential grants.
	const renewalDecision = appMatch
		? await authorizer.authorize(user, 'session.attach', resource)
		: undefined;
	if (renewalDecision && !renewalDecision.allowed) {
		if (
			renewalDecision.category === 'constraint' ||
			renewalDecision.category === 'lifecycle' ||
			renewalDecision.category === 'credential-resource'
		) {
			return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
		}
		return {
			kind: 'reject',
			status: 403,
			code: 'FORBIDDEN',
			message: 'App renewal not authorized',
		};
	}

	// The CURRENT context expiry can be earlier than the deadline stamped at
	// session start — an established socket must not outlive either.
	const contextDeadline =
		decision.subjectContextExpiresAt !== undefined
			? Date.parse(decision.subjectContextExpiresAt)
			: undefined;
	let effectiveDeadline =
		authorizationDeadline !== undefined && contextDeadline !== undefined
			? Math.min(authorizationDeadline, contextDeadline)
			: (authorizationDeadline ?? contextDeadline);
	if (renewalDecision?.allowed && renewalDecision.subjectContextExpiresAt) {
		effectiveDeadline = Math.min(
			effectiveDeadline ?? Infinity,
			Date.parse(renewalDecision.subjectContextExpiresAt),
		);
	}
	if (appMatch && effectiveDeadline !== undefined && Date.now() >= effectiveDeadline) {
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
	}

	if (sessionMode(session) === 'app') {
		try {
			const pool = new AppPoolService(
				deps.bucket,
				deps.services.sessions,
				deps.policy.appPool,
				deps.metrics,
			);
			const allowed =
				appMatch && visit?.success
					? await pool.heartbeat(projectId, session.notebook_id, user.id, sessionId, visit.data)
					: await pool.canAccess(
							projectId,
							session.notebook_id,
							user.id,
							sessionId,
							!session.app_pool,
						);
			if (!allowed) {
				return {
					kind: 'reject',
					status: 410,
					code: 'GONE',
					message: 'The app assignment expired. Open the app again.',
				};
			}
			if (appMatch) {
				session = await deps.services.sessions.heartbeatFromSnapshot(session);
				if (
					(session.status !== 'running' && session.status !== 'starting') ||
					isPastAuthorizationDeadline(session, Date.now())
				) {
					return {
						kind: 'reject',
						status: 410,
						code: 'GONE',
						message: 'Session is no longer running',
					};
				}
				if (session.sandbox_origin_url !== originUrl) {
					return {
						kind: 'reject',
						status: 503,
						code: 'SERVICE_UNAVAILABLE',
						message: 'Session target changed',
					};
				}
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
	if (appMatch && session.authorization_expires_at) {
		effectiveDeadline = Math.min(
			effectiveDeadline ?? Infinity,
			Date.parse(session.authorization_expires_at),
		);
	}
	if (appMatch && effectiveDeadline !== undefined && Date.now() >= effectiveDeadline) {
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
	}

	if (appMatch && session.status === 'starting') return { kind: 'starting' };
	if (!originUrl) {
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session is not reachable via the proxy',
		};
	}

	// Records written before `proxy_path` was persisted route by the configured
	// VS Code flavor; code-server (the default) strips the prefix.
	const proxyPath =
		surfaceState?.proxy_path ??
		(surfaceId === 'vscode' && deps.sandbox.surfaces?.vscode?.flavor === 'openvscode'
			? 'preserve-prefix'
			: 'strip-prefix');
	const appKernelBase = appMatch
		? `/proxy/${await signProxyToken(projectId, sessionId, secret)}`
		: undefined;
	const upstreamPath = appMatch
		? `${appKernelBase}${url.pathname.slice(appMatch[0].length) || '/'}`
		: surfaceMatch && proxyPath === 'strip-prefix'
			? url.pathname.slice(surfaceMatch[0].length) || '/'
			: url.pathname;
	const targetUrl = `${trimTrailingSlash(originUrl)}${upstreamPath}${url.search}`;
	return {
		kind: 'forward',
		targetUrl,
		sessionId,
		...((kernelMatch || appMatch) && session.kernel_auth_token
			? { kernelAuthToken: session.kernel_auth_token }
			: {}),
		...(effectiveDeadline !== undefined ? { authorizationDeadline: effectiveDeadline } : {}),
		...(appKernelBase
			? { appProxyBaseUrl: `${trimTrailingSlash(originUrl)}${appKernelBase}` }
			: {}),
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

/**
 * In `proxy` exposure the kernel answers on the APP's origin, so a `Set-Cookie`
 * it emits is written for the hub — letting notebook-author code overwrite the
 * caller's hub session. The WS forwarder strips the same set from its 101.
 */
export const UNSAFE_RESPONSE_HEADERS = new Set([
	APP_VISIT_HEADER,
	APP_GENERATION_HEADER,
	'set-cookie',
	'set-cookie2',
	APP_STATUS_HEADER,
	APP_PROXY_HEADER,
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
	// `fetch` transparently decodes a compressed response body but leaves the
	// original content-encoding/length headers in place — forwarding them would
	// make the browser double-decode (or truncate) the already-decoded body.
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

async function appProxyResponse(
	response: Response,
	requestUrl: string,
	targetUrl: string,
	baseUrl: string,
): Promise<Response> {
	const location = response.headers.get('location');
	if (location === null) return response;
	const target = new URL(targetUrl);
	const kernelBase = new URL(baseUrl).pathname;
	let redirect: URL | undefined;
	try {
		redirect = new URL(location, target);
	} catch {
		// An invalid Location must not turn a handled upstream response into a 500.
	}
	if (
		!redirect ||
		redirect.origin !== target.origin ||
		(redirect.pathname !== kernelBase && !redirect.pathname.startsWith(`${kernelBase}/`))
	) {
		await response.body?.cancel();
		return Response.json(
			{
				success: false,
				error: { code: 'SERVICE_UNAVAILABLE', message: 'Kernel redirect left the app' },
			},
			{ status: 502 },
		);
	}
	const request = new URL(requestUrl);
	const appBase = APP_PROXY_PREFIX.exec(request.pathname)![0];
	const headers = new Headers(response.headers);
	headers.set(
		'location',
		`${request.origin}${appBase}${redirect.pathname.slice(kernelBase.length)}${redirect.search}${redirect.hash}`,
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Hono middleware that serves `proxy`-mode kernel traffic. A no-op in `subdomain`
 * mode (and for non-proxy paths). Mounted on `*` ahead of the app's own
 * routes so kernel asset/API requests never fall through to the SPA or `/api`.
 */
export function sandboxProxyMiddleware(deps: ApiDeps): MiddlewareHandler<HonoEnv> {
	return async (c, next) => {
		if (deps.sandbox.exposure?.mode !== 'proxy') return next();
		const appRoute = APP_PROXY_PREFIX.test(new URL(c.req.url).pathname);
		if (appRoute) c.header(APP_PROXY_HEADER, '1');
		const decision = await authorizeProxyRequest(c.req.raw, deps);
		if (decision.kind === 'pass') return next();
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
		);
		forwarded.headers.set(APP_PROXY_HEADER, '1');
		return forwarded;
	};
}

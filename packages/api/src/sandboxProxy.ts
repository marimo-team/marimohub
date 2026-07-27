/**
 * Request-time forwarding for `proxy` sandbox-exposure mode.
 *
 * The browser reaches a kernel via `…/proxy/<token>/…` on the app's origin. Each
 * HTTP request is authenticated and authorized per-session (the caller must hold
 * the project role that starting a session requires), then streamed to the
 * kernel's origin. The kernel runs under `--base-url=/proxy/<token>`, so the full
 * path is forwarded unchanged. `authorizeProxyRequest` is shared with the
 * WebSocket path (the Node entrypoint) so the two transports authorize
 * identically — but a WebSocket is authorized at the UPGRADE only: an
 * established kernel socket outlives a later revocation until it closes.
 */
import type { MiddlewareHandler } from 'hono';
import { ForbiddenError, ProxyExposure, verifyProxyToken } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from './context';
import { assertSessionAccess, fail } from './shared';

/** Outcome of routing a `/proxy/<token>/…` request. */
export type ProxyDecision =
	| { kind: 'pass' } // Not a proxy path — let the normal app handle it.
	| { kind: 'reject'; status: 401 | 403 | 404 | 410 | 503; code: string; message: string }
	| { kind: 'forward'; targetUrl: string; sessionId: string };

const PROXY_PREFIX = /^\/proxy\/([^/]+)/;

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
 * session liveness, then the per-session role check.
 */
export async function authorizeProxyRequest(
	request: Request,
	deps: ApiDeps,
): Promise<ProxyDecision> {
	const url = new URL(request.url);
	const match = PROXY_PREFIX.exec(url.pathname);
	if (!match) return { kind: 'pass' };

	// The proxy signing secret travels with the ProxyExposure (subdomain mode has none).
	const exposure = deps.sandbox.exposure;
	const secret = exposure instanceof ProxyExposure ? exposure.signingSecret : undefined;
	if (!secret) {
		// Proxy mode isn't configured (e.g. subdomain deployment) — a `/proxy/*` URL
		// here is not a kernel route; treat it as a normal (likely 404) app path.
		return { kind: 'pass' };
	}

	const token = match[1];
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

	let session;
	try {
		session = await deps.services.sessions.getSession(projectId, sessionId);
	} catch {
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}

	if (session.status !== 'running') {
		return { kind: 'reject', status: 410, code: 'GONE', message: 'Session is no longer running' };
	}

	const originUrl = session.sandbox_origin_url;
	if (!originUrl) {
		// Running but no origin recorded — the session was provisioned under a
		// different exposure mode. Not reachable via the proxy.
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session is not reachable via the proxy',
		};
	}

	// Per-session authorization — role re-checked per request, so a revoked
	// membership cuts kernel access (assertSessionAccess says who is admitted).
	let project;
	try {
		project = await deps.services.projects.getProject(projectId);
	} catch {
		// A session whose project is gone is unreachable, like a missing session.
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}
	// A soft-deleted project's kernels go dark immediately: this gate is the only
	// thing in the browser→kernel path, and the sandbox may still be alive.
	if (project.status === 'deleted') {
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}
	try {
		assertSessionAccess(project, session, user, deps.policy);
	} catch (err) {
		if (err instanceof ForbiddenError) {
			return { kind: 'reject', status: 403, code: 'FORBIDDEN', message: err.message };
		}
		throw err;
	}

	// Forward the FULL path unchanged (marimo runs under --base-url=/proxy/<token>).
	const targetUrl = `${trimTrailingSlash(originUrl)}${url.pathname}${url.search}`;
	return { kind: 'forward', targetUrl, sessionId };
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
 * Hub credentials must never reach the kernel: it runs `--no-token` and needs
 * none, and notebook code can read request headers (`mo.app_meta().request`) —
 * forwarding them would hand every caller's credential to the notebook author.
 * `cf-access-jwt-assertion` is exactly that under the Cloudflare Access
 * authenticator (it is the whole proof of identity), and the `cf-access-client-*`
 * service-token pair mints one. Access's `CF_Authorization` cookie is covered by
 * `cookie`. The WS forwarder filters on this same set.
 */
export const CREDENTIAL_HEADERS = new Set([
	'cookie',
	'authorization',
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

function requestHeaders(request: Request, targetUrl: string): Headers {
	const out = new Headers();
	request.headers.forEach((value, key) => {
		const k = key.toLowerCase();
		if (!HOP_BY_HOP.has(k) && !CREDENTIAL_HEADERS.has(k)) out.set(key, value);
	});
	// marimo validates a request's Origin against its own host; present the kernel
	// origin so the proxied request reads as same-origin (Host is set by `fetch`).
	out.set('origin', new URL(targetUrl).origin);
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

/**
 * Forward an authorized HTTP request to the kernel and return its response,
 * streaming the body. WebSocket upgrades are handled separately (the Node
 * entrypoint) since `fetch` can't carry them on every runtime.
 */
export async function forwardHttp(request: Request, targetUrl: string): Promise<Response> {
	const init: RequestInit = {
		method: request.method,
		headers: requestHeaders(request, targetUrl),
		redirect: 'manual',
	};
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		init.body = request.body;
		// Node's fetch requires this when streaming a request body.
		(init as { duplex?: string }).duplex = 'half';
	}
	let upstream: Response;
	try {
		upstream = await fetch(targetUrl, init);
	} catch {
		// Kernel unreachable (e.g. torn down mid-request) — a gateway failure, not a
		// server bug, so don't surface a 500 through the error handler.
		return new Response('Kernel unavailable', { status: 502 });
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
		return forwardHttp(c.req.raw, decision.targetUrl);
	};
}

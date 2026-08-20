import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { etag } from 'hono/etag';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { routePath } from 'hono/route';
import {
	DomainError,
	ensureInitialized,
	isPatRequest,
	MAX_REQUEST_BYTES,
	noopNotifier,
	probeKernelLiveness,
	SubdomainExposure,
	UnavailableError,
} from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from './context';
import { describeError, errorMetadata, logEvent } from './log';
import adminApp from './routes/admin';
import { createAiProxy } from './routes/ai';
import eventsApp from './routes/events';
import gitSyncApp from './routes/gitSync';
import notebooksApp from './routes/notebooks';
import changeRequestsApp from './routes/changeRequests';
import projectsApp from './routes/projects';
import projectAlertsApp from './routes/projectAlerts';
import integrationsApp from './routes/integrations';
import sessionsApp from './routes/sessions';
import systemApp from './routes/system';
import tokensApp from './routes/tokens';
import usersApp from './routes/users';
import { createOidcDiscovery } from './oidcDiscovery';
import { sandboxProxyMiddleware } from './sandboxProxy';
import { createApp, ErrorResponseSchema, fail } from './shared';
import type { ErrorCode } from './shared';

const OPENAPI_DOC = {
	openapi: '3.1.0' as const,
	info: {
		title: 'marimohub API',
		version: '1.0.0',
		description: 'API for managing Marimo notebooks, projects, and sandboxes',
	},
	tags: [
		{ name: 'Auth', description: 'Authentication' },
		{ name: 'Projects', description: 'Project management' },
		{ name: 'Alerts', description: 'Project alert destinations' },
		{ name: 'Notebooks', description: 'Notebook CRUD and versioning' },
		{ name: 'Sessions', description: 'Notebook session lifecycle' },
		{ name: 'Integrations', description: 'Project and organization integrations' },
		{ name: 'Secrets', description: 'Project secret management' },
		{ name: 'Users', description: 'User identity resolution' },
		{ name: 'Audit', description: 'Deployment and project audit events' },
		{ name: 'System', description: 'Deployment metadata' },
	],
	// Every documented `/api/v1/*` route sits behind the authN guard, satisfiable
	// by either the session cookie or a personal access token (the schemes are
	// registered on the app below), so the requirement is global and disjunctive.
	security: [{ cookieAuth: [] }, { bearerAuth: [] }] as Record<string, string[]>[],
};

/** The versioned API mount. Health and auth routes live outside it, unversioned. */
const API_PREFIX = '/api/v1';

/**
 * Mount point of the OpenAI-compatible AI proxy. Not our own v1 API — errors
 * under it keep OpenAI's error shape instead of the hub envelope (see `onError`).
 */
const AI_PROXY_PREFIX = '/api/ai/v1';

/** `/api/v1/*` paths that skip the catalog auto-init — metadata that must render before any catalog exists. */
const SKIP_INIT_PATHS = new Set([`${API_PREFIX}/version`, `${API_PREFIX}/capabilities`]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function rejectionDetails(response: Response): Promise<{ code: string; message: string }> {
	try {
		const result = ErrorResponseSchema.safeParse(await response.clone().json());
		if (result.success) {
			return { code: result.data.error.code, message: result.data.error.message };
		}
	} catch {
		// Unknown routes can return Hono's plain-text 404.
	}
	return {
		code: `HTTP_${response.status}`,
		message: response.statusText || 'Request rejected',
	};
}

/**
 * Build the provider-agnostic marimohub API. All external dependencies arrive
 * through `deps` (no `c.env`, no vendor SDK): the same app runs on Cloudflare
 * Workers (`app.fetch`) or under @hono/node-server in `apps/server`.
 */
export function createApi(rawDeps: ApiDeps) {
	const app = createApp();

	// Default the exposure mode and kernel probe so library callers need not wire them.
	const deps: ApiDeps = {
		...rawDeps,
		notifier: rawDeps.notifier ?? noopNotifier,
		kernelProbe: rawDeps.kernelProbe ?? ((url) => probeKernelLiveness(url, { timeoutMs: 2000 })),
		sandbox: {
			...rawDeps.sandbox,
			exposure: rawDeps.sandbox.exposure ?? new SubdomainExposure(),
		},
		policy: {
			...rawDeps.policy,
			viewerMode: rawDeps.policy.viewerMode ?? 'static',
			editorSandboxSharing: rawDeps.policy.editorSandboxSharing ?? 'shared',
		},
	};

	// Inject deps into every request context.
	app.use('*', (c, next) => {
		c.set('deps', deps);
		return next();
	});

	// Tracing wraps everything below it, including the proxy short-circuits.
	if (deps.tracingMiddleware) app.use('*', deps.tracingMiddleware);

	// In `proxy` mode, authenticate + authorize + forward `…/proxy/<token>/…` kernel
	// traffic through the app. A no-op in `subdomain` mode. Mounted ahead of `/api`,
	// the CSRF/body-limit guards, and the SPA fallback.
	app.use('*', sandboxProxyMiddleware(deps));

	// Sandbox proxy (provider hook): forward requests destined for a running kernel
	// (no-op for adapters whose kernels are reached directly, e.g. Modal tunnel URLs;
	// used by the Cloudflare Durable Object backend).
	app.use('*', async (c, next) => {
		const response = await deps.compute.proxy(c.req.raw);
		if (response) return response;
		await next();
	});

	// Error handler. Domain errors carry their own `code`/`status`, so the mapping
	// is one branch. 5xx (server-side failures + unknown errors) is logged with the
	// full cause chain; the client only ever sees the sanitized envelope.
	app.onError((err, c) => {
		// HTTPException (hono's own throws: malformed JSON in a request body, the
		// AI proxy's bearer-auth middleware) carries its own Response. Rewrap the
		// body — the envelope invariant says every error is
		// `{ success: false, error }`, and third-party SDKs parse on that — but
		// honor its status and headers (e.g. WWW-Authenticate).
		if (err instanceof HTTPException) {
			const res = err.getResponse();
			// The AI proxy speaks OpenAI's protocol, not ours: its thrown responses
			// already carry the `{ error: { message, type } }` body an openai client
			// parses, so rewrapping them would strip the message it shows the user.
			if (c.req.path.startsWith(AI_PROXY_PREFIX)) return res;
			for (const [name, value] of res.headers) {
				if (name.toLowerCase() !== 'content-type') c.header(name, value);
			}
			const errorCodesByStatus: Partial<Record<number, ErrorCode>> = {
				400: 'BAD_REQUEST',
				401: 'UNAUTHORIZED',
				403: 'FORBIDDEN',
				404: 'NOT_FOUND',
			};
			const code =
				errorCodesByStatus[res.status] ?? (res.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
			if (res.status >= 500) {
				logEvent({
					level: 'error',
					event: 'request_error',
					request_id: c.get('requestId') ?? null,
					method: c.req.method,
					path: c.req.path,
					user: c.get('user')?.id ?? null,
					status: res.status,
					error: errorMetadata(err),
				});
				return fail(c, code, 'Internal server error', res.status);
			}
			return fail(c, code, err.message || res.statusText || 'Request failed', res.status);
		}
		if (err instanceof DomainError) {
			if (err.status >= 500) {
				logEvent({
					level: 'error',
					event: 'request_error',
					request_id: c.get('requestId') ?? null,
					method: c.req.method,
					path: c.req.path,
					user: c.get('user')?.id ?? null,
					status: err.status,
					error: describeError(err),
				});
			}
			return fail(c, err.code, err.message, err.status);
		}
		logEvent({
			level: 'error',
			event: 'request_error',
			request_id: c.get('requestId') ?? null,
			method: c.req.method,
			path: c.req.path,
			user: c.get('user')?.id ?? null,
			status: 500,
			error: describeError(err),
		});
		return fail(c, 'INTERNAL_ERROR', 'Internal server error', 500);
	});

	// Correlation id: reuse an inbound `X-Request-Id` or mint one, echo it on the
	// response header, and thread it into error envelopes + logs for tracing.
	app.use(`${API_PREFIX}/*`, requestId());
	app.use('/api/sync/*', requestId());

	const observeRejection: MiddlewareHandler<HonoEnv> = async (c, next) => {
		await next();
		if (
			!MUTATING_METHODS.has(c.req.method) ||
			c.res.status < 400 ||
			c.res.status >= 500 ||
			c.res.status === 401 ||
			c.res.status === 403
		) {
			return;
		}

		const rejection = await rejectionDetails(c.res);
		const route = routePath(c, -1) || c.req.path;
		const projectId = c.req.param('pid');
		const notebookId = c.req.param('nid');
		deps.metrics?.increment('requests.rejected', 1, { route, code: rejection.code });
		logEvent({
			level: 'warn',
			event: 'request_rejected',
			route,
			method: c.req.method,
			status: c.res.status,
			code: rejection.code,
			message: rejection.message,
			request_id: c.get('requestId') ?? null,
			user: c.get('user')?.id ?? null,
			...(projectId ? { project_id: projectId } : {}),
			...(notebookId ? { notebook_id: notebookId } : {}),
		});
	};
	app.use(`${API_PREFIX}/*`, observeRejection);
	app.use('/api/sync/*', observeRejection);

	// Body-size cap: the API buffers request bodies in full (Hono parses JSON in
	// memory), so an unbounded POST could OOM the service. Reject anything past
	// MAX_REQUEST_BYTES with the standard envelope before any handler runs. Scoped
	// to `/api/v1/*` so it never touches the kernel proxy above (which short-circuits
	// on `*` and may carry large uploads of its own).
	app.use(
		`${API_PREFIX}/*`,
		bodyLimit({
			maxSize: MAX_REQUEST_BYTES,
			onError: (c) =>
				fail(
					c,
					'PAYLOAD_TOO_LARGE',
					`Request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
					413,
				),
		}),
	);
	app.use(
		'/api/sync/*',
		bodyLimit({
			maxSize: MAX_REQUEST_BYTES,
			onError: (c) =>
				fail(
					c,
					'PAYLOAD_TOO_LARGE',
					`Request body exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
					413,
				),
		}),
	);

	// Health check (unauthenticated) for container / k8s liveness probes — cheap and
	// MUST NOT touch downstream deps. `?deep=true` runs the preflight suite (storage/
	// auth/compute reachability) for on-demand operator diagnostics; it names backends
	// and reachability, so it is gated behind auth like /api/v1/version (the handler is
	// registered ahead of the authN guard, so it authenticates inline). Wire only the
	// shallow form to k8s probes — the deep form hits downstream deps on every call.
	app.get('/api/health', async (c) => {
		if (c.req.query('deep') !== 'true') return c.json({ status: 'ok' });
		const user = await deps.authenticator.authenticate(c.req.raw);
		if (!user) return fail(c, 'UNAUTHORIZED', 'Authentication required', 401);
		let suspensionUnavailable = false;
		try {
			if (await deps.services.identities.isSuspended(user.id)) {
				return fail(c, 'USER_SUSPENDED', 'User account is suspended', 403);
			}
		} catch (err) {
			if (!(err instanceof UnavailableError)) throw err;
			suspensionUnavailable = true;
		}
		const suspensionChecks = suspensionUnavailable
			? [
					{
						name: 'identity.suspension',
						status: 'fail' as const,
						message: 'Unable to verify account suspension status',
					},
				]
			: [];
		if (!deps.preflight) {
			return c.json(
				{ status: 'unavailable', checks: suspensionChecks },
				suspensionUnavailable ? 503 : 200,
			);
		}
		const report = await deps.preflight();
		const ok = report.ok && !suspensionUnavailable;
		return c.json(
			{ status: ok ? 'ok' : 'degraded', checks: [...suspensionChecks, ...report.checks] },
			ok ? 200 : 503,
		);
	});

	// Provider-specific auth routes (e.g. the OIDC login/callback/logout flow).
	// Mounted before the authN guard so they stay public.
	if (deps.authRoutes) {
		app.route('/', deps.authRoutes);
	}

	// Public OIDC discovery + JWKS for Workload Identity Federation. A federating
	// cloud fetches these anonymously to validate hub-issued JWTs, so they mount
	// before the authN guard (and 404 when WIF is unconfigured).
	app.route('/', createOidcDiscovery(deps));

	// Managed-AI proxy. Notebook kernels call it server-to-server with a minted
	// session token (no app cookie), so it mounts OUTSIDE the `/api/v1/*` cookie-auth
	// + CSRF guards and authenticates by the token alone (404s when AI is unconfigured).
	app.route(AI_PROXY_PREFIX, createAiProxy());

	// External git push-sync (e.g. a CI workflow). Authenticates with a
	// notebook-scoped bearer token, not the browser cookie, so it lives outside the
	// `/api/v1/*` auth/CSRF chain.
	app.route('/api/sync/git/v1', gitSyncApp);

	// CSRF defense-in-depth. The session cookie is already SameSite=Lax (so a
	// browser won't attach it to a cross-site POST/PUT/DELETE), and there is no
	// permissive CORS. On top of that we reject any state-changing request that a
	// browser flags as cross-origin, via two independent signals:
	//   - `Sec-Fetch-Site` (Fetch Metadata): sent by modern browsers on every
	//     request and far less likely than `Origin` to be stripped by a proxy.
	//     `cross-site`/`same-site` means it came from another (sub)domain.
	//   - `Origin`: rejected when its full origin differs from the request origin.
	// Either signal can clear via the allowlist. Requests with NEITHER header
	// (non-browser callers — the generated client, server-to-server, the CLI) are
	// allowed, so this never breaks programmatic use. Safe methods
	// (GET/HEAD/OPTIONS) are exempt.
	app.use(`${API_PREFIX}/*`, async (c, next) => {
		const method = c.req.method;
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

		const origin = c.req.header('origin');
		const allowlisted = origin ? (deps.policy.allowedOrigins?.includes(origin) ?? false) : false;
		const reject = () => fail(c, 'FORBIDDEN', 'Cross-origin request rejected', 403);

		const secFetchSite = c.req.header('sec-fetch-site');
		if ((secFetchSite === 'cross-site' || secFetchSite === 'same-site') && !allowlisted) {
			return reject();
		}

		if (origin) {
			let sourceOrigin: string | null = null;
			try {
				sourceOrigin = new URL(origin).origin;
			} catch {
				sourceOrigin = null;
			}
			const requestUrl = new URL(c.req.url);
			const destinationHost = c.req.header('host') ?? requestUrl.host;
			const forwardedProtocol = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
			const protocol = forwardedProtocol || requestUrl.protocol.slice(0, -1);
			let destinationOrigin: string | null = null;
			try {
				destinationOrigin = deps.sandbox.appBaseUrl
					? new URL(deps.sandbox.appBaseUrl).origin
					: new URL(`${protocol}://${destinationHost}`).origin;
			} catch {
				destinationOrigin = null;
			}
			const sameOrigin = sourceOrigin !== null && sourceOrigin === destinationOrigin;
			if (!sameOrigin && !allowlisted) return reject();
		}
		return next();
	});

	// AuthN: reject unauthenticated /api/v1/* requests.
	app.use(`${API_PREFIX}/*`, async (c, next) => {
		const user = await deps.authenticator.authenticate(c.req.raw);
		if (!user) {
			return fail(c, 'UNAUTHORIZED', 'Authentication required', 401);
		}
		if (await deps.services.identities.isSuspended(user.id)) {
			return fail(c, 'USER_SUSPENDED', 'User account is suspended', 403);
		}
		c.set('user', user);
		// A PAT-shaped bearer is resolved ONLY by the token path (see
		// composeAuthenticators), so its presence is an exact signal for "this
		// request authenticated with a PAT". Decided here, once, and read by the
		// token-management guard — never re-parsed downstream.
		c.set('authMethod', isPatRequest(c.req.raw) ? 'pat' : 'session');

		// Refresh this user's identity-directory record so opaque ids (author /
		// session user_id) resolve to a name+email at read time. Best-effort and
		// write-coalesced (see IdentityService.upsert) — a failure must never block
		// an otherwise-authenticated request.
		try {
			await deps.services.identities.upsert(user);
		} catch (err) {
			logEvent({
				level: 'error',
				event: 'identity_upsert_failed',
				request_id: c.get('requestId') ?? null,
				method: c.req.method,
				path: c.req.path,
				user: user.id,
				error: errorMetadata(err),
			});
		}

		await next();
	});

	// Auto-init: ensure the catalog + default project exist, except for the
	// metadata routes that must render before any catalog exists (see SKIP_INIT_PATHS).
	app.use(`${API_PREFIX}/*`, async (c, next) => {
		if (SKIP_INIT_PATHS.has(c.req.path)) return next();
		await ensureInitialized(deps.bucket, c.get('user').id);
		await next();
	});

	// Conditional GET: a weak ETag + 304 on a matching `If-None-Match` (hono/etag),
	// paired with `Cache-Control: no-cache` so browsers revalidate each poll and
	// serve the cached body on a 304 — turning the session-status poll loop into
	// tiny 304s. `etag` is registered first so the Cache-Control hook's header lands
	// before `etag` builds the 304 (which retains cache-control).
	const conditionalGet = etag({ weak: true });
	app.use(`${API_PREFIX}/*`, (c, next) =>
		c.req.path.endsWith('/browse/objects/content') ? next() : conditionalGet(c, next),
	);
	app.use(`${API_PREFIX}/*`, async (c, next) => {
		await next();
		// Routes that set their own Cache-Control (e.g. the no-store HTML snapshot)
		// keep it; everything else revalidates per poll.
		if (c.req.method === 'GET' && c.res.status === 200 && !c.res.headers.has('Cache-Control')) {
			c.res.headers.set('Cache-Control', 'no-cache');
		}
	});

	// Mount resource routers.
	app.route(API_PREFIX, systemApp);
	app.route(API_PREFIX, projectsApp);
	app.route(API_PREFIX, projectAlertsApp);
	app.route(API_PREFIX, eventsApp);
	app.route(API_PREFIX, adminApp);
	app.route(API_PREFIX, notebooksApp);
	app.route(API_PREFIX, changeRequestsApp);
	app.route(API_PREFIX, sessionsApp);
	app.route(API_PREFIX, integrationsApp);
	app.route(API_PREFIX, usersApp);
	app.route(API_PREFIX, tokensApp);

	// Declare the cookie-session auth scheme the global `security` requirement
	// (OPENAPI_DOC) points at, so generated clients know the API is authenticated.
	app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
		type: 'apiKey',
		in: 'cookie',
		name: 'mh_session',
		description: 'Session cookie minted by the OIDC login flow; browsers attach it automatically.',
	});
	app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
		type: 'http',
		scheme: 'bearer',
		description:
			'Personal access token (`mhub_pat_…`) minted at POST /api/v1/me/tokens, for CI/CLI/' +
			'service callers. Acts as the issuing user; cannot manage tokens.',
	});

	// OpenAPI spec.
	app.doc(`${API_PREFIX}/doc`, OPENAPI_DOC);

	return app;
}

/**
 * Produce the OpenAPI 3.1 document without a running server. Used by
 * @marimo-hub/client codegen. The document is derived purely from route
 * definitions, so stub deps suffice — only the groups `createApi` reads at wiring
 * time (`sandbox`, `policy`) need to be present.
 */
export function generateOpenApiDocument(): Record<string, unknown> {
	const app = createApi({ sandbox: {}, policy: {} } as ApiDeps);
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- generated OpenAPI is JSON object data
	return app.getOpenAPI31Document(OPENAPI_DOC) as unknown as Record<string, unknown>;
}

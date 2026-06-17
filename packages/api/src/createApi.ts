import { createRoute, z } from '@hono/zod-openapi';
import {
	ConflictError,
	ensureInitialized,
	ForbiddenError,
	NotFoundError,
	NotInitializedError,
	PreconditionFailedError,
	ResourceExhaustedError,
	UnavailableError,
} from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { logEvent } from './log';
import notebooksApp from './routes/notebooks';
import projectsApp from './routes/projects';
import sessionsApp from './routes/sessions';
import { createApp, jsonContent } from './shared';

const OPENAPI_DOC = {
	openapi: '3.1.0' as const,
	info: {
		title: 'MarimoHub API',
		version: '1.0.0',
		description: 'API for managing Marimo notebooks, projects, and sandboxes',
	},
	tags: [
		{ name: 'Auth', description: 'Authentication' },
		{ name: 'Projects', description: 'Project management' },
		{ name: 'Notebooks', description: 'Notebook CRUD and versioning' },
		{ name: 'Sessions', description: 'Notebook session lifecycle' },
	],
};

/**
 * Build the provider-agnostic MarimoHub API. All external dependencies arrive
 * through `deps` (no `c.env`, no vendor SDK): the same app runs on Cloudflare
 * Workers (`app.fetch`) or under @hono/node-server in `apps/server`.
 */
export function createApi(deps: ApiDeps) {
	const app = createApp();

	// Inject deps into every request context.
	app.use('*', (c, next) => {
		c.set('deps', deps);
		return next();
	});

	// Sandbox proxy: forward requests destined for a running kernel (no-op for
	// adapters whose kernels are reached directly, e.g. Modal tunnel URLs).
	app.use('*', async (c, next) => {
		const response = await deps.compute.proxy(c.req.raw);
		if (response) return response;
		await next();
	});

	// Error handler — maps domain errors to the response envelope.
	app.onError((err, c) => {
		if (err instanceof NotFoundError) {
			return c.json({ success: false, error: { code: 'NOT_FOUND', message: err.message } }, 404);
		}
		if (err instanceof ForbiddenError) {
			return c.json({ success: false, error: { code: 'FORBIDDEN', message: err.message } }, 403);
		}
		if (err instanceof ConflictError) {
			return c.json({ success: false, error: { code: 'CONFLICT', message: err.message } }, 409);
		}
		if (err instanceof PreconditionFailedError) {
			return c.json(
				{ success: false, error: { code: 'PRECONDITION_FAILED', message: err.message } },
				412,
			);
		}
		if (err instanceof NotInitializedError) {
			return c.json(
				{ success: false, error: { code: 'NOT_INITIALIZED', message: err.message } },
				409,
			);
		}
		if (err instanceof UnavailableError) {
			return c.json(
				{ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: err.message } },
				503,
			);
		}
		if (err instanceof ResourceExhaustedError) {
			return c.json(
				{ success: false, error: { code: 'RESOURCE_EXHAUSTED', message: err.message } },
				429,
			);
		}
		// Structured, contextful server log. The client still gets the generic
		// envelope below; we never leak the stack or request body to the client.
		logEvent({
			level: 'error',
			event: 'request_error',
			method: c.req.method,
			path: c.req.path,
			user: c.get('user')?.id ?? null,
			error: err instanceof Error ? err.message : String(err),
			name: err instanceof Error ? err.name : undefined,
		});
		return c.json(
			{ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
			500,
		);
	});

	// Health check (unauthenticated) for container / k8s probes.
	app.get('/api/health', (c) => c.json({ status: 'ok' }));

	// Provider-specific auth routes (e.g. the OIDC login/callback/logout flow).
	// Mounted before the authN guard so they stay public.
	if (deps.authRoutes) {
		app.route('/', deps.authRoutes);
	}

	// CSRF defense-in-depth. The session cookie is already SameSite=Lax (so a
	// browser won't attach it to a cross-site POST/PUT/DELETE), and there is no
	// permissive CORS. On top of that we reject any state-changing request that a
	// browser flags as cross-origin, via two independent signals:
	//   - `Sec-Fetch-Site` (Fetch Metadata): sent by modern browsers on every
	//     request and far less likely than `Origin` to be stripped by a proxy.
	//     `cross-site`/`same-site` means it came from another (sub)domain.
	//   - `Origin`: rejected when its host differs from the `Host` header.
	// Either signal can clear via the allowlist. Requests with NEITHER header
	// (non-browser callers — the generated client, server-to-server, the CLI) are
	// allowed, so this never breaks programmatic use. Safe methods
	// (GET/HEAD/OPTIONS) are exempt.
	app.use('/api/*', async (c, next) => {
		const method = c.req.method;
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

		const origin = c.req.header('origin');
		const allowlisted = origin ? (deps.allowedOrigins?.includes(origin) ?? false) : false;
		const reject = () =>
			c.json(
				{ success: false, error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected' } },
				403,
			);

		const secFetchSite = c.req.header('sec-fetch-site');
		if ((secFetchSite === 'cross-site' || secFetchSite === 'same-site') && !allowlisted) {
			return reject();
		}

		if (origin) {
			let originHost: string | null = null;
			try {
				originHost = new URL(origin).host;
			} catch {
				originHost = null;
			}
			const sameOrigin = originHost !== null && originHost === c.req.header('host');
			if (!sameOrigin && !allowlisted) return reject();
		}
		return next();
	});

	// AuthN: reject unauthenticated /api/* requests (health stays public).
	app.use('/api/*', async (c, next) => {
		if (c.req.path === '/api/health') return next();
		const user = await deps.authenticator.authenticate(c.req.raw);
		if (!user) {
			return c.json(
				{ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
				401,
			);
		}
		c.set('user', user);
		await next();
	});

	// Auto-init: ensure the catalog + default project exist.
	app.use('/api/*', async (c, next) => {
		if (c.req.path === '/api/health') return next();
		await ensureInitialized(deps.bucket, c.get('user').id);
		await next();
	});

	// GET /api/me
	const meRoute = createRoute({
		method: 'get',
		path: '/api/me',
		tags: ['Auth'],
		summary: 'Get current user info',
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: z.object({
						id: z.string(),
						email: z.string(),
						logoutUrl: z.string().nullable(),
					}),
				}),
				'Current user information',
			),
		},
	});

	app.openapi(meRoute, (c) => {
		const user = c.get('user');
		const logoutUrl = deps.authenticator.logoutUrl?.() ?? null;
		return c.json({ success: true, data: { id: user.id, email: user.email, logoutUrl } }, 200);
	});

	// Mount resource routers.
	app.route('/api', projectsApp);
	app.route('/api', notebooksApp);
	app.route('/api', sessionsApp);

	// OpenAPI spec.
	app.doc('/api/doc', OPENAPI_DOC);

	return app;
}

/**
 * Produce the OpenAPI 3.1 document without a running server. Used by
 * @marimo-hub/client codegen. The document is derived purely from route
 * definitions, so stub deps (never invoked during generation) are sufficient.
 */
export function generateOpenApiDocument(): Record<string, unknown> {
	const app = createApi({} as ApiDeps);
	return app.getOpenAPI31Document(OPENAPI_DOC) as unknown as Record<string, unknown>;
}

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
	APP_HEARTBEAT_INTERVAL_MS,
	AppPoolService,
	createSlidingWindowBudget,
	DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
	DeepLinkSlugSchema,
	isPastAuthorizationDeadline,
	isPublicDeepLink,
	Millis,
	NotFoundError,
	openPublicAppVisitToken,
	publicAppSessionOwner,
	publicAppVisitActor,
	ResourceExhaustedError,
	sealPublicAppVisitToken,
	sessionAudience,
	SessionId,
	UnavailableError,
} from '@marimo-hub/core';
import type {
	AppPoolNamespace,
	AuthenticatedPrincipal,
	DeepLink,
	NotebookMeta,
	Project,
	PublicAppVisitTokenClaims,
	PublicDeepLinkAccess,
	Session,
} from '@marimo-hub/core';
import type { HonoEnv, PublicAppsConfig, ResolvedApiDeps } from '../context';
import { createApp, jsonBody, jsonContent, resolvePublicBaseUrl } from '../shared';
import { resolveSandboxHostname, startNotebookSession } from './sessionStart';

export const PUBLIC_VISIT_TOKEN_HEADER = 'x-mh-visit-token';
export const PUBLIC_VISIT_COOKIE_NAME = 'mh_public_visit';

const PUBLIC_API_SECURITY: Record<string, string[]>[] = [];
const WAIT_MIN_SECONDS = 0;
const WAIT_MAX_SECONDS = 20;

const resolveBudget = createSlidingWindowBudget<string>({ windowMs: 60_000, limit: 600 });
const startBudget = createSlidingWindowBudget<string>({ windowMs: 60_000, limit: 120 });

const PublicErrorSchema = z.object({
	success: z.literal(false),
	error: z.object({
		code: z.enum([
			'NOT_FOUND',
			'BAD_REQUEST',
			'RESOURCE_EXHAUSTED',
			'SERVICE_UNAVAILABLE',
			'START_FAILED',
		]),
		message: z.string(),
	}),
});

const PublicAppInfoSchema = z
	.strictObject({
		slug: DeepLinkSlugSchema,
		title: z.string(),
		heartbeat_interval_seconds: z.number().positive(),
		startup_timeout_seconds: z.number().positive(),
	})
	.openapi('PublicAppInfo');

const PublicAppVisitSchema = z
	.strictObject({
		slug: DeepLinkSlugSchema,
		status: z.enum(['starting', 'running', 'ended']),
		sandbox_url: z.string().nullable(),
		visit_token: z.string(),
		heartbeat_interval_seconds: z.number().positive(),
		startup_timeout_seconds: z.number().positive(),
	})
	.openapi('PublicAppVisit');

function publicHeartbeatIntervalSeconds(config: PublicAppsConfig): number {
	return Math.min(APP_HEARTBEAT_INTERVAL_MS, config.poolPolicy.userLeaseMs / 4) / 1000;
}

function publicStartupTimeoutSeconds(deps: ResolvedApiDeps): number {
	return Millis.toSeconds(deps.sandbox.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS);
}

function publicError<S extends 400 | 404 | 429 | 500 | 503>(
	c: Context<HonoEnv>,
	status: S,
	code: 'NOT_FOUND' | 'BAD_REQUEST' | 'RESOURCE_EXHAUSTED' | 'SERVICE_UNAVAILABLE' | 'START_FAILED',
	message: string,
	retryAfterSeconds?: number,
) {
	if (retryAfterSeconds !== undefined) {
		c.header('Retry-After', String(retryAfterSeconds));
	}
	return c.json({ success: false as const, error: { code, message } }, status);
}

function mapPublicError(c: Context<HonoEnv>, err: unknown) {
	if (err instanceof NotFoundError) {
		return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	}
	if (err instanceof ResourceExhaustedError) {
		return publicError(
			c,
			429,
			'RESOURCE_EXHAUSTED',
			'This app is currently busy. Retry shortly.',
			10,
		);
	}
	if (err instanceof UnavailableError) {
		return publicError(
			c,
			503,
			'SERVICE_UNAVAILABLE',
			'This app is temporarily unavailable. Retry shortly.',
			5,
		);
	}
	return publicError(c, 503, 'START_FAILED', 'Unable to open this app right now.');
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function setPublicProxyCookie(
	c: Context<HonoEnv>,
	sandboxUrl: string | undefined,
	visitToken: string,
	ttlSeconds: number,
) {
	if (!sandboxUrl) return;
	let parsed: URL;
	try {
		parsed = new URL(sandboxUrl);
	} catch {
		return;
	}
	const proxyPath = parsed.pathname.replace(/\/+$/, '');
	if (!proxyPath.includes('/proxy/')) return;
	const secure = parsed.protocol === 'https:' || !isLoopbackHost(parsed.hostname);
	const parts = [
		`${PUBLIC_VISIT_COOKIE_NAME}=${visitToken}`,
		`Path=${proxyPath}`,
		'HttpOnly',
		'SameSite=Strict',
		...(secure ? ['Secure'] : []),
		`Max-Age=${Math.max(1, Math.floor(ttlSeconds))}`,
	];
	c.header('Set-Cookie', parts.join('; '), { append: true });
}

interface ResolvedPublicTarget {
	link: DeepLink & { access: PublicDeepLinkAccess };
	project: Project;
	meta: NotebookMeta;
	allowProjectIntegrations: boolean;
	namespace: AppPoolNamespace;
}

async function resolveLivePublicTarget(
	deps: ResolvedApiDeps,
	slug: string,
): Promise<ResolvedPublicTarget | null> {
	const config = deps.publicApps;
	if (!config) return null;
	let link: DeepLink;
	try {
		link = await deps.services.deepLinks.resolvePublic(slug);
	} catch {
		return null;
	}
	if (!isPublicDeepLink(link)) return null;
	const allowProjectIntegrations =
		config.allowProjectIntegrations && link.access.allow_project_integrations === true;
	const [project, meta] = await Promise.all([
		deps.services.projects
			.getProject(link.target.project_id, { consistency: 'validated' })
			.catch(() => null),
		deps.services.notebooks
			.getNotebookMeta(link.target.project_id, link.target.notebook_id)
			.catch(() => null),
	]);
	if (!project || project.status === 'deleted' || project.security_labels !== undefined) {
		return null;
	}
	if (!meta || meta.status === 'deleted' || meta.preview || meta.security_labels !== undefined) {
		return null;
	}
	return {
		link,
		project,
		meta,
		allowProjectIntegrations,
		namespace: allowProjectIntegrations ? 'public-integrations' : 'public',
	};
}

function mintVisitExpiry(
	config: PublicAppsConfig,
	session?: Pick<Session, 'authorization_expires_at'>,
): number {
	const nowSec = Math.floor(Date.now() / 1000);
	const desired = nowSec + config.visitTokenTtlSeconds;
	if (!session?.authorization_expires_at) return desired;
	const hardSec = Math.floor(Date.parse(session.authorization_expires_at) / 1000);
	if (!Number.isFinite(hardSec)) return desired;
	return Math.min(desired, hardSec);
}

async function openVerifiedVisit(
	c: Context<HonoEnv>,
	deps: ResolvedApiDeps,
): Promise<{ claims: PublicAppVisitTokenClaims; resolved: ResolvedPublicTarget } | null> {
	const config = deps.publicApps;
	if (!config) return null;
	const token = c.req.header(PUBLIC_VISIT_TOKEN_HEADER)?.trim();
	if (!token) return null;
	const claims = await openPublicAppVisitToken(token, config.signingSecret);
	if (!claims) return null;
	const resolved = await resolveLivePublicTarget(deps, claims.slug);
	if (!resolved) return null;
	if (
		resolved.link.registration_id !== claims.reg ||
		resolved.link.access.grant_id !== claims.grant ||
		resolved.link.target.project_id !== claims.pid ||
		resolved.link.target.notebook_id !== claims.nid
	) {
		return null;
	}
	return { claims, resolved };
}

function syntheticLaunchUser(nid: PublicAppVisitTokenClaims['nid']): AuthenticatedPrincipal {
	return {
		id: publicAppSessionOwner(nid),
		email: '',
		credential: { kind: 'sso' },
	};
}

const resolveRoute = createRoute({
	method: 'get',
	path: '/apps/{slug}',
	operationId: 'public-apps.resolve',
	tags: ['Public apps'],
	summary: 'Resolve metadata for a public app link',
	security: PUBLIC_API_SECURITY,
	request: { params: z.object({ slug: DeepLinkSlugSchema }) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: PublicAppInfoSchema }),
			'Public app metadata',
		),
		404: jsonContent(PublicErrorSchema, 'App link unavailable'),
		429: jsonContent(PublicErrorSchema, 'Rate limited'),
	},
});

const startVisitRoute = createRoute({
	method: 'post',
	path: '/visits',
	operationId: 'public-apps.startVisit',
	tags: ['Public apps'],
	summary: 'Start or attach to a public app visit',
	security: PUBLIC_API_SECURITY,
	request: {
		body: jsonBody(z.strictObject({ slug: DeepLinkSlugSchema })),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: PublicAppVisitSchema }),
			'Active or starting public app visit',
		),
		404: jsonContent(PublicErrorSchema, 'App link unavailable'),
		429: jsonContent(PublicErrorSchema, 'Capacity or rate limit reached'),
		503: jsonContent(PublicErrorSchema, 'App unavailable'),
	},
});

const currentVisitRoute = createRoute({
	method: 'get',
	path: '/visits/current',
	operationId: 'public-apps.currentVisit',
	tags: ['Public apps'],
	summary: 'Poll status of a public app visit',
	security: PUBLIC_API_SECURITY,
	request: {
		query: z.object({
			wait: z.coerce.number().int().min(WAIT_MIN_SECONDS).max(WAIT_MAX_SECONDS).optional(),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: PublicAppVisitSchema }),
			'Current visit state',
		),
		404: jsonContent(PublicErrorSchema, 'Visit invalid or revoked'),
	},
});

const heartbeatVisitRoute = createRoute({
	method: 'post',
	path: '/visits/heartbeat',
	operationId: 'public-apps.heartbeatVisit',
	tags: ['Public apps'],
	summary: 'Renew a public app visit lease and token',
	security: PUBLIC_API_SECURITY,
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: PublicAppVisitSchema }),
			'Renewed visit token',
		),
		404: jsonContent(PublicErrorSchema, 'Visit invalid or revoked'),
	},
});

const leaveVisitRoute = createRoute({
	method: 'post',
	path: '/visits/leave',
	operationId: 'public-apps.leaveVisit',
	tags: ['Public apps'],
	summary: 'Release a public app visit slot',
	security: PUBLIC_API_SECURITY,
	responses: {
		200: jsonContent(z.object({ success: z.literal(true), data: z.null() }), 'Visit released'),
		404: jsonContent(PublicErrorSchema, 'Visit invalid'),
	},
});

const app = createApp();
app.openAPIRegistry.registerPath(resolveRoute);

app.use('*', async (c, next) => {
	if (!c.get('deps').publicApps) {
		return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	}
	await next();
});

app.openapi({ ...resolveRoute, path: '/apps/:slug{[\\s\\S]+}', hide: true }, async (c) => {
	const deps = c.get('deps');
	const config = deps.publicApps!;
	if (!resolveBudget.consume('resolve')) {
		return publicError(c, 429, 'RESOURCE_EXHAUSTED', 'Too many requests. Retry shortly.', 10);
	}
	const parsedSlug = DeepLinkSlugSchema.safeParse(c.req.param('slug'));
	if (!parsedSlug.success) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	const resolved = await resolveLivePublicTarget(deps, parsedSlug.data);
	if (!resolved) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	return c.json(
		{
			success: true as const,
			data: {
				slug: resolved.link.slug,
				title: resolved.meta.title,
				heartbeat_interval_seconds: publicHeartbeatIntervalSeconds(config),
				startup_timeout_seconds: publicStartupTimeoutSeconds(deps),
			},
		},
		200,
	);
});

app.openapi(startVisitRoute, async (c) => {
	const deps = c.get('deps');
	const config = deps.publicApps!;
	const { slug } = c.req.valid('json');
	if (!startBudget.consume(slug)) {
		return publicError(
			c,
			429,
			'RESOURCE_EXHAUSTED',
			'This app is currently busy. Retry shortly.',
			10,
		);
	}
	const resolved = await resolveLivePublicTarget(deps, slug);
	if (!resolved) return publicError(c, 404, 'NOT_FOUND', 'App link not found');

	// Reuse the caller's own visit_id when retrying/reloading with a valid visit token for this grant.
	let visitId: string = crypto.randomUUID();
	const priorToken = c.req.header(PUBLIC_VISIT_TOKEN_HEADER)?.trim();
	if (priorToken) {
		const prior = await openPublicAppVisitToken(priorToken, config.signingSecret);
		if (
			prior &&
			prior.slug === resolved.link.slug &&
			prior.reg === resolved.link.registration_id &&
			prior.grant === resolved.link.access.grant_id
		) {
			visitId = prior.vid;
		}
	}

	try {
		const started = await startNotebookSession({
			deps,
			user: syntheticLaunchUser(resolved.link.target.notebook_id),
			pid: resolved.link.target.project_id,
			nid: resolved.link.target.notebook_id,
			body: { mode: 'app', app_visit_id: visitId },
			publicAccess: {
				slug: resolved.link.slug,
				registrationId: resolved.link.registration_id,
				grantId: resolved.link.access.grant_id,
				visitId,
				allowProjectIntegrations: resolved.allowProjectIntegrations,
				config,
			},
			request: {
				requestId: c.get('requestId'),
				method: c.req.method,
				path: c.req.path,
				hostname: resolveSandboxHostname(c, deps.sandbox),
				appBaseUrl: resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
				signal: c.req.raw.signal,
			},
		});

		const sessionId = SessionId.parse(started.session_id);
		const session = await deps.services.sessions
			.getSession(resolved.link.target.project_id, sessionId)
			.catch(() => null);
		const exp = mintVisitExpiry(config, session ?? undefined);
		const generation = started.app_assignment?.generation ?? crypto.randomUUID();
		const visitToken = await sealPublicAppVisitToken(
			{
				slug: resolved.link.slug,
				reg: resolved.link.registration_id,
				grant: resolved.link.access.grant_id,
				pid: resolved.link.target.project_id,
				nid: resolved.link.target.notebook_id,
				sid: sessionId,
				vid: visitId,
				gen: generation,
				exp,
			},
			config.signingSecret,
		);
		const status =
			started.status === 'running'
				? ('running' as const)
				: started.status === 'starting'
					? ('starting' as const)
					: ('ended' as const);
		if (status === 'running') {
			setPublicProxyCookie(
				c,
				started.sandbox_url ?? undefined,
				visitToken,
				exp - Math.floor(Date.now() / 1000),
			);
		}
		return c.json(
			{
				success: true as const,
				data: {
					slug: resolved.link.slug,
					status,
					sandbox_url: status === 'running' ? (started.sandbox_url ?? null) : null,
					visit_token: visitToken,
					heartbeat_interval_seconds: publicHeartbeatIntervalSeconds(config),
					startup_timeout_seconds: publicStartupTimeoutSeconds(deps),
				},
			},
			200,
		);
	} catch (err) {
		return mapPublicError(c, err);
	}
});

app.openapi(currentVisitRoute, async (c) => {
	const deps = c.get('deps');
	const config = deps.publicApps!;
	const verified = await openVerifiedVisit(c, deps);
	if (!verified) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	const { claims, resolved } = verified;
	const waitSeconds = c.req.valid('query').wait ?? 0;

	const pool = new AppPoolService(
		deps.bucket,
		deps.services.sessions,
		config.poolPolicy,
		deps.metrics,
		undefined,
		resolved.namespace,
	);
	const allowed = await pool.canAccess(
		claims.pid,
		claims.nid,
		publicAppVisitActor(claims.vid),
		claims.sid,
		false,
	);
	if (!allowed) return publicError(c, 404, 'NOT_FOUND', 'App link not found');

	let session = await deps.services.sessions.getSession(claims.pid, claims.sid).catch(() => null);
	if (
		waitSeconds > 0 &&
		session?.status === 'starting' &&
		!isPastAuthorizationDeadline(session, Date.now())
	) {
		const deadline = Date.now() + waitSeconds * 1000;
		while (Date.now() < deadline && !c.req.raw.signal.aborted) {
			await deps.sleep(Math.min(500, deadline - Date.now()), c.req.raw.signal);
			session = await deps.services.sessions.getSession(claims.pid, claims.sid).catch(() => null);
			if (session?.status !== 'starting') break;
		}
	}
	if (
		!session ||
		sessionAudience(session) !== 'public' ||
		isPastAuthorizationDeadline(session, Date.now())
	) {
		return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	}
	const status =
		session.status === 'running'
			? ('running' as const)
			: session.status === 'starting'
				? ('starting' as const)
				: ('ended' as const);
	const exp = mintVisitExpiry(config, session);
	const nextToken = await sealPublicAppVisitToken({ ...claims, exp }, config.signingSecret);
	if (status === 'running') {
		setPublicProxyCookie(c, session.sandbox_url, nextToken, exp - Math.floor(Date.now() / 1000));
	}
	return c.json(
		{
			success: true as const,
			data: {
				slug: resolved.link.slug,
				status,
				sandbox_url: status === 'running' ? (session.sandbox_url ?? null) : null,
				visit_token: nextToken,
				heartbeat_interval_seconds: publicHeartbeatIntervalSeconds(config),
				startup_timeout_seconds: publicStartupTimeoutSeconds(deps),
			},
		},
		200,
	);
});

app.openapi(heartbeatVisitRoute, async (c) => {
	const deps = c.get('deps');
	const config = deps.publicApps!;
	const verified = await openVerifiedVisit(c, deps);
	if (!verified) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	const { claims, resolved } = verified;

	const session = await deps.services.sessions.getSession(claims.pid, claims.sid).catch(() => null);
	if (
		!session ||
		sessionAudience(session) !== 'public' ||
		(session.status !== 'running' && session.status !== 'starting') ||
		isPastAuthorizationDeadline(session, Date.now())
	) {
		return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	}
	const pool = new AppPoolService(
		deps.bucket,
		deps.services.sessions,
		config.poolPolicy,
		deps.metrics,
		undefined,
		resolved.namespace,
	);
	const renewed = await pool.heartbeat(
		claims.pid,
		claims.nid,
		publicAppVisitActor(claims.vid),
		claims.sid,
		{ visit_id: claims.vid, generation: claims.gen },
	);
	if (!renewed) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	await deps.services.sessions.heartbeat(claims.pid, claims.sid).catch(() => {});

	const exp = mintVisitExpiry(config, session);
	const nextToken = await sealPublicAppVisitToken({ ...claims, exp }, config.signingSecret);
	if (session.status === 'running') {
		setPublicProxyCookie(c, session.sandbox_url, nextToken, exp - Math.floor(Date.now() / 1000));
	}
	return c.json(
		{
			success: true as const,
			data: {
				slug: resolved.link.slug,
				status: session.status === 'running' ? ('running' as const) : ('starting' as const),
				sandbox_url: session.status === 'running' ? (session.sandbox_url ?? null) : null,
				visit_token: nextToken,
				heartbeat_interval_seconds: publicHeartbeatIntervalSeconds(config),
				startup_timeout_seconds: publicStartupTimeoutSeconds(deps),
			},
		},
		200,
	);
});

app.openapi(leaveVisitRoute, async (c) => {
	const deps = c.get('deps');
	const config = deps.publicApps!;
	const token = c.req.header(PUBLIC_VISIT_TOKEN_HEADER)?.trim();
	if (!token) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	// Allow a short grace period past token expiry so closing tabs can still release their slot.
	const claims = await openPublicAppVisitToken(token, config.signingSecret, Date.now() - 120_000);
	if (!claims) return publicError(c, 404, 'NOT_FOUND', 'App link not found');
	const session = await deps.services.sessions.getSession(claims.pid, claims.sid).catch(() => null);
	if (session && sessionAudience(session) === 'public') {
		const namespace: AppPoolNamespace = session.allow_project_integrations
			? 'public-integrations'
			: 'public';
		await new AppPoolService(
			deps.bucket,
			deps.services.sessions,
			config.poolPolicy,
			deps.metrics,
			undefined,
			namespace,
		)
			.leave(claims.pid, claims.nid, publicAppVisitActor(claims.vid), claims.sid, {
				visit_id: claims.vid,
				generation: claims.gen,
			})
			.catch(() => {});
	}
	return c.json({ success: true as const, data: null }, 200);
});

export default app;

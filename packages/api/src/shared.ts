import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	ASSIGNABLE_ROLES,
	AuthorizationService,
	BUCKET_SCAN_CONCURRENCY,
	DOMAIN_ERROR_CODES,
	MAX_SECURITY_COMPARTMENTS,
	mapWithConcurrency,
	SECURITY_LABEL_TOKEN,
	ForbiddenError,
	NotebookId,
	NotFoundError,
	NOTEBOOK_STATUSES,
	normalizeBaseUrl,
	PROJECT_ALERT_KINDS,
	PROJECT_STATUSES,
	ProjectId,
	projectActionMinRole,
	ROLES,
	SESSION_MODES,
	SESSION_STATUSES,
	SessionId,
	sessionPersistsEdits,
	subjectDefaultRole,
	SessionRetirer,
	SOURCE_TYPES,
	EDITOR_SANDBOX_SHARING_VALUES,
	VIEWER_MODES,
	SurfaceForbiddenError,
} from '@marimo-hub/core';
import type {
	AuthorizationPolicy,
	AuthorizationSubject,
	AuthSubject,
	CredentialKind,
	ResourceSecurityLabels,
	ResourceSecurityPolicy,
	NotebookDetail,
	ComputeResources,
	DeploymentAction,
	Project,
	ProjectAction,
	ProjectService,
	SessionAdmissionRecord,
	SessionScopedAction,
	Session,
	TokenGrant,
} from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from './context';
import { describeError, logEvent } from './log';

// Re-export the injected-context types for route modules that import from './shared'.
export type { ApiDeps, HonoEnv } from './context';

export function resolvePublicBaseUrl(c: Context<HonoEnv>, configured?: string): string {
	const publicBaseUrl = configured?.trim();
	if (publicBaseUrl) return normalizeBaseUrl(publicBaseUrl);
	const requestUrl = new URL(c.req.url);
	const forwardedProtocol = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
	const protocol =
		forwardedProtocol === 'http' || forwardedProtocol === 'https'
			? forwardedProtocol
			: requestUrl.protocol.slice(0, -1);
	const host = c.req.header('host') ?? requestUrl.host;
	return new URL(`${protocol}://${host}`).origin;
}

export function extensibleResponseEnum<const Values extends readonly [string, ...string[]]>(
	knownValues: Values,
	example: Values[number],
) {
	const fallbackEnum = z.enum(knownValues).or(z.literal('unknown')).catch('unknown');
	return z
		.string()
		.pipe(fallbackEnum)
		.openapi({
			type: 'string',
			enum: [...knownValues, 'unknown'],
			description: `Known values: ${knownValues.join(', ')}. Unrecognized values normalize to unknown.`,
			example,
		});
}

/**
 * The authorization wiring every guard reads: the pure-data policy slice plus
 * the resource-security collaborators. `ApiDeps` satisfies it structurally, so
 * route handlers pass `deps` straight through.
 */
export interface AuthzDeps {
	policy?: AuthorizationPolicy;
	resourceSecurity?: ResourceSecurityPolicy;
}

/**
 * The one `AuthorizationService` per dep bundle. `deps` is stable for a
 * server's lifetime, so every guard shares one instance; the WeakMap only
 * matters for tests that build many bundles.
 */
const AUTHZ_SERVICES = new WeakMap<AuthzDeps, AuthorizationService>();

export function authorizationService(deps: AuthzDeps): AuthorizationService {
	let service = AUTHZ_SERVICES.get(deps);
	if (!service) {
		service = new AuthorizationService(deps.policy, deps.resourceSecurity);
		AUTHZ_SERVICES.set(deps, service);
	}
	return service;
}

/**
 * Authorize a project-scoped action against an already-loaded project, mapping
 * the service's decision to the canonical transport errors: a `lifecycle` or
 * `visibility` denial is **404** (a soft-deleted or hidden project is
 * indistinguishable from a nonexistent one — super admins included), a `role`
 * denial is a tier-named **403**. The subject is the request's principal —
 * membership matches by user id or (invite) email. Pass `notebookLabels` when
 * the action targets a notebook carrying its own override, so the caller must
 * satisfy that override too (the decision fails closed on either label set).
 */
export async function assertProjectActionOn(
	project: Project,
	subject: AuthorizationSubject,
	action: ProjectAction,
	deps: AuthzDeps = {},
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<void> {
	const decision = await authorizationService(deps).authorize(subject, action, {
		kind: 'project',
		project,
		notebookLabels,
	});
	if (decision.allowed) return;
	if (decision.category === 'role' || decision.category === 'credential-action') {
		throw new ForbiddenError(
			`Requires '${projectActionMinRole(action)}' role on project ${project.id}`,
		);
	}
	if (decision.category === 'standing') {
		throw new ForbiddenError('Requires super admin');
	}
	throw new NotFoundError(`Project ${project.id} not found`);
}

/**
 * Enforce a project-scoped action: loads `project.json` (404 if the project
 * does not exist), then {@link assertProjectActionOn}. Returns the loaded
 * project so callers can reuse it without a second fetch.
 */
export async function assertProjectRole(
	projects: ProjectService,
	pid: ProjectId,
	subject: AuthorizationSubject,
	action: ProjectAction,
	deps: AuthzDeps = {},
): Promise<Project> {
	const project = await projects.getProject(pid);
	await assertProjectActionOn(project, subject, action, deps);
	return project;
}

export async function assertTokenGrantProjectsVisible(
	deps: Pick<ApiDeps, 'services' | 'policy' | 'resourceSecurity'>,
	subject: AuthorizationSubject,
	grant: TokenGrant,
): Promise<void> {
	if (grant.projects === '*') return;
	let projects: Project[];
	try {
		projects = await mapWithConcurrency(grant.projects, BUCKET_SCAN_CONCURRENCY, (projectId) =>
			deps.services.projects.getProject(projectId),
		);
	} catch (error) {
		if (error instanceof NotFoundError) {
			throw new NotFoundError('One or more selected projects were not found');
		}
		throw error;
	}
	const decisions = await authorizationService(deps).authorizeMany(
		subject,
		'project.read',
		projects.map((project) => ({ kind: 'project' as const, project })),
	);
	if (decisions.some((decision) => !decision.allowed)) {
		throw new NotFoundError('One or more selected projects were not found');
	}
}

/**
 * Load a notebook the caller may see: 404 for a deleted notebook, and a
 * `project.read` decision including the notebook's security-label override — a
 * constraint denial masks the notebook as nonexistent, matching the
 * project-level rule. The project itself must already have passed its own
 * guard; only the override needs evaluating here (the service checks the
 * project labels again regardless — labels only ever remove access).
 */
export async function loadAuthorizedNotebook(
	deps: Pick<ApiDeps, 'services' | 'policy' | 'resourceSecurity'>,
	project: Project,
	nid: NotebookId,
	subject: AuthSubject,
): Promise<NotebookDetail> {
	const detail = await deps.services.notebooks.getNotebook(project.id, nid);
	if (detail.meta.status === 'deleted') {
		throw new NotFoundError(`Notebook ${nid} not found`);
	}
	if (detail.meta.security_labels !== undefined) {
		const decision = await authorizationService(deps).authorize(subject, 'project.read', {
			kind: 'project',
			project,
			notebookLabels: detail.meta.security_labels,
		});
		if (!decision.allowed) {
			throw new NotFoundError(`Notebook ${nid} not found`);
		}
	}
	return detail;
}

/**
 * Mask-before-gate for session routes: a session whose notebook's security-label
 * override the caller does not satisfy is nonexistent to them, and the 404 must
 * land BEFORE any session-tier 403 could confirm the session exists. Returns
 * the labels so the follow-up session gate can carry them too.
 */
export async function assertSessionNotebookVisible(
	deps: Pick<ApiDeps, 'services' | 'policy' | 'resourceSecurity'>,
	project: Project,
	session: { notebook_id: NotebookId },
	subject: AuthSubject,
): Promise<ResourceSecurityLabels | null> {
	const labels = await deps.services.notebooks.getSecurityLabels(project.id, session.notebook_id);
	if (labels !== null) {
		const decision = await authorizationService(deps).authorize(subject, 'project.read', {
			kind: 'project',
			project,
			notebookLabels: labels,
		});
		if (!decision.allowed) {
			throw new NotFoundError('Session not found');
		}
	}
	return labels;
}

/**
 * Enforce that the caller is a deployment super admin (`MARIMOHUB_SUPER_ADMINS`).
 * Gates org-scoped resources, which no project role can reach.
 */
export async function assertSuperAdmin(
	subject: AuthorizationSubject,
	deps: AuthzDeps = {},
): Promise<void> {
	const decision = await authorizationService(deps).authorize(subject, 'admin.access', {
		kind: 'deployment',
	});
	if (!decision.allowed) {
		if (decision.category === 'credential-resource') {
			throw new NotFoundError('Deployment resource not found');
		}
		throw new ForbiddenError('Requires super admin');
	}
}

/**
 * OpenAPI security override for session-only routes: the generated spec
 * advertises ONLY cookieAuth, so a client must not pick a bearer token it
 * can't use there. Pair with `assertSessionAuthenticated`, which enforces it.
 */
export const SESSION_ONLY_SECURITY = [{ cookieAuth: [] }];

/**
 * Reject PAT-authenticated requests on routes that must be session-only (token
 * management, admin surfaces): a leaked PAT must not reach them. Gates on the
 * `authMethod` flag the authN middleware set — not a re-parse of the
 * Authorization header, which would risk disagreeing with the authenticator
 * over scheme casing/whitespace.
 */
export function assertSessionAuthenticated(c: Context<HonoEnv>, action: string): void {
	if (c.get('authMethod') === 'pat') {
		throw new ForbiddenError(`Personal access tokens cannot ${action} — sign in to do this`);
	}
}

/**
 * Classify a credential for the session-only guard. Exhaustive on purpose: a
 * new credential kind must decide here whether it is interactive (`session`)
 * or a bearer secret (`pat`) rather than silently inheriting session powers.
 */
export function authMethodFor(kind: CredentialKind): HonoEnv['Variables']['authMethod'] {
	switch (kind) {
		case 'sso':
		case 'development':
			return 'session';
		case 'personal-access-token':
		case 'service-account':
			return 'pat';
		default: {
			const unreachable: never = kind;
			throw new Error(`Unhandled credential kind: ${String(unreachable)}`);
		}
	}
}

export { subjectDefaultRole };

/** The caller's evaluated grants on a session — the `can` object in responses. */
export async function sessionGrantsFor(
	project: Project,
	subject: AuthorizationSubject,
	session: SessionAdmissionRecord,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<{ attach: boolean; stop: boolean; surface: boolean }> {
	const resource = { kind: 'session' as const, project, session, notebookLabels };
	const authz = authorizationService(deps);
	const decisions = await Promise.all([
		authz.authorize(subject, 'session.attach', resource),
		authz.authorize(subject, 'session.stop', resource),
		authz.authorize(subject, 'session.surface', resource),
	]);
	return {
		attach: decisions[0].allowed,
		stop: decisions[1].allowed,
		surface: decisions[2].allowed,
	};
}

async function assertSession(
	action: SessionScopedAction,
	error: () => Error,
	project: Project,
	session: SessionAdmissionRecord,
	subject: AuthSubject,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<void> {
	const decision = await authorizationService(deps).authorize(subject, action, {
		kind: 'session',
		project,
		session,
		notebookLabels,
	});
	if (!decision.allowed) {
		// A security-label denial masks the session as nonexistent, like every
		// other constraint denial; only role/session denials use the gate's 403.
		if (decision.category === 'constraint' || decision.category === 'credential-resource') {
			throw new NotFoundError('Session not found');
		}
		throw error();
	}
}

/**
 * Gate control of a live session (stop / terminate) — the `session.stop`
 * decision as a thrower. Applies the shared, exclusive, temporary,
 * administrator, and viewer rules from `sessionCan`.
 */
export async function assertSessionControl(
	project: Project,
	session: SessionAdmissionRecord,
	subject: AuthSubject,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<void> {
	await assertSession(
		'session.stop',
		() => new ForbiddenError('Not authorized to stop this session'),
		project,
		session,
		subject,
		deps,
		notebookLabels,
	);
}

/**
 * Gate *reaching* a live session's kernel (proxy traffic, keep-alive
 * heartbeats) — the `session.attach` decision as a thrower. Everything the
 * control gate admits, plus any viewer for a shared-mode session their viewer
 * mode grants.
 */
export async function assertSessionAccess(
	project: Project,
	session: SessionAdmissionRecord,
	subject: AuthSubject,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<void> {
	await assertSession(
		'session.attach',
		() => new ForbiddenError('Not authorized to attach this session'),
		project,
		session,
		subject,
		deps,
		notebookLabels,
	);
}

/**
 * Proxy-path variant of {@link assertSessionAccess}: the same admission rule
 * (`session.proxy` maps onto attach), named separately so forwarded kernel
 * traffic stays distinguishable from direct attach in decisions and future
 * constraint evaluation.
 */
export async function assertSessionProxyAccess(
	project: Project,
	session: SessionAdmissionRecord,
	subject: AuthSubject,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<void> {
	await assertSession(
		'session.proxy',
		() => new ForbiddenError('Not authorized to attach this session'),
		project,
		session,
		subject,
		deps,
		notebookLabels,
	);
}

export async function assertSessionSurfaceAccess(
	project: Project,
	session: SessionAdmissionRecord,
	subject: AuthSubject,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<void> {
	await assertSession(
		'session.surface',
		() => new SurfaceForbiddenError(),
		project,
		session,
		subject,
		deps,
		notebookLabels,
	);
}

/** The retire seam (save + destroy + terminal mark + claim release) over this request's deps. */
export function sessionRetirer(deps: ApiDeps): SessionRetirer {
	return new SessionRetirer({
		sessions: deps.services.sessions,
		notebooks: deps.services.notebooks,
		compute: deps.compute,
		bucket: deps.bucket,
		persistWorkspace: deps.sandbox.persistWorkspace,
		workdir: deps.sandbox.workdir,
	});
}

/**
 * Tear down the project's live app kernels after its content was deleted — they
 * would otherwise keep serving it (in subdomain exposure the hub is not even in
 * their request path). `scope` narrows to one notebook. Edit sessions are left to
 * the heartbeat reaper: retiring one commits a save to deleted content.
 * Best-effort, but every failure is logged: the lifecycle sweep reaps by
 * idle/expiry only — it has no deleted-content check, and an actively-viewed app
 * keeps extending its own deadline — so a stranded app can serve deleted content
 * indefinitely.
 */
export async function retireLiveApps(
	deps: ApiDeps,
	pid: ProjectId,
	scope?: (session: Session) => boolean,
): Promise<void> {
	let apps: Session[];
	try {
		apps = (await deps.services.sessions.listActiveByProject(pid)).filter(
			(s) => s.status === 'running' && !sessionPersistsEdits(s) && (!scope || scope(s)),
		);
	} catch (err) {
		logEvent({
			level: 'error',
			event: 'app_retire_list_failed',
			project_id: pid,
			error: describeError(err),
		});
		return;
	}
	// Per-app, so one failure cannot strand the apps behind it.
	for (const s of apps) {
		try {
			const { session, transitioned } = await deps.services.sessions.beginTerminating(
				pid,
				s.session_id,
			);
			await sessionRetirer(deps).retire(session, { teardown: transitioned });
		} catch (err) {
			logEvent({
				level: 'error',
				event: 'app_retire_failed',
				project_id: pid,
				session_id: s.session_id,
				error: describeError(err),
			});
		}
	}
}

/**
 * Load `project.json` and require the caller can *see* it (at least `viewer`),
 * throwing **404 NotFound** (not 403) when they can't — so a hidden project
 * (`MARIMOHUB_DEFAULT_ROLE=none`, non-member) is indistinguishable from a
 * nonexistent one. A soft-deleted project is 404 too — its bytes linger until the
 * GC sweep, but nothing about it stays reachable, sessions and kernels included.
 * Returns the loaded project for reuse. Use in read routes that need the project
 * object anyway.
 */
export async function loadVisibleProject(
	projects: ProjectService,
	pid: ProjectId,
	subject: AuthSubject,
	deps: AuthzDeps = {},
): Promise<Project> {
	// `project.read` denials are all masked (`deniedAs: 'not-found'`), so this is
	// assertProjectRole with a guaranteed-404 denial shape.
	return assertProjectRole(projects, pid, subject, 'project.read', deps);
}

/**
 * Read gate for routes that don't otherwise load the project. The project is
 * loaded even under a `defaultRole` that makes every authenticated user a
 * viewer: a default role bypasses *membership* evaluation, never *lifecycle*
 * evaluation — skipping the load would leave a soft-deleted project's notebooks
 * readable for the whole GC grace period.
 */
export async function assertProjectVisible(
	projects: ProjectService,
	pid: ProjectId,
	subject: AuthSubject,
	deps: AuthzDeps = {},
): Promise<void> {
	await loadVisibleProject(projects, pid, subject, deps);
}

export function createApp() {
	return new OpenAPIHono<HonoEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				const details = [
					...new Map(
						result.error.issues.map((issue) => {
							const detail = {
								field: issue.path.join('.') || '(body)',
								message: issue.message,
							};
							return [`${detail.field}\u0000${detail.message}`, detail] as const;
						}),
					).values(),
				];
				const message = details.map((detail) => `${detail.field}: ${detail.message}`).join('; ');
				return fail(c, 'VALIDATION_ERROR', message, 422, { details });
			}
		},
	});
}

// --- Helpers ---

const dt = () => z.string().openapi({ format: 'date-time', example: '2025-03-05T14:00:00Z' });
const nullableDt = () => dt().nullable();

export function jsonContent<T extends z.ZodType>(
	schema: T,
	description: string,
	headers?: z.ZodObject,
) {
	return {
		content: { 'application/json': { schema } },
		description,
		...(headers ? { headers } : {}),
	};
}

/** The two response envelopes, built in one place so the shape never drifts. */
export function ok<T>(c: Context, data: T) {
	return c.json({ success: true as const, data }, 200);
}

/** Backoff hint (seconds) for the retriable statuses, surfaced as `Retry-After`. */
const RETRY_AFTER_SECONDS: Record<number, number> = { 429: 5, 503: 2 };

export interface ErrorDetail {
	field: string;
	message: string;
}

export function fail(
	c: Context,
	code: ErrorCode,
	message: string,
	status: number,
	options: { details?: ErrorDetail[] } = {},
) {
	const retryAfter = RETRY_AFTER_SECONDS[status];
	if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
	const requestId = (c.var as { requestId?: string }).requestId;
	return c.json(
		{
			success: false as const,
			error: {
				code,
				message,
				...(options.details ? { details: options.details } : {}),
				...(requestId ? { request_id: requestId } : {}),
			},
		},
		status as ContentfulStatusCode,
	);
}

export function jsonBody<T extends z.ZodType>(schema: T) {
	return {
		content: { 'application/json': { schema } },
		required: true as const,
	};
}

// --- ETag / optimistic concurrency ---
//
// A resource's strong ETag is its `updated_at` — every mutation bumps it
// (`hono/etag` keeps an ETag we set rather than hashing the body, so the same
// token drives both `If-None-Match` revalidation and `If-Match` write guards).
// A client GETs the resource, reads the ETag, and echoes it as `If-Match` on a
// PUT/DELETE; the service rejects with 412 if the resource changed underneath.

/** The strong ETag header value for a resource at version `updatedAt`. */
export function etagFor(updatedAt: string): string {
	return `"${updatedAt}"`;
}

/** OpenAPI response schema documenting the `ETag` header carrying the resource version. */
export const EtagResponseHeader = z.object({
	ETag: z.string().openapi({
		description: 'Strong validator (the resource version). Echo as `If-Match` to guard a write.',
		example: '"2025-03-05T14:00:00Z"',
	}),
});

/** OpenAPI request schema for the optional `If-Match` precondition header. */
export const IfMatchHeader = z.object({
	'if-match': z
		.string()
		.optional()
		.openapi({ param: { name: 'if-match', in: 'header' }, example: '"2025-03-05T14:00:00Z"' }),
});

/** A retry key shared by the optional and required idempotency header schemas. */
const IdempotencyKeySchema = z
	.string()
	.min(1)
	.max(255)
	.openapi({
		param: { name: 'idempotency-key', in: 'header' },
		description: 'Stable client-generated key reused for retries of the same operation.',
		example: 'a1b2c3d4-e5f6-7890',
	});

export const IdempotencyKeyHeader = z.object({
	'idempotency-key': IdempotencyKeySchema.optional(),
});

export const RequiredIdempotencyKeyHeader = z.object({
	'idempotency-key': IdempotencyKeySchema,
});

/**
 * The unquoted version token from the request's `If-Match` header, or undefined
 * when absent (no precondition) or `*` (matches any existing resource — and we
 * already 404 a missing one). Strips the optional weak marker and the quotes.
 */
export function ifMatchToken(c: Context): string | undefined {
	const raw = c.req.header('if-match');
	if (!raw || raw.trim() === '*') return undefined;
	return raw
		.trim()
		.replace(/^W\//, '')
		.replace(/^"(.*)"$/, '$1');
}

// --- Path param schemas ---

// `.regex(...)` keeps the OpenAPI `pattern` on the param; `.refine(XId.is)`
// narrows the parsed value to the branded id, so `c.req.valid('param')` hands
// route handlers a ProjectId/NotebookId/SessionId without an `as` cast.
export const ProjectIdParam = z.object({
	pid: z
		.string()
		.regex(ProjectId.regex)
		.refine(ProjectId.is)
		.openapi({
			param: { name: 'pid', in: 'path' },
			example: 'proj-7h2k9qm4xz7rp3w8',
		}),
});

export const NotebookIdParam = ProjectIdParam.extend({
	nid: z
		.string()
		.regex(NotebookId.regex)
		.refine(NotebookId.is)
		.openapi({
			param: { name: 'nid', in: 'path' },
			example: 'nb-3w8h2k9qm4xz7rp3',
		}),
});

export const SessionIdParam = NotebookIdParam.extend({
	sid: z
		.string()
		.regex(SessionId.regex)
		.refine(SessionId.is)
		.openapi({
			param: { name: 'sid', in: 'path' },
			example: 'sess-9qm4xz7rp3w8h2k9',
		}),
});

// --- Shared response schemas ---

/**
 * Every machine-readable `error.code` the API can return, so a client can switch
 * on the code instead of pattern-matching `message`. The union of the
 * `DomainError` codes (see `@marimo-hub/core`'s errors) and the codes the API
 * layer emits directly (auth, validation, body-limit, proxy, the catch-all).
 */
export const ERROR_CODES = [
	...DOMAIN_ERROR_CODES,
	'UNAUTHORIZED',
	'USER_SUSPENDED',
	'GONE',
	'PAYLOAD_TOO_LARGE',
	'NO_HTML_SNAPSHOT',
	'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorResponseSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.enum(ERROR_CODES),
			message: z.string(),
			details: z
				.array(z.object({ field: z.string(), message: z.string() }))
				.optional()
				.openapi({ description: 'Field-level validation failures.' }),
			/** Correlation id (also on the `X-Request-Id` header) for support/tracing. */
			request_id: z.string().optional(),
		}),
	})
	.openapi('ErrorResponse');

export const SuccessResponseSchema = z
	.object({
		success: z.literal(true),
	})
	.openapi('SuccessResponse');

// Default description per documented error status, so routes declare the codes
// they can actually return (`...errorResponses(401, 404)`) instead of repeating
// the `jsonContent(ErrorResponseSchema, …)` boilerplate and drifting apart.
const ERROR_DESCRIPTIONS: Record<number, string> = {
	400: 'Bad request',
	401: 'Authentication required',
	403: 'Access forbidden',
	404: 'Not found',
	409: 'Conflict',
	412: 'Precondition failed (If-Match did not match the current version)',
	413: 'Request body too large',
	416: 'Range not satisfiable',
	422: 'Validation error',
	429: 'Resource limit reached',
	503: 'Service unavailable',
	500: 'Internal server error',
};

/** `Retry-After` header schema, documented on the retriable (429/503) responses. */
const RetryAfterHeader = z.object({
	'Retry-After': z.string().openapi({
		description: 'Seconds to wait before retrying.',
		example: '5',
	}),
});

export function errorResponses(...codes: number[]) {
	const out: Record<number, ReturnType<typeof jsonContent>> = {};
	for (const code of codes) {
		const headers = code === 429 || code === 503 ? RetryAfterHeader : undefined;
		out[code] = jsonContent(ErrorResponseSchema, ERROR_DESCRIPTIONS[code] ?? 'Error', headers);
	}
	return out;
}

/**
 * Errors reachable on any authenticated `/api/v1/*` route regardless of its
 * handler: 401 (the authN guard), 403 (a suspended user), 413 (the body-size
 * guard), 422 (request body / path-param validation via the OpenAPIHono
 * `defaultHook`), 500 (the catch-all), and 503 (a transient storage/compute
 * outage). Spread into a route's `responses` alongside its
 * handler-specific codes so the generated client models them too:
 *   responses: { 200: ..., ...commonErrors(), ...errorResponses(403, 404) }
 */
export function commonErrors() {
	return errorResponses(401, 403, 413, 422, 500, 503);
}

// --- Domain response schemas for OpenAPI docs ---

// Exactly one of `user_id` / `email` is present: `user_id` for a known user,
// `email` for a pending invite (someone who hasn't logged in yet).
export const ProjectMemberResponseSchema = z
	.object({
		user_id: z.string().optional(),
		email: z.string().optional(),
		role: z.enum(ROLES),
	})
	.openapi('ProjectMember');

// Loose: audit events carry per-operation context fields (project_id,
// notebook_id, …) beyond the required envelope.
export const AuditEventResponseSchema = z
	.looseObject({
		ts: dt(),
		event: z.string().openapi({ example: 'project.update' }),
		actor: z.string(),
	})
	.openapi('AuditEvent');

export const AuditLogEntryResponseSchema = z
	.object({
		id: z.string(),
		schema_version: z.number().int().positive(),
		ts: dt(),
		event: z.string().openapi({ example: 'project.update' }),
		actor: z.string(),
		metadata: z.record(z.string(), z.unknown()),
	})
	.openapi('AuditLogEntry');

export const ProjectFederationResponseSchema = z
	.object({
		enabled: z.boolean(),
		target: z.string().optional(),
	})
	.openapi('ProjectFederation');

/**
 * Resource security labels on a project or notebook. Only visible to callers
 * who already satisfied them (or hold the label-management standing), so the
 * label values themselves are not a disclosure channel.
 */
export const SecurityLabelsResponseSchema = z
	.object({
		classification: z.string(),
		compartments: z.array(z.string()),
	})
	.openapi('SecurityLabels');

export const SecurityLabelsBodySchema = z
	.object({
		classification: z.string().regex(SECURITY_LABEL_TOKEN),
		compartments: z.array(z.string().regex(SECURITY_LABEL_TOKEN)).max(MAX_SECURITY_COMPARTMENTS),
	})
	.openapi('SecurityLabelsInput');

export const ProjectResponseSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		owner: z.string(),
		members: z.array(ProjectMemberResponseSchema),
		status: z.enum(PROJECT_STATUSES),
		created_at: dt(),
		updated_at: dt(),
		tags: z.array(z.string()),
		federation: ProjectFederationResponseSchema.optional(),
		security_labels: SecurityLabelsResponseSchema.optional(),
		/** The requesting user's effective role on this project, or null if none. */
		your_role: z.enum(ROLES).nullable(),
	})
	.openapi('Project');

export const SnapshotNotebookEntrySchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string(),
		status: z.enum(NOTEBOOK_STATUSES),
		source_type: z.enum(SOURCE_TYPES),
		author: z.string(),
		created_at: dt(),
		updated_at: dt(),
		tags: z.array(z.string()),
		last_run_at: nullableDt(),
		/** The notebook's non-default compute profile; absent = deployment default. */
		compute_profile: z.string().optional(),
	})
	.openapi('SnapshotNotebookEntry');

export const SnapshotProjectEntrySchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		owner: z.string(),
		status: z.enum(PROJECT_STATUSES),
		created_at: dt(),
		updated_at: dt(),
		// The nested notebook roster is intentionally omitted: it is unbounded and
		// would defeat the cursor's page bound. Use `notebook_count` for the summary
		// and page `GET /projects/{pid}/notebooks` for the list.
		notebook_count: z.number(),
	})
	.openapi('SnapshotProjectEntry');

export const RuntimeResponseSchema = z.object({
	python_version: z.string().optional(),
	marimo_version: z.string().optional(),
});

export const NotebookMetaResponseSchema = z
	.object({
		id: z.string(),
		project_id: z.string(),
		title: z.string(),
		description: z.string(),
		status: z.enum(NOTEBOOK_STATUSES),
		author: z.string(),
		created_at: dt(),
		updated_at: dt(),
		last_run_at: nullableDt(),
		tags: z.array(z.string()),
		runtime: RuntimeResponseSchema.optional(),
		/** The notebook's chosen sandbox image; absent = the deployment default. */
		base_image: z.string().optional(),
		/** The notebook's non-default compute profile; absent = deployment default. */
		compute_profile: z.string().optional(),
		/** Security-label override enforced in addition to the project labels. */
		security_labels: SecurityLabelsResponseSchema.optional(),
	})
	.openapi('NotebookMeta');

export const LocalSourceResponseSchema = z.object({
	type: z.literal('local'),
	current_version_id: z.string(),
});

export const GitSourceConfigResponseSchema = z
	.object({
		repo: z.string().openapi({
			description: 'Normalized repository coordinate: owner/repo or an HTTPS repository URL.',
			example: 'marimo-team/marimohub',
		}),
		branch: z.string().openapi({ description: 'Synced repository branch.', example: 'main' }),
		root_path: z.string().openapi({
			description: 'Repository-relative directory synced into the notebook workspace.',
			example: 'apps',
		}),
		entry_notebook: z.string().openapi({
			description: 'Path to the entry notebook relative to root_path.',
			example: 'dashboard.py',
		}),
	})
	.openapi('GitSourceConfig');

export const GitSourceResponseSchema = z.object({
	type: z.literal('git'),
	// Null when the repo's host isn't a recognized provider (links can't be built).
	provider: z.string().min(1).nullable().openapi({
		description: 'Detected Git provider id, or null when the repository host is not recognized.',
		example: 'github',
	}),
	...GitSourceConfigResponseSchema.shape,
	pending_config: GitSourceConfigResponseSchema.optional(),
	sync_mode: z.enum(['push', 'pull']),
	current_version_id: z.string().nullable(),
	commit: z.string().nullable(),
	last_synced_at: nullableDt(),
});

export const SourceResponseSchema = z
	.discriminatedUnion('type', [LocalSourceResponseSchema, GitSourceResponseSchema])
	.openapi('Source');

export const NotebookDetailResponseSchema = z
	.object({
		meta: NotebookMetaResponseSchema,
		readme: z.string().nullable(),
		source: SourceResponseSchema,
	})
	.openapi('NotebookDetail');

const SnapshotDescriptorResponseSchema = z
	.object({
		captured_at: dt(),
		size_bytes: z.number(),
	})
	.openapi('SnapshotDescriptor');

const GitSourceRevisionResponseSchema = z
	.object({
		provider: z.string().min(1).nullable().openapi({
			description:
				'Detected provider id for this immutable source revision, or null when the repository host is unrecognized.',
			example: 'github',
		}),
		...GitSourceConfigResponseSchema.shape,
		commit: z.string().openapi({
			description: 'Immutable Git commit from which the saved version was synced.',
			example: '9e107d9d372bb6826bd81d3542a419d6',
		}),
	})
	.openapi('GitSourceRevision');

export const NotebookVersionResponseSchema = z
	.object({
		version_id: z.string(),
		notebook_id: z.string(),
		saved_at: dt(),
		author: z.string(),
		message: z.string(),
		parent_id: z.string().nullable(),
		html_snapshot: SnapshotDescriptorResponseSchema.optional(),
		session_snapshot: SnapshotDescriptorResponseSchema.optional(),
		commit: z.string().optional(),
		git_source: GitSourceRevisionResponseSchema.optional(),
	})
	.openapi('NotebookVersion');

export const ComputeResourcesResponseSchema = z
	.object({
		cpu: z.number().optional(),
		memory_bytes: z.number().optional(),
		gpu: z.string().optional(),
	})
	.openapi('ComputeResources');

export const SurfaceResponseSchema = z
	.object({
		status: z.enum(['starting', 'ready', 'stopping', 'stopped', 'failed', 'unavailable']),
		port: z.number().int().positive().optional(),
		url: z.string().optional(),
		started_at: dt().optional(),
		probe: z
			.object({
				available: z.boolean(),
				reason: z.string().optional(),
				version: z.string().optional(),
			})
			.optional(),
		last_error: z.string().optional(),
	})
	.openapi('Surface');

export function toComputeResourcesResponse(
	resources: ComputeResources | undefined,
): z.infer<typeof ComputeResourcesResponseSchema> | undefined {
	if (!resources) return undefined;
	return {
		cpu: resources.cpu,
		memory_bytes: resources.memoryBytes,
		gpu: resources.gpu,
	};
}

export const SessionResponseSchema = z
	.object({
		session_id: z.string(),
		notebook_id: z.string(),
		project_id: z.string(),
		/** The user id (auth `sub`) that started the session — resolve via /api/v1/users. */
		user_id: z.string(),
		status: z.enum(SESSION_STATUSES),
		/**
		 * The kernel URL the browser embeds. Absent while `starting`, and absent
		 * from list/get projections for callers who may not reach this kernel: in
		 * `subdomain` exposure the URL itself is the access capability (the kernel
		 * runs `--no-token`), so it is shown only to callers the kernel gates
		 * would admit.
		 */
		sandbox_url: z.string().optional(),
		started_at: dt(),
		last_heartbeat: dt(),
		/**
		 * A discard-only viewer or temporary-editor session. Edits run live but
		 * are discarded at teardown. Drives the client's warning banner.
		 */
		ephemeral: z.boolean().optional(),
		editor_sandbox_sharing: z.enum(EDITOR_SANDBOX_SHARING_VALUES).optional(),
		ended_reason: z.enum(['takeover']).optional(),
		ended_by_user_id: z.string().optional(),
		/**
		 * `edit` (an editor sandbox) or `app` (the notebook served read-only —
		 * a per-notebook singleton shared by everyone admitted to it). Always
		 * present in responses; stored records may omit it (= `edit`).
		 */
		mode: z.enum(SESSION_MODES),
		/**
		 * `app` only: the notebook's head version when the app was provisioned.
		 * Compare against the notebook's current head to show "app is stale —
		 * restart to update".
		 */
		source_version_id: z.string().optional(),
		/**
		 * The caller's grants on this session, evaluated server-side (the same
		 * `sessionCan` the gates enforce): `attach` — may reach the kernel (open,
		 * heartbeat; `sandbox_url` is present iff true), `stop` — may stop or
		 * restart it, `surfaces` — may use each secondary editor. Clients
		 * render from these instead of re-deriving policy.
		 */
		can: z.object({
			attach: z.boolean(),
			stop: z.boolean(),
			surfaces: z.object({ vscode: z.boolean(), opencode: z.boolean() }).optional(),
		}),
		surfaces: z.record(z.string(), SurfaceResponseSchema).optional(),
		/**
		 * Shared app/editor kernel connection count as of the lifecycle sweep's last
		 * probe (approximate). Drives the "~N connected" stop-confirm hint.
		 */
		active_connections: z.number().optional(),
		connections_checked_at: dt().optional(),
		/** Named compute profile used to provision the sandbox. */
		compute_profile: z.string().optional(),
		/** CPU and memory resolved when the session was provisioned. */
		compute_resources: ComputeResourcesResponseSchema.optional(),
		/** The session booted from a provider snapshot whose resources are immutable. */
		compute_from_snapshot: z.boolean().optional(),
		/** Integration config versions used to provision this session. */
		integrations: z
			.array(
				z.object({
					id: z.string(),
					name: z.string(),
					kind: z.string(),
					version: z.number().int(),
				}),
			)
			.optional(),
		/** Why the session went `failed` (sanitized); absent unless it failed. */
		error: z.object({ code: z.string(), message: z.string() }).optional(),
	})
	.openapi('Session');

/**
 * A resolved user identity for rendering `author` / session `user_id` foreign
 * keys as a person. `name` falls back to the email local-part when the provider
 * supplies no display name.
 */
export const UserResponseSchema = z
	.object({
		id: z.string(),
		email: z.string(),
		name: z.string(),
		picture_url: z.url().nullable().optional(),
	})
	.openapi('User');

// --- System (/api/v1/me, /api/v1/version, /api/v1/capabilities) ---

export const MeResponseSchema = z
	.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable().optional(),
		picture_url: z.url().nullable().optional(),
		logout_url: z.string().nullable(),
		/** Static or OIDC group-derived super admin: implicit admin everywhere. */
		is_super_admin: z.boolean(),
		/** Whether the current credential can create projects. */
		can_create_projects: z.boolean(),
	})
	.openapi('Me');

// --- Admin (/api/v1/admin/*) ---

/** A directory entry on the super-admin users page. */
export const AdminUserResponseSchema = z
	.object({
		id: z.string(),
		email: z.string(),
		name: z.string(),
		/**
		 * When the identity record was last written — a coarse activity signal
		 * (refreshed on sign-in, identity changes, and server restarts), not a
		 * precise last-seen timestamp.
		 */
		updated_at: z.string().openapi({ format: 'date-time' }),
		/** When access was suspended; null means the user is active. */
		suspended_at: z.string().openapi({ format: 'date-time' }).nullable(),
		/** Whether this user matches an entry in MARIMOHUB_SUPER_ADMINS. */
		is_super_admin: z.boolean(),
	})
	.openapi('AdminUser');

export const ConfigSettingSchema = z
	.object({
		/** Env var id, e.g. `MARIMOHUB_AUTH_OIDC_ISSUER`. */
		key: z.string(),
		name: z.string(),
		/** Configured (or default) value; always null when `secret`. */
		value: z.string().nullable(),
		secret: z.boolean(),
		/** Whether the env var is explicitly set in this deployment. */
		set: z.boolean(),
	})
	.openapi('ConfigSetting');

export const ConfigGroupSchema = z
	.object({
		/** Spec group name, e.g. `Auth`, `Storage`. */
		name: z.string(),
		/** The group's resolved backend selector; null for selector-less groups. */
		backend: z.string().nullable(),
		settings: z.array(ConfigSettingSchema),
	})
	.openapi('ConfigGroup');

/** Build/runtime identity of the serving replica, super-admin only. */
export const AdminDeploymentSchema = z
	.object({
		version: z.string(),
		image: z.string().nullable(),
		sandbox_image: z.string().nullable(),
		started_at: z.string().nullable(),
		replica: z.string().nullable(),
		node: z.string().nullable(),
		backends: z
			.object({
				storage: z.string(),
				compute: z.string(),
				auth: z.string(),
			})
			.nullable(),
	})
	.openapi('AdminDeployment');

/**
 * The effective (parsed) authorization policy, as the server enforces it —
 * unlike the raw env values in `groups`, which may be unset or carry defaults.
 */
export const AdminPolicySchema = z
	.object({
		default_role: z.enum(ASSIGNABLE_ROLES).nullable(),
		/** Raw MARIMOHUB_SUPER_ADMINS entries (emails or user ids). */
		super_admins: z.array(z.string()),
	})
	.openapi('AdminPolicy');

/** Read-only deployment configuration surfaced by `GET /api/v1/admin/config`. */
export const DeploymentConfigResponseSchema = z
	.object({
		/** Null when the wiring provides no version metadata (library/Workers, tests). */
		deployment: AdminDeploymentSchema.nullable(),
		/** Empty when the wiring provides no summary (library/Workers). */
		groups: z.array(ConfigGroupSchema),
		policy: AdminPolicySchema,
	})
	.openapi('DeploymentConfig');

/**
 * The deployment version surfaced by `GET /api/v1/version`. Just the version:
 * the rest of the build/runtime identity (image, replica, backends, …) is
 * super-admin material, served by `GET /api/v1/admin/config`.
 */
export const DeploymentInfoResponseSchema = z
	.object({
		version: z.string(),
	})
	.openapi('DeploymentInfo');

/**
 * Deployment-wide feature flags + limits the UI keys off, so the client reads
 * server-enforced bounds instead of hardcoding them. `maxConcurrentSessionsPerUser`
 * is null when unlimited.
 */
export const CapabilitiesResponseSchema = z
	.object({
		federation: z.object({ available: z.boolean() }),
		integrations: z.object({ available: z.boolean() }),
		source_control: z.object({
			change_request_providers: z.array(z.string()).openapi({
				description:
					'Provider ids configured to publish pull requests, merge requests, or equivalents from notebook sessions.',
				example: ['github'],
			}),
			sync_providers: z.array(z.string()).openapi({
				description:
					'Provider ids configured for server-initiated pull sync (drift lookup and "Sync now").',
				example: ['github'],
			}),
			pull_source_providers: z.array(z.string()).openapi({
				description:
					'Provider ids configured to create pull-mode sources with server-materialized Git metadata.',
				example: ['github'],
			}),
		}),
		project_alerts: z.object({
			available: z.boolean(),
			destination_types: z.array(extensibleResponseEnum(['slack', 'webhook'], 'slack')),
			selectable_kinds: z.array(
				extensibleResponseEnum(PROJECT_ALERT_KINDS, PROJECT_ALERT_KINDS[0]),
			),
			max_destinations: z.number().int().positive(),
		}),
		/** Read-only data browsing over integrations; `preview` gates row preview. */
		data_browser: z.object({
			available: z.boolean(),
			preview: z.boolean(),
			query: z.boolean(),
			ai_query: z.boolean(),
		}),
		/**
		 * What an effective `viewer` sees when opening a notebook
		 * (MARIMOHUB_VIEWER_MODE): the client branches on this before starting a
		 * session — the server enforces the same matrix regardless.
		 */
		viewer_mode: z.enum(VIEWER_MODES),
		/**
		 * The session modes an effective viewer may start or attach to under this
		 * deployment's viewer mode — the server's admission row, evaluated, so
		 * clients render from it instead of re-deriving policy from `viewer_mode`.
		 */
		viewer_session_modes: z.array(z.enum(SESSION_MODES)),
		editor_sandbox_sharing: z.enum(EDITOR_SANDBOX_SHARING_VALUES),
		/**
		 * Role granted to an authenticated non-member (MARIMOHUB_DEFAULT_ROLE);
		 * null = members-only. The UI derives its role/access copy from this.
		 */
		default_role: z.enum(ASSIGNABLE_ROLES).nullable(),
		limits: z.object({
			max_concurrent_sessions_per_user: z.number().nullable(),
			max_apps_per_project: z.number().nullable(),
			max_request_bytes: z.number(),
			max_versions_per_notebook: z.number(),
			default_page_size: z.number(),
			max_page_size: z.number(),
		}),
		/**
		 * Selectable sandbox images, in order — the first is the default. Empty when
		 * the deployment offers no image choice (single image or imageless backend).
		 */
		sandbox_images: z.array(z.string()),
		/**
		 * How long the server waits for a kernel to come up before failing a
		 * session start (MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS). Clients bound
		 * their own "still starting" waits with it instead of hardcoding a copy.
		 */
		sandbox_startup_timeout_seconds: z.number(),
		compute_profiles: z.array(
			ComputeResourcesResponseSchema.extend({
				name: z.string(),
			}),
		),
		compute_profile_override: z.enum(['none', 'editors']),
		surfaces: z.array(
			z.discriminatedUnion('id', [
				z.object({
					id: z.literal('vscode'),
					flavor: z.enum(['code-server', 'openvscode']),
					start: z.enum(['on-demand', 'eager']),
					embed: z.enum(['tab', 'iframe']),
				}),
				z.object({
					id: z.literal('opencode'),
					start: z.enum(['on-demand', 'eager']),
					embed: z.enum(['tab', 'iframe']),
					managed_ai: z.boolean(),
				}),
			]),
		),
	})
	.openapi('Capabilities');

/**
 * Whether the caller holds deployment standing for `action` (project creation
 * under a restricted deployment, directory search, super-admin surfaces).
 * Boolean form for capability flags such as `GET /me`.
 */
export async function canDeploymentAction(
	subject: AuthorizationSubject,
	action: DeploymentAction,
	deps: AuthzDeps = {},
): Promise<boolean> {
	const decision = await authorizationService(deps).authorize(subject, action, {
		kind: 'deployment',
	});
	return decision.allowed;
}

/** {@link canDeploymentAction} as a guard: a standing denial is a plain 403. */
export async function assertDeploymentAction(
	subject: AuthorizationSubject,
	action: DeploymentAction,
	deps: AuthzDeps = {},
	message = 'Requires super admin',
): Promise<void> {
	const decision = await authorizationService(deps).authorize(subject, action, {
		kind: 'deployment',
	});
	if (decision.allowed) return;
	if (decision.category === 'credential-resource') {
		throw new NotFoundError('Deployment resource not found');
	}
	throw new ForbiddenError(message);
}

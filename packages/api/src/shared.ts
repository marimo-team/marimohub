import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	canAct,
	NotebookId,
	NotFoundError,
	NOTEBOOK_STATUSES,
	PROJECT_STATUSES,
	ProjectId,
	requireRole,
	ROLES,
	SESSION_STATUSES,
	SessionId,
	SOURCE_TYPES,
	VIEWER_MODES,
} from '@marimo-hub/core';
import type { AuthSubject, Project, ProjectService, Role, Session } from '@marimo-hub/core';
import type { HonoEnv } from './context';

// Re-export the injected-context types for route modules that import from './shared'.
export type { ApiDeps, HonoEnv } from './context';

/**
 * Enforce that the caller holds at least `min` role on the project. Loads
 * `project.json` (404 if the project does not exist) and throws ForbiddenError
 * (403) on insufficient role. Used to gate write routes. Returns the loaded
 * project so callers can reuse it without a second fetch. The subject is the
 * request's `AuthUser` — membership matches by user id or (invite) email.
 */
export async function assertProjectRole(
	projects: ProjectService,
	pid: ProjectId,
	subject: AuthSubject,
	min: Role,
	defaultRole?: Role,
): Promise<Project> {
	const project = await projects.getProject(pid);
	requireRole(project, subject, min, defaultRole);
	return project;
}

/**
 * Gate control of a live session (heartbeat / stop / kernel proxy): `editor`+
 * as for starting one, OR the owner of an ephemeral (viewer) session who still
 * holds at least `viewer` on the project. The role is re-checked on every call
 * — ownership of the stamped record alone must not outlive a revoked
 * membership, or a removed user could keep their kernel alive indefinitely.
 * Session ownership is deliberately strict id equality — an email-invite match
 * never transfers control of someone else's session.
 */
export async function assertSessionControl(
	projects: ProjectService,
	session: Pick<Session, 'project_id' | 'user_id' | 'ephemeral'>,
	subject: AuthSubject,
	defaultRole?: Role,
): Promise<void> {
	const project = await projects.getProject(session.project_id);
	if (
		session.ephemeral &&
		session.user_id === subject.id &&
		canAct(project, subject, 'viewer', defaultRole)
	) {
		return;
	}
	requireRole(project, subject, 'editor', defaultRole);
}

/**
 * Load `project.json` and require the caller can *see* it (at least `viewer`),
 * throwing **404 NotFound** (not 403) when they can't — so a hidden project
 * (`MARIMOHUB_DEFAULT_ROLE=none`, non-member) is indistinguishable from a
 * nonexistent one. Returns the loaded project for reuse. Use in read routes that
 * need the project object anyway.
 */
export async function loadVisibleProject(
	projects: ProjectService,
	pid: ProjectId,
	subject: AuthSubject,
	defaultRole?: Role,
): Promise<Project> {
	const project = await projects.getProject(pid);
	if (!canAct(project, subject, 'viewer', defaultRole)) {
		throw new NotFoundError(`Project ${pid} not found`);
	}
	return project;
}

/**
 * Read gate for routes that don't otherwise load the project. Fast-path when a
 * `defaultRole` is set (every authenticated user is a viewer, so no load); under
 * `none` it enforces membership via {@link loadVisibleProject}.
 */
export async function assertProjectVisible(
	projects: ProjectService,
	pid: ProjectId,
	subject: AuthSubject,
	defaultRole?: Role,
): Promise<void> {
	if (defaultRole != null) return;
	await loadVisibleProject(projects, pid, subject, defaultRole);
}

export function createApp() {
	return new OpenAPIHono<HonoEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				// One `field: message` per failing field, deduped, so the caller can see
				// exactly what to fix instead of one comma-run blob.
				const seen = new Set<string>();
				const message = result.error.issues
					.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
					.filter((m) => !seen.has(m) && (seen.add(m), true))
					.join('; ');
				return fail(c, 'VALIDATION_ERROR', message, 422);
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

export function fail(c: Context, code: string, message: string, status: number) {
	const retryAfter = RETRY_AFTER_SECONDS[status];
	if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
	const requestId = (c.var as { requestId?: string }).requestId;
	return c.json(
		{
			success: false as const,
			error: { code, message, ...(requestId ? { request_id: requestId } : {}) },
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

/**
 * OpenAPI request schema for the optional `Idempotency-Key` header on the create
 * routes. A client sends the same key on a retry so a dropped-response replay
 * returns the original result instead of creating a duplicate (see `idempotentCreate`).
 */
export const IdempotencyKeyHeader = z.object({
	'idempotency-key': z
		.string()
		.min(1)
		.max(255)
		.optional()
		.openapi({ param: { name: 'idempotency-key', in: 'header' }, example: 'a1b2c3d4-e5f6-7890' }),
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
	'BAD_REQUEST',
	'UNAUTHORIZED',
	'FORBIDDEN',
	'NOT_FOUND',
	'CONFLICT',
	'GONE',
	'PRECONDITION_FAILED',
	'PAYLOAD_TOO_LARGE',
	'VALIDATION_ERROR',
	'RESOURCE_EXHAUSTED',
	'NOT_INITIALIZED',
	'SERVICE_UNAVAILABLE',
	'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorResponseSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.enum(ERROR_CODES),
			message: z.string(),
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
	403: 'Insufficient role',
	404: 'Not found',
	409: 'Conflict',
	412: 'Precondition failed (If-Match did not match the current version)',
	413: 'Request body too large',
	422: 'Validation error',
	429: 'Resource limit reached',
	503: 'Service unavailable',
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
 * handler: 401 (the authN guard), 422 (request body / path-param validation via
 * the OpenAPIHono `defaultHook`), and 503 (a storage/compute dependency is
 * transiently unavailable). Spread into a route's `responses` alongside its
 * handler-specific codes so the generated client models them too:
 *   responses: { 200: ..., ...commonErrors(), ...errorResponses(403, 404) }
 */
export function commonErrors() {
	return errorResponses(401, 422, 503);
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

export const ProjectFederationResponseSchema = z
	.object({
		enabled: z.boolean(),
		target: z.string().optional(),
	})
	.openapi('ProjectFederation');

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
	})
	.openapi('NotebookMeta');

export const LocalSourceResponseSchema = z.object({
	type: z.literal('local'),
	current_version_id: z.string(),
});

export const GitSourceResponseSchema = z.object({
	type: z.literal('git'),
	provider: z.literal('github'),
	repo: z.string(),
	branch: z.string(),
	root_path: z.string(),
	entry_notebook: z.string(),
	sync_mode: z.literal('push'),
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
	})
	.openapi('NotebookVersion');

export const SessionResponseSchema = z
	.object({
		session_id: z.string(),
		notebook_id: z.string(),
		project_id: z.string(),
		/** The user id (auth `sub`) that started the session — resolve via /api/v1/users. */
		user_id: z.string(),
		status: z.enum(SESSION_STATUSES),
		sandbox_url: z.string().optional(),
		started_at: dt(),
		last_heartbeat: dt(),
		/**
		 * A viewer's throwaway session (MARIMOHUB_VIEWER_MODE=ephemeral-sandbox):
		 * edits run live but are discarded at teardown. Drives the client's
		 * "edits won't be saved" banner; absent = persisting.
		 */
		ephemeral: z.boolean().optional(),
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
	})
	.openapi('User');

// --- System (/api/v1/me, /api/v1/version, /api/v1/capabilities) ---

export const MeResponseSchema = z
	.object({
		id: z.string(),
		email: z.string(),
		logout_url: z.string().nullable(),
	})
	.openapi('Me');

/** Read-only deployment identity/metadata surfaced by `GET /api/v1/version`. */
export const DeploymentInfoResponseSchema = z
	.object({
		version: z.string(),
		image: z.string().nullable(),
		sandbox_image: z.string().nullable(),
		started_at: z.string().nullable(),
		replica: z.string().nullable(),
		node: z.string().nullable(),
		backends: z.object({
			storage: z.string(),
			compute: z.string(),
			auth: z.string(),
		}),
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
		/**
		 * What an effective `viewer` sees when opening a notebook
		 * (MARIMOHUB_VIEWER_MODE): the client branches on this before starting a
		 * session — the server enforces the same matrix regardless.
		 */
		viewer_mode: z.enum(VIEWER_MODES),
		/**
		 * Role granted to an authenticated non-member (MARIMOHUB_DEFAULT_ROLE);
		 * null = members-only. The UI derives its role/access copy from this.
		 */
		default_role: z.enum(ROLES).nullable(),
		limits: z.object({
			max_concurrent_sessions_per_user: z.number().nullable(),
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
	})
	.openapi('Capabilities');

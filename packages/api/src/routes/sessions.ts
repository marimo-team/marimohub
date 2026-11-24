import { notebookCssCacheFor, notebookCssUrl } from '../notebookCss';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { resolveSessionLinks } from '@marimo-hub/core/session-links';
import type { SessionLinkTemplate } from '@marimo-hub/core/session-links';
import { createRoute, z } from '@hono/zod-openapi';
import { all, allSettled } from 'better-all';
import type {
	KnownObject,
	Millis,
	ProvisionResult,
	SecondarySurfaceId,
	WarmPoolClaim,
	ResourceSecurityLabels,
	Role,
	AuthenticatedPrincipal,
	AuthUser,
	EditorClaim,
	EditorSandboxSharing,
	NotebookId,
	PreviewId,
	Project,
	ProjectId,
	MarimoConfigContributor,
	Session,
	SessionAdmissionRecord,
	SessionMode,
	SandboxInstance,
	SessionRender,
	UserId,
	WorkloadRef,
} from '@marimo-hub/core';
import { SANDBOX_STARTUP_PHASES, STARTUP_DETAIL_MAX_LENGTH } from '@marimo-hub/core/constants';
import {
	EditorClaimLostError,
	admissionCaps,
	assertAdmissionRank,
	previewAvailable,
	AppPoolService,
	AppAssignmentExpiredError,
	sessionResourceNotebookId,
	sessionResourcePath,
	PREVIEW_IDLE_MS,
	AppVisitSchema,
	jitteredBackoff,
	BadRequestError,
	ConflictError,
	StartupCompletionExpiredError,
	SessionPersistenceRequiredError,
	PreconditionFailedError,
	WarmPoolClaimExpiredError,
	createKernelAuthToken,
	createSandboxId,
	createSessionId,
	deferOrAwait,
	DomainError,
	marimoAiContributor,
	marimoConfigToSessionEnv,
	marimoBrandDisplay,
	mergeSessionEnv,
	marimoNotebookDefaults,
	marimoSharingDisabled,
	mintAiSessionToken,
	NotFoundError,
	notificationRouter,
	paths,
	roleAtLeast,
	resolveBaseImage,
	resolveComputeProfile,
	storedComputeProfile,
	resolveLaunchStrategyForSession,
	resolveNotebookLaunchSource,
	resolveRestoreSnapshot,
	pullSourceGitOptions,
	recipientFromIdentity,
	ResourceExhaustedError,
	saga,
	MODE_POLICY,
	isTerminal,
	isPastAuthorizationDeadline,
	SandboxProvisioner,
	SESSION_MODES,
	SessionId,
	sessionMode,
	sessionPersistsEdits,
	buildSandboxContext,
	effectivePersistenceMode,
	sandboxContextPath,
	sandboxContextFile,
	writeSandboxContext,
	sessionSandbox,
	reconnectSessionSandbox,
	sessionWorkspaceDir,
	UnavailableError,
	EditSessionOwnedError,
	EditSessionRetiringError,
	EditSessionChangedError,
	ForbiddenError,
	TakeoverInProgressError,
	TakeoverRetirementError,
	kernelActiveConnections,
	localKernelBasePath,
	joinUrlPath,
	SECONDARY_SURFACE_IDS,
	SurfaceForbiddenError,
	workspaceSourcePolicy,
	validateWifCredentialsUrl,
	wifCredentialsDeadline,
} from '@marimo-hub/core';
import { previewAppPoolPolicy, previewIdleTimeout, PREVIEW_MAX_SESSIONS } from '../previewPolicy';
import { checkComputeProfile } from '../computeProfile';
import { logObserver } from '../saga';
import { appendAudit, describeError, errorMetadata, logEvent } from '../log';
import { sessionClientFor } from '../sessionClient';
import {
	assertNotificationMutationAllowed,
	scheduleNotification,
	scheduleProjectAlert,
} from '../notifications';
import type { ApiDeps, ResolvedApiDeps, SandboxConfig } from '../context';
import {
	composeSessionEnv,
	federatedCredentialsFor,
	resolveFederatedVars,
	resolveIntegrationRender,
} from '../sandboxEnv';
import { federationFor } from '../federation';
import { WIF_CREDENTIALS_PATH } from './wifCredentials';
import {
	deferTeardown,
	assertProjectRole,
	assertSessionAccess,
	assertSessionControl,
	assertSessionNotebookVisible,
	assertSessionPreviewActive,
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	IdempotencyKeyHeader,
	jsonContent,
	loadAuthorizedNotebookMeta,
	loadVisibleProject,
	loadSessionProject,
	NotebookIdParam,
	ProjectIdParam,
	resolvePublicBaseUrl,
	SessionIdParam,
	extensibleResponseEnum,
	internalErrorMessage,
	RETRY_AFTER_SECONDS,
	sessionGrantsFor,
	SessionResponseSchema,
	SurfaceResponseSchema,
	sessionRetirer,
	SuccessResponseSchema,
	toComputeResourcesResponse,
} from '../shared';
import type { AuthzDeps } from '../shared';
import { durableStartup } from './durableStartup';
import { sessionStartupReporter } from './sessionStartup';
import { sessionStartupStream } from './sessionStartupStream';
import type { SandboxStartupSnapshot } from '@marimo-hub/core/ports/sandbox';
import { pageSchema, paginate, PaginationQuery } from '../pagination';
import {
	beginSessionSurface,
	beginSessionSurfaces,
	loadSurfaceSession,
	surfaceConfig,
	surfaceStopManager,
} from './sessionSurfaces';

function effectiveEditorSharing(
	claim: EditorClaim | undefined,
	configured: EditorSandboxSharing | undefined,
): EditorSandboxSharing {
	return claim?.session_id || claim?.transfer ? claim.sharing : (configured ?? 'shared');
}

// --- Route definitions ---

// createSession is create-or-reuse; `reused` distinguishes an existing shared,
// owned, or temporary session from a freshly provisioned one.
export const SessionCreateResponseSchema = SessionResponseSchema.extend({
	reused: z.boolean(),
	app_assignment: AppVisitSchema.optional(),
	editor_session: z
		.object({
			sharing: z.enum(['shared', 'exclusive']),
			access: z.enum(['shared', 'owner', 'temporary']),
		})
		.optional(),
}).openapi('SessionCreateResult');

const listSessions = createRoute({
	method: 'get',
	path: '/projects/{pid}/sessions',
	operationId: 'sessions.list',
	tags: ['Sessions'],
	summary: 'List active sessions for a project',
	request: { params: ProjectIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(SessionResponseSchema, 'SessionPage'),
			}),
			'Active sessions for the project, newest first',
		),
		...commonErrors(),
		// 404: unknown project, or one hidden from the caller (members-only).
		...errorResponses(400, 404),
	},
});

// Optional body: absent (or `{}`) = `edit`, so pre-`mode` clients are untouched.
export const SessionCreateBodySchema = z
	.strictObject({
		/**
		 * `edit` (default): a persistent or temporary editor sandbox according to
		 * the editor sandbox-sharing policy. `app`: the notebook served as a
		 * read-only, per-notebook app. Viewer access depends on
		 * MARIMOHUB_VIEWER_MODE.
		 */
		mode: z.enum(SESSION_MODES).optional(),
		app_visit_id: z.string().min(1).max(128).optional(),
		replace_app_session_id: z
			.string()
			.refine(SessionId.is)
			.optional()
			.describe(
				'Replace the selected app sandbox without joining it. Requires permission to stop that sandbox.',
			),
		/** One-shot edit-session override that does not change notebook metadata. */
		compute_profile: z.string().min(1).optional(),
		/** Request a discard-only editor sandbox. Valid only with exclusive sharing. */
		edit_intent: z.literal('temporary').optional(),
		/** Secondary editor surfaces to start with this edit session. */
		surfaces: z
			.array(z.enum(SECONDARY_SURFACE_IDS))
			.max(SECONDARY_SURFACE_IDS.length)
			.refine((surfaces) => new Set(surfaces).size === surfaces.length, {
				message: 'Duplicate session surfaces are not allowed',
			})
			.optional(),
	})
	.openapi('SessionCreateBody');

const SessionStartupPhaseSchema = extensibleResponseEnum(SANDBOX_STARTUP_PHASES, 'allocating');

export const SessionStartupProgressSchema = z
	.object({
		phase: SessionStartupPhaseSchema,
		detail: z.string().max(STARTUP_DETAIL_MAX_LENGTH).optional(),
		started_at: z.string().openapi({ format: 'date-time', example: '2025-03-05T14:00:00Z' }),
		attempt: z.number().int().min(1).describe('Increments when the sandbox is replaced.'),
		observed: z.array(SessionStartupPhaseSchema),
	})
	.openapi('SessionStartupProgress');

export const SessionStartupErrorSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.string(),
			message: z.string(),
			status: z.number().int().describe('The HTTP status the JSON response would carry.'),
			retry_after_ms: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Present when the JSON response would carry Retry-After.'),
		}),
	})
	.openapi('SessionStartupError');

export const SessionStartupEventSchema = z
	.discriminatedUnion('event', [
		z.object({ event: z.literal('progress'), data: SessionStartupProgressSchema }),
		z.object({
			event: z.literal('result'),
			data: z.object({ success: z.literal(true), data: SessionCreateResponseSchema }),
		}),
		z.object({ event: z.literal('error'), data: SessionStartupErrorSchema }),
	])
	.openapi('SessionStartupEvent', {
		description:
			'One server-sent event: `event` is the SSE event name and `data` is its JSON payload. ' +
			'Opt in with Accept: text/event-stream. Only edit starts emit progress; app starts omit it. ' +
			'Clients must ignore unknown phases and unknown events. ' +
			'The stream ends with exactly one result or error event. ' +
			'Failures after authorization arrive as an error event on HTTP 200. ' +
			'No replay or automatic reconnect. Disconnect ends observation, not provisioning.',
	});

const createSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions',
	operationId: 'sessions.create',
	tags: ['Sessions'],
	summary: 'Create a session and provision a sandbox',
	// `Idempotency-Key` is accepted and documented, but this route is already
	// idempotent through session reuse. Edit reuse follows the configured sharing
	// policy; app reuse follows the visit assignment.
	description:
		'Create or reuse a notebook sandbox. Edit-session reuse follows the configured ' +
		'editor sandbox-sharing policy. App sessions use sticky visit assignments in a version-aware pool.',
	request: {
		params: NotebookIdParam,
		headers: IdempotencyKeyHeader,
		body: {
			content: { 'application/json': { schema: SessionCreateBodySchema } },
			required: false,
			description: 'Optional; omit for an edit session.',
		},
	},
	responses: {
		200: {
			description: 'Session created or reused',
			content: {
				'application/json': {
					schema: z.object({ success: z.literal(true), data: SessionCreateResponseSchema }),
				},
				'text/event-stream': { schema: SessionStartupEventSchema },
			},
		},
		...commonErrors(),
		...errorResponses(400, 403, 404, 409, 429),
	},
});

const deleteSession = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}',
	operationId: 'sessions.terminate',
	tags: ['Sessions'],
	summary: 'Terminate a session and destroy sandbox',
	request: {
		params: SessionIdParam,
		headers: z.object({ 'idempotency-key': z.string().min(1).max(128).optional() }),
		query: z.object({
			force: z
				.enum(['true', 'false'])
				.optional()
				.describe('Explicitly discard changes that have not been saved durably.'),
			request_key: z.string().min(1).max(128).optional(),
			previous_attempt_id: z.uuid().optional(),
			wait: z
				.enum(['true', 'false'])
				.optional()
				.describe('Wait for teardown to finish before responding. Use for restart.'),
		}),
	},
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Session terminated'),
		202: jsonContent(
			SuccessResponseSchema,
			'Session termination accepted; teardown continues in the background',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409),
	},
});

const getSession = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}',
	operationId: 'sessions.get',
	tags: ['Sessions'],
	summary: 'Get a session (status + kernel URL)',
	request: {
		params: SessionIdParam,
		query: z.object({
			wait: z.coerce
				.number()
				.int()
				.min(0)
				.max(20)
				.optional()
				.describe('Wait up to this many seconds for a starting session to change status.'),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionResponseSchema }),
			'Session',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const heartbeatSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat',
	operationId: 'sessions.heartbeat',
	tags: ['Sessions'],
	summary: 'Update session heartbeat',
	request: {
		params: SessionIdParam,
		body: { content: { 'application/json': { schema: AppVisitSchema } }, required: false },
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionResponseSchema }),
			'Heartbeat updated',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

const leaveAppVisit = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/leave',
	operationId: 'sessions.leaveApp',
	tags: ['Sessions'],
	summary: 'Release this app visit',
	request: {
		params: SessionIdParam,
		body: { content: { 'application/json': { schema: AppVisitSchema } }, required: true },
	},
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Visit released'),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const SurfaceParam = SessionIdParam.extend({
	surface: z.enum(SECONDARY_SURFACE_IDS).openapi({ param: { name: 'surface', in: 'path' } }),
});

const SurfaceStartBodySchema = z
	.object({
		open: z
			.string()
			.max(4096)
			.optional()
			.describe('Workspace-relative file to open. Supported only by the VS Code surface.'),
	})
	.openapi('SurfaceStartBody');

const SurfaceResultSchema = SurfaceResponseSchema.extend({
	id: z.enum(SECONDARY_SURFACE_IDS),
});

const ensureSurfaceRoute = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}',
	operationId: 'sessions.surfaces.ensure',
	tags: ['Sessions'],
	summary: 'Start or reuse a session surface',
	request: {
		params: SurfaceParam,
		body: {
			content: { 'application/json': { schema: SurfaceStartBodySchema } },
			required: false,
		},
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SurfaceResultSchema }),
			'Surface ready',
		),
		202: jsonContent(
			z.object({ success: z.literal(true), data: SurfaceResultSchema }),
			'Surface starting',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409, 503),
	},
});

const getSurfaceRoute = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}',
	operationId: 'sessions.surfaces.get',
	tags: ['Sessions'],
	summary: 'Get a session surface',
	request: { params: SurfaceParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SurfaceResultSchema }),
			'Surface status',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const deleteSurfaceRoute = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}/surfaces/{surface}',
	operationId: 'sessions.surfaces.stop',
	tags: ['Sessions'],
	summary: 'Stop a secondary session surface',
	request: { params: SurfaceParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Surface stopped'),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409),
	},
});

const EditorActivitySchema = z.enum(['active', 'idle', 'unknown', 'starting']);
const EditorSessionStateSchema = z
	.object({
		sharing: z.enum(['shared', 'exclusive']),
		holder: z
			.object({
				session_id: z.string(),
				user_id: z.string(),
				status: z.enum(['starting', 'running', 'terminating']),
				started_at: z.string(),
				activity: z.object({
					state: EditorActivitySchema,
					active_connections: z.number().optional(),
					checked_at: z.string().optional(),
				}),
			})
			.nullable(),
		can_take_over: z.boolean(),
		transfer: z.object({ status: z.enum(['requested', 'draining', 'ready']) }).optional(),
	})
	.openapi('EditorSessionState');

const getEditorSession = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/editor-session',
	operationId: 'sessions.editor.get',
	tags: ['Sessions'],
	summary: 'Inspect persistent editor ownership',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: EditorSessionStateSchema }),
			'Persistent editor ownership and current activity',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const TakeoverBodySchema = z
	.object({
		takeover_id: z.string().min(1).max(255),
		expected_holder_session_id: z.string().refine(SessionId.is),
		expected_activity: EditorActivitySchema,
		acknowledge_disruption: z.literal(true),
	})
	.openapi('EditorTakeoverBody');

const takeoverEditorSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/editor-session/takeover',
	operationId: 'sessions.editor.takeover',
	'x-cli-destructive': true,
	tags: ['Sessions'],
	summary: 'Gracefully take over an exclusive editor session',
	request: {
		params: NotebookIdParam,
		body: { content: { 'application/json': { schema: TakeoverBodySchema } }, required: true },
	},
	responses: {
		200: jsonContent(SuccessResponseSchema, 'The prior editor was saved and stopped'),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409, 429, 503),
	},
});

// --- App ---

/**
 * `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` when configured, else the host this
 * request arrived on. Eager and on-demand surface starts must agree on this so
 * a session's surfaces are exposed under one hostname.
 */
export function resolveSandboxHostname(
	c: { req: { url: string } },
	sandbox: SandboxConfig,
): string {
	return sandbox.hostname || new URL(c.req.url).hostname;
}

function surfaceGrants(granted: boolean): Record<SecondarySurfaceId, boolean> {
	return Object.fromEntries(SECONDARY_SURFACE_IDS.map((id) => [id, granted])) as Record<
		SecondarySurfaceId,
		boolean
	>;
}

function publicSurfaces(s: Session, can: { attach: boolean; surface: boolean }) {
	if (!s.surfaces) return;
	return Object.fromEntries(
		Object.entries(s.surfaces).map(([id, state]) => [
			id,
			{
				status: state.status,
				port: state.port,
				url:
					id === 'marimo'
						? can.attach
							? state.url
							: undefined
						: can.surface
							? state.url
							: undefined,
				started_at: state.started_at,
				probe: state.probe,
				last_error: can.surface ? state.last_error : undefined,
			},
		]),
	);
}

/**
 * Project a stored Session onto the public Session response envelope, carrying
 * the caller's evaluated grants (`sessionGrantsFor`). `sandbox_url` rides on
 * `can.attach`: in `subdomain` exposure the URL carries the kernel token, so
 * listing it to a caller the kernel gates would reject hands them the kernel.
 * `user_id` supports the collaborative "started by" UI and is visible only to
 * users who can list the project's sessions. Internal infrastructure fields
 * (`sandbox_id`, `used_fallback`) stay private.
 */
export function toSessionResponse(
	s: Session,
	can: Awaited<ReturnType<typeof sessionGrantsFor>>,
	linkTemplates: readonly SessionLinkTemplate[] = [],
) {
	const { appReadOnly } = can;
	return {
		session_id: s.session_id,
		notebook_id: sessionResourceNotebookId(s),
		origin: s.origin,
		resource_path: sessionResourcePath(s),
		project_id: s.project_id,
		user_id: appReadOnly ? undefined : s.user_id,
		status: s.status,
		stop:
			!appReadOnly && s.stop
				? {
						id: s.stop.id,
						outcome: s.stop.outcome,
						force: s.stop.force,
						trigger: s.stop.trigger,
						requested_at: s.stop.requested_at,
						updated_at: s.stop.updated_at,
						runtime_state: s.stop.runtime_state,
						failure: s.stop.failure,
						captured_at: s.stop.captured_at,
						version_id: s.stop.version_id,
					}
				: undefined,
		last_durable_capture: appReadOnly ? undefined : s.last_durable_capture,
		sandbox_url: can.attach ? s.sandbox_url : undefined,
		links:
			can.attach && !appReadOnly && sessionMode(s) === 'edit' && linkTemplates.length > 0
				? resolveSessionLinks(linkTemplates, { ...s, notebook_id: sessionResourceNotebookId(s) })
				: undefined,
		can: {
			attach: can.attach,
			stop: can.stop,
			surfaces: surfaceGrants(can.surface),
		},
		surfaces: appReadOnly ? undefined : publicSurfaces(s, can),
		started_at: s.started_at,
		last_heartbeat: s.last_heartbeat,
		ephemeral: appReadOnly ? undefined : s.ephemeral,
		editor_sandbox_sharing: appReadOnly ? undefined : s.editor_sandbox_sharing,
		ended_reason: appReadOnly ? undefined : s.ended_reason,
		ended_by_user_id: appReadOnly ? undefined : s.ended_by_user_id,
		// Defaulted in the projection so clients never see `undefined` (stored
		// records predating the field omit it).
		mode: sessionMode(s),
		source_version_id: appReadOnly || s.origin ? undefined : s.source_version_id,
		working_branch_version_id: appReadOnly || s.origin ? undefined : s.working_branch_version_id,
		active_connections: appReadOnly ? undefined : s.active_connections,
		connections_checked_at: appReadOnly ? undefined : s.connections_checked_at,
		compute_profile: appReadOnly ? undefined : s.compute_profile,
		compute_resources: appReadOnly ? undefined : s.compute_resources,
		compute_from_snapshot: appReadOnly ? undefined : s.compute_from_snapshot,
		integrations: appReadOnly ? undefined : s.integrations,
		// A provision failure's message can name the sandbox host — the very thing
		// withholding `sandbox_url` protects — so it rides the same grant.
		error:
			can.attach && s.error
				? appReadOnly
					? { code: 'APP_FAILED', message: 'The app could not start. Contact its owner.' }
					: s.error
				: undefined,
	};
}

/**
 * Sanitize a provisioning error into the `{ code, message }` persisted on a failed
 * session. A DomainError contributes its own code/message — ours, and scrubbed at
 * the throw site. Anything else is arbitrary upstream text (an SDK error, a
 * secret manager's response) that can carry credential material, so only its
 * class name survives; the full error still reaches the server-side log.
 */
function toSessionError(err: unknown): { code: string; message: string } {
	if (err instanceof DomainError) return { code: err.code, message: err.message };
	const e = err instanceof Error ? err : new Error(String(err));
	return { code: 'PROVISION_FAILED', message: `Failed to provision the sandbox (${e.name})` };
}

/**
 * The start gate — the `session.start` decision as a thrower, plus the session
 * classification: a viewer's admitted session is what
 * `MODE_POLICY[mode].viewerSession` says — their own ephemeral throwaway for
 * `edit`, a shared pool member for `app` (identical to an editor-started one,
 * with WIF credentials and integration secrets).
 */
export async function authorizeSessionStart(
	project: Project,
	user: AuthUser,
	mode: SessionMode,
	deps: AuthzDeps,
	notebookLabels: ResourceSecurityLabels | null = null,
): Promise<{
	role: Role | null;
	ephemeral: boolean;
	profileOverrideEligible: boolean;
	restrictedViewerCredentials: boolean;
	subjectContextExpiresAt?: string;
}> {
	const decision = await authorizationService(deps).authorize(user, 'session.start', {
		kind: 'session-start',
		project,
		mode,
		notebookLabels,
	});
	const role = decision.role;
	if (!decision.allowed) {
		// A security-label denial masks the project as nonexistent, matching the
		// read routes; role denials keep the canonical editor-gate 403
		// (session.start admits every editor+; the caller already 404'd a deleted
		// project).
		if (decision.category === 'constraint' || decision.category === 'credential-resource') {
			throw new NotFoundError(`Project ${project.id} not found`);
		}
		throw new ForbiddenError(`Requires 'editor' role on project ${project.id}`);
	}
	const ephemeral = role === 'viewer' && MODE_POLICY[mode].viewerSession === 'ephemeral';
	return {
		role,
		ephemeral,
		// The notebook's configured profile applies to every editor-or-higher session and
		// to any shared (non-ephemeral) session: a shared app is the notebook's app and
		// must provision identically no matter who starts it. Only a viewer's own
		// ephemeral throwaway is forced onto the deployment default.
		profileOverrideEligible: !ephemeral,
		restrictedViewerCredentials: ephemeral,
		...(decision.subjectContextExpiresAt !== undefined
			? { subjectContextExpiresAt: decision.subjectContextExpiresAt }
			: {}),
	};
}

async function recheckSessionAuthorization(
	project: Project,
	user: AuthenticatedPrincipal,
	mode: SessionMode,
	deps: AuthzDeps,
	labels: ResourceSecurityLabels | null,
	expected: { ephemeral: boolean; restrictedViewerCredentials: boolean },
) {
	const current = await authorizeSessionStart(project, user, mode, deps, labels);
	if (
		current.ephemeral !== expected.ephemeral ||
		current.restrictedViewerCredentials !== expected.restrictedViewerCredentials
	)
		throw new ForbiddenError('Session authorization changed during startup');
	return current;
}

/** The earlier of two ISO deadlines; undefined entries do not bound. */
function earliestDeadline(...deadlines: (string | undefined)[]): string | undefined {
	// Compare as instants, not strings: ISO timestamps with mixed fractional
	// seconds do not sort lexicographically ('…00.900Z' < '…00Z' as text).
	let earliest: string | undefined;
	for (const deadline of deadlines) {
		if (deadline === undefined) continue;
		if (earliest === undefined || Date.parse(deadline) < Date.parse(earliest)) {
			earliest = deadline;
		}
	}
	return earliest;
}

function entitlementAuthorizationDeadline(user: AuthUser): string | undefined {
	if (!user.entitlementsExpiresAt) {
		if (user.entitlements?.length || user.groups?.length) {
			throw new ForbiddenError('Group authorization has no credential expiry; sign in again');
		}
		return undefined;
	}
	const deadline = Date.parse(user.entitlementsExpiresAt);
	if (!Number.isFinite(deadline) || deadline <= Date.now()) {
		throw new ForbiddenError('Group authorization has expired; sign in again');
	}
	return new Date(deadline).toISOString();
}

function capsFor(
	deps: ApiDeps,
	mode: SessionMode,
	pid: ProjectId,
	userId: UserId,
	onSource?: (source: 'scan' | 'index') => void,
) {
	const { sessions } = deps.services;
	return admissionCaps(mode, deps.policy).map((cap) => ({
		...cap,
		queue: () =>
			cap.scope === 'project'
				? sessions.listActiveAppsForProject(pid)
				: sessions.listActiveForUser(
						userId,
						cap.scope === 'user-apps' ? 'project' : 'user',
						onSource,
					),
	}));
}

/** Preserve cap precedence even when a later queue fails. */
async function checkCapQueues(
	caps: ReturnType<typeof capsFor>,
	excludedSessionId: SessionId | undefined,
	check: (cap: { max: number; message: string; sessions: Session[] }) => void,
): Promise<void> {
	const results = await Promise.allSettled(
		caps.flatMap(({ max, message, queue }) => {
			if (!max || max <= 0) return [];
			return [
				Promise.resolve()
					.then(queue)
					.then((sessions) => ({
						max,
						message: message(max),
						sessions: sessions.filter((session) => session.session_id !== excludedSessionId),
					})),
			];
		}),
	);
	for (const result of results) {
		if (result.status === 'rejected') throw result.reason;
		check(result.value);
	}
}

/** Reuse bypasses cap checks; only project-local queues run before boot. */
async function enforceSessionCap(
	deps: ApiDeps,
	mode: SessionMode,
	pid: ProjectId,
	userId: UserId,
	excludedSessionId: SessionId | undefined,
): Promise<void> {
	const caps = capsFor(deps, mode, pid, userId).filter((cap) => cap.preflight);
	await checkCapQueues(caps, excludedSessionId, (cap) => {
		if (cap.sessions.length >= cap.max) throw new ResourceExhaustedError(cap.message);
	});
}

/**
 * Concurrent starts can pass preflight together. After creation, queue rank
 * admits the earliest sessions instead of rejecting every competing start.
 */
async function assertCapAfterCreate(
	deps: ApiDeps,
	mode: SessionMode,
	pid: ProjectId,
	userId: UserId,
	sessionId: SessionId,
	excludedSessionId?: SessionId,
	onSource?: (source: 'scan' | 'index') => void,
): Promise<void> {
	const caps = capsFor(deps, mode, pid, userId, onSource);
	await checkCapQueues(caps, excludedSessionId, (cap) => {
		assertAdmissionRank(cap.sessions, sessionId, cap.max, cap.message);
	});
}

const app = createApp();

function drainsDeferredWork(deps: ApiDeps): boolean {
	return deps.backgroundWork !== undefined && !deps.teardownInline;
}

/**
 * Notebook-override enforcement for session read paths: sessions of a notebook
 * whose security-label override the caller does not satisfy are
 * indistinguishable from nonexistent — they must not leak existence or a
 * kernel URL through listings. One meta read and one batched decision per
 * distinct notebook; an unreadable meta fails closed (hidden, not leaked).
 */
async function admittedSessionNotebooks(
	deps: ApiDeps,
	user: AuthUser,
	project: Project,
	notebookIds: readonly NotebookId[],
): Promise<Map<NotebookId, ResourceSecurityLabels | null>> {
	const distinct = [...new Set(notebookIds)];
	const states = await Promise.all(
		distinct.map(async (nid) => {
			try {
				return { nid, labels: await deps.services.notebooks.getSecurityLabels(project.id, nid) };
			} catch {
				return null;
			}
		}),
	);
	const admitted = new Map<NotebookId, ResourceSecurityLabels | null>(
		states.flatMap((state) => (state?.labels === null ? ([[state.nid, null]] as const) : [])),
	);
	const labeled = states.filter(
		(s): s is { nid: NotebookId; labels: ResourceSecurityLabels } =>
			s !== null && s.labels !== null,
	);
	if (labeled.length > 0) {
		const decisions = await authorizationService(deps).authorizeMany(
			user,
			'project.read',
			labeled.map((s) => ({ kind: 'project' as const, project, notebookLabels: s.labels })),
		);
		decisions.forEach((decision, index) => {
			if (decision.allowed) admitted.set(labeled[index].nid, labeled[index].labels);
		});
	}
	return admitted;
}

async function retireSelectedSession(
	deps: ApiDeps,
	selected: Session,
	options: { wait: boolean; thumbnail: 'skip' | 'bounded' } = { wait: true, thumbnail: 'skip' },
	known?: KnownObject<Session>,
): Promise<void> {
	const { sessions } = deps.services;
	const { project_id: pid, notebook_id: nid, session_id: sid } = selected;
	if (sessionPersistsEdits(selected)) {
		const requested = await sessions.requestStop(pid, sid);
		if (options.wait) {
			const result = await sessionRetirer(deps).stop(requested);
			if (result.stop?.outcome !== 'stopped' && !result.sandbox_reclaimed_at)
				throw new SessionPersistenceRequiredError();
		} else
			await deferTeardown(
				deps,
				'session.stop',
				async () => {
					await sessionRetirer(deps).stop(requested);
				},
				{ project_id: pid, session_id: sid },
			);
		return;
	}
	// Only the winner of the terminating transition performs teardown.
	const { session, transitioned } = await sessions.beginTerminating(pid, sid, undefined, known);
	let reclaimed = true;
	try {
		if (sessionMode(session) === 'app')
			await new AppPoolService(deps.bucket, sessions, deps.policy.appPool, deps.metrics).invalidate(
				pid,
				nid,
				sid,
			);
	} finally {
		// Reconciliation can recover the pool from the terminal session if invalidation fails.
		const retire = async () => {
			if (
				!transitioned &&
				isTerminal(session.status) &&
				session.sandbox_id &&
				!session.sandbox_reclaimed_at
			) {
				const outcome = await sessionRetirer(deps)
					.reclaim(session, { thumbnail: options.thumbnail })
					.catch(() => null);
				return outcome?.reclaimed ?? false;
			}
			await sessionRetirer(deps).retire(session, {
				teardown: transitioned,
				thumbnail: options.thumbnail,
			});
			return true;
		};
		if (options.wait) reclaimed = await retire();
		else
			await deferTeardown(
				deps,
				'session.stop',
				async () => {
					if (!(await retire())) {
						throw new UnavailableError('The session is still shutting down. Retry shortly.');
					}
				},
				{ project_id: pid, notebook_id: nid, session_id: sid },
			);
	}
	if (options.wait && (!reclaimed || (!transitioned && session.status === 'terminating'))) {
		throw new UnavailableError('The session is still shutting down. Retry shortly.');
	}
}

function withoutConnectionUrls(response: ReturnType<typeof toSessionResponse>) {
	return {
		...response,
		can: { ...response.can, attach: false },
		sandbox_url: undefined,
		links: undefined,
		surfaces:
			response.surfaces &&
			Object.fromEntries(
				Object.entries(response.surfaces).map(([id, surface]) => [
					id,
					{ ...surface, url: undefined },
				]),
			),
	};
}

export async function presentSession(
	deps: ApiDeps,
	user: AuthUser,
	session: Session,
	grants: Awaited<ReturnType<typeof sessionGrantsFor>>,
	poolView?: () => ReturnType<AppPoolService['view']> | undefined,
) {
	const response = toSessionResponse(session, grants, deps.theme?.session_links);
	try {
		await assertSessionPreviewActive(deps, session.project_id, session);
	} catch (error) {
		if (!(error instanceof NotFoundError)) throw error;
		return {
			...withoutConnectionUrls(response),
			can: { attach: false, stop: false, surfaces: surfaceGrants(false) },
		};
	}
	if (sessionMode(session) !== 'app') return response;
	const view = await (poolView?.() ??
		new AppPoolService(deps.bucket, deps.services.sessions, deps.policy.appPool, deps.metrics).view(
			session.project_id,
			session.notebook_id,
		));
	const access = view.canAccess(user.id, session.session_id, !session.app_pool);
	const member = view.members.get(session.session_id);
	return {
		...(access ? response : withoutConnectionUrls(response)),
		...(member && !grants.appReadOnly
			? { app_pool: { state: member.state, users: member.users, max_users: member.max_users } }
			: {}),
	};
}

app.openapi(listSessions, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	// Read-only project-scoped data, gated at `viewer` like the notebook-list route:
	// open when a default role is set, members-only under MARIMOHUB_DEFAULT_ROLE=none.
	// The project is loaded (not just visibility-checked) to gate each item's
	// kernel URL and `can` grants by the caller's role (see sessionGrantsFor).
	const project = await loadVisibleProject(projects, pid, user, deps);
	const active = await sessions.listActiveByProject(pid);
	const admitted = await admittedSessionNotebooks(
		deps,
		user,
		project,
		active.map(sessionResourceNotebookId),
	);
	const visible = active.filter((s) => admitted.has(sessionResourceNotebookId(s)));
	const pools = new AppPoolService(deps.bucket, sessions, deps.policy.appPool, deps.metrics);
	const poolViews = new Map<NotebookId, ReturnType<AppPoolService['view']>>();
	const viewFor = (session: Session) => {
		if (sessionMode(session) !== 'app') return;
		let view = poolViews.get(session.notebook_id);
		if (!view) {
			view = pools.view(pid, session.notebook_id);
			poolViews.set(session.notebook_id, view);
		}
		return view;
	};
	const responses = await Promise.all(
		visible.map(async (session) =>
			presentSession(
				deps,
				user,
				session,
				await sessionGrantsFor(
					project,
					user,
					session,
					deps,
					admitted.get(sessionResourceNotebookId(session)) ?? null,
				),
				() => viewFor(session),
			),
		),
	);
	const data = paginate(responses, c.req.valid('query'), {
		key: (s) => s.started_at,
		tiebreak: (s) => s.session_id,
	});
	return c.json({ success: true, data }, 200);
});

export async function loadAuthorizedSession(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	{ pid, nid, sid }: { pid: ProjectId; nid: NotebookId; sid: SessionId },
): Promise<{
	project: Project;
	session: Session;
	labels: ResourceSecurityLabels | null;
	appUser: boolean;
}> {
	// The project-scoped key masks cross-project IDs; also reject other notebooks.
	const project = await loadSessionProject(deps.services.projects, pid, user, deps);
	const session = await deps.services.sessions.getSession(pid, sid);
	if (sessionResourceNotebookId(session) !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}
	const appUser = authorizationService(deps).role(user, project) === 'app-user';
	const labels = await assertSessionNotebookVisible(deps, project, session, user, {
		requireActivePreview: false,
	});
	if (appUser) await assertSessionAccess(project, session, user, deps, labels);
	return { project, session, labels, appUser };
}

app.openapi(getSession, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	let { project, session, labels } = await loadAuthorizedSession(deps, user, c.req.valid('param'));
	const wait = c.req.valid('query').wait ?? 0;
	if (wait > 0 && session.status === 'starting') {
		await deps.services.sessions.waitForStartup(session, wait * 1000, c.req.raw.signal);
		({ project, session, labels } = await loadAuthorizedSession(deps, user, c.req.valid('param')));
	}
	return c.json(
		{
			success: true,
			data: await presentSession(
				deps,
				user,
				session,
				await sessionGrantsFor(project, user, session, deps, labels),
			),
		},
		200,
	);
});

const EDITOR_ACTIVITY_MAX_AGE_MS = 30_000;

function cachedEditorActivity(session: Session) {
	if (
		session.status !== 'running' ||
		!session.sandbox_id ||
		session.active_connections === undefined ||
		!session.connections_checked_at
	)
		return;
	const age = Date.now() - Date.parse(session.connections_checked_at);
	if (!(age >= 0 && age < EDITOR_ACTIVITY_MAX_AGE_MS)) return;
	return {
		state: session.active_connections > 0 ? ('active' as const) : ('idle' as const),
		active_connections: session.active_connections,
		checked_at: session.connections_checked_at,
	};
}

async function inspectEditorActivity(deps: ApiDeps, session: Session) {
	if (session.status === 'starting') return { state: 'starting' as const };
	if (session.status !== 'running' || !session.sandbox_id) {
		return { state: 'unknown' as const };
	}
	const basePath = localKernelBasePath(session);
	const active = await kernelActiveConnections(
		sessionSandbox(deps.compute, session, deps.metrics, 'poll'),
		basePath,
	).catch((error: unknown) => {
		if (error instanceof NotFoundError) return null;
		throw error;
	});
	const checkedAt = new Date().toISOString();
	if (active === null) return { state: 'unknown' as const, checked_at: checkedAt };
	await deps.services.sessions
		.markConnections(session.project_id, session.session_id, active, checkedAt)
		.catch(() => {});
	return {
		state: active > 0 ? ('active' as const) : ('idle' as const),
		active_connections: active,
		checked_at: checkedAt,
	};
}

export async function getEditorSessionState(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	pid: ProjectId,
	nid: NotebookId,
) {
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'notebook.write',
		deps,
	);
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'notebook.write');
	const claim = await deps.services.sessions.getEditorClaim(pid, nid);
	const sharing = effectiveEditorSharing(claim, deps.policy.editorSandboxSharing);
	const claimedSession = claim?.session_id
		? await deps.services.sessions.getSession(pid, claim.session_id).catch(() => null)
		: undefined;
	// A terminal session is a stale claim, not a holder eligible for takeover.
	const holder =
		claimedSession &&
		(claimedSession.status === 'starting' ||
			claimedSession.status === 'running' ||
			claimedSession.status === 'terminating')
			? { ...claimedSession, status: claimedSession.status }
			: null;
	const holderView = holder
		? {
				session_id: holder.session_id,
				user_id: holder.user_id,
				status: holder.status,
				started_at: holder.started_at,
				activity:
					holder.user_id === user.id
						? { state: holder.status === 'starting' ? ('starting' as const) : ('unknown' as const) }
						: (cachedEditorActivity(holder) ?? (await inspectEditorActivity(deps, holder))),
			}
		: null;
	return {
		sharing,
		holder: holderView,
		can_take_over:
			sharing === 'exclusive' && !!holder && holder.user_id !== user.id && !claim?.transfer,
		...(claim?.transfer ? { transfer: { status: claim.transfer.phase } } : {}),
	};
}

app.openapi(getEditorSession, async (c) => {
	const { pid, nid } = c.req.valid('param');
	const data = await getEditorSessionState(c.get('deps'), c.get('user'), pid, nid);
	return c.json({ success: true, data }, 200);
});

export async function takeOverNotebookEditor(input: {
	deps: ResolvedApiDeps;
	user: AuthenticatedPrincipal;
	pid: ProjectId;
	nid: NotebookId;
	body: z.infer<typeof TakeoverBodySchema>;
	request: { requestId?: string; method: string; path: string };
}): Promise<void> {
	const { deps, user, pid, nid, body, request } = input;
	const startedAt = Date.now();
	const observer = logObserver({
		event: 'session_takeover',
		takeover_id: body.takeover_id,
		project_id: pid,
		notebook_id: nid,
		user_id: user.id,
		expected_holder_session_id: body.expected_holder_session_id,
		expected_activity: body.expected_activity,
	});
	let failed = false;
	const audit = (event: string) =>
		appendAudit(deps, { ...request, userId: user.id }, event, () =>
			deps.services.events.append({
				event,
				actor: user.id,
				project_id: pid,
				notebook_id: nid,
				session_id: body.expected_holder_session_id,
				takeover_id: body.takeover_id,
			}),
		);
	const assertAccess = async () => {
		const project = await assertProjectRole(
			deps.services.projects,
			pid,
			user,
			'notebook.write',
			deps,
		);
		const notebook = await loadAuthorizedNotebookMeta(deps, project, nid, user, 'notebook.write');
		return { project, notebook };
	};
	try {
		const subject = await assertAccess();
		const currentClaim = await deps.services.sessions.getEditorClaim(pid, nid);
		if (effectiveEditorSharing(currentClaim, deps.policy.editorSandboxSharing) !== 'exclusive') {
			throw new ConflictError('Takeover is only available in exclusive editor mode');
		}
		assertNotificationMutationAllowed(deps, user.id);
		let holderIdentity: Awaited<ReturnType<typeof deps.services.identities.get>> | undefined;
		let holder: Session | undefined;
		const reserved = await deps.services.sessions.reserveTakeoverWithOutcome(pid, nid, {
			takeoverId: body.takeover_id,
			requestedBy: user.id,
			expectedHolder: body.expected_holder_session_id,
			expectedActivity: body.expected_activity,
		});
		const claim = reserved.value;
		if (reserved.written) {
			holder = await deps.services.sessions.getSession(pid, claim.session_id!);
			holderIdentity = await deps.services.identities.get(holder.user_id).catch(() => null);
			assertNotificationMutationAllowed(deps, user.id, {
				recipient: holderIdentity?.email ?? holder.user_id,
				recipientScope: pid,
				consumeActor: false,
			});
		}
		observer.tag('phase', claim.transfer?.phase ?? 'changed');
		await audit('session.takeover.request');
		const notifyTakeover = (holderUserId: UserId) => {
			const rendered = Promise.resolve().then(() => {
				return notificationRouter.render({
					kind: 'session.takeover',
					project: subject.project,
					notebookTitle: subject.notebook.title,
					projectId: pid,
					notebookId: nid,
					takeoverId: body.takeover_id,
					displacedUserId: holderUserId,
					recipient: recipientFromIdentity(holderIdentity),
					actor: user,
					baseUrl: deps.sandbox.appBaseUrl,
				});
			});
			const render = () => rendered;
			scheduleNotification(
				deps,
				'session.takeover',
				{ project_id: pid, notebook_id: nid, takeover_id: body.takeover_id },
				render,
			);
			scheduleProjectAlert(
				deps,
				pid,
				'session.takeover',
				{ project_id: pid, notebook_id: nid, takeover_id: body.takeover_id },
				render,
			);
		};
		if (claim.transfer?.phase === 'ready') {
			await audit('session.takeover.success');
			return;
		}
		holder ??= await deps.services.sessions.getSession(pid, claim.session_id!);
		if (holderIdentity === undefined) {
			holderIdentity = await deps.services.identities.get(holder.user_id).catch(() => null);
		}
		if (claim.transfer?.phase === 'draining') {
			try {
				const completed = await sessionRetirer(deps).completeTakeoverDrain(
					holder,
					body.takeover_id,
					crypto.randomUUID(),
				);
				if (!completed) throw new ConflictError('Another request owns the takeover drain lease');
				await audit('session.takeover.success');
				notifyTakeover(holder.user_id);
				return;
			} catch (err) {
				if (err instanceof ConflictError) throw err;
				logEvent({
					level: 'error',
					event: 'session_takeover_drain_failed',
					project_id: pid,
					notebook_id: nid,
					takeover_id: body.takeover_id,
					error: errorMetadata(err),
				});
				throw new UnavailableError(
					'The prior editor is still shutting down; retry this takeover shortly',
				);
			}
		}
		if (holder.notebook_id !== nid || holder.user_id === user.id || holder.ephemeral) {
			await deps.services.sessions.cancelRequestedTakeover(pid, nid, body.takeover_id);
			throw new ConflictError('The selected session cannot be taken over');
		}
		const activity = await inspectEditorActivity(deps, holder);
		observer.tag('activity', activity.state);
		observer.tag(
			'active_connections',
			'active_connections' in activity ? activity.active_connections : null,
		);
		if (activity.state !== body.expected_activity) {
			await deps.services.sessions.cancelRequestedTakeover(pid, nid, body.takeover_id);
			throw new EditSessionChangedError(
				'The current editor activity changed; refresh and confirm the takeover again',
			);
		}
		await assertAccess();
		try {
			await sessionRetirer(deps).retireForTakeover(holder, user.id);
			await deps.services.sessions.setTakeoverPhase(pid, nid, body.takeover_id, 'ready');
		} catch (err) {
			// Only the pre-drain lease race surfaces as a 409; once the drain has
			// started, even a ConflictError cause must fall through to the phase
			// bookkeeping and log below, or the persisted takeover state goes stale.
			if (
				err instanceof TakeoverRetirementError &&
				err.cause instanceof ConflictError &&
				!err.drainStarted
			) {
				throw err.cause;
			}
			if (err instanceof TakeoverRetirementError && err.drainStarted) {
				await deps.services.sessions
					.setTakeoverPhase(pid, nid, body.takeover_id, 'draining')
					.catch(() => {});
			} else {
				await deps.services.sessions.cancelRequestedTakeover(pid, nid, body.takeover_id);
			}
			logEvent({
				level: 'error',
				event: 'session_takeover_retirement_failed',
				project_id: pid,
				notebook_id: nid,
				takeover_id: body.takeover_id,
				error: errorMetadata(err instanceof TakeoverRetirementError ? err.cause : err),
			});
			throw new UnavailableError(
				'Could not safely save and stop the current editor; no replacement was started',
			);
		}
		await audit('session.takeover.success');
		notifyTakeover(holder.user_id);
		return;
	} catch (err) {
		failed = true;
		await deps.services.sessions
			.cancelRequestedTakeover(pid, nid, body.takeover_id)
			.catch(() => {});
		observer.tag('error', err instanceof Error ? err.name : 'unknown');
		await audit('session.takeover.failure');
		throw err;
	} finally {
		observer.tag('success', !failed);
		observer.tag('duration_ms', Date.now() - startedAt);
		observer.flush();
	}
}

app.openapi(takeoverEditorSession, async (c) => {
	const { pid, nid } = c.req.valid('param');
	await takeOverNotebookEditor({
		deps: c.get('deps'),
		user: c.get('user'),
		pid,
		nid,
		body: c.req.valid('json'),
		request: { requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
	});
	return c.json({ success: true }, 200);
});

export type SessionCreateBody = z.infer<typeof SessionCreateBodySchema>;
export type SessionCreateResult = z.infer<typeof SessionCreateResponseSchema>;

const EDITOR_STOP_WAIT_MS = 10_000;

class StartupCompletionRejectedError extends ConflictError {
	override readonly name = 'StartupCompletionRejectedError';
	constructor(readonly reason: 'claim' | 'expiry') {
		super(
			reason === 'claim'
				? 'The editor claim changed during startup'
				: 'The prepared runtime has expired',
		);
	}
}

async function rejectStartupCompletion(
	deps: ApiDeps,
	session: Session,
	expected: { sandbox_id: NonNullable<Session['sandbox_id']>; id?: string },
	error: unknown,
): Promise<void> {
	const { sessions } = deps.services;
	if (
		await sessions.rejectStartupCompletion(
			session.project_id,
			session.session_id,
			error instanceof StartupCompletionRejectedError && error.reason === 'expiry'
				? { ...expected, status: 'starting' }
				: expected,
			toSessionError(error),
		)
	) {
		await sessionRetirer(deps).reclaim(
			await sessions.getSession(session.project_id, session.session_id),
			{ thumbnail: 'skip' },
		);
	}
}

function canRecoverStartup(session: Session): boolean {
	return (
		sessionMode(session) === 'edit' && !session.ephemeral && !session.origin && !session.app_pool
	);
}

async function validateStartupCompletion(
	deps: ResolvedApiDeps,
	user: AuthenticatedPrincipal,
	session: Session,
): Promise<void> {
	if (
		isPastAuthorizationDeadline(session, Date.now()) ||
		(user.credential.expiresAt && Date.parse(user.credential.expiresAt) <= Date.now())
	)
		throw new ForbiddenError('Session authorization expired during startup');
	entitlementAuthorizationDeadline(user);
	if (
		session.status === 'starting' &&
		[session.startup_completion?.expires_at, session.startup_completion?.sandbox_deadline_at].some(
			(at) => at !== undefined && Date.parse(at) <= Date.now(),
		)
	)
		throw new StartupCompletionRejectedError('expiry');
	const { projects, notebooks, sessions, identities } = deps.services;
	const [project, notebook, claim, suspended] = await Promise.all([
		projects.getProject(session.project_id, { consistency: 'validated' }),
		notebooks.getNotebookMeta(session.project_id, session.notebook_id, {
			consistency: 'validated',
		}),
		sessions.getEditorClaim(session.project_id, session.notebook_id),
		identities.get(user.id).then((identity) => identity?.suspended_at !== undefined),
	]);
	if (claim?.session_id !== session.session_id || claim.transfer)
		throw new StartupCompletionRejectedError('claim');
	if (project.status === 'deleted')
		throw new NotFoundError(`Project ${session.project_id} not found`);
	if (notebook.status === 'deleted')
		throw new NotFoundError(`Notebook ${session.notebook_id} not found`);
	if (suspended) throw new ForbiddenError('The session owner is suspended');

	const authorization = await recheckSessionAuthorization(
		project,
		user,
		'edit',
		deps,
		notebook.security_labels ?? null,
		{
			ephemeral: false,
			restrictedViewerCredentials: !!session.restricted_viewer_credentials,
		},
	);
	const deadline = earliestDeadline(
		user.credential.expiresAt,
		user.entitlementsExpiresAt,
		authorization.subjectContextExpiresAt,
	);
	if (deadline)
		await sessions.tightenAuthorizationDeadline(session.project_id, session.session_id, deadline);
}

/** The caller supplies a freshly authenticated principal; stored receipts carry no authorization. */
export async function recoverNotebookSessionStart(input: {
	deps: ResolvedApiDeps;
	user: AuthenticatedPrincipal;
	pid: ProjectId;
	sid: SessionId;
}): Promise<Session> {
	const session = await input.deps.services.sessions.getSessionWithEtag(input.pid, input.sid);
	return completeNotebookSessionStart(input, session, { verifyRuntime: true });
}

async function completeNotebookSessionStart(
	{ deps, user }: Pick<Parameters<typeof recoverNotebookSessionStart>[0], 'deps' | 'user'>,
	prepared: KnownObject<Session>,
	{ verifyRuntime }: { verifyRuntime: boolean },
): Promise<Session> {
	const { sessions } = deps.services;
	const session = prepared.value;
	const { project_id: pid, session_id: sid } = session;
	const receipt = session.startup_completion;
	if (!receipt || !canRecoverStartup(session))
		throw new ConflictError('Session startup has no recoverable completion');
	if (!deps.compute.connectExisting)
		throw new UnavailableError('The compute provider cannot reconnect to this runtime');
	// A different caller cannot invalidate the owner's pending launch.
	if (session.user_id !== user.id)
		throw new ForbiddenError('Only the session owner can complete startup');
	try {
		if (verifyRuntime) {
			await validateStartupCompletion(deps, user, session);
			const existing = reconnectSessionSandbox(
				deps.compute,
				session,
				deps.metrics,
				'startup_recovery',
			)!;
			if (existing.ready) await existing.ready();
			else if (!(await existing.exec('true')).success)
				throw new UnavailableError('The prepared runtime is unavailable');
			if ((await deps.kernelProbe(receipt.sandbox_origin_url ?? receipt.sandbox_url)) !== 'alive')
				throw new UnavailableError('The prepared runtime is not ready. Retry shortly.');
			await validateStartupCompletion(deps, user, session);
		}
		const updated = await sessions
			.completeStartup(pid, sid, receipt.id, prepared)
			.catch((error: unknown) => {
				throw error instanceof StartupCompletionExpiredError
					? new StartupCompletionRejectedError('expiry')
					: error;
			});
		await validateStartupCompletion(deps, user, updated);
		return updated;
	} catch (error) {
		if (
			error instanceof ForbiddenError ||
			error instanceof NotFoundError ||
			error instanceof StartupCompletionRejectedError
		) {
			await rejectStartupCompletion(deps, session, receipt, error);
		}
		throw error;
	}
}

export async function startNotebookSession(input: {
	onProgress?: (progress: SandboxStartupSnapshot) => void;
	onAuthorized?: () => void;
	deps: ResolvedApiDeps;
	user: AuthenticatedPrincipal;
	pid: ProjectId;
	nid: NotebookId;
	body: SessionCreateBody | undefined;
	preview?: { id: PreviewId; notebook_id: NotebookId };
	request: {
		requestId?: string;
		method: string;
		path: string;
		hostname: string;
		appBaseUrl: string;
		via?: 'mcp' | 'rest';
		signal?: AbortSignal;
	};
}): Promise<SessionCreateResult> {
	const startedAt = Date.now();
	let authReuseMs = 0;
	let provisionAttempted = false;
	let stopWaitMs = 0;
	const observer = logObserver({
		event: 'session_provision',
		client: sessionClientFor(input.user.credential.kind, input.request.via ?? 'rest'),
		project_id: input.pid,
		notebook_id: input.nid,
		user_id: input.user.id,
		mode: input.body?.mode ?? 'edit',
	});
	const start = async () => {
		const attemptStarted = Date.now();
		let authFinishedAt: number | undefined;
		try {
			return await startNotebookSessionOnce(
				input,
				() => {
					provisionAttempted = true;
					return observer;
				},
				() => {
					authFinishedAt = Date.now();
				},
			);
		} finally {
			authReuseMs += (authFinishedAt ?? Date.now()) - attemptStarted;
		}
	};
	const waitForStop = async (error: EditSessionRetiringError) => {
		const { sessions } = input.deps.services;
		const { pid, nid, user, request } = input;
		const claim = await sessions.getEditorClaim(pid, nid);
		if (claim?.transfer) throw error;
		if (!claim?.session_id) return;
		const holder = await sessions.getSession(pid, claim.session_id).catch((readError: unknown) => {
			if (readError instanceof NotFoundError) return null;
			throw readError;
		});
		if (!holder) return;
		if (holder.user_id !== user.id || holder.status !== 'terminating') throw error;

		const waitStarted = Date.now();
		const deadline = waitStarted + EDITOR_STOP_WAIT_MS;
		try {
			while (Date.now() < deadline) {
				await input.deps.sleep(Math.min(500, deadline - Date.now()), request.signal);
				const current = await sessions.getEditorClaim(pid, nid);
				if (
					current?.transfer ||
					current?.session_id !== claim.session_id ||
					!(await sessions.isClaimRetiring(pid, nid, user.id, { claim: current }))
				)
					return;
			}
			throw error;
		} finally {
			stopWaitMs = Date.now() - waitStarted;
		}
	};
	try {
		const result = await start().catch(async (error: unknown) => {
			if (!(error instanceof EditSessionRetiringError)) throw error;
			await waitForStop(error);
			// Stop can save a new snapshot, so the retry must repeat admission and reads.
			return start();
		});
		observer.tag('success', true);
		observer.tag('reused', result.reused);
		observer.tag('session_id', result.session_id);
		return result;
	} catch (error) {
		observer.tag('success', false);
		observer.tag('error', error instanceof Error ? error.name : 'unknown');
		throw error;
	} finally {
		observer.tag('auth_reuse_ms', authReuseMs);
		observer.tag('stop_wait_ms', stopWaitMs);
		observer.tag('total_ms', Date.now() - startedAt);
		if (provisionAttempted) observer.flush();
	}
}

async function startNotebookSessionOnce(
	input: Parameters<typeof startNotebookSession>[0],
	observeProvision: () => ReturnType<typeof logObserver>,
	recordAuthReuse: () => void,
): Promise<SessionCreateResult> {
	input.request.signal?.throwIfAborted();
	const { deps, user, pid, nid, body, request } = input;
	const { sessions, projects, notebooks } = deps.services;
	const mode: SessionMode = body?.mode ?? 'edit';
	const onProgress = mode === 'edit' ? input.onProgress : undefined;
	if ((body?.app_visit_id || body?.replace_app_session_id) && mode !== 'app')
		throw new BadRequestError('App visit and replacement options are only valid for app sessions');

	if (body?.replace_app_session_id && body.app_visit_id)
		throw new BadRequestError('Replacement does not admit a visit. Open the app separately.');

	// Consume notebook errors after authorization so role denials retain their 403.
	const notebookRead = notebooks.getNotebook(pid, nid);
	notebookRead.catch(() => {});
	// A soft-deleted project's bytes linger until GC, but no new kernel may serve them.
	const project = await projects.getProject(pid, { consistency: 'validated' });
	if (project.status === 'deleted') {
		throw new NotFoundError(`Project ${pid} not found`);
	}
	let authorization = await authorizeSessionStart(project, user, mode, deps);
	const appUser = authorization.role === 'app-user';
	if (
		appUser &&
		(body?.compute_profile !== undefined ||
			body?.edit_intent !== undefined ||
			(body?.surfaces?.length ?? 0) > 0)
	) {
		throw new ForbiddenError('App users cannot customize sessions');
	}
	// Only admitted callers learn whether the notebook exists.
	// Deleted notebooks remain readable until GC. New sessions must not serve
	// their content or recreate app-pool claims after deletion cleanup.
	const notebook = await notebookRead;
	if (
		notebook.meta.preview &&
		(input.preview?.id !== notebook.meta.preview.preview_id ||
			input.preview?.notebook_id !== notebook.meta.preview.notebook_id)
	)
		throw new NotFoundError('Notebook not found');
	const isPreview = !!notebook.meta.preview;
	if (notebook.meta.status === 'deleted') {
		throw new NotFoundError(`Notebook ${nid} not found`);
	}
	if (notebook.meta.security_labels !== undefined) {
		authorization = await authorizeSessionStart(
			project,
			user,
			mode,
			deps,
			notebook.meta.security_labels,
		);
	}
	const previewRecord = isPreview
		? await deps.services.previews.get(
				pid,
				notebook.meta.preview!.notebook_id,
				notebook.meta.preview!.preview_id,
			)
		: undefined;
	if (previewRecord && !previewAvailable(previewRecord))
		throw new NotFoundError('Preview not found');
	input.onAuthorized?.();
	// Sessions must end before their credentials, security context, or preview expires.
	const authorizationExpiresAt = earliestDeadline(
		entitlementAuthorizationDeadline(user),
		earliestDeadline(authorization.subjectContextExpiresAt, previewRecord?.expires_at ?? undefined),
	);
	const existingEditorClaim = mode === 'edit' ? await sessions.getEditorClaim(pid, nid) : undefined;
	const sharing = isPreview
		? 'exclusive'
		: effectiveEditorSharing(existingEditorClaim, deps.policy.editorSandboxSharing);
	const replacingAfterTakeover =
		existingEditorClaim?.transfer?.phase === 'ready' &&
		existingEditorClaim.transfer.requested_by === user.id;
	const editorTemporary =
		mode === 'edit' &&
		body?.edit_intent === 'temporary' &&
		roleAtLeast(authorization.role, 'editor');
	if (body?.edit_intent && mode !== 'edit') {
		throw new BadRequestError('edit_intent is only valid for edit sessions');
	}
	if (editorTemporary && sharing === 'shared') {
		throw new BadRequestError('Temporary editor sessions are only available in exclusive mode');
	}
	const ephemeral = authorization.ephemeral || editorTemporary || (isPreview && mode === 'edit');
	const { compute, bucket: bucketHandle, sandbox } = deps;
	const workspacePolicy = workspaceSourcePolicy(notebook.source);
	const syncedVersionId = workspacePolicy.persistSessionEdits
		? undefined
		: notebook.source.current_version_id;
	const unsyncedSource = !workspacePolicy.persistSessionEdits && !syncedVersionId;
	const grants = (session: SessionAdmissionRecord) =>
		sessionGrantsFor(project, user, session, deps, notebook.meta.security_labels ?? null);
	const surfaceGrantRead = grants({
		mode,
		ephemeral,
		user_id: user.id,
		editor_sandbox_sharing: sharing,
	});
	// Unsynced notebooks must fail validation before any session scan.
	const editorReuseRead =
		mode === 'edit' && !unsyncedSource
			? sessions.findReusableEditor(pid, nid, user.id, sharing, ephemeral, {
					claim: existingEditorClaim,
				})
			: Promise.resolve(undefined);
	const readRestoreSnapshot = () =>
		!ephemeral && workspacePolicy.restoreFilesystemSnapshot
			? resolveRestoreSnapshot(compute, notebooks, pid, nid, {
					sharing: mode === 'edit' ? sharing : 'shared',
					userId: user.id,
				})
			: Promise.resolve(undefined);
	const restoreSnapshotRead = readRestoreSnapshot();
	for (const read of [surfaceGrantRead, editorReuseRead, restoreSnapshotRead]) read.catch(() => {});
	const surfaceGrant = (await surfaceGrantRead).surface;
	const requestedSurfaces = body?.surfaces ?? [];
	if (requestedSurfaces.length > 0 && mode !== 'edit') {
		throw new BadRequestError('Session surfaces are only valid for edit sessions');
	}
	if (requestedSurfaces.length > 0 && !surfaceGrant) {
		throw new SurfaceForbiddenError();
	}
	for (const id of requestedSurfaces) {
		surfaceConfig(deps, id);
	}
	const userHome =
		!isPreview &&
		mode === 'edit' &&
		sharing === 'exclusive' &&
		roleAtLeast(authorization.role, 'editor')
			? deps.sandbox.userHome?.resolve(user)
			: undefined;
	const profileOverrideEligible = authorization.profileOverrideEligible;
	const restrictedViewerCredentials = authorization.restrictedViewerCredentials;
	const tightenAuthorizationDeadline = (session: Session) =>
		authorizationExpiresAt
			? sessions.tightenAuthorizationDeadline(pid, session.session_id, authorizationExpiresAt)
			: Promise.resolve(session);
	const revalidateEditorReuse = async (session: Session) => {
		const current = await sessions.getReusableEditor(pid, session.session_id);
		if (!current) {
			throw new EditSessionRetiringError();
		}
		if (isPastAuthorizationDeadline(current, Date.now())) {
			throw new ConflictError('The editor session authorization expired. Retry shortly.');
		}
		return current;
	};

	if (unsyncedSource) {
		throw new ConflictError('Synced notebook has not been synced yet');
	}
	const notebookPaths = paths.project(pid).notebook(nid);
	const syncedVersionPaths = syncedVersionId ? notebookPaths.version(syncedVersionId) : undefined;
	const workspacePrefix = syncedVersionPaths?.workspacePrefix;
	const workspaceArchive = syncedVersionPaths?.workspaceArchive;
	const pullSourceGit = pullSourceGitOptions(notebook.source, syncedVersionPaths);
	const workspaceDir = sessionWorkspaceDir(notebook.source, deps.sandbox.workdir);
	// Apps and synced notebooks retain their source version so clients can detect stale sessions.
	const sourceVersionId =
		syncedVersionId ??
		(MODE_POLICY[mode].persistsEdits
			? undefined
			: (notebook.source.current_version_id ?? undefined));
	const origin: Session['origin'] =
		previewRecord && sourceVersionId && notebook.source.type === 'git' && notebook.source.commit
			? {
					type: 'preview',
					notebook_id: previewRecord.notebook_id,
					preview_id: previewRecord.id,
					revision_id: sourceVersionId,
					commit: notebook.source.commit,
				}
			: undefined;
	if (isPreview && !origin) throw new ConflictError('Preview revision provenance is unavailable');
	let launchSource = resolveNotebookLaunchSource({
		entryNotebook: workspacePolicy.entryNotebook,
		workspacePrefix: workspacePrefix ?? notebookPaths.workspacePrefix,
		localVersion:
			notebook.source.type === 'local'
				? notebookPaths.version(sourceVersionId ?? notebook.source.current_version_id)
				: undefined,
		localCapture:
			notebook.source.type === 'local'
				? notebook.source.publication?.versions.find(
						(version) =>
							version.version_id === (sourceVersionId ?? notebook.source.current_version_id),
					)
				: undefined,
	});
	const logStoredConfigFallback = (config: 'base_image' | 'compute_profile') =>
		logEvent({
			level: 'warn',
			event: 'stored_config_fallback',
			request_id: request.requestId ?? null,
			config,
			project_id: pid,
			notebook_id: nid,
			reason: 'selection_unavailable',
			recovered: true,
		});

	const sandboxExposure = sandbox.exposure;
	const hostname = sandbox.hostname || request.hostname;
	const { appBaseUrl } = request;
	const finalizeSurfaces = async (
		current: Session,
		{
			includeEager,
			contextPublication,
		}: { includeEager: boolean; contextPublication?: Promise<void> },
	): Promise<Session> => {
		if (mode !== 'edit' || !surfaceGrant || current.status !== 'running') return current;
		const ids = SECONDARY_SURFACE_IDS.filter((id) => {
			const config = sandbox.surfaces?.[id];
			return (
				config && ((includeEager && config.start === 'eager') || requestedSurfaces.includes(id))
			);
		});
		if (ids.length === 0) return current;
		// Surfaces consume the context file when the launching replica is still publishing it.
		await contextPublication;
		return beginSessionSurfaces({
			deps,
			session: current,
			user,
			ids,
			workspaceDir,
			exposure: sandboxExposure,
			hostname,
			appBaseUrl,
		});
	};
	const image = resolveBaseImage(notebook.meta.base_image, sandbox.images ?? [], () =>
		logStoredConfigFallback('base_image'),
	);
	const retryWithDefault = mode === 'edit' && body?.compute_profile === 'default';
	let selectedComputeProfile = isPreview
		? (notebook.meta.compute_profile ?? sandbox.previewComputeProfile)
		: storedComputeProfile(notebook.meta, sandbox, mode);
	if (body?.compute_profile !== undefined && body.compute_profile !== 'default') {
		if (mode !== 'edit' || !profileOverrideEligible) {
			throw new ForbiddenError('Compute profile selection requires a persistent edit session');
		}
		selectedComputeProfile = checkComputeProfile(sandbox, body.compute_profile) ?? undefined;
	}
	const requestedComputeProfile = resolveComputeProfile(
		sandbox,
		retryWithDefault ? undefined : selectedComputeProfile,
		isPreview || (sandbox.computeProfileOverride === 'editors' && profileOverrideEligible),
		() => logStoredConfigFallback('compute_profile'),
		isPreview ? undefined : mode,
	);
	const provisioner = new SandboxProvisioner(compute);

	const editorReuse = await editorReuseRead;
	if (editorReuse?.takeoverInProgress) throw new TakeoverInProgressError();
	if (editorReuse?.ownedByOther) {
		throw new EditSessionOwnedError(
			`Editing is currently owned by ${editorReuse.ownedByOther.user_id}`,
		);
	}
	const appPool = new AppPoolService(
		deps.bucket,
		sessions,
		isPreview ? previewAppPoolPolicy(deps.policy.appPool) : deps.policy.appPool,
		deps.metrics,
	);
	if (mode === 'app' && !sourceVersionId)
		throw new ConflictError('The app has no committed version');

	let replacementTarget: Session | undefined;
	if (body?.replace_app_session_id) {
		const target = await sessions.getSession(pid, body.replace_app_session_id);
		if (target.notebook_id !== nid || sessionMode(target) !== 'app')
			throw new NotFoundError('App session not found');
		await assertSessionControl(project, target, user, deps, notebook.meta.security_labels ?? null);
		replacementTarget = target;
	}
	const admissionInput = {
		projectId: pid,
		notebookId: nid,
		userId: user.id,
		versionId: sourceVersionId!,
		// The startup timeout bounds only the kernel-port wait, not cold boot, image pull,
		// or workspace restore, and nothing renews this reservation while a start runs.
		startupMs: Math.max((sandbox.startupTimeoutMs ?? 0) + 30_000, 900_000),
		readSession: true,
	};
	const admitApp = () =>
		body?.replace_app_session_id
			? appPool.replace({ ...admissionInput, replacesSessionId: body.replace_app_session_id })
			: appPool.admit({ ...admissionInput, visitId: body?.app_visit_id });
	const pace = deps.sleep;
	const admitWithRetry = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await admitApp();
			} catch (error) {
				if (!(error instanceof ConflictError) || !(error.cause instanceof PreconditionFailedError))
					throw error;
				if (attempt === 3)
					throw new UnavailableError('The app is busy. Retry shortly.', { cause: error });
				await pace(jitteredBackoff(attempt, { baseMs: 250, capMs: 2000, jitter: 1 }));
			}
		}
	};
	const admission = mode === 'app' ? await admitWithRetry() : undefined;
	const appAssignment = admission?.assignment
		? { visit_id: body?.app_visit_id ?? 'api', generation: admission.assignment.generation }
		: undefined;
	const reusableApp = async () => {
		if (admission?.kind !== 'reuse') return;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				const session =
					attempt === 0
						? admission.session
						: await sessions.getSession(pid, admission.member.session_id);
				if (session) {
					if (session.status !== 'running' && session.status !== 'starting')
						throw new ConflictError('The app session ended. Retry shortly.');
					return session;
				}
			} catch (error) {
				if (!(error instanceof NotFoundError)) throw error;
			}
			await pace(jitteredBackoff(attempt, { baseMs: 50, capMs: 200, jitter: 0.5 }));
		}
		throw new UnavailableError('The app is starting. Retry shortly.');
	};
	const reusableCandidate = mode === 'edit' ? editorReuse?.session : await reusableApp();
	if (reusableCandidate) {
		if (previewRecord) {
			const current = await deps.services.previews.get(
				pid,
				previewRecord.notebook_id,
				previewRecord.id,
			);
			if (
				!previewAvailable(current) ||
				!current.revisions.some(
					(revision) => revision.notebook_id === nid && revision.state === 'ready',
				)
			)
				throw new NotFoundError('Preview not found');
		}
		const [reusableTightened, reusableGrants] = await Promise.all([
			tightenAuthorizationDeadline(reusableCandidate),
			grants(reusableCandidate),
		]);
		let reusable = reusableTightened;
		let recoveredStartup = false;
		if (
			reusable.status === 'starting' &&
			reusable.startup_completion &&
			canRecoverStartup(reusable) &&
			reusable.user_id === user.id
		) {
			reusable = await recoverNotebookSessionStart({ deps, user, pid, sid: reusable.session_id });
			recoveredStartup = true;
		}
		const authorizationExpired = isPastAuthorizationDeadline(reusable, Date.now());
		// Role changes must not reuse a kernel with the previous credential policy.
		const classMismatch =
			!!reusable.ephemeral !== ephemeral ||
			(mode === 'edit' &&
				(reusable.restricted_viewer_credentials === true) !== restrictedViewerCredentials);
		// Reuse does not grant control: a failed probe must not let a viewer
		// tear down another caller's app.
		const mayRetire = reusableGrants.stop;
		// Recovery already probed this runtime; ordinary reuse still needs a liveness check.
		const kernelUrl =
			!recoveredStartup && mayRetire && reusable.status === 'running' && reusable.sandbox_id
				? (reusable.sandbox_origin_url ?? reusable.sandbox_url)
				: undefined;
		const dead = !!kernelUrl && (await deps.kernelProbe(kernelUrl)) === 'dead';
		if (!authorizationExpired && (!mayRetire || (!dead && !classMismatch))) {
			reusable = await finalizeSurfaces(reusable, { includeEager: recoveredStartup });
			// Probing and surface startup can overlap a stop or an authorization update.
			if (mode === 'edit') reusable = await revalidateEditorReuse(reusable);
			const response = toSessionResponse(reusable, reusableGrants, deps.theme?.session_links);
			return {
				...(body?.replace_app_session_id ? withoutConnectionUrls(response) : response),
				reused: true,
				...(appAssignment ? { app_assignment: appAssignment } : {}),
				...(mode === 'edit'
					? {
							editor_session: {
								sharing,
								access: ephemeral
									? ('temporary' as const)
									: sharing === 'shared'
										? ('shared' as const)
										: ('owner' as const),
							},
						}
					: {}),
			};
		}

		if (!mayRetire) {
			throw new ForbiddenError('Not permitted to stop the reusable session');
		}
		await retireSelectedSession(deps, reusable);
		if (mode === 'app') {
			throw new ConflictError('The app session ended. Retry shortly.');
		}
	}

	if (
		mode === 'edit' &&
		!ephemeral &&
		(await sessions.isClaimRetiring(pid, nid, user.id, { claim: existingEditorClaim }))
	) {
		deps.metrics?.increment('sessions.editor_claim.lost', 1, { phase: 'preflight' });
		const observer = observeProvision();
		observer.tag('editor_claim_lost', true);
		observer.tag('editor_claim_lost_phase', 'preflight');
		throw new EditSessionRetiringError();
	}

	const temporaryToRetire = replacingAfterTakeover
		? (await sessions.findReusableEditor(pid, nid, user.id, 'exclusive', true)).session
		: undefined;

	const credentialsEndpoint = federationFor(project, deps.wif, {
		restricted: restrictedViewerCredentials,
	})?.credentialsEndpoint
		? {
				url: joinUrlPath(appBaseUrl, WIF_CREDENTIALS_PATH),
				principal: user,
				// A bounded launch credential (e.g. an expiring PAT) must not keep refreshing storage access.
				expiresAt: earliestDeadline(wifCredentialsDeadline(), user.credential.expiresAt)!,
			}
		: undefined;
	if (credentialsEndpoint) validateWifCredentialsUrl(credentialsEndpoint.url);

	let sandboxId = admission?.member.sandbox_id ?? createSandboxId();
	const sessionId = admission?.member.session_id ?? createSessionId();
	let warmClaim: WarmPoolClaim | undefined;
	let warmProbe: Promise<void> | undefined;
	let bootedSandbox: ReturnType<SandboxProvisioner['boot']> | undefined;
	let workspacePrefetch: ReturnType<SandboxProvisioner['prefetchWorkspace']> | undefined;
	let publicationReady = mode !== 'edit' || ephemeral || notebook.source.type !== 'local';
	const kernelAuthToken = sandbox.auth === 'on' ? createKernelAuthToken() : undefined;

	const progressStore = durableStartup(
		(progress) => sessions.recordStartupProgress(pid, sessionId, progress),
		drainsDeferredWork(deps)
			? (task) => {
					void deferOrAwait(deps.backgroundWork, 'session.startup_progress', task, deps.metrics, {
						project_id: pid,
						session_id: sessionId,
					});
				}
			: undefined,
	);
	const startup = sessionStartupReporter((progress, sourceSandboxId) => {
		progressStore.report({ ...progress, sandbox_id: sourceSandboxId });
		onProgress?.(progress);
	});
	let createdSession: KnownObject<Session> | undefined;
	let session: Session | undefined;
	let sessionRecordAttempted = false;
	const recoverableStartup =
		mode === 'edit' &&
		!ephemeral &&
		!origin &&
		!replacingAfterTakeover &&
		compute.connectExisting !== undefined;
	let completionAttempted = false;
	let sandboxMayExist = false;
	let workspaceStarted = false;
	const atomicEditorAdmission =
		sessions.supportsAtomicMetadata &&
		mode === 'edit' &&
		!ephemeral &&
		!origin &&
		!replacingAfterTakeover;
	const deferBootForAdmission =
		atomicEditorAdmission ||
		capsFor(deps, mode, pid, user.id).some(
			({ max, preflight }) => !preflight && max !== undefined && max > 0,
		);
	const recordSandboxCleanup = async () => {
		if (sessionRecordAttempted) {
			const reclaimed = await sessions.markSandboxReclaimed(
				pid,
				sessionId,
				new Date().toISOString(),
				sandboxId,
			);
			if (reclaimed.sandbox_id === sandboxId && reclaimed.stop?.outcome === 'stopped')
				await sessionRetirer(deps).stop(reclaimed);
		}
	};
	let updated: Session | undefined;
	let url = '';
	let usedFallback = false;
	let provisionedSandbox: SandboxInstance;
	let preparedContextFile: ReturnType<typeof sandboxContextFile> | undefined;
	let contextPublication: Promise<void> | undefined;
	const contextFor = (publicUrl: string) =>
		buildSandboxContext({
			session: session!,
			sessionMode: mode,
			appBaseUrl,
			publicUrl,
			exposureMode: sandboxExposure.mode,
			persistence: effectivePersistenceMode({
				persistEdits: sessionPersistsEdits(session!),
				source: notebook.source,
				persistWorkspace: sandbox.persistWorkspace,
			}),
		});
	// Audit pin for the integration versions rendered into this sandbox.
	let integrationAttachments: SessionRender['attachments'] | undefined;
	// In subdomain mode clientUrl === url and originUrl is unset.
	let clientUrl = '';
	let originUrl: string | undefined;
	const observer = observeProvision();
	observer.tag('origin', origin);
	observer.tag('sandbox_id', sandboxId);
	observer.tag('image', image);
	observer.tag('compute_profile', requestedComputeProfile.name);
	observer.tag('notebook_id', origin?.notebook_id ?? nid);
	try {
		// Sessions and jobs share credential resolution. Viewer sandboxes exclude project credentials.
		const sessionWorkload: WorkloadRef = { kind: 'session', id: sessionId };
		const federatedCredentials = federatedCredentialsFor(deps, project, sessionWorkload, {
			restricted: restrictedViewerCredentials,
		});
		const resolveWifVars = () =>
			resolveFederatedVars(deps, {
				project,
				workload: sessionWorkload,
				restricted: restrictedViewerCredentials,
				federatedCredentials,
				credentialsEndpoint,
				onError: (err) => {
					observer.tag('wif_exchange_failed', true);
					observer.tag(
						'wif_exchange_error',
						err instanceof Error ? `${err.name}: ${err.message}` : String(err),
					);
				},
			});

		const resolveMarimoConfigEnv = async () => {
			const contributors: MarimoConfigContributor[] = [
				marimoNotebookDefaults,
				marimoSharingDisabled,
			];
			if (MODE_POLICY[mode].injectEditorConfig && userHome) {
				contributors.push(() => ({
					file_browser: { folders: [{ path: userHome.path, name: 'Personal files' }] },
				}));
			}
			if (MODE_POLICY[mode].injectEditorConfig && deps.ai) {
				try {
					const token = await mintAiSessionToken(
						deps.ai.signingSecret,
						{
							projectId: pid,
							notebookId: nid,
							sessionId,
							userId: user.id,
						},
						{ ttlSeconds: deps.ai.tokenTtlSeconds },
					);
					contributors.push(
						marimoAiContributor({
							baseUrl: joinUrlPath(appBaseUrl, '/api/ai/v1'),
							apiKey: token,
							model: deps.ai.model,
							allowedModels: deps.ai.allowedModels,
							enabled: true,
							maxTokens: deps.ai.maxTokens,
							rules: deps.ai.rules,
						}),
					);
				} catch (err) {
					observer.tag('ai_inject_failed', true);
					observer.tag(
						'ai_inject_error',
						err instanceof Error ? `${err.name}: ${err.message}` : String(err),
					);
				}
			}
			const theme = deps.theme ?? DEFAULT_THEME_CONFIG;
			const css = theme.notebook_css
				? await notebookCssCacheFor(theme).get(
						notebookCssUrl(theme.notebook_css, deps.sandbox.appBaseUrl),
					)
				: '';
			return mergeSessionEnv(
				marimoConfigToSessionEnv(contributors),
				marimoBrandDisplay(theme, css),
			);
		};

		const resolveIntegrationEnv = () =>
			resolveIntegrationRender(deps, {
				projectId: pid,
				project,
				workload: sessionWorkload,
				principal: { userId: user.id, email: user.email },
				restricted: restrictedViewerCredentials,
				federatedCredentials,
				onRendered: (render) => {
					observer.tag('integrations_rendered_count', render.attachments.length);
					if (render.warnings.length > 0) {
						observer.tag('integration_warnings', render.warnings);
						observer.tag('integration_warning_count', render.warnings.length);
					}
					integrationAttachments = render.attachments;
				},
				onError: (err) => {
					observer.tag('integration_render_failed', true);
					for (const [key, value] of Object.entries(errorMetadata(err))) {
						observer.tag(`integrations_${key}`, value);
					}
				},
			});

		// Project caps reject before credential exchange. The user cap scan follows
		// record creation to rank concurrent starts while the cold sandbox boots.
		const startEnvResolution = () => {
			const sessionEnv = all({
				wifVars: resolveWifVars,
				marimoEnv: resolveMarimoConfigEnv,
				integrationEnv: resolveIntegrationEnv,
			}).then((layers) =>
				composeSessionEnv({ ...layers, endpointDelivery: credentialsEndpoint !== undefined }),
			);
			const gitIdentity =
				mode === 'edit' && sandbox.gitIdentity === 'user'
					? deps.services.identities.get(user.id).then((identity) => {
							return {
								name: identity?.name ?? user.name ?? user.email,
								email: identity?.email ?? user.email,
							};
						})
					: undefined;
			gitIdentity?.catch(() => {});
			const launchStrategy = resolveLaunchStrategyForSession({
				entryNotebookKey: launchSource.entryNotebookKey,
				bucket: bucketHandle,
			}).then((resolved) => {
				observer.tag('launch_strategy', resolved.strategy);
				observer.tag('launch_strategy_detection_failed', resolved.detectionFailed);
				return resolved.strategy;
			});
			// Record-phase or boot failures can reject before provisioning consumes these.
			for (const pending of [sessionEnv, launchStrategy]) pending.catch(() => {});
			return { sessionEnv, launchStrategy, gitIdentity };
		};
		let envResolution: ReturnType<typeof startEnvResolution> | undefined;
		if (replacementTarget) {
			await retireSelectedSession(deps, replacementTarget);
			const retired = await sessions.getSession(pid, replacementTarget.session_id);
			if (!retired.sandbox_reclaimed_at)
				throw new ConflictError('The selected app is still stopping. Retry shortly.');
		}
		// Retirement can publish a newer snapshot than the speculative read.
		const restoreFilesystemSnapshot = await (reusableCandidate || replacementTarget
			? readRestoreSnapshot()
			: restoreSnapshotRead);
		const appliedComputeProfile = restoreFilesystemSnapshot
			? {
					name: restoreFilesystemSnapshot.compute_profile,
					resources: restoreFilesystemSnapshot.compute_resources,
				}
			: {
					name: requestedComputeProfile.name,
					resources: toComputeResourcesResponse(requestedComputeProfile.resources),
				};
		observer.tag('compute_profile', appliedComputeProfile.name);
		const provisionOptions = (): Parameters<SandboxProvisioner['provision']>[0] => ({
			onSandboxDestroyed: recordSandboxCleanup,
			sandboxId,
			projectId: pid,
			userId: user.id,
			notebookId: nid,
			hostname,
			notebook: { projectId: pid, notebookId: nid, title: notebook.meta.title },
			bucket: sandbox.bucket,
			bucketHandle,
			workspaceLimits: notebooks.workspace.limits,
			workdir: sandbox.workdir,
			assetUrl: sandbox.assetUrl,
			notebookBridge: sandbox.notebookBridge,
			runtimeCapture: mode === 'edit' && !ephemeral && notebook.source.type === 'local',
			bridgeParentOrigin: new URL(appBaseUrl).origin,
			startupTimeoutMs: sandbox.startupTimeoutMs,
			onProgress: startup.forSandbox(sandboxId),
			kernelAuthToken,
			// A second editor writes the notebook file, so marimo must reload it.
			marimoWatch: mode === 'edit' && SECONDARY_SURFACE_IDS.some((id) => sandbox.surfaces?.[id]),
			restoreFilesystemSnapshotId: restoreFilesystemSnapshot?.snapshot_id,
			image,
			resources: requestedComputeProfile.resources,
			userHome,
			sessionIdleTimeoutMs: isPreview
				? (previewIdleTimeout(sandbox.sessionLifetime?.idleTimeoutMsByMode[mode]) as Millis)
				: sandbox.sessionLifetime?.idleTimeoutMsByMode[mode],
			sessionEnv: envResolution!.sessionEnv,
			gitIdentity: envResolution!.gitIdentity,
			entryNotebook: workspacePolicy.entryNotebook,
			launchStrategy: envResolution!.launchStrategy,
			launchMode: mode,
			// Viewer sandboxes copy files: mounts expose bucket credentials and write
			// through to the source, bypassing persistence guards and racing editors.
			workspaceLoadMode:
				ephemeral || MODE_POLICY[mode].workspaceLoad === 'copy-only'
					? 'copy-only'
					: workspacePolicy.loadMode,
			workspacePrefix,
			...pullSourceGit,
			workspaceArchive,
			workspaceOverlay: launchSource.workspaceOverlay,
			workspaceRemovePaths: launchSource.workspaceRemovePaths,
		});
		const bootSandbox = () => {
			bootedSandbox = provisioner.boot(provisionOptions());
			sandboxMayExist = true;
		};
		const bindAppSandbox = async () => {
			if (admission) {
				await appPool.bindWarmSandbox(
					pid,
					nid,
					sessionId,
					admission.member.operation_token,
					sandboxId,
				);
			}
		};
		const prefetchWorkspace = () => {
			if (!publicationReady) return;
			const sandbox = warmClaim?.sandbox ?? bootedSandbox?.sandbox;
			if (sandbox) workspacePrefetch ??= provisioner.prefetchWorkspace(sandbox, provisionOptions());
		};

		let coldCleanup: Promise<void> | undefined;
		const cleanupColdSandbox = async () => {
			const boot = bootedSandbox;
			if (completionAttempted || warmClaim || !boot || !sandboxMayExist) return;
			return (coldCleanup ??= (async () => {
				await workspacePrefetch?.cancel();
				const reclaim = async () => {
					await boot.ready.catch(() => {});
					await boot.sandbox.destroy();
					sandboxMayExist = false;
					await recordSandboxCleanup();
				};
				// Losing starts must not wait for the speculative boot; request-limited hosts reclaim inline.
				if (!drainsDeferredWork(deps)) return reclaim();
				await deferOrAwait(
					deps.backgroundWork,
					'session.cold_boot_cleanup',
					reclaim,
					deps.metrics,
					{
						project_id: pid,
						notebook_id: nid,
						sandbox_id: sandboxId,
					},
				);
			})());
		};

		recordAuthReuse();
		await saga(observer)
			.step('preview_admission', async () => {
				if (!previewRecord) return;
				const record = previewRecord;
				const reaped = await deps.services.previews.reapAdmissions(record, async (id) => {
					try {
						return !(await sessions.getSession(pid, id)).sandbox_reclaimed_at;
					} catch (error) {
						if (error instanceof NotFoundError) return;
						throw error;
					}
				});
				await deps.services.previews.reserveAdmission(reaped, nid, sessionId, PREVIEW_MAX_SESSIONS);
			})
			.step('capacity', async () => {
				await enforceSessionCap(deps, mode, pid, user.id, temporaryToRetire?.session_id);
				envResolution = startEnvResolution();
			})
			.step('warm_sandbox', async () => {
				warmClaim = await deps.warmPool?.reserve({
					profile: requestedComputeProfile.name,
					resources: requestedComputeProfile.resources,
					image,
					userHome,
					restoreSnapshotId: restoreFilesystemSnapshot?.snapshot_id,
					destination: { project_id: pid, notebook_id: nid, session_id: sessionId },
				});
				if (!warmClaim) return;
				const probeStarted = Date.now();
				warmProbe = deps.warmPool!.probe(warmClaim).finally(() => {
					observer.tag('warm_probe_ms', Date.now() - probeStarted);
				});
				warmProbe.catch(() => {});
				sandboxId = warmClaim.member.sandbox_id;
				sandboxMayExist = true;
				observer.tag('sandbox_id', sandboxId);
				observer.tag('warm_pool_hit', true);
				// Mutable workspace reads must follow publication under the source lease.
				if (workspacePrefix) prefetchWorkspace();
				await bindAppSandbox();
			})
			.step('sandbox_boot', {
				do: () => {
					if (warmClaim || deferBootForAdmission) return;
					bootSandbox();
				},
				compensate: cleanupColdSandbox,
			})
			.step('session_record', async () => {
				const create = async () => {
					sessionRecordAttempted = true;
					createdSession = await sessions.createSessionWithEtag(
						{
							session_id: sessionId,
							...(admission ? { app_pool: true as const } : {}),
							notebook_id: nid,
							origin,
							project_id: pid,
							user_id: user.id,
							sandbox_id: sandboxId,
							kernel_auth_token: kernelAuthToken,
							compute_profile: appliedComputeProfile.name,
							compute_resources: appliedComputeProfile.resources,
							compute_from_snapshot: restoreFilesystemSnapshot !== undefined,
							ephemeral,
							restricted_viewer_credentials: restrictedViewerCredentials,
							idle_timeout_ms: isPreview ? PREVIEW_IDLE_MS : undefined,
							mode,
							source_version_id: sourceVersionId,
							editor_sandbox_sharing: mode === 'edit' ? sharing : undefined,
							authorization_expires_at: earliestDeadline(
								authorizationExpiresAt,
								credentialsEndpoint?.expiresAt,
							),
						},
						...(atomicEditorAdmission
							? [
									{
										maxConcurrentSessionsPerUser: deps.policy.maxConcurrentSessionsPerUser,
										projectUpdatedAt: project.updated_at,
										notebookUpdatedAt: notebook.meta.updated_at,
									},
								]
							: []),
					);
					return createdSession.value;
				};
				// Publish the starting record under the source-mutation lease. Once visible,
				// the session itself blocks source replacement through sandbox reclamation.
				session =
					mode === 'edit' && !ephemeral
						? await notebooks.workspace.withMutation(
								pid,
								nid,
								{
									deferRelease: drainsDeferredWork(deps)
										? (release) =>
												void deferOrAwait(
													deps.backgroundWork,
													'notebook.workspace_lease_release',
													() => release,
													deps.metrics,
													{ project_id: pid, notebook_id: nid, session_id: sessionId },
												)
										: undefined,
								},
								async (lease) => {
									session = await create();
									await lease.heartbeat();
									return session;
								},
							)
						: await create();
				observer.tag('session_id', session.session_id);
				prefetchWorkspace();
			})
			.step('admission', {
				do: async () => {
					const timed = async (name: string, task: () => Promise<unknown>) => {
						const started = Date.now();
						try {
							await task();
							observer.tag(`${name}_succeeded`, true);
						} catch (error) {
							observer.tag(`${name}_failed`, true);
							throw error;
						} finally {
							observer.tag(`${name}_ms`, Date.now() - started);
						}
					};
					// Settle every writer before compensation; cap errors retain precedence.
					const checks = await allSettled({
						cap: () =>
							atomicEditorAdmission
								? Promise.resolve()
								: timed('cap_recheck', () =>
										assertCapAfterCreate(
											deps,
											mode,
											pid,
											user.id,
											sessionId,
											temporaryToRetire?.session_id,
											(source) => observer.tag('cap_source', source),
										),
									),
						preview: () =>
							timed('preview_admission_commit', async () => {
								if (previewRecord)
									await deps.services.previews.commitAdmission(previewRecord, sessionId);
							}),
						editor: () =>
							timed('editor_claim', async () => {
								if (mode !== 'edit' || ephemeral) return;
								if (!atomicEditorAdmission) {
									const result = await sessions.claimEditor(pid, nid, sessionId, sharing, user.id);
									if (!result.claimed && result.claim.session_id)
										throw new EditorClaimLostError(result.claim.session_id);
								}
								if (notebook.source.type === 'local') {
									const fenced = atomicEditorAdmission
										? await notebooks.getNotebookSource(pid, nid)
										: await notebooks.fenceSessionPublications(pid, nid);
									if (fenced.type !== 'local')
										throw new ConflictError('Notebook source changed during admission');
									launchSource = resolveNotebookLaunchSource({
										entryNotebook: workspacePolicy.entryNotebook,
										workspacePrefix: notebookPaths.workspacePrefix,
										localVersion: notebookPaths.version(fenced.current_version_id),
										localCapture: fenced.publication?.versions.find(
											(version) => version.version_id === fenced.current_version_id,
										),
									});
									if (envResolution)
										envResolution.launchStrategy = resolveLaunchStrategyForSession({
											entryNotebookKey: launchSource.entryNotebookKey,
											bucket: bucketHandle,
										}).then((resolved) => resolved.strategy);
									publicationReady = true;
								}
							}),
					});
					for (const result of [checks.cap, checks.preview, checks.editor]) {
						if (result.status === 'rejected') {
							await sessions.releaseEditorFor(session!).catch(() => {});
							throw result.reason;
						}
					}
				},
				compensate: async () => {
					if (session && !completionAttempted) await sessions.releaseEditorFor(session);
				},
			})
			.step('admitted_sandbox_boot', {
				do: () => {
					progressStore.enable();
					if (!warmClaim && !bootedSandbox) {
						bootSandbox();
						prefetchWorkspace();
					}
				},
				compensate: cleanupColdSandbox,
			})
			.step('sandbox_provision', {
				do: async () => {
					workspaceStarted = true;
					try {
						// `prepare` picks marimo's `--base-url`; `finalize` maps the adapter's
						// exposed URL to the client URL + the origin to persist.
						const exposureCtx = {
							sessionId: session!.session_id,
							projectId: pid,
							notebookId: nid,
							sandboxId,
							kernelAuthToken,
							appBaseUrl,
						};
						const replaceWarmSandbox = async (reason: string) => {
							const expired = warmClaim!;
							await workspacePrefetch?.cancel();
							workspacePrefetch = undefined;
							await deps.warmPool!.abandon(expired).catch(() => {});
							// Pool cleanup must never target the cold replacement.
							sandboxId = createSandboxId();
							sandboxMayExist = false;
							await bindAppSandbox();
							session = await sessions.replaceStartingSandbox(
								pid,
								sessionId,
								expired.member.sandbox_id,
								sandboxId,
							);
							warmClaim = undefined;
							exposureCtx.sandboxId = sandboxId;
							observer.tag('sandbox_id', sandboxId);
							observer.tag('warm_pool_hit', false);
							observer.tag('warm_pool_fallback', reason);
							bootSandbox();
							prefetchWorkspace();
						};
						if (warmClaim) {
							try {
								await warmProbe;
							} catch (error) {
								await replaceWarmSandbox(
									error instanceof WarmPoolClaimExpiredError ? 'claim_expired' : 'probe_failed',
								);
							}
						}
						const runProvision = async () => {
							const results = await allSettled<{
								handoff: () => Promise<void>;
								provision: () => Promise<ProvisionResult>;
							}>({
								handoff: async () => {
									if (warmClaim) await deps.warmPool!.handoff(warmClaim);
								},
								async provision(): Promise<ProvisionResult> {
									const { baseUrl, publicUrl, cookiePartitioned } =
										await sandboxExposure.prepare(exposureCtx);
									preparedContextFile =
										publicUrl === undefined
											? undefined
											: sandboxContextFile(sandboxId, contextFor(publicUrl));
									return provisioner.provision({
										...provisionOptions(),
										existingSandbox: warmClaim?.sandbox,
										bootedSandbox,
										workspacePrefetch,
										beforePrepare: this.$.handoff,
										baseUrl,
										publicUrl,
										cookiePartitioned,
										contextFile: preparedContextFile ?? { path: sandboxContextPath(sandboxId) },
									});
								},
							});
							if (results.handoff.status === 'rejected') throw results.handoff.reason;
							if (results.provision.status === 'rejected') throw results.provision.reason;
							return results.provision.value;
						};
						const provision = await runProvision().catch(async (error) => {
							if (!warmClaim || !(error instanceof WarmPoolClaimExpiredError)) throw error;
							await replaceWarmSandbox('claim_expired');
							return runProvision();
						});
						({ url, usedFallback } = provision);
						provisionedSandbox = provision.sandbox;
						for (const [phase, ms] of Object.entries(provision.timings)) {
							observer.tag(`provision_${phase}_ms`, ms);
							if (phase === 'ingress_publish') observer.tag('ingress_publish_ms', ms);
						}
						for (const [name, value] of Object.entries(provision.counters)) {
							observer.tag(`provision_${name}`, value);
						}
						observer.tag('provision_used_fallback', usedFallback);
						({ clientUrl, originUrl } = await sandboxExposure.finalize(url, exposureCtx));
					} catch (error) {
						// Reclaim a failed cold provision before the saga releases its editor claim.
						await cleanupColdSandbox().catch(() => {});
						throw error;
					}
				},
				compensate: async () => {
					if (completionAttempted) return;
					// Never destroy the sandbox under an in-flight context write.
					await contextPublication;
					await cleanupColdSandbox();
				},
			})
			.step('sandbox_context', async () => {
				if (preparedContextFile) return;
				// Consumers tolerate a missing file, so the publication overlaps the remaining
				// steps and the response instead of delaying them.
				contextPublication = writeSandboxContext(
					provisionedSandbox,
					sandboxId,
					contextFor(clientUrl),
				).catch((error: unknown) => {
					// Optional metadata must not reclaim an already-running kernel. The tag only
					// reaches the provision event when the failure precedes its flush.
					observer.tag('sandbox_context', 'unavailable');
					logEvent({
						level: 'warn',
						event: 'sandbox_context_unavailable',
						project_id: pid,
						session_id: session!.session_id,
						sandbox_id: sandboxId,
						...errorMetadata(error),
						message: error instanceof Error ? error.message.slice(-2200) : undefined,
					});
				});
			})
			.step('mark_running', async () => {
				startup.close();
				const finalProgress = progressStore.finish();
				if (isPastAuthorizationDeadline(session!, Date.now())) {
					throw new ForbiddenError('Group authorization expired while starting the session');
				}
				// The lifetime clock starts here — when the kernel is live, not at record
				// creation — so provisioning time never eats into the session TTL.
				const ttlMs = sandbox.sessionLifetime?.maxLifetimeMs;
				const providerDeadline =
					warmClaim?.member.sandbox_deadline_at ??
					(compute.warmPool?.maxLifetimeMs
						? (warmClaim?.member.checked_at ?? Date.now()) + compute.warmPool.maxLifetimeMs
						: undefined);
				const knownSession =
					!progressStore.hasWrites && createdSession?.value === session
						? createdSession
						: undefined;
				if (recoverableStartup) {
					// An uncertain receipt write may already be visible to another replica.
					// From here, retirement owns cleanup, never saga compensation.
					completionAttempted = true;
					const prepared = await sessions
						.recordStartupCompletion(
							pid,
							session!.session_id,
							{
								id: crypto.randomUUID(),
								sandbox_id: sandboxId,
								ready_at: new Date().toISOString(),
								sandbox_url: clientUrl,
								sandbox_origin_url: originUrl,
								used_fallback: usedFallback,
								expires_at: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
								sandbox_deadline_at:
									providerDeadline === undefined
										? undefined
										: new Date(providerDeadline).toISOString(),
								reconnect_reference: provisionedSandbox.reconnectReference,
								integrations: integrationAttachments,
								startup: finalProgress,
							},
							knownSession,
						)
						.catch(async (error) => {
							// The conditional failure loses to any committed receipt, including one
							// whose acknowledgement was lost. A storage outage leaves the record
							// for stale-session retirement once metadata is available again.
							await rejectStartupCompletion(deps, session!, { sandbox_id: sandboxId }, error).catch(
								() => {},
							);
							throw error;
						});
					updated = await completeNotebookSessionStart({ deps, user }, prepared, {
						verifyRuntime: false,
					});
					return;
				}
				updated = await sessions.setRunning(
					pid,
					session!.session_id,
					clientUrl,
					usedFallback,
					originUrl,
					ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
					integrationAttachments,
					providerDeadline === undefined ? undefined : new Date(providerDeadline).toISOString(),
					knownSession,
					provisionedSandbox.reconnectReference,
					finalProgress,
				);
			})
			// Deletion can miss a starting sandbox. Rechecks after mark_running close that race.
			// The project needs a separate check because its notebooks remain readable until GC.
			.step('running_rechecks', async () => {
				if (recoverableStartup) return;
				const rechecks = await all({
					claim: async () => {
						if (mode !== 'edit' || ephemeral) return;
						if (replacingAfterTakeover && existingEditorClaim?.transfer) {
							await sessions.completeTakeover(
								pid,
								nid,
								existingEditorClaim.transfer.takeover_id,
								session!.session_id,
							);
							return;
						}
						return sessions.claimEditor(pid, nid, session!.session_id, sharing, user.id);
					},
					notebook: () =>
						(isPreview
							? notebooks.getNotebook(pid, nid).then((current) => current.meta)
							: notebooks.getNotebookMeta(pid, nid)
						).catch(() => null),
					project: () => projects.getProject(pid, { consistency: 'validated' }).catch(() => null),
				});
				if (rechecks.claim && !rechecks.claim.claimed && rechecks.claim.claim.session_id) {
					throw new EditorClaimLostError(rechecks.claim.claim.session_id);
				}
				if (!rechecks.notebook || rechecks.notebook.status === 'deleted') {
					throw new NotFoundError(`Notebook ${nid} not found`);
				}
				if (!rechecks.project || rechecks.project.status === 'deleted') {
					throw new NotFoundError(`Project ${pid} not found`);
				}
				await recheckSessionAuthorization(
					rechecks.project,
					user,
					mode,
					deps,
					rechecks.notebook.security_labels ?? null,
					{
						ephemeral: authorization.ephemeral,
						restrictedViewerCredentials,
					},
				);
			})
			.step('app_pool_complete', async () => {
				if (admission) {
					if (updated?.status !== 'running')
						throw new ConflictError('The app session ended during startup');
					await appPool.complete(pid, nid, session!.session_id, admission.member.operation_token);
				}
			})
			.run();
	} catch (err) {
		if (completionAttempted) {
			observer.tag('provision_error_code', toSessionError(err).code);
			throw err;
		}
		startup.close();
		const finalProgress = progressStore.finish();
		await contextPublication;
		await warmProbe?.catch(() => {});
		await workspacePrefetch?.cancel();
		if (warmClaim) {
			let released = false;
			if (
				!workspaceStarted &&
				(err instanceof ResourceExhaustedError || err instanceof EditorClaimLostError)
			) {
				try {
					const relinquished =
						!sessionRecordAttempted ||
						(await sessions.relinquishStartingSandbox(pid, sessionId, sandboxId));
					if (relinquished) released = await deps.warmPool!.releaseUnused(warmClaim);
				} catch {}
			}
			if (released) sandboxMayExist = false;
			else await deps.warmPool!.abandon(warmClaim).catch(() => {});
		}
		if (admission?.kind === 'reserve') {
			// A failed session PUT may have committed; only release when it was never attempted.
			await (
				sessionRecordAttempted
					? appPool.invalidate(pid, nid, admission.member.session_id)
					: appPool.releaseReservation(
							pid,
							nid,
							admission.member.session_id,
							admission.member.operation_token,
						)
			).catch(() => {});
		}
		if (!sandboxMayExist) await recordSandboxCleanup().catch(() => {});
		if (previewRecord && !sessionRecordAttempted)
			await deps.services.previews.releaseAdmission(previewRecord, sessionId).catch(() => {});

		if (err instanceof EditorClaimLostError) {
			deps.metrics?.increment('sessions.editor_claim.lost', 1, { phase: 'claim' });
			observer.tag('editor_claim_lost', true);
			observer.tag('editor_claim_lost_phase', 'claim');
			if (session) await sessions.markTerminated(pid, session.session_id).catch(() => {});
			const winnerCandidate = await sessions.getSession(pid, err.holder).catch(() => null);
			if (winnerCandidate?.notebook_id === nid && sessionMode(winnerCandidate) === 'edit') {
				// Revalidate before the ownership check: a dead holder must yield the
				// retryable 409, not "owned by" a session that is already gone.
				const winner = await revalidateEditorReuse(
					await tightenAuthorizationDeadline(winnerCandidate),
				);
				if (sharing === 'exclusive' && winner.user_id !== user.id) {
					throw new EditSessionOwnedError(`Editing is currently owned by ${winner.user_id}`);
				}
				const winnerGrants = await grants(winner);
				return {
					...toSessionResponse(winner, winnerGrants, deps.theme?.session_links),
					reused: true,
					editor_session: {
						sharing,
						access: sharing === 'shared' ? ('shared' as const) : ('owner' as const),
					},
				};
			}
			throw new ConflictError('The editor session changed. Retry shortly.');
		}
		// Record WHY the session failed so the client polling `GET …/sessions/{sid}`
		// sees a reason, not a bare `failed`. Best-effort (never mask the original
		// error): a marking failure just leaves the record for the stale reaper, and
		// markFailed no-ops if a concurrent stop already made it terminal.
		if (session) {
			const safeError = toSessionError(err);
			observer.tag('provision_error_code', safeError.code);
			const failed = await sessions
				.markFailedWithOutcome(pid, session.session_id, safeError, finalProgress)
				.catch(() => null);
			if (MODE_POLICY[mode].sharedApp && failed?.transitioned) {
				scheduleProjectAlert(
					deps,
					pid,
					'app.start_failed',
					{ project_id: pid, notebook_id: nid, session_id: session.session_id },
					() =>
						notificationRouter.render({
							kind: 'app.start_failed',
							project,
							notebookId: nid,
							notebookTitle: notebook.meta.title,
							sessionId: session!.session_id,
							startedByUserId: user.id,
							errorCode: safeError.code,
							baseUrl: appBaseUrl,
						}),
				);
			}
		}
		if (
			!(err instanceof NotFoundError) &&
			!(err instanceof ResourceExhaustedError) &&
			(appUser ||
				(mode === 'app' &&
					!authorizationService(deps).credentialAllowsAction(user, 'project.read')))
		) {
			throw new UnavailableError('The app could not start. Contact its owner.');
		}
		throw err;
	}

	if (replacingAfterTakeover && temporaryToRetire) {
		const claimed = await sessions.beginTerminating(pid, temporaryToRetire.session_id);
		await deferTeardown(
			deps,
			'session.retire_temporary',
			() =>
				sessionRetirer(deps).retire(claimed.session, {
					teardown: claimed.transitioned,
					thumbnail: 'skip',
				}),
			{ project_id: pid, notebook_id: nid, session_id: claimed.session.session_id },
		);
	}

	if (updated) {
		updated = await finalizeSurfaces(updated, { includeEager: true, contextPublication });
	}

	// App sessions can expose integration secrets and WIF credentials to their audience.
	// The audit records who started the session.
	if (MODE_POLICY[mode].sharedApp) {
		await appendAudit(deps, { ...request, userId: user.id }, 'app.start', () =>
			deps.services.events.append({
				event: 'app.start',
				actor: user.id,
				project_id: pid,
				notebook_id: origin?.notebook_id ?? nid,
				origin,
				session_id: session!.session_id,
			}),
		);
	}

	if (contextPublication) {
		const publication = contextPublication;
		await deferOrAwait(
			deps.backgroundWork,
			'session.context_publication',
			() => publication,
			deps.metrics,
			{ project_id: pid, notebook_id: nid, session_id: session!.session_id, sandbox_id: sandboxId },
		);
	}

	const response = toSessionResponse(updated!, await grants(updated!), deps.theme?.session_links);
	return {
		...(body?.replace_app_session_id ? withoutConnectionUrls(response) : response),
		reused: false,
		...(appAssignment ? { app_assignment: appAssignment } : {}),
		...(mode === 'edit'
			? {
					editor_session: {
						sharing,
						access: ephemeral
							? ('temporary' as const)
							: sharing === 'shared'
								? ('shared' as const)
								: ('owner' as const),
					},
				}
			: {}),
	};
}

app.openapi(createSession, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	const input: Parameters<typeof startNotebookSession>[0] = {
		deps,
		user: c.get('user'),
		pid,
		nid,
		body: c.req.valid('json'),
		request: {
			requestId: c.get('requestId'),
			method: c.req.method,
			path: c.req.path,
			hostname: resolveSandboxHostname(c, deps.sandbox),
			appBaseUrl: resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
			signal: c.req.raw.signal,
		},
	};
	if (
		c.req
			.header('Accept')
			?.split(',')
			.some((type) => type.trim().split(';')[0] === 'text/event-stream')
	) {
		const stream = sessionStartupStream(
			(callbacks) =>
				startNotebookSession({
					...input,
					...callbacks,
					request: { ...input.request, signal: undefined },
				}),
			(error) => {
				const domain = error instanceof DomainError ? error : undefined;
				const status = domain?.status ?? 500;
				// The stream already answered 200, so `app.onError` never sees this failure.
				if (status >= 500)
					logEvent({
						level: 'error',
						event: 'request_error',
						request_id: input.request.requestId ?? null,
						method: input.request.method,
						path: input.request.path,
						user: input.user.id,
						status,
						project_id: pid,
						notebook_id: nid,
						error: describeError(error),
					});
				const retryAfter = RETRY_AFTER_SECONDS[status];
				return {
					code: domain?.code ?? 'INTERNAL_ERROR',
					message: domain?.message ?? internalErrorMessage(input.request.requestId),
					status,
					...(retryAfter === undefined ? {} : { retry_after_ms: retryAfter * 1000 }),
				};
			},
			c.req.raw.signal,
		);
		// Register provisioning so the host can drain it after a disconnect.
		void deferOrAwait(deps.backgroundWork, 'session.start', () => stream.done, deps.metrics, {
			project_id: pid,
			notebook_id: nid,
		});
		await stream.started;
		return stream.response;
	}
	const data = await startNotebookSession(input);
	return c.json({ success: true as const, data }, 200);
});

app.openapi(deleteSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Project visibility FIRST (404 when hidden, matching getSession) — resolving
	// the session before it would let 403-vs-404 leak whether a session id exists
	// in a project the caller cannot see.
	const project = await loadVisibleProject(projects, pid, user, deps);

	// Scope-check: the project-scoped key 404s a cross-project id; the notebook
	// check keeps a same-project/other-notebook id out of scope.
	const known = await sessions.getSessionWithEtag(pid, sid);
	const existing = known.value;
	if (sessionResourceNotebookId(existing) !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	const labels = await assertSessionNotebookVisible(deps, project, existing, user);

	// Terminating a session tears down a running kernel — editor+, or the owner of
	// their own ephemeral session (role re-checked; see assertSessionControl).
	await assertSessionControl(project, existing, user, deps, labels);

	const query = c.req.valid('query');
	const wait = query.wait === 'true';
	const headerKey = c.req.valid('header')['idempotency-key'];
	if (headerKey && query.request_key && headerKey !== query.request_key)
		throw new BadRequestError('Conflicting stop request keys');
	const requested = await sessions.requestStop(pid, sid, {
		key: headerKey ?? query.request_key,
		requestedBy: user.id,
		previousId: query.previous_attempt_id,
		force: query.force === 'true',
	});
	let invalidationError: unknown;
	try {
		if (sessionMode(existing) === 'app')
			await new AppPoolService(deps.bucket, sessions, deps.policy.appPool, deps.metrics).invalidate(
				pid,
				existing.notebook_id,
				sid,
			);
	} catch (error) {
		invalidationError = error;
	}
	let pending = !wait;
	if (wait) {
		const result = await sessionRetirer(deps).stop(requested);
		if (
			!result.sandbox_reclaimed_at &&
			(result.stop?.outcome === 'retained' || result.stop?.outcome === 'uncertain')
		)
			throw new SessionPersistenceRequiredError();
		pending = result.stop?.outcome !== 'stopped' && !result.sandbox_reclaimed_at;
	} else {
		await deferTeardown(
			deps,
			'session.stop',
			async () => {
				await sessionRetirer(deps).stop(requested);
			},
			{ project_id: pid, session_id: sid },
		);
	}
	if (invalidationError instanceof Error) throw invalidationError;
	if (invalidationError !== undefined) throw new Error('App pool invalidation failed');

	return pending ? c.json({ success: true }, 202) : c.json({ success: true }, 200);
});

app.openapi(heartbeatSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Preserve project-denial precedence without waiting for speculative session I/O.
	const sessionRead = sessions.getSessionWithEtag(pid, sid).then(
		(value) => ({ status: 'fulfilled' as const, value }),
		(reason: unknown) => ({ status: 'rejected' as const, reason }),
	);
	const project = await loadSessionProject(projects, pid, user, deps);

	// Scope-check: the project-scoped key 404s a cross-project id; the notebook
	// check keeps a same-project/other-notebook id out of scope.
	const sessionResult = await sessionRead;
	if (sessionResult.status === 'rejected') throw sessionResult.reason;
	const known = sessionResult.value;
	const existing = known.value;
	if (sessionResourceNotebookId(existing) !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	const labels = await assertSessionNotebookVisible(deps, project, existing, user);

	// Access-level gate, not control: an admitted viewer watching the shared app
	// must keep it alive too (see assertSessionAccess).
	await assertSessionAccess(project, existing, user, deps, labels);

	if (
		sessionMode(existing) === 'app' &&
		(existing.status === 'running' || existing.status === 'starting')
	) {
		const pool = new AppPoolService(deps.bucket, sessions, deps.policy.appPool, deps.metrics);
		if (!existing.app_pool) await pool.synchronize(pid, existing.notebook_id, [existing]);
		const visit = c.req.valid('json');
		if (
			!(await pool.heartbeat(
				pid,
				existing.notebook_id,
				user.id,
				sid,
				visit?.visit_id ? visit : undefined,
			))
		) {
			throw new AppAssignmentExpiredError();
		}
	}

	const updated = await sessions.heartbeat(pid, sid, known);
	const grants = await sessionGrantsFor(project, user, updated, deps, labels);
	const response: ReturnType<typeof toSessionResponse> &
		Pick<z.infer<typeof SessionResponseSchema>, 'head_version_id' | 'edit_active'> =
		toSessionResponse(updated, grants, deps.theme?.session_links);
	if (
		sessionMode(updated) === 'app' &&
		!grants.appReadOnly &&
		!updated.origin &&
		(updated.status === 'running' || updated.status === 'starting')
	) {
		const [source, claim] = await Promise.all([
			deps.services.notebooks.getNotebookSource(pid, nid, { consistency: 'validated' }),
			sessions.getEditorClaim(pid, nid, { consistency: 'validated' }),
		]);
		response.head_version_id = source.current_version_id ?? null;
		response.edit_active = !!claim?.session_id;
	}
	const terminalApp =
		sessionMode(updated) === 'app' && updated.status !== 'running' && updated.status !== 'starting';
	return c.json(
		{ success: true, data: terminalApp ? withoutConnectionUrls(response) : response },
		200,
	);
});

app.openapi(leaveAppVisit, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, sid } = c.req.valid('param');
	const user = c.get('user');
	const project = await loadSessionProject(deps.services.projects, pid, user, deps);
	const session = await deps.services.sessions.getSession(pid, sid);
	if (sessionResourceNotebookId(session) !== nid || sessionMode(session) !== 'app')
		throw new NotFoundError('App session not found');
	const labels = await assertSessionNotebookVisible(deps, project, session, user);
	await assertSessionAccess(project, session, user, deps, labels);
	await new AppPoolService(
		deps.bucket,
		deps.services.sessions,
		deps.policy.appPool,
		deps.metrics,
	).leave(pid, session.notebook_id, user.id, sid, c.req.valid('json'));
	return c.json({ success: true as const }, 200);
});

app.openapi(ensureSurfaceRoute, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, sid, surface } = c.req.valid('param');
	const session = await loadSurfaceSession(deps, user, { pid, nid, sid });
	const exposure = deps.sandbox.exposure;
	const appBaseUrl = resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl);
	const begun = await beginSessionSurface({
		deps,
		session,
		user,
		id: surface,
		workspaceDir: sessionWorkspaceDir(
			await deps.services.notebooks.getNotebookSource(pid, session.notebook_id),
			deps.sandbox.workdir,
		),
		exposure,
		hostname: resolveSandboxHostname(c, deps.sandbox),
		appBaseUrl,
		open: c.req.valid('json')?.open,
	});
	const result = begun.result;
	if (result.status === 'starting') c.header('Retry-After', '1');
	const data = {
		id: surface,
		status: result.state.status,
		port: result.state.port,
		url: result.state.url,
		started_at: result.state.started_at,
		probe: result.state.probe,
		last_error: result.state.last_error,
	};
	return c.json({ success: true, data }, result.status === 'ready' ? 200 : 202);
});

app.openapi(getSurfaceRoute, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, sid, surface } = c.req.valid('param');
	const session = await loadSurfaceSession(deps, c.get('user'), { pid, nid, sid });
	const state = session.surfaces?.[surface];
	if (!state) throw new NotFoundError(`Surface ${surface} not found`);
	return c.json(
		{
			success: true,
			data: {
				id: surface,
				status: state.status,
				port: state.port,
				url: state.url,
				started_at: state.started_at,
				probe: state.probe,
				last_error: state.last_error,
			},
		},
		200,
	);
});

app.openapi(deleteSurfaceRoute, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, sid, surface } = c.req.valid('param');
	const session = await loadSurfaceSession(deps, c.get('user'), { pid, nid, sid }, 'control');
	await surfaceStopManager(deps).stop(session, surface);
	return c.json({ success: true }, 200);
});

export default app;

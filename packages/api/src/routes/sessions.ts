import { createRoute, z } from '@hono/zod-openapi';
import type {
	AuthUser,
	EditorClaim,
	EditorSandboxSharing,
	Project,
	ProjectId,
	MarimoConfigContributor,
	SessionEnv,
	Session,
	SessionMode,
	SessionRender,
	UserId,
} from '@marimo-hub/core';
import {
	BadRequestError,
	ConflictError,
	createSandboxId,
	DomainError,
	effectiveRole,
	exchangeFederatedStorageEnv,
	marimoAiContributor,
	marimoConfigToSessionEnv,
	marimoNotebookDefaults,
	marimoSharingDisabled,
	mintAiSessionToken,
	NotFoundError,
	paths,
	requireRole,
	resolveBaseImage,
	resolveRestoreSnapshot,
	ResourceExhaustedError,
	saga,
	MODE_POLICY,
	SandboxProvisioner,
	SESSION_MODES,
	SessionId,
	sessionMode,
	sessionModePolicy,
	SubdomainExposure,
	canStartSessionMode,
	UnavailableError,
	EditSessionOwnedError,
	EditSessionChangedError,
	TakeoverInProgressError,
	TakeoverRetirementError,
	kernelActiveConnections,
	ValidationError,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import { logObserver } from '../saga';
import { errorMetadata } from '../log';
import type { ApiDeps, PolicyConfig, SandboxConfig } from '../context';
import {
	assertSessionAccess,
	assertSessionControl,
	commonErrors,
	createApp,
	errorResponses,
	IdempotencyKeyHeader,
	jsonContent,
	loadVisibleProject,
	NotebookIdParam,
	ProjectIdParam,
	SessionIdParam,
	sessionGrantsFor,
	SessionResponseSchema,
	sessionRetirer,
	SuccessResponseSchema,
	toComputeResourcesResponse,
} from '../shared';
import { pageSchema, paginate, PaginationQuery } from '../pagination';

function mergeSessionEnv(base: SessionEnv | undefined, add: SessionEnv): SessionEnv {
	return {
		files: [...(base?.files ?? []), ...(add.files ?? [])],
		vars: { ...base?.vars, ...add.vars },
		defaults: { ...base?.defaults, ...add.defaults },
	};
}

function effectiveEditorSharing(
	claim: EditorClaim | undefined,
	configured: EditorSandboxSharing | undefined,
): EditorSandboxSharing {
	return claim?.session_id || claim?.transfer ? claim.sharing : (configured ?? 'shared');
}

// --- Route definitions ---

// createSession is create-or-reuse; `reused` distinguishes an existing shared,
// owned, or temporary session from a freshly provisioned one.
const SessionCreateResponseSchema = SessionResponseSchema.extend({
	reused: z.boolean(),
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
const SessionCreateBodySchema = z
	.object({
		/**
		 * `edit` (default): a persistent or temporary editor sandbox according to
		 * the editor sandbox-sharing policy. `app`: the notebook served as a
		 * read-only, per-notebook app. Viewer access depends on
		 * MARIMOHUB_VIEWER_MODE.
		 */
		mode: z.enum(SESSION_MODES).optional(),
		/** One-shot fallback that does not change notebook metadata. */
		compute_profile: z.literal('default').optional(),
		/** Request a discard-only editor sandbox. Valid only with exclusive sharing. */
		edit_intent: z.literal('temporary').optional(),
	})
	.openapi('SessionCreateBody');

const createSession = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/sessions',
	tags: ['Sessions'],
	summary: 'Create a session and provision a sandbox',
	// `Idempotency-Key` is accepted and documented, but this route is already
	// idempotent through session reuse. Edit reuse follows the configured sharing
	// policy; app reuse is per notebook. A retry returns the same live session.
	description:
		'Create or reuse a notebook sandbox. Edit-session reuse follows the configured ' +
		'editor sandbox-sharing policy. App-session reuse is shared per notebook.',
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
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionCreateResponseSchema }),
			'Session created or reused',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409, 429),
	},
});

const deleteSession = createRoute({
	method: 'delete',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}',
	tags: ['Sessions'],
	summary: 'Terminate a session and destroy sandbox',
	request: { params: SessionIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Session terminated'),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const getSession = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/sessions/{sid}',
	tags: ['Sessions'],
	summary: 'Get a session (status + kernel URL)',
	request: { params: SessionIdParam },
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
	tags: ['Sessions'],
	summary: 'Update session heartbeat',
	request: { params: SessionIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SessionResponseSchema }),
			'Heartbeat updated',
		),
		...commonErrors(),
		...errorResponses(403, 404),
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
	tags: ['Sessions'],
	summary: 'Gracefully take over an exclusive editor session',
	request: {
		params: NotebookIdParam,
		body: { content: { 'application/json': { schema: TakeoverBodySchema } }, required: true },
	},
	responses: {
		200: jsonContent(SuccessResponseSchema, 'The prior editor was saved and stopped'),
		...commonErrors(),
		...errorResponses(400, 403, 404, 409, 503),
	},
});

// --- App ---

/**
 * Project a stored Session onto the public Session response envelope, carrying
 * the caller's evaluated grants (`sessionGrantsFor`). `sandbox_url` rides on
 * `can.attach`: in `subdomain` exposure the URL is the kernel capability
 * itself (kernels run `--no-token`), so listing it to a caller the kernel
 * gates would reject hands them the kernel. Exposes `user_id` (who started it)
 * for the collaborative "started by" UI — visible only to users who can
 * already list the project's sessions. Internal infra fields (`sandbox_id`,
 * `used_fallback`) stay private.
 */
function toSessionResponse(s: Session, can: { attach: boolean; stop: boolean }) {
	return {
		session_id: s.session_id,
		notebook_id: s.notebook_id,
		project_id: s.project_id,
		user_id: s.user_id,
		status: s.status,
		sandbox_url: can.attach ? s.sandbox_url : undefined,
		can,
		started_at: s.started_at,
		last_heartbeat: s.last_heartbeat,
		ephemeral: s.ephemeral,
		editor_sandbox_sharing: s.editor_sandbox_sharing,
		ended_reason: s.ended_reason,
		ended_by_user_id: s.ended_by_user_id,
		// Defaulted in the projection so clients never see `undefined` (stored
		// records predating the field omit it).
		mode: sessionMode(s),
		source_version_id: s.source_version_id,
		active_connections: s.active_connections,
		connections_checked_at: s.connections_checked_at,
		compute_profile: s.compute_profile,
		compute_resources: s.compute_resources,
		compute_from_snapshot: s.compute_from_snapshot,
		integrations: s.integrations,
		// A provision failure's message can name the sandbox host — the very thing
		// withholding `sandbox_url` protects — so it rides the same grant.
		error: can.attach ? s.error : undefined,
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
 * Internal sentinel: another concurrent "Run as app" won the app claim. Carries
 * the winner's session id so the losing create can attach to it (returned as
 * `reused: true`) instead of surfacing an error.
 */
class AppClaimLostError extends Error {
	constructor(readonly holder: SessionId) {
		super('app claim lost');
	}
}

class EditorClaimLostError extends Error {
	constructor(readonly holder: SessionId) {
		super('editor claim lost');
	}
}

/**
 * The start gate — `canStartSessionMode` as a thrower, plus the session
 * classification: a viewer's admitted session is what
 * `MODE_POLICY[mode].viewerSession` says — their own ephemeral throwaway for
 * `edit`, the shared singleton for `app` (identical to an editor-started one,
 * WIF/secrets included).
 */
function authorizeSessionStart(
	project: Project,
	user: AuthUser,
	mode: SessionMode,
	policy: PolicyConfig,
): {
	role: ReturnType<typeof effectiveRole>;
	ephemeral: boolean;
	profileOverrideEligible: boolean;
	restrictedViewerCredentials: boolean;
} {
	const role = effectiveRole(project, user, policy);
	if (!canStartSessionMode({ role, viewerMode: policy.viewerMode }, mode)) {
		// Throws the canonical editor-gate 403 (canStart admits every editor+).
		requireRole(project, user, 'editor', policy);
	}
	const ephemeral = role === 'viewer' && MODE_POLICY[mode].viewerSession === 'ephemeral';
	return {
		role,
		ephemeral,
		// The notebook's configured profile applies to every editor/admin session and
		// to any shared (non-ephemeral) session: a shared app is the notebook's app and
		// must provision identically no matter who starts it. Only a viewer's own
		// ephemeral throwaway is forced onto the deployment default.
		profileOverrideEligible: !ephemeral,
		restrictedViewerCredentials: ephemeral,
	};
}

function resolveComputeProfile(
	sandbox: SandboxConfig,
	storedName: string | undefined,
	allowOverride: boolean,
	onFallback: (message: string) => void,
): { name: string | undefined; resources: NonNullable<SandboxConfig['resources']> } {
	const fallback = sandbox.computeProfiles?.[0] ?? {
		name: sandbox.computeProfile,
		resources: sandbox.resources ?? {},
	};
	if (!allowOverride || !storedName) return fallback;
	const selected = sandbox.computeProfiles?.find((profile) => profile.name === storedName);
	if (selected) return selected;
	onFallback(
		`Compute profile "${storedName}" is no longer configured; using default "${fallback.name ?? 'adapter default'}"`,
	);
	return fallback;
}

const CAP_REACHED = {
	appsPerProject: (max: number) =>
		`Concurrent app limit reached for this project (${max}). Stop an app before starting another.`,
	appsPerUser: (max: number) =>
		`Concurrent app limit reached (${max} apps started by you). Stop an app before starting another.`,
	sessionsPerUser: (max: number) =>
		`Concurrent session limit reached (${max}). Terminate a session before starting another.`,
};

/**
 * The caps that apply to `mode`, each with the queue it bounds. Edit sessions
 * consume the per-user cap. Apps are capped per project AND per starter: without
 * the latter, a user could escape the cost bound entirely by fanning apps out
 * across (freely creatable) projects. Shared apps are few per person, so the
 * starter bound rarely binds on legitimate use.
 */
function capsFor(deps: ApiDeps, mode: SessionMode, pid: ProjectId, userId: UserId) {
	const { sessions } = deps.services;
	const maxSessions = deps.policy.maxConcurrentSessionsPerUser;
	if (MODE_POLICY[mode].capScope === 'project') {
		return [
			{
				max: deps.policy.maxAppsPerProject,
				message: CAP_REACHED.appsPerProject,
				queue: () => sessions.listActiveAppsForProject(pid),
			},
			{
				max: maxSessions,
				message: CAP_REACHED.appsPerUser,
				queue: () => sessions.listActiveForUser(userId, 'project'),
			},
		];
	}
	return [
		{
			max: maxSessions,
			message: CAP_REACHED.sessionsPerUser,
			queue: () => sessions.listActiveForUser(userId),
		},
	];
}

/**
 * Cost-DoS guards, checked after reuse so a reconnect/attach never trips them.
 * Cheap pre-flight: rejects before any record or sandbox exists. Not sufficient
 * on its own — see `assertCapAfterCreate`.
 */
async function enforceSessionCap(
	deps: ApiDeps,
	mode: SessionMode,
	pid: ProjectId,
	userId: UserId,
	excludedSessionId?: SessionId,
): Promise<void> {
	for (const cap of capsFor(deps, mode, pid, userId)) {
		if (!cap.max || cap.max <= 0) continue;
		const queued = (await cap.queue()).filter(
			(session) => session.session_id !== excludedSessionId,
		);
		if (queued.length >= cap.max) {
			throw new ResourceExhaustedError(cap.message(cap.max));
		}
	}
}

/**
 * Close the count-then-create window: N concurrent creates all clear the
 * pre-flight check, because none of their records exists yet. Once the record IS
 * written every racer reads the same set, so ranking by start order admits
 * exactly `max` of them — the rest abort and compensate. Ranking (not counting)
 * is what avoids the other failure mode, where each racer rejects every other.
 */
async function assertCapAfterCreate(
	deps: ApiDeps,
	mode: SessionMode,
	pid: ProjectId,
	userId: UserId,
	sessionId: SessionId,
	excludedSessionId?: SessionId,
): Promise<void> {
	for (const cap of capsFor(deps, mode, pid, userId)) {
		if (!cap.max || cap.max <= 0) continue;
		const rank = (await cap.queue())
			.filter((session) => session.session_id !== excludedSessionId)
			.findIndex((s) => s.session_id === sessionId);
		// rank < 0: our record went terminal underneath us — nothing left to cap.
		if (rank >= cap.max) throw new ResourceExhaustedError(cap.message(cap.max));
	}
}

const app = createApp();

app.openapi(listSessions, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	// Read-only project-scoped data, gated at `viewer` like the notebook-list route:
	// open when a default role is set, members-only under MARIMOHUB_DEFAULT_ROLE=none.
	// The project is loaded (not just visibility-checked) to gate each item's
	// kernel URL and `can` grants by the caller's role (see sessionGrantsFor).
	const project = await loadVisibleProject(projects, pid, user, deps.policy);
	const active = await sessions.listActiveByProject(pid);
	const data = paginate(
		active.map((s) => toSessionResponse(s, sessionGrantsFor(project, user, s, deps.policy))),
		c.req.valid('query'),
		{
			key: (s) => s.started_at,
			tiebreak: (s) => s.session_id,
		},
	);
	return c.json({ success: true, data }, 200);
});

app.openapi(getSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');
	// Read-only, project-scoped (matches listSessions). The project-scoped key 404s
	// a cross-project id; the notebook check keeps a same-project/other-notebook id
	// out of scope.
	const project = await loadVisibleProject(projects, pid, user, deps.policy);
	const session = await sessions.getSession(pid, sid);
	if (session.notebook_id !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}
	return c.json(
		{
			success: true,
			data: toSessionResponse(session, sessionGrantsFor(project, user, session, deps.policy)),
		},
		200,
	);
});

async function inspectEditorActivity(deps: ApiDeps, session: Session) {
	if (session.status === 'starting') return { state: 'starting' as const };
	if (session.status !== 'running' || !session.sandbox_id) {
		return { state: 'unknown' as const };
	}
	let basePath = '';
	try {
		basePath = session.sandbox_url ? new URL(session.sandbox_url).pathname.replace(/\/$/, '') : '';
	} catch {
		basePath = '';
	}
	const active = await kernelActiveConnections(deps.compute.create(session.sandbox_id), basePath);
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

app.openapi(getEditorSession, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await deps.services.projects.getProject(pid);
	if (project.status === 'deleted') throw new NotFoundError(`Project ${pid} not found`);
	requireRole(project, user, 'editor', deps.policy);
	const notebook = await deps.services.notebooks.getNotebook(pid, nid);
	if (notebook.meta.status === 'deleted') throw new NotFoundError(`Notebook ${nid} not found`);
	const claim = await deps.services.sessions.getEditorClaim(pid, nid);
	const sharing = effectiveEditorSharing(claim, deps.policy.editorSandboxSharing);
	const holder = claim?.session_id
		? await deps.services.sessions.getSession(pid, claim.session_id).catch(() => null)
		: undefined;
	const activity = holder ? await inspectEditorActivity(deps, holder) : undefined;
	return c.json(
		{
			success: true,
			data: {
				sharing,
				holder:
					holder &&
					(holder.status === 'starting' ||
						holder.status === 'running' ||
						holder.status === 'terminating')
						? {
								session_id: holder.session_id,
								user_id: holder.user_id,
								status: holder.status,
								started_at: holder.started_at,
								activity: activity!,
							}
						: null,
				can_take_over:
					sharing === 'exclusive' && !!holder && holder.user_id !== user.id && !claim?.transfer,
				...(claim?.transfer ? { transfer: { status: claim.transfer.phase } } : {}),
			},
		},
		200,
	);
});

app.openapi(takeoverEditorSession, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const body = c.req.valid('json');
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
		deps.services.events
			.append({
				event,
				actor: user.id,
				project_id: pid,
				notebook_id: nid,
				session_id: body.expected_holder_session_id,
				takeover_id: body.takeover_id,
			})
			.catch(() => {});
	const assertAccess = async () => {
		const project = await deps.services.projects.getProject(pid);
		if (project.status === 'deleted') throw new NotFoundError(`Project ${pid} not found`);
		requireRole(project, user, 'editor', deps.policy);
		const notebook = await deps.services.notebooks.getNotebook(pid, nid);
		if (notebook.meta.status === 'deleted') throw new NotFoundError(`Notebook ${nid} not found`);
	};
	try {
		await assertAccess();
		const currentClaim = await deps.services.sessions.getEditorClaim(pid, nid);
		if (effectiveEditorSharing(currentClaim, deps.policy.editorSandboxSharing) !== 'exclusive') {
			throw new BadRequestError('Takeover is only available in exclusive editor mode');
		}
		const claim = await deps.services.sessions.reserveTakeover(pid, nid, {
			takeoverId: body.takeover_id,
			requestedBy: user.id,
			expectedHolder: body.expected_holder_session_id,
			expectedActivity: body.expected_activity,
		});
		observer.tag('phase', claim.transfer?.phase ?? 'changed');
		await audit('session.takeover.request');
		if (claim.transfer?.phase === 'ready') {
			await audit('session.takeover.success');
			return c.json({ success: true }, 200);
		}
		const holder = await deps.services.sessions.getSession(pid, body.expected_holder_session_id);
		if (claim.transfer?.phase === 'draining') {
			try {
				const completed = await sessionRetirer(deps).completeTakeoverDrain(
					holder,
					body.takeover_id,
					crypto.randomUUID(),
				);
				if (!completed) throw new Error('Another request owns the takeover drain lease');
				await audit('session.takeover.success');
				return c.json({ success: true }, 200);
			} catch {
				throw new UnavailableError(
					'The prior editor is still shutting down; retry this takeover shortly',
				);
			}
		}
		if (holder.notebook_id !== nid || holder.user_id === user.id || holder.ephemeral) {
			await deps.services.sessions.cancelRequestedTakeover(pid, nid, body.takeover_id);
			throw new BadRequestError('The selected session cannot be taken over');
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
			if (err instanceof TakeoverRetirementError && err.drainStarted) {
				await deps.services.sessions
					.setTakeoverPhase(pid, nid, body.takeover_id, 'draining')
					.catch(() => {});
			} else {
				await deps.services.sessions.cancelRequestedTakeover(pid, nid, body.takeover_id);
			}
			throw new UnavailableError(
				'Could not safely save and stop the current editor; no replacement was started',
			);
		}
		await audit('session.takeover.success');
		return c.json({ success: true }, 200);
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
});

app.openapi(createSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects, notebooks } = deps.services;
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const body = c.req.valid('json');
	const mode: SessionMode = body?.mode ?? 'edit';

	// Starting a session runs code — see authorizeSessionStart for the matrix.
	// The loaded project is reused below (federation opt-in), not re-fetched.
	// A soft-deleted project reads as gone here as it does on every read route: its
	// bytes linger until GC, but no new kernel may serve them.
	const project = await projects.getProject(pid);
	if (project.status === 'deleted') {
		throw new NotFoundError(`Project ${pid} not found`);
	}
	const authorization = authorizeSessionStart(project, user, mode, deps.policy);
	const existingEditorClaim = mode === 'edit' ? await sessions.getEditorClaim(pid, nid) : undefined;
	const sharing = effectiveEditorSharing(existingEditorClaim, deps.policy.editorSandboxSharing);
	const replacingAfterTakeover =
		existingEditorClaim?.transfer?.phase === 'ready' &&
		existingEditorClaim.transfer.requested_by === user.id;
	const editorTemporary =
		mode === 'edit' &&
		body?.edit_intent === 'temporary' &&
		(authorization.role === 'editor' || authorization.role === 'admin');
	if (body?.edit_intent && mode !== 'edit') {
		throw new BadRequestError('edit_intent is only valid for edit sessions');
	}
	if (editorTemporary && sharing === 'shared') {
		throw new BadRequestError('Temporary editor sessions are only available in exclusive mode');
	}
	const ephemeral = authorization.ephemeral || editorTemporary;
	const profileOverrideEligible = authorization.profileOverrideEligible;
	const restrictedViewerCredentials = authorization.restrictedViewerCredentials;
	const grants = (s: Session) => sessionGrantsFor(project, user, s, deps.policy);

	// Verify the notebook exists in this project — throws NotFoundError (→ 404)
	// otherwise. Prevents provisioning a billable sandbox for a bogus notebook id.
	// A soft-deleted notebook is treated as missing: getNotebook still serves it
	// (the delete/GC paths need that), but starting a session on it would serve
	// deleted content — and, for `app`, recreate the singleton claim that
	// deleteNotebook just cleaned up, permanently (its cleanup never runs again).
	const notebook = await notebooks.getNotebook(pid, nid);
	if (notebook.meta.status === 'deleted') {
		throw new NotFoundError(`Notebook ${nid} not found`);
	}
	const workspacePolicy = workspaceSourcePolicy(notebook.source);
	// Synced sources are read-only mirrors served from the immutable workspace of the
	// version the source currently points at; a session can't start before a push.
	const syncedVersionId = workspacePolicy.persistSessionEdits
		? undefined
		: notebook.source.current_version_id;
	if (!workspacePolicy.persistSessionEdits && !syncedVersionId) {
		throw new BadRequestError('Synced notebook has not been synced yet');
	}
	const workspacePrefix = syncedVersionId
		? paths.project(pid).notebook(nid).version(syncedVersionId).workspacePrefix
		: undefined;
	// Staleness provenance: a session that serves a frozen snapshot — a
	// non-persisting mode (`app`), or any mode on a synced source (a read-only
	// mirror, even under `edit`) — is stamped with the head committed version it
	// was provisioned from. The client compares it against the live head for the
	// "session is stale" banners.
	const sourceVersionId =
		syncedVersionId ??
		(MODE_POLICY[mode].persistsEdits
			? undefined
			: (notebook.source.current_version_id ?? undefined));

	const { compute, bucket: bucketHandle, sandbox } = deps;
	// The notebook's stored choice, resolved leniently: "default"/absent → first
	// configured image; a choice that fell off the list falls back with a warning
	// rather than blocking the session.
	const image = resolveBaseImage(notebook.meta.base_image, sandbox.images ?? [], (msg) =>
		console.warn(`[session] ${msg} (project=${pid} notebook=${nid})`),
	);
	const retryWithDefault = mode === 'edit' && body?.compute_profile === 'default';
	const requestedComputeProfile = resolveComputeProfile(
		sandbox,
		retryWithDefault ? undefined : notebook.meta.compute_profile,
		sandbox.computeProfileOverride === 'editors' && profileOverrideEligible,
		(msg) => console.warn(`[session] ${msg} (project=${pid} notebook=${nid})`),
	);
	const provisioner = new SandboxProvisioner(compute);

	// Reuse follows the session class: the claimed editor sandbox, the caller's
	// temporary editor, or the notebook app. Check before the cap and before any
	// compute call. A `starting` reuse has no URL yet; the client polls
	// `GET …/sessions/{sid}` until it is `running`.
	const editorReuse =
		mode === 'edit'
			? await sessions.findReusableEditor(pid, nid, user.id, sharing, ephemeral)
			: undefined;
	if (editorReuse?.takeoverInProgress) throw new TakeoverInProgressError();
	if (editorReuse?.ownedByOther) {
		throw new EditSessionOwnedError(
			`Editing is currently owned by ${editorReuse.ownedByOther.user_id}`,
		);
	}
	const reusable =
		mode === 'edit' ? editorReuse?.session : await sessions.findReusable(pid, nid, user.id, mode);
	if (reusable) {
		// A role change flips the session class the caller is entitled to (a demoted
		// editor must not keep a persisting, WIF-holding kernel; a promoted viewer's
		// edits must stop being discarded). A stale-class session is retired below
		// like a dead kernel instead of reused.
		const classMismatch = !!reusable.ephemeral !== ephemeral;
		// findReusable is user-blind for the shared app, so this may be someone
		// else's running app. Only a caller who could stop it outright may
		// retire-and-replace it — otherwise a viewer's create (or a probe
		// false-negative under load) tears the app down under everyone.
		const mayRetire = !MODE_POLICY[mode].singleton || grants(reusable).stop;
		// Only a `running` reconnect can hit a dead kernel; a `starting` reuse has no
		// kernel yet. Probe what the browser would hit (origin in proxy mode, else url).
		const kernelUrl =
			mayRetire && reusable.status === 'running' && reusable.sandbox_id
				? (reusable.sandbox_origin_url ?? reusable.sandbox_url)
				: undefined;
		const dead =
			!!kernelUrl && !!deps.kernelProbe && (await deps.kernelProbe(kernelUrl)) === 'dead';
		if (!mayRetire || (!dead && !classMismatch)) {
			return c.json(
				{
					success: true,
					data: {
						...toSessionResponse(reusable, grants(reusable)),
						reused: true,
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
					},
				},
				200,
			);
		}

		// Sandbox alive but marimo exited (e.g. shut down from the notebook UI), so a
		// reconnect would 502. Retire it the way an explicit stop does — teardown reads
		// the notebook back from the still-live container and cuts a version the fresh
		// sandbox restores — then fall through to provision a new one. Best-effort, so a
		// concurrent refresh that also saw `dead` does no harm.
		const claimed = await sessions.beginTerminating(reusable.project_id, reusable.session_id);
		// Skip the sandbox work unless this call won the terminating transition —
		// a concurrent stop that won owns the teardown.
		await sessionRetirer(deps).retire(reusable, { teardown: claimed.transitioned });
	}

	const temporaryToRetire = replacingAfterTakeover
		? (await sessions.findReusableEditor(pid, nid, user.id, 'exclusive', true)).session
		: undefined;
	await enforceSessionCap(deps, mode, pid, user.id, temporaryToRetire?.session_id);

	const sandboxId = createSandboxId();

	// createApi defaults this; the fallback satisfies the type for direct callers.
	const sandboxExposure = sandbox.exposure ?? new SubdomainExposure();
	const restoreFilesystemSnapshot =
		!ephemeral && workspacePolicy.restoreFilesystemSnapshot
			? await resolveRestoreSnapshot(compute, notebooks, pid, nid, {
					sharing: mode === 'edit' ? sharing : 'shared',
					userId: user.id,
				})
			: undefined;
	const appliedComputeProfile = restoreFilesystemSnapshot
		? {
				name: restoreFilesystemSnapshot.compute_profile,
				resources: restoreFilesystemSnapshot.compute_resources,
			}
		: {
				name: requestedComputeProfile.name,
				resources: toComputeResourcesResponse(requestedComputeProfile.resources),
			};

	const hostname = sandbox.hostname || new URL(c.req.url).hostname;
	// App origin for building proxy-mode client URLs; falls back to this request.
	const appBaseUrl = sandbox.appBaseUrl ?? new URL(c.req.url).origin;

	// Provision as a saga: if a later step fails, completed steps compensate in
	// reverse — the session record is terminated (so it does not linger in
	// `starting` and the reaper collects it) and a provisioned sandbox is
	// destroyed. A failure *inside* provisioning self-cleans (see
	// SandboxProvisioner.provision); the saga handles failures after it.
	let session: Session | undefined;
	let updated: Session | undefined;
	let url = '';
	let usedFallback = false;
	// Audit pin for the integration versions rendered into this sandbox.
	let integrationAttachments: SessionRender['attachments'] | undefined;
	// In subdomain mode clientUrl === url and originUrl is unset.
	let clientUrl = '';
	let originUrl: string | undefined;
	const observer = logObserver({
		event: 'session_provision',
		sandbox_id: sandboxId,
		project_id: pid,
		notebook_id: nid,
		user_id: user.id,
		mode,
	});
	try {
		await saga(observer)
			.step('session_record', async () => {
				session = await sessions.createSession({
					notebook_id: nid,
					project_id: pid,
					user_id: user.id,
					sandbox_id: sandboxId,
					compute_profile: appliedComputeProfile.name,
					compute_resources: appliedComputeProfile.resources,
					compute_from_snapshot: restoreFilesystemSnapshot !== undefined,
					ephemeral,
					mode,
					source_version_id: sourceVersionId,
					editor_sandbox_sharing: mode === 'edit' ? sharing : undefined,
				});
			})
			// The pre-flight cap check alone is raceable; re-rank now that this
			// session is visible to every concurrent create.
			.step('cap_recheck', () =>
				assertCapAfterCreate(
					deps,
					mode,
					pid,
					user.id,
					session!.session_id,
					temporaryToRetire?.session_id,
				),
			)
			// The app singleton: exactly one concurrent "Run as app" wins the
			// per-notebook claim; a loser aborts before provisioning (no second
			// sandbox) and attaches to the winner in the catch below.
			.step('app_claim', {
				do: async () => {
					if (!MODE_POLICY[mode].singleton) return;
					const claim = await sessions.claimApp(pid, nid, session!.session_id);
					if (!claim.claimed) throw new AppClaimLostError(claim.holder);
				},
				compensate: async () => {
					if (session) await sessions.releaseAppFor(session);
				},
			})
			.step('editor_claim', {
				do: async () => {
					if (mode !== 'edit' || ephemeral) return;
					const result = await sessions.claimEditor(
						pid,
						nid,
						session!.session_id,
						sharing,
						user.id,
					);
					if (!result.claimed && result.claim.session_id) {
						throw new EditorClaimLostError(result.claim.session_id);
					}
				},
				compensate: async () => {
					if (session) await sessions.releaseEditorFor(session);
				},
			})
			.step('sandbox_provision', {
				do: async () => {
					// `prepare` picks marimo's `--base-url`; `finalize` maps the adapter's
					// exposed URL to the client URL + the origin to persist.
					const exposureCtx = {
						sessionId: session!.session_id,
						projectId: pid,
						notebookId: nid,
						sandboxId,
						appBaseUrl,
					};
					// WIF: best-effort project-scoped federated S3 creds; never for a
					// viewer sandbox. A federation/policy gap yields no creds,
					// never a failed kernel. jwt/creds are never logged.
					const resolveWifVars = async () => {
						if (!(deps.wif && project.federation?.enabled && !restrictedViewerCredentials)) {
							return;
						}
						try {
							return await exchangeFederatedStorageEnv(
								deps.wif.issuer,
								deps.wif.issuerUrl,
								deps.wif.target,
								pid,
								session!.session_id,
							);
						} catch (err) {
							observer.tag('wif_exchange_failed', true);
							observer.tag(
								'wif_exchange_error',
								err instanceof Error ? `${err.name}: ${err.message}` : String(err),
							);
							return;
						}
					};

					const resolveMarimoConfigEnv = async () => {
						if (!MODE_POLICY[mode].injectEditorConfig) return;
						const contributors: MarimoConfigContributor[] = [
							marimoNotebookDefaults,
							marimoSharingDisabled,
						];
						if (deps.ai) {
							try {
								const token = await mintAiSessionToken(
									deps.ai.signingSecret,
									{
										projectId: pid,
										notebookId: nid,
										sessionId: session!.session_id,
										userId: user.id,
									},
									{ ttlSeconds: deps.ai.tokenTtlSeconds },
								);
								contributors.push(
									marimoAiContributor({
										baseUrl: `${appBaseUrl}/api/ai/v1`,
										apiKey: token,
										model: deps.ai.model,
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
						return marimoConfigToSessionEnv(contributors);
					};

					// Project secrets: unlike WIF/AI, this FAILS CLOSED — a key the author
					// configured is load-bearing, so a resolve failure aborts session create
					// rather than starting a kernel that silently lacks it. Viewer sandboxes
					// are restricted; temporary editor sandboxes retain editor credentials.
					const resolveSecretVars = async () => {
						if (!(deps.secrets && !restrictedViewerCredentials)) return;
						try {
							const vars = await deps.secrets.resolve(pid);
							observer.tag('secrets_injected_count', Object.keys(vars).length);
							return vars;
						} catch (err) {
							observer.tag('secret_resolution_failed', true);
							// The resolver's message can quote the value it failed on, so the
							// error must not be carried anywhere — as `cause` it would reach the
							// request log through `describeError`'s chain.
							for (const [key, value] of Object.entries(errorMetadata(err))) {
								observer.tag(`secrets_${key}`, value);
							}
							throw new UnavailableError(
								'secret_resolution_failed: could not resolve this project’s secrets',
							);
						}
					};

					// Integrations: like secrets, FAILS CLOSED — a configured data source is
					// load-bearing, so a render failure aborts provisioning rather than
					// starting a sandbox with partial config. Viewer sandboxes are restricted;
					// temporary editor sandboxes retain editor credentials.
					const resolveIntegrationEnv = async () => {
						if (!(deps.integrations && !restrictedViewerCredentials)) return;
						try {
							const render = await deps.integrations.resolveForSession(pid, {
								sessionId: session!.session_id,
								principal: { userId: user.id, email: user.email },
							});
							if (render) {
								observer.tag('integrations_rendered_count', render.attachments.length);
								integrationAttachments = render.attachments;
							}
							return render;
						} catch (err) {
							observer.tag('integration_render_failed', true);
							for (const [key, value] of Object.entries(errorMetadata(err))) {
								observer.tag(`integrations_${key}`, value);
							}
							// Only curated validation errors are safe to return to the caller.
							if (err instanceof ValidationError) throw err;
							throw new UnavailableError(
								'integration_render_failed: could not render this project’s integrations',
							);
						}
					};

					// The four sources are independent, so resolve them together. Precedence
					// on an env-name collision, lowest to highest: project secrets <
					// integrations < system/WIF/marimo-config — user-supplied values can
					// never shadow the hub's own injected vars.
					const resolveSessionEnv = async (): Promise<SessionEnv | undefined> => {
						const [wifVars, marimoEnv, secretVars, integrationEnv] = await Promise.all([
							resolveWifVars(),
							resolveMarimoConfigEnv(),
							resolveSecretVars(),
							resolveIntegrationEnv(),
						]);
						let env: SessionEnv | undefined = wifVars ? { vars: wifVars } : undefined;
						if (marimoEnv) env = mergeSessionEnv(env, marimoEnv);
						// The lower-precedence layers merge as the BASE, with everything
						// resolved so far as the winning overlay.
						if (integrationEnv) env = mergeSessionEnv(integrationEnv, env ?? {});
						if (secretVars) env = mergeSessionEnv({ vars: secretVars }, env ?? {});
						return env;
					};

					// Unawaited on purpose: provision awaits it at the inject phase, so this
					// resolution overlaps the sandbox create (the dominant cost). The no-op
					// catch only marks the rejection handled — a fail-closed secrets error
					// would otherwise land as an unhandledRejection during the create.
					const sessionEnv = resolveSessionEnv();
					void sessionEnv.catch(() => {});

					const { baseUrl } = await sandboxExposure.prepare(exposureCtx);

					const provisionResult = await provisioner.provision({
						sandboxId,
						projectId: pid,
						notebookId: nid,
						hostname,
						bucket: sandbox.bucket,
						bucketHandle,
						workdir: sandbox.workdir,
						assetUrl: sandbox.assetUrl,
						baseUrl,
						restoreFilesystemSnapshotId: restoreFilesystemSnapshot?.snapshot_id,
						image,
						resources: requestedComputeProfile.resources,
						sessionEnv,
						entryNotebook: workspacePolicy.entryNotebook,
						launchMode: mode,
						// Ephemeral and app sandboxes never mount the live workspace: a mount
						// writes straight through to the bucket (bypassing every persistEdits
						// guard), puts the deployment's bucket credentials inside a viewer's
						// sandbox, and — for apps — would race the edit kernel's autosaves on
						// the same objects. Copy-only loads the files server-side.
						workspaceLoadMode:
							ephemeral || MODE_POLICY[mode].workspaceLoad === 'copy-only'
								? 'copy-only'
								: workspacePolicy.loadMode,
						workspacePrefix,
					});
					({ url, usedFallback } = provisionResult);
					// Per-phase durations onto the session_provision event.
					for (const [phase, ms] of Object.entries(provisionResult.timings)) {
						observer.tag(`provision_${phase}_ms`, ms);
					}
					// Counts, not durations: workspace objects/bytes copied, and the
					// command round-trips the provision spent.
					for (const [name, value] of Object.entries(provisionResult.counters)) {
						observer.tag(`provision_${name}`, value);
					}
					// Whether the files phase mounted the bucket (false) or copied it in
					// (true) — files is the largest phase, so this says which path to optimize.
					observer.tag('provision_used_fallback', usedFallback);
					({ clientUrl, originUrl } = await sandboxExposure.finalize(url, exposureCtx));
				},
				compensate: () => compute.create(sandboxId).destroy(),
			})
			.step('mark_running', async () => {
				// The lifetime clock starts here — when the kernel is live, not at record
				// creation — so provisioning time never eats into the session TTL.
				const ttlMs = sandbox.sessionLifetime?.maxLifetimeMs;
				updated = await sessions.setRunning(
					pid,
					session!.session_id,
					clientUrl,
					usedFallback,
					originUrl,
					ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
					integrationAttachments,
				);
			})
			// A slow provision looks like a wedged holder once the `starting` record
			// ages past the liveness window, so a second "Run as app" may steal the
			// claim mid-provision. Re-assert it AFTER the record is `running` (a
			// running holder is never treated as stale, so no later steal is
			// possible): if it was stolen, this saga compensates — the sandbox is
			// destroyed, the record terminated — and the caller attaches to the
			// thief. Without this, both provisions would finish `running` and the
			// per-notebook singleton would be two apps.
			.step('app_claim_recheck', async () => {
				if (!MODE_POLICY[mode].singleton) return;
				const claim = await sessions.claimApp(pid, nid, session!.session_id);
				if (!claim.claimed) throw new AppClaimLostError(claim.holder);
			})
			.step('editor_claim_recheck', async () => {
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
				const result = await sessions.claimEditor(pid, nid, session!.session_id, sharing, user.id);
				if (!result.claimed && result.claim.session_id) {
					throw new EditorClaimLostError(result.claim.session_id);
				}
			})
			// A delete only retires sessions that are already `running`, so one that
			// lands mid-provision leaves this kernel serving deleted content — and,
			// for an app, the recheck above just re-created the claim `deleteNotebook`
			// cleaned up. Abort so the saga destroys the sandbox and drops the claim.
			// Past this step the record is `running`, so a later delete catches it —
			// and a delete writes the status before it lists sessions to retire, so
			// nothing falls between the two.
			.step('notebook_recheck', async () => {
				const current = await notebooks.getNotebook(pid, nid).catch(() => null);
				if (!current || current.meta.status === 'deleted') {
					throw new NotFoundError(`Notebook ${nid} not found`);
				}
			})
			// The same race one level up, which the check above does NOT cover: a
			// soft-deleted project keeps its notebooks readable until GC, so
			// `getNotebook` still answers `active`.
			.step('project_recheck', async () => {
				const current = await projects.getProject(pid).catch(() => null);
				if (!current || current.status === 'deleted') {
					throw new NotFoundError(`Project ${pid} not found`);
				}
			})
			.run();
	} catch (err) {
		if (err instanceof EditorClaimLostError) {
			observer.tag('editor_claim_lost', true);
			if (session) await sessions.markTerminated(pid, session.session_id).catch(() => {});
			const winner = await sessions.getSession(pid, err.holder).catch(() => null);
			if (winner?.notebook_id === nid && sessionMode(winner) === 'edit') {
				if (sharing === 'exclusive' && winner.user_id !== user.id) {
					throw new EditSessionOwnedError(`Editing is currently owned by ${winner.user_id}`);
				}
				return c.json(
					{
						success: true,
						data: {
							...toSessionResponse(winner, grants(winner)),
							reused: true,
							editor_session: {
								sharing,
								access: sharing === 'shared' ? ('shared' as const) : ('owner' as const),
							},
						},
					},
					200,
				);
			}
			throw new ConflictError('The editor session changed. Retry shortly.');
		}
		if (err instanceof AppClaimLostError) {
			// Lost the app singleton — at the initial claim (nothing provisioned yet)
			// or at the post-provision recheck (the saga compensation just destroyed
			// our sandbox). Either way: retire our record and attach to the winner
			// exactly as the reuse path would have.
			observer.tag('app_claim_lost', true);
			if (session) {
				await sessions.markTerminated(pid, session.session_id).catch(() => {});
			}
			const winner = await sessions.getSession(pid, err.holder).catch(() => {});
			if (winner && winner.notebook_id === nid && sessionModePolicy(winner).singleton) {
				return c.json(
					{ success: true, data: { ...toSessionResponse(winner, grants(winner)), reused: true } },
					200,
				);
			}
			// The winner vanished between claim and read — rare; the client retries.
			throw new ConflictError('The app is being started by another user. Retry shortly.');
		}
		// Record WHY the session failed so the client polling `GET …/sessions/{sid}`
		// sees a reason, not a bare `failed`. Best-effort (never mask the original
		// error): a marking failure just leaves the record for the stale reaper, and
		// markFailed no-ops if a concurrent stop already made it terminal.
		if (session) {
			await sessions.markFailed(pid, session.session_id, toSessionError(err)).catch(() => {});
		}
		throw err;
	} finally {
		observer.flush();
	}

	if (replacingAfterTakeover && temporaryToRetire) {
		const claimed = await sessions.beginTerminating(pid, temporaryToRetire.session_id);
		await sessionRetirer(deps).retire(temporaryToRetire, {
			teardown: claimed.transitioned,
		});
	}

	// An app start puts a (possibly secrets/WIF-bearing) kernel in front of the
	// whole admitted audience — who did it belongs in the project's event log.
	// Best-effort like every audit append.
	if (MODE_POLICY[mode].singleton) {
		await deps.services.events
			.append({
				event: 'app.start',
				actor: user.id,
				project_id: pid,
				notebook_id: nid,
				session_id: session!.session_id,
			})
			.catch(() => {});
	}

	return c.json(
		{
			success: true,
			data: {
				...toSessionResponse(updated!, grants(updated!)),
				reused: false,
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
			},
		},
		200,
	);
});

app.openapi(deleteSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Project visibility FIRST (404 when hidden, matching getSession) — resolving
	// the session before it would let 403-vs-404 leak whether a session id exists
	// in a project the caller cannot see.
	const project = await loadVisibleProject(projects, pid, user, deps.policy);

	// Scope-check: the project-scoped key 404s a cross-project id; the notebook
	// check keeps a same-project/other-notebook id out of scope.
	const existing = await sessions.getSession(pid, sid);
	if (existing.notebook_id !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	// Terminating a session tears down a running kernel — editor+, or the owner of
	// their own ephemeral session (role re-checked; see assertSessionControl).
	assertSessionControl(project, existing, user, deps.policy);

	// Mark `terminating` first (atomic): pollers immediately see `Stopping…` while
	// the retire below runs, instead of a stale `running`. The CAS in the service
	// makes this stick even against an in-flight heartbeat. Only the caller that
	// won the transition runs the teardown — a concurrent stop's loser must not
	// save-and-destroy the same sandbox twice.
	const { session, transitioned } = await sessions.beginTerminating(pid, sid);

	await sessionRetirer(deps).retire(session, { teardown: transitioned });

	return c.json({ success: true }, 200);
});

app.openapi(heartbeatSession, async (c) => {
	const deps = c.get('deps');
	const { sessions, projects } = deps.services;
	const user = c.get('user');
	const { pid, nid, sid } = c.req.valid('param');

	// Project visibility FIRST (404 when hidden) — see the delete route.
	const project = await loadVisibleProject(projects, pid, user, deps.policy);

	// Scope-check: the project-scoped key 404s a cross-project id; the notebook
	// check keeps a same-project/other-notebook id out of scope.
	const existing = await sessions.getSession(pid, sid);
	if (existing.notebook_id !== nid) {
		throw new NotFoundError(`Session ${sid} not found`);
	}

	// Access-level gate, not control: an admitted viewer watching the shared app
	// must keep it alive too (see assertSessionAccess).
	assertSessionAccess(project, existing, user, deps.policy);

	const updated = await sessions.heartbeat(pid, sid);

	return c.json(
		{
			success: true,
			data: toSessionResponse(updated, sessionGrantsFor(project, user, updated, deps.policy)),
		},
		200,
	);
});

export default app;

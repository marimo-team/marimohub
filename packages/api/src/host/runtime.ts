import {
	EditSessionOwnedError,
	EditSessionChangedError,
	NotFoundError,
	SandboxProvisioner,
	SessionId,
	reconnectSessionSandbox,
	sessionSandbox,
	sessionPersistsEdits,
	sessionWorkspaceDir,
	UnavailableError,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, NotebookDetail, Project, Session } from '@marimo-hub/core';
import { requestRuntimeHost } from '@marimo-hub/core/host-bridge';
import type { HostRequest } from '@marimo-hub/core/host-bridge';
import { sha256Hex } from '@marimo-hub/core/sha256';
import { HostProblemError } from '@marimo-hub/host-protocol';
import type { ApiDeps, ResolvedApiDeps } from '../context';
import { notebookBridgeFor } from '../mcp/bridge';
import {
	authorizeMcpSession,
	SessionAuthorizationExpiredError,
	SessionEndedError,
	withMcpSessionActivity,
} from '../mcp/sessionActivity';
import {
	getEditorSessionState,
	startNotebookSession,
	takeOverNotebookEditor,
} from '../routes/sessionStart';

export const DECISION_PREFIX = 'hub-editor:';

/** What session start and takeover record about the originating request. */
export interface HostSessionRequest {
	requestId?: string;
	method: string;
	path: string;
	hostname: string;
	appBaseUrl: string;
	signal?: AbortSignal;
}

async function editorProblem(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	project: Project,
	notebook: NotebookDetail,
) {
	const state = await getEditorSessionState(deps, user, project.id, notebook.meta.id);
	if (!state.can_take_over || !state.holder)
		return HostProblemError.conflict('The editor session changed; retry runtime.start');
	const holder = state.holder;
	return HostProblemError.decisionRequired(
		'Another user owns the editor. Submit a choice to runtime.start with a new Idempotency-Key.',
		[
			{
				id: `${DECISION_PREFIX}${holder.session_id}:${holder.activity.state}`,
				prompt: `Another user owns this editor (${holder.activity.state}). Taking over saves and stops their sandbox.`,
				options: [
					{ id: 'cancel', label: 'Cancel' },
					{ id: 'takeover', label: 'Take over editing, running, and saving' },
					{ id: 'temporary', label: 'Start a separate sandbox without saving' },
				],
			},
		],
	);
}

export async function ensureHostSession(
	deps: ResolvedApiDeps,
	user: AuthenticatedPrincipal,
	request: HostSessionRequest,
	project: Project,
	notebook: NotebookDetail,
	options: { session?: Session; decisions?: Record<string, string>; key?: string } = {},
): Promise<Session> {
	let session = options.session;
	let temporary = false;
	const choices = Object.entries(options.decisions ?? {}).filter(([id]) =>
		id.startsWith(DECISION_PREFIX),
	);
	if (choices.length > 1) throw HostProblemError.invalidRequest('Choose one editor decision');
	if (choices.length > 0) {
		if (session)
			throw HostProblemError.invalidRequest('Temporary notebooks cannot take over an editor');
		const [id, choice] = choices[0];
		const [holder, activity, extra] = id.slice(DECISION_PREFIX.length).split(':');
		if (
			!SessionId.is(holder) ||
			!['active', 'idle', 'unknown', 'starting'].includes(activity) ||
			extra !== undefined ||
			!['cancel', 'takeover', 'temporary'].includes(choice)
		)
			throw HostProblemError.invalidRequest('Invalid editor decision');
		if (choice === 'cancel') throw HostProblemError.conflict('Runtime start cancelled');
		if (choice === 'temporary') {
			const state = await getEditorSessionState(deps, user, project.id, notebook.meta.id);
			if (!state.can_take_over || state.holder?.session_id !== holder)
				throw await editorProblem(deps, user, project, notebook);
			temporary = true;
		} else {
			const claim = await deps.services.sessions.getEditorClaim(project.id, notebook.meta.id);
			let current: Session | undefined;
			if (claim?.session_id) {
				try {
					current = await deps.services.sessions.getSession(project.id, claim.session_id);
				} catch (error) {
					if (!(error instanceof NotFoundError)) throw error;
					throw await editorProblem(deps, user, project, notebook);
				}
			}
			if (current?.user_id !== user.id || claim?.transfer) {
				try {
					await takeOverNotebookEditor({
						deps,
						user,
						pid: project.id,
						nid: notebook.meta.id,
						request,
						body: {
							takeover_id: await sha256Hex(
								JSON.stringify([project.id, notebook.meta.id, user.id, options.key]),
							),
							expected_holder_session_id: holder,
							expected_activity: activity as 'active' | 'idle' | 'unknown' | 'starting',
							acknowledge_disruption: true,
						},
					});
				} catch (error) {
					if (error instanceof EditSessionChangedError)
						throw await editorProblem(deps, user, project, notebook);
					throw error;
				}
			}
		}
	}
	if (!session) {
		try {
			const started = await startNotebookSession({
				deps,
				user,
				pid: project.id,
				nid: notebook.meta.id,
				body: { mode: 'edit', ...(temporary ? { edit_intent: 'temporary' as const } : {}) },
				request,
			});
			session = await deps.services.sessions.getSession(
				project.id,
				SessionId.parse(started.session_id),
			);
		} catch (error) {
			if (error instanceof EditSessionOwnedError)
				throw await editorProblem(deps, user, project, notebook);
			throw error;
		}
		// Never silently switch a persistent notebook to an independently editable runtime.
		if (session.ephemeral && !temporary)
			throw HostProblemError.conflict('Use the temporary notebook ID from the catalog');
	}
	const deadline = Date.now() + 60_000;
	while (session.status === 'starting' && Date.now() < deadline) {
		await deps.sleep(500, request.signal);
		session = await deps.services.sessions.getSession(project.id, session.session_id);
	}
	if (session.status !== 'running' || !session.sandbox_id)
		throw new UnavailableError('The notebook sandbox is not ready; retry the request');
	return session;
}

/**
 * The runtime a notebook already has, for operations that act on existing work. Nothing is
 * provisioned: without a running runtime there is no run to interrupt or input to answer.
 */
export async function existingHostSession(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	project: Project,
	notebook: NotebookDetail,
	temporary?: Session,
): Promise<Session> {
	const unavailable = () => HostProblemError.noRuntime('The notebook has no running runtime');
	let session = temporary;
	if (!session) {
		const claim = await deps.services.sessions.getEditorClaim(project.id, notebook.meta.id);
		if (!claim?.session_id) throw unavailable();
		try {
			session = await deps.services.sessions.getSession(project.id, claim.session_id);
		} catch (error) {
			if (error instanceof NotFoundError) throw unavailable();
			throw error;
		}
		await authorizeMcpSession(deps, user, session);
	}
	if (session.status !== 'running' || !session.sandbox_id) throw unavailable();
	return session;
}

export async function callRuntime(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	notebook: NotebookDetail,
	session: Session,
	request: Omit<HostRequest, 'notebookPath'>,
	signal?: AbortSignal,
	keepAlive = true,
) {
	if (!session.sandbox_id) throw new UnavailableError('Notebook sandbox unavailable');
	if (request.path === '/save' && session.ephemeral)
		throw HostProblemError.forbidden('Temporary notebooks cannot be saved');
	const sandbox =
		(keepAlive
			? undefined
			: reconnectSessionSandbox(deps.compute, session, deps.metrics, 'host')) ??
		sessionSandbox(deps.compute, session, deps.metrics, 'host');
	const workspaceDir = sessionWorkspaceDir(notebook.source, deps.sandbox.workdir);
	const path = `${workspaceDir}/${workspaceSourcePolicy(notebook.source).entryNotebook}`;
	const perform = async (activeSignal?: AbortSignal) => {
		if (!session.ephemeral) {
			const claim = await deps.services.sessions.getEditorClaim(project.id, notebook.meta.id);
			if (claim?.transfer || !(await deps.services.sessions.ownsEditorClaim(session)))
				throw HostProblemError.conflict('The notebook editor changed or is being taken over');
		}
		const reply = await requestRuntimeHost(
			sandbox,
			{
				...request,
				notebookPath: sandbox.resolveProcessPath?.(path) ?? path,
			},
			activeSignal,
			notebookBridgeFor(deps, session.sandbox_id!),
		);
		if (request.path === '/save' && reply.status < 400) {
			if (!(await deps.services.sessions.ownsEditorClaim(session)))
				throw HostProblemError.conflict('The session no longer owns the notebook editor');
			const saved = await new SandboxProvisioner(deps.compute).captureSession(
				sandbox,
				deps.services.notebooks,
				deps.bucket,
				project.id,
				notebook.meta.id,
				principal.id,
				deps.sandbox.persistWorkspace,
				deps.sandbox.workdir,
				{ persistEdits: sessionPersistsEdits(session) },
			);
			if (!saved)
				throw HostProblemError.unsupportedOperation(
					'This notebook source cannot be saved by the host',
				);
		}
		return reply;
	};
	if (!keepAlive) {
		await authorizeMcpSession(deps, principal, session);
		return perform(signal);
	}
	try {
		return await withMcpSessionActivity(deps, principal, project, session, perform, signal);
	} catch (error) {
		if (error instanceof SessionEndedError) throw HostProblemError.noRuntime(error.message);
		if (error instanceof SessionAuthorizationExpiredError)
			throw HostProblemError.unauthorized(error.message);
		throw error;
	}
}

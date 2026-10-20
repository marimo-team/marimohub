import {
	EditSessionOwnedError,
	EditSessionChangedError,
	SandboxProvisioner,
	SessionId,
	sessionOwner,
	sleep,
	UnavailableError,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, NotebookDetail, Project, Session } from '@marimo-hub/core';
import { requestRuntimeHost } from '@marimo-hub/core/host-bridge';
import type { HostRequest } from '@marimo-hub/core/host-bridge';
import { sha256Hex } from '@marimo-hub/core/sha256';
import type { Context } from 'hono';
import type { ApiDeps, HonoEnv } from '../context';
import { authorizeMcpSession, withMcpSessionActivity } from '../mcp/sessionActivity';
import {
	getEditorSessionState,
	startNotebookSession,
	takeOverNotebookEditor,
} from '../routes/sessionStart';
import { resolvePublicBaseUrl } from '../shared';
import { HostProblemError } from './protocol';

const DECISION_PREFIX = 'hub-editor:';

async function editorProblem(c: Context<HonoEnv>, project: Project, notebook: NotebookDetail) {
	const state = await getEditorSessionState(
		c.get('deps'),
		c.get('user'),
		project.id,
		notebook.meta.id,
	);
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

export function runtimeDecisions(decisions?: Record<string, string>) {
	return decisions
		? Object.fromEntries(
				Object.entries(decisions).filter(([id]) => !id.startsWith(DECISION_PREFIX)),
			)
		: undefined;
}

export async function ensureHostSession(
	c: Context<HonoEnv>,
	project: Project,
	notebook: NotebookDetail,
	options: { session?: Session; decisions?: Record<string, string>; key?: string } = {},
): Promise<Session> {
	const deps = c.get('deps');
	const user = c.get('user');
	const request = {
		requestId: c.get('requestId'),
		method: c.req.method,
		path: c.req.path,
		hostname: new URL(c.req.url).hostname,
		appBaseUrl: resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
	};
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
				throw await editorProblem(c, project, notebook);
			temporary = true;
		} else {
			const claim = await deps.services.sessions.getEditorClaim(project.id, notebook.meta.id);
			const current = claim?.session_id
				? await deps.services.sessions.getSession(project.id, claim.session_id)
				: undefined;
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
						throw await editorProblem(c, project, notebook);
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
			if (error instanceof EditSessionOwnedError) throw await editorProblem(c, project, notebook);
			throw error;
		}
		// Never silently switch a persistent notebook to an independently editable runtime.
		if (session.ephemeral && !temporary)
			throw HostProblemError.conflict('Use the temporary notebook ID from the catalog');
	}
	const deadline = Date.now() + 60_000;
	while (session.status === 'starting' && Date.now() < deadline) {
		await sleep(500, c.req.raw.signal);
		session = await deps.services.sessions.getSession(project.id, session.session_id);
	}
	if (session.status !== 'running' || !session.sandbox_id)
		throw new UnavailableError('The notebook sandbox is not ready; retry the request');
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
		!keepAlive && deps.compute.connectExisting
			? deps.compute.connectExisting(session.sandbox_id, { owner: sessionOwner(session) })
			: deps.compute.create(session.sandbox_id, { owner: sessionOwner(session) });
	const path = `${deps.sandbox.workdir}/${workspaceSourcePolicy(notebook.source).entryNotebook}`;
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
				{ persistEdits: true },
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
	return withMcpSessionActivity(deps, principal, project, session, perform, signal);
}

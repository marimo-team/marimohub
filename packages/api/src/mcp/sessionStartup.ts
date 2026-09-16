import {
	bootstrapKernel,
	SessionId,
	sessionMode,
	sessionOwner,
	sleep,
	withAbortSignal,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	KernelBootstrapResult,
	NotebookId,
	Project,
	Session,
} from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { errorMetadataChain, logEvent } from '../log';
import { assertSessionNotebookVisible, sessionGrantsFor } from '../shared';
import { startNotebookSession, toSessionResponse } from '../routes/sessionStart';
import { authorizeMcpSession, withMcpSessionActivity } from './sessionActivity';
import type { StartRequestContext } from './server';

type ExecutionReadiness = { ready: boolean; status: string; next_step: string };

function lifecycleReadiness(session: Session): ExecutionReadiness {
	return {
		ready: false,
		status: session.status,
		next_step:
			session.status === 'starting'
				? 'Call start_session again to check startup progress.'
				: 'Check the session error before retrying start_session.',
	};
}

function bootstrapReadiness(
	status: KernelBootstrapResult['status'],
	notebookUrl: string,
): ExecutionReadiness {
	const nextSteps = {
		ready: 'Call execute_code with this project_id and session_id.',
		initializing:
			'Call start_session again with wait_seconds greater than zero to finish kernel initialization.',
		awaiting_client: `This runtime does not support automatic initialization. Open ${notebookUrl} in a browser. Once the notebook loads, call execute_code.`,
		unavailable:
			'Kernel initialization failed. Retry start_session; if it still fails, check the session logs or open the notebook in a browser.',
	};
	return { ready: status === 'ready', status, next_step: nextSteps[status] };
}

async function waitForSession(
	deps: ApiDeps,
	session: Session,
	deadline: number,
	signal?: AbortSignal,
): Promise<Session> {
	let current = session;
	while (current.status === 'starting' && Date.now() < deadline) {
		await withAbortSignal(sleep(Math.max(0, Math.min(2_000, deadline - Date.now()))), signal);
		current = await deps.services.sessions.getSession(current.project_id, current.session_id);
	}
	return current;
}

export async function startMcpSession(input: {
	deps: ApiDeps;
	principal: AuthenticatedPrincipal;
	request: StartRequestContext;
	project: Project;
	notebookId: NotebookId;
	mode: 'edit' | 'app';
	waitSeconds: number;
}): Promise<Record<string, unknown>> {
	const { deps, principal, request, project, notebookId, mode, waitSeconds } = input;
	const started = await startNotebookSession({
		deps,
		user: principal,
		pid: project.id,
		nid: notebookId,
		body: { mode },
		request,
	});
	let session = await deps.services.sessions.getSession(
		project.id,
		SessionId.parse(started.session_id),
	);
	const deadline = Date.now() + waitSeconds * 1000;
	const notebookUrl = `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebookId}`;
	const labels = await assertSessionNotebookVisible(deps, project, session, principal);
	const grants = await sessionGrantsFor(project, principal, session, deps, labels);
	let execution = lifecycleReadiness(session);

	if (sessionMode(session) !== 'edit') {
		session = await waitForSession(deps, session, deadline);
		execution = {
			ready: false,
			status: 'app_mode',
			next_step: 'Use start_session with mode="edit" to execute code.',
		};
	} else if (!grants.attach) {
		execution = {
			ready: false,
			status: session.status === 'starting' ? 'starting' : 'forbidden',
			next_step: 'Authorize session.attach access before executing code.',
		};
	} else if (session.status === 'starting' || session.status === 'running') {
		const startedAt = Date.now();
		let failure: unknown;
		try {
			execution = await withMcpSessionActivity(
				deps,
				principal,
				project,
				session,
				async (signal, authorizationDeadline) => {
					session = await waitForSession(deps, session, deadline, signal);
					if (session.status !== 'running') return lifecycleReadiness(session);
					await authorizeMcpSession(deps, principal, session);
					signal.throwIfAborted();
					const timeoutMs = Math.max(
						0,
						Math.min(
							waitSeconds === 0 ? 5_000 : deadline - Date.now(),
							authorizationDeadline - Date.now(),
						),
					);
					const outcome = session.sandbox_id
						? await bootstrapKernel(
								deps.compute.create(session.sandbox_id, { owner: sessionOwner(session) }),
								{ timeoutMs, inspectOnly: waitSeconds === 0, signal },
							)
						: { status: 'unavailable' as const };
					return bootstrapReadiness(outcome.status, notebookUrl);
				},
			);
		} catch (error) {
			failure = error;
			execution = {
				ready: false,
				status: 'unavailable',
				next_step: 'Check session access and status, then retry start_session.',
			};
		} finally {
			logEvent({
				level: failure ? 'error' : 'info',
				event: 'mcp_kernel_bootstrap',
				request_id: request.requestId ?? null,
				project_id: project.id,
				session_id: session.session_id,
				outcome: execution.status,
				duration_ms: Date.now() - startedAt,
				...(failure ? { error: errorMetadataChain(failure) } : {}),
			});
		}
	}
	const currentLabels = await assertSessionNotebookVisible(deps, project, session, principal);
	const projected = toSessionResponse(
		session,
		await sessionGrantsFor(project, principal, session, deps, currentLabels),
	);
	return {
		project_id: project.id,
		notebook_id: notebookId,
		session_id: session.session_id,
		status: session.status,
		execution,
		reused: started.reused,
		mode: sessionMode(session),
		notebook_url: notebookUrl,
		...(projected.sandbox_url ? { sandbox_url: projected.sandbox_url } : {}),
		...(session.error ? { error: session.error } : {}),
	};
}

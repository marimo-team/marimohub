import { BadRequestError, withAbortSignal } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project, Session } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { assertSessionAccess, assertSessionNotebookVisible, loadVisibleProject } from '../shared';

function activeDeadline(
	session: Session,
	principal: AuthenticatedPrincipal,
	subjectContextExpiresAt?: string,
): number {
	if (session.status !== 'running' && session.status !== 'starting') {
		throw new BadRequestError('Session is no longer running');
	}
	const expirations = [
		session.authorization_expires_at,
		principal.credential.expiresAt,
		principal.entitlementsExpiresAt,
		subjectContextExpiresAt,
	];
	const deadline = Math.min(
		...expirations.map((value) => (value === undefined ? Infinity : Date.parse(value))),
	);
	if (Number.isNaN(deadline) || Date.now() >= deadline) {
		throw new BadRequestError('Session authorization has expired');
	}
	return deadline;
}

export async function authorizeMcpSession(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	session: Session,
) {
	const project = await loadVisibleProject(
		deps.services.projects,
		session.project_id,
		principal,
		deps,
	);
	const labels = await assertSessionNotebookVisible(deps, project, session, principal);
	return assertSessionAccess(project, session, principal, deps, labels);
}

export async function withMcpSessionActivity<T>(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	session: Session,
	work: (
		signal: AbortSignal,
		authorizationDeadline: number,
		refreshAuthorization: () => Promise<number>,
	) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let deadline = activeDeadline(session, principal);

	const armExpiry = () => {
		if (expiryTimer !== undefined) clearTimeout(expiryTimer);
		if (!Number.isFinite(deadline)) return;
		expiryTimer = setTimeout(
			() => controller.abort(new BadRequestError('Session authorization has expired')),
			Math.min(2_147_483_647, Math.max(0, deadline - Date.now())),
		);
	};
	const refresh = async () => {
		const current = await deps.services.sessions.getSession(project.id, session.session_id);
		if (finished) return deadline;
		deadline = Math.min(deadline, activeDeadline(current, principal));
		armExpiry();
		const decision = await authorizeMcpSession(deps, principal, current);
		if (finished) return deadline;
		deadline = Math.min(
			deadline,
			activeDeadline(current, principal, decision.subjectContextExpiresAt),
		);
		armExpiry();
		controller.signal.throwIfAborted();
		const heartbeated = await deps.services.sessions.heartbeat(project.id, current.session_id);
		if (finished) return deadline;
		deadline = Math.min(deadline, activeDeadline(heartbeated, principal));
		armExpiry();
		return deadline;
	};
	const schedule = () => {
		timer = setTimeout(() => {
			void refresh()
				.catch((error: unknown) => controller.abort(error))
				.finally(() => {
					if (!finished && !controller.signal.aborted) schedule();
				});
		}, 30_000);
	};
	try {
		armExpiry();
		await withAbortSignal(refresh(), controller.signal);
		controller.signal.throwIfAborted();
		schedule();
		return await withAbortSignal(work(controller.signal, deadline, refresh), controller.signal);
	} finally {
		finished = true;
		if (timer !== undefined) clearTimeout(timer);
		if (expiryTimer !== undefined) clearTimeout(expiryTimer);
	}
}

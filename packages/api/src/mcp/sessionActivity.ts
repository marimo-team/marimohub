import { BadRequestError, withAbortSignal } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project, Session } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { assertSessionAccess, assertSessionNotebookVisible, loadVisibleProject } from '../shared';

function assertAuthorizationDeadline(deadline: number): void {
	if (Number.isNaN(deadline) || Date.now() >= deadline) {
		throw new BadRequestError('Session authorization has expired');
	}
}

export function sessionAuthorizationDeadline(
	session: Session,
	principal: AuthenticatedPrincipal,
	subjectContextExpiresAt?: string,
): number {
	const expirations = [
		session.authorization_expires_at,
		principal.credential.expiresAt,
		principal.entitlementsExpiresAt,
		subjectContextExpiresAt,
	];
	const deadline = Math.min(
		...expirations.map((value) => (value === undefined ? Infinity : Date.parse(value))),
	);
	assertAuthorizationDeadline(deadline);
	return deadline;
}

function activeDeadline(
	session: Session,
	principal: AuthenticatedPrincipal,
	subjectContextExpiresAt?: string,
): number {
	if (session.status !== 'running' && session.status !== 'starting') {
		throw new BadRequestError('Session is no longer running');
	}
	return sessionAuthorizationDeadline(session, principal, subjectContextExpiresAt);
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
	requestSignal?: AbortSignal,
): Promise<T> {
	requestSignal?.throwIfAborted();
	const controller = new AbortController();
	const signal = requestSignal
		? AbortSignal.any([controller.signal, requestSignal])
		: controller.signal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let deadline = activeDeadline(session, principal);

	const armExpiry = () => {
		assertAuthorizationDeadline(deadline);
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
		signal.throwIfAborted();
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
					if (!finished && !signal.aborted) schedule();
				});
		}, 30_000);
	};
	try {
		armExpiry();
		await withAbortSignal(refresh(), signal);
		signal.throwIfAborted();
		schedule();
		return await withAbortSignal(work(signal, deadline, refresh), signal);
	} finally {
		finished = true;
		if (timer !== undefined) clearTimeout(timer);
		if (expiryTimer !== undefined) clearTimeout(expiryTimer);
	}
}

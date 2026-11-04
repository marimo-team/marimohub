import { withAbortSignal } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project, ProjectId } from '@marimo-hub/core';
import { ForbiddenError, NotFoundError } from '@marimo-hub/core/errors';
import type { ApiDeps } from '../context';
import { loadVisibleProject } from '../shared';

export interface ConversationOperationContext {
	deps: ApiDeps;
	principal: AuthenticatedPrincipal;
	pid: ProjectId;
	signal?: AbortSignal;
	appBaseUrl?: string;
}

/** True when a configured model and chat budgets make project chat usable. */
export function chatAvailable(deps: Pick<ApiDeps, 'ai'>): boolean {
	return Boolean(deps.ai?.languageModel && deps.ai.chat);
}

export function requireChat(deps: Pick<ApiDeps, 'ai'>): void {
	if (!chatAvailable(deps)) throw new NotFoundError('Project chat is not enabled');
}

/** Chat acts with a person's authority; machine credentials cannot hold conversations. */
export function assertConversationPrincipal(principal: AuthenticatedPrincipal): void {
	if (principal.credential.kind === 'service-account')
		throw new ForbiddenError('Project chat requires a human identity');
}

/** When the caller's session or entitlements lapse; throws once they already have. */
export function chatPrincipalDeadline(principal: AuthenticatedPrincipal): number {
	const candidates = [principal.credential.expiresAt, principal.entitlementsExpiresAt].map(
		(value) => (value === undefined ? Infinity : Date.parse(value)),
	);
	const deadline = Math.min(...candidates);
	if (Number.isNaN(deadline) || deadline <= Date.now())
		throw new ForbiddenError('Chat authorization has expired');
	return deadline;
}

/** Re-check the principal mid-turn: a long response must not outlive a suspension. */
export async function assertChatPrincipalCurrent(
	deps: Pick<ApiDeps, 'services'>,
	principal: AuthenticatedPrincipal,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	chatPrincipalDeadline(principal);
	const suspended = await withAbortSignal(
		deps.services.identities.isSuspended(principal.id),
		signal,
	);
	signal?.throwIfAborted();
	if (suspended) throw new ForbiddenError('User account is suspended');
}

export async function authorizeConversation({
	deps,
	principal,
	pid,
	signal,
}: ConversationOperationContext): Promise<Project> {
	signal?.throwIfAborted();
	requireChat(deps);
	assertConversationPrincipal(principal);
	await assertChatPrincipalCurrent(deps, principal, signal);
	const project = await loadVisibleProject(deps.services.projects, pid, principal, deps);
	signal?.throwIfAborted();
	return project;
}

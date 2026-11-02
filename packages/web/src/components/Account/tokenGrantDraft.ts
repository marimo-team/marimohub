import { DEPLOYMENT_ACTIONS } from '@marimo-hub/core/token-grants';
import type { AuthorizationAction } from '@marimo-hub/core/token-grants';
import type { TokenGrant } from '@/types';

const deploymentActions = new Set<AuthorizationAction>(DEPLOYMENT_ACTIONS);

export interface TokenGrantDraft {
	actions: TokenGrant['actions'] | null;
	projects: TokenGrant['projects'] | null;
}

export function tokenGrantFromDraft(value: TokenGrantDraft): TokenGrant | null {
	if (value.actions === null || value.projects === null) return null;
	if (Array.isArray(value.projects) && value.projects.length === 0) return null;
	const grant = { actions: value.actions, projects: value.projects };
	if (
		Array.isArray(grant.actions) &&
		grant.actions.some((action) => !actionFitsProjects(action, grant.projects))
	)
		return null;
	return grant;
}

export function actionFitsProjects(
	action: AuthorizationAction,
	projects: TokenGrant['projects'],
): boolean {
	return projects === '*' || !deploymentActions.has(action);
}

export function actionsForProjects(
	actions: TokenGrantDraft['actions'],
	projects: TokenGrant['projects'],
): TokenGrantDraft['actions'] {
	return Array.isArray(actions)
		? actions.filter((action) => actionFitsProjects(action, projects))
		: actions;
}

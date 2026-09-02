import { z } from 'zod';
import { ProjectId } from './ids';
import { ACTION_RULES, AUTHORIZATION_ACTIONS } from './services/authorization/actions';
import type { AuthorizationAction } from './services/authorization/actions';

export type { AuthorizationAction } from './services/authorization/actions';
export { AUTHORIZATION_ACTIONS } from './services/authorization/actions';

export const MAX_TOKEN_GRANT_PROJECTS = 100;

const uniqueArray = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const TokenGrantSchema = z.strictObject({
	actions: z.union([
		z.literal('*'),
		z.array(z.enum(AUTHORIZATION_ACTIONS)).refine(uniqueArray, 'Actions must be unique'),
	]),
	projects: z.union([
		z.literal('*'),
		z
			.array(z.string().regex(ProjectId.regex).transform(ProjectId.parse))
			.min(1)
			.max(MAX_TOKEN_GRANT_PROJECTS)
			.refine(uniqueArray, 'Projects must be unique'),
	]),
});

export type TokenGrant = z.infer<typeof TokenGrantSchema>;

export const TOKEN_GRANT_PRESETS = {
	read: ['project.read', 'integration.read'],
	run: [
		'project.read',
		'integration.read',
		'integration.use',
		'session.start',
		'session.attach',
		'session.stop',
		'session.surface',
		'session.proxy',
	],
	edit: [
		'project.read',
		'integration.read',
		'integration.use',
		'session.start',
		'session.attach',
		'session.stop',
		'session.surface',
		'session.proxy',
		'notebook.write',
		'change-request.publish',
	],
	full: '*',
} as const satisfies Record<string, '*' | readonly AuthorizationAction[]>;

export type TokenGrantPreset = keyof typeof TOKEN_GRANT_PRESETS;

export function expandTokenGrantPreset(preset: TokenGrantPreset): '*' | AuthorizationAction[] {
	const actions = TOKEN_GRANT_PRESETS[preset];
	return actions === '*' ? '*' : [...actions];
}

export function tokenGrantAllowsAction(
	grant: TokenGrant | undefined,
	action: AuthorizationAction,
): boolean {
	if (!grant) return true;
	if (grant.projects !== '*' && ACTION_RULES[action].scope === 'deployment') return false;
	return grant.actions === '*' || grant.actions.includes(action);
}

export function tokenGrantAllowsProject(
	grant: TokenGrant | undefined,
	projectId: ProjectId,
): boolean {
	return !grant || grant.projects === '*' || grant.projects.includes(projectId);
}

export function tokenGrantIsSubset(candidate: TokenGrant, upperBound: TokenGrant): boolean {
	const actionsAllowed =
		upperBound.actions === '*' ||
		(candidate.actions !== '*' &&
			candidate.actions.every((action) => upperBound.actions.includes(action)));
	const projectsAllowed =
		upperBound.projects === '*' ||
		(candidate.projects !== '*' &&
			candidate.projects.every((projectId) => upperBound.projects.includes(projectId)));
	return actionsAllowed && projectsAllowed;
}

import type { AssignableProjectRole, Capabilities, ProjectRole } from '@/types';

const ROLE_ORDER: Record<ProjectRole, true> = {
	'app-user': true,
	manager: true,
	editor: true,
	viewer: true,
	admin: true,
};
export const PROJECT_ROLES = Object.keys(ROLE_ORDER) as ProjectRole[];
export const ASSIGNABLE_ROLES: AssignableProjectRole[] = PROJECT_ROLES.filter(
	(role) => role !== 'admin',
);

export function canManageProject(role: ProjectRole | null): boolean {
	return role === 'manager' || role === 'admin';
}

/**
 * Human copy for each role, derived from the deployment config rather than
 * hardcoded: what a `viewer` actually gets depends on MARIMOHUB_VIEWER_MODE
 * (a static HTML snapshot, running apps, or a throwaway sandbox that can run
 * code). Falls back to mode-neutral copy while capabilities are still loading.
 */
export function roleDescriptions(caps: Capabilities | undefined): Record<ProjectRole, string> {
	const viewer =
		caps === undefined
			? 'View projects and notebooks (read-only)'
			: caps.viewer_mode === 'ephemeral-sandbox'
				? 'View notebooks, use running apps, and run notebooks in a temporary sandbox — changes are never saved'
				: caps.viewer_mode === 'applications'
					? 'View notebooks read-only and use notebooks running as apps'
					: 'View notebooks and their last saved outputs (read-only)';
	return {
		'app-user': 'Use notebook apps without access to source code or authoring tools',
		admin: 'Reserved for project owners, deployment super admins, and legacy assignments',
		manager: 'Manage members and project settings, plus everything an editor can do',
		editor: 'Create, edit, and run notebooks',
		viewer,
	};
}

/**
 * One-line summary of what a signed-in NON-member can do, from the deployment's
 * MARIMOHUB_DEFAULT_ROLE. Null while capabilities are loading.
 */
export function defaultAccessSummary(caps: Capabilities | undefined): string | null {
	if (caps === undefined) return null;
	switch (caps.default_role) {
		case null:
			return 'This project is members-only: only the owner and the members listed here can access it.';
		case 'app-user':
			return 'Everyone who signs in can use this project’s apps by default, without source access.';
		case 'viewer':
			return 'Everyone who signs in can view this project by default; add members to grant more access.';
		case 'editor':
			return 'Everyone who signs in can edit notebooks in this project by default; add a manager to manage it.';
		case 'manager':
			return 'Everyone who signs in can manage this project by default.';
	}
}

export function canEditProject(role: ProjectRole | null): boolean {
	return role === 'editor' || canManageProject(role);
}

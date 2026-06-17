import type { Capabilities, ProjectRole } from '@/types';

// Derived from an exhaustive Record so the compiler fails here when the API
// gains a role — a plain ProjectRole[] would silently accept a subset and the
// new role would vanish from every dropdown. Key order is display order.
const ROLE_ORDER: Record<ProjectRole, true> = { admin: true, editor: true, viewer: true };
export const ROLES = Object.keys(ROLE_ORDER) as ProjectRole[];

/**
 * Human copy for each role, derived from the deployment config rather than
 * hardcoded: what a `viewer` actually gets depends on MARIMOHUB_VIEWER_MODE
 * (a static HTML snapshot vs a throwaway sandbox that can run code). Falls back
 * to mode-neutral copy while capabilities are still loading.
 */
export function roleDescriptions(caps: Capabilities | undefined): Record<ProjectRole, string> {
	const viewer =
		caps === undefined
			? 'View projects and notebooks (read-only)'
			: caps.viewer_mode === 'ephemeral-sandbox'
				? 'View notebooks and run them in a temporary sandbox — changes are never saved'
				: 'View notebooks and their last saved outputs (read-only)';
	return {
		admin: 'Manage members and project settings, plus everything an editor can do',
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
		case 'viewer':
			return 'Everyone who signs in can view this project by default; add members to grant more access.';
		case 'editor':
			return 'Everyone who signs in can edit notebooks in this project by default; add an admin to manage it.';
		case 'admin':
			return 'Everyone who signs in has full admin access to this project by default.';
	}
}

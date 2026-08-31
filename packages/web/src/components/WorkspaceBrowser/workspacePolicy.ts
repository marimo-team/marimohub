import type { WorkspaceAccess as ApiWorkspaceAccess, WorkspaceOperation } from '@marimo-hub/client';

export type WorkspaceAccess = ApiWorkspaceAccess;

const READ_ONLY_MESSAGES = {
	git_source: 'Git-backed workspaces are read-only.',
	viewer: 'Your project role allows browsing, but not workspace changes.',
	active_session: 'Workspace changes are disabled while an edit session is active.',
} satisfies Record<NonNullable<WorkspaceAccess['read_only_reason']>, string>;

export function workspaceAccessMessage(access: WorkspaceAccess): string | null {
	return access.read_only_reason ? READ_ONLY_MESSAGES[access.read_only_reason] : null;
}

export function isWorkspacePathProtected(
	access: WorkspaceAccess,
	path: string,
	operation: WorkspaceOperation,
): boolean {
	return access.protected_paths.some(
		(rule) => rule.path === path && rule.denied_operations.includes(operation),
	);
}

export function canApplyWorkspaceOperation(
	access: WorkspaceAccess,
	paths: readonly string[],
	operation: WorkspaceOperation,
): boolean {
	return (
		access.writable &&
		paths.length > 0 &&
		!paths.some((path) => isWorkspacePathProtected(access, path, operation))
	);
}

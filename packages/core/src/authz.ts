/**
 * Authorization (role enforcement)
 *
 * Separate from authentication (`auth.ts`, *who* the caller is). This module
 * answers *what* an authenticated caller may do on a given project.
 *
 * v1 is single-tenant / trusted-org (see docs/bucket_spec.md §12): reads are
 * open to any authenticated user, and the role matrix below is enforced on
 * writes against the target project. A project's `owner` is implicitly admin.
 */

import { ForbiddenError } from './errors';
import type { Project, ProjectMember } from './schema';

export type Role = ProjectMember['role']; // 'admin' | 'editor' | 'viewer'

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** The caller's effective role on a project, or null if they have none. */
export function effectiveRole(project: Project, userId: string): Role | null {
	if (project.owner === userId) return 'admin';
	return project.members.find((m) => m.user_id === userId)?.role ?? null;
}

/** True if the caller's role on the project is at least `min`. */
export function canAct(project: Project, userId: string, min: Role): boolean {
	const role = effectiveRole(project, userId);
	return role != null && RANK[role] >= RANK[min];
}

/** Throw {@link ForbiddenError} unless the caller has at least `min` on the project. */
export function requireRole(project: Project, userId: string, min: Role): void {
	if (!canAct(project, userId, min)) {
		throw new ForbiddenError(`Requires '${min}' role on project ${project.id}`);
	}
}

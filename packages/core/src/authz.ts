/**
 * Authorization (role enforcement)
 *
 * Separate from authentication (`auth.ts`, *who* the caller is). This module
 * answers *what* an authenticated caller may do on a given project.
 *
 * Writes are gated by the role matrix (see development_docs/bucket_spec.md §12)
 * against the target project. Reads are gated at `viewer`: with a
 * `defaultRole` set (the usual editor/viewer deployment) every authenticated
 * user is at least a viewer, so reads stay open; with `MARIMOHUB_DEFAULT_ROLE`
 * unset (`none`), reads are membership-gated — a non-member cannot see the
 * project at all. A project's `owner` is implicitly admin.
 */

import type { Role } from './constants';
import { ForbiddenError } from './errors';
import type { UserId } from './ids';
import type { Project } from './schema';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/**
 * The caller's effective role on a project, or null if they have none.
 *
 * `defaultRole` is the deployment-wide fallback (config: MARIMOHUB_DEFAULT_ROLE)
 * applied to any authenticated caller who is neither the owner nor an explicit
 * member. Left undefined it preserves the members-only behavior; passed `editor`
 * it lets every logged-in user edit notebooks. The default never overrides an
 * explicit membership — it only fills the gap when there is none.
 */
export function effectiveRole(
	project: Project,
	userId: UserId,
	defaultRole?: Role | null,
): Role | null {
	if (project.owner === userId) return 'admin';
	return project.members.find((m) => m.user_id === userId)?.role ?? defaultRole ?? null;
}

/** True if the caller's role on the project is at least `min`. */
export function canAct(
	project: Project,
	userId: UserId,
	min: Role,
	defaultRole?: Role | null,
): boolean {
	const role = effectiveRole(project, userId, defaultRole);
	return role != null && RANK[role] >= RANK[min];
}

/** Throw {@link ForbiddenError} unless the caller has at least `min` on the project. */
export function requireRole(
	project: Project,
	userId: UserId,
	min: Role,
	defaultRole?: Role | null,
): void {
	if (!canAct(project, userId, min, defaultRole)) {
		throw new ForbiddenError(`Requires '${min}' role on project ${project.id}`);
	}
}

/**
 * Whether a caller may *see* a project, decided from a catalog snapshot entry
 * (owner + denormalized `member_ids`) without loading `project.json`. With a
 * `defaultRole` set every authenticated user is a viewer, so all projects are
 * visible; with it null (`none`) only the owner and explicit members are.
 *
 * Returns `null` when the entry predates `member_ids` and the caller is not the
 * owner — visibility is then indeterminate from the snapshot alone, so the
 * caller must fall back to loading `project.json`.
 */
export function canSeeProjectEntry(
	entry: { owner: UserId; member_ids?: UserId[] },
	userId: UserId,
	defaultRole?: Role | null,
): boolean | null {
	if (defaultRole != null) return true;
	if (entry.owner === userId) return true;
	if (entry.member_ids === undefined) return null;
	return entry.member_ids.includes(userId);
}

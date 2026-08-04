/**
 * Authorization (role enforcement)
 *
 * Separate from authentication (`auth.ts`, *who* the caller is). This module
 * answers *what* an authenticated caller may do on a given project.
 *
 * Writes are gated by the role matrix (see development_docs/bucket_spec.md §12)
 * against the target project. Reads are gated at `viewer`: with a default role
 * set by deployment policy or a mapped OIDC entitlement, the user is at least
 * a viewer, so reads stay open. Otherwise reads are membership-gated and a
 * non-member cannot see the project. A project's `owner` is implicitly admin.
 *
 * A member row carries either a `user_id` or an `email` (a pending invite for
 * someone who hasn't logged in yet). The caller is therefore matched as a
 * subject — `{ id, email }` — against both: id rows by exact id, email rows by
 * case-insensitive email. Session ownership is NOT part of this module and
 * stays strict id equality (see api/shared.ts assertSessionControl).
 */

import type { Role } from './constants';
import { ForbiddenError } from './errors';
import type { UserId } from './ids';
import { anyRefMatchesSubject, emailsEqual, memberRefMatchesSubject } from './identityMatch';
import type { IdentitySubject } from './identityMatch';
import type { Project } from './schema';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
const ENTITLEMENT_ROLE: Partial<Record<string, Role>> = {
	'default-role:viewer': 'viewer',
	'default-role:editor': 'editor',
	'default-role:admin': 'admin',
};

export function subjectDefaultRole(subject: AuthSubject, policy?: AuthzPolicy): Role | null {
	let role = policy?.defaultRole ?? null;
	for (const entitlement of subject.entitlements ?? []) {
		const candidate = ENTITLEMENT_ROLE[entitlement];
		if (candidate && (role === null || RANK[candidate] > RANK[role])) role = candidate;
	}
	return role;
}

/**
 * The authenticated caller as authorization sees them. Structurally a subset
 * of `AuthUser`, so route handlers pass the request user directly. Matched
 * against ids and emails via {@link ./identityMatch}.
 */
export type AuthSubject = IdentitySubject;

/**
 * The authorization-relevant slice of the deployment policy. `PolicyConfig`
 * (api/context.ts) is structurally assignable, so callers pass `deps.policy`
 * wholesale.
 */
export interface AuthzPolicy {
	defaultRole?: Role | null;
	/** MARIMOHUB_SUPER_ADMINS entries: emails (contain `@`) or user ids. */
	superAdmins?: readonly string[];
}

/**
 * Whether the caller is a deployment super admin, either from static config or
 * a mapped OIDC session entitlement. Super admins hold implicit `admin` on
 * every project and see all projects in listings. Static entries match by id or
 * email per the namespace rule in {@link refMatchesSubject}.
 */
export function isSuperAdmin(subject: AuthSubject, superAdmins?: readonly string[]): boolean {
	return (
		subject.entitlements?.includes('super-admin') === true ||
		anyRefMatchesSubject(superAdmins, subject)
	);
}

/**
 * The caller's effective role on a project, or null if they have none.
 *
 * `policy.defaultRole` is the deployment-wide fallback (config:
 * MARIMOHUB_DEFAULT_ROLE) applied to any authenticated caller who is neither
 * the owner nor an explicit member. Left undefined it preserves the
 * members-only behavior; passed `editor` it lets every logged-in user edit
 * notebooks. The default never overrides an explicit membership — it only
 * fills the gap when there is none. A static or group-derived super admin is
 * `admin` everywhere, regardless of membership.
 *
 * When both an id row and an email row match the same caller (added by id and
 * separately invited by email), the highest-ranked role wins, so the result is
 * independent of member order.
 */
export function effectiveRole(
	project: Project,
	subject: AuthSubject,
	policy?: AuthzPolicy,
): Role | null {
	if (isSuperAdmin(subject, policy?.superAdmins)) return 'admin';
	if (project.owner === subject.id) return 'admin';
	let best: Role | null = null;
	for (const member of project.members) {
		if (!memberRefMatchesSubject(member, subject)) continue;
		if (best === null || RANK[member.role] > RANK[best]) best = member.role;
		if (best === 'admin') break;
	}
	return best ?? subjectDefaultRole(subject, policy);
}

/** True if the caller's role on the project is at least `min`. */
export function canAct(
	project: Project,
	subject: AuthSubject,
	min: Role,
	policy?: AuthzPolicy,
): boolean {
	const role = effectiveRole(project, subject, policy);
	return role != null && RANK[role] >= RANK[min];
}

/** Throw {@link ForbiddenError} unless the caller has at least `min` on the project. */
export function requireRole(
	project: Project,
	subject: AuthSubject,
	min: Role,
	policy?: AuthzPolicy,
): void {
	if (!canAct(project, subject, min, policy)) {
		throw new ForbiddenError(`Requires '${min}' role on project ${project.id}`);
	}
}

/**
 * Whether a caller may *see* a project, decided from a catalog snapshot entry
 * (owner + denormalized `member_ids`/`member_emails`) without loading
 * `project.json`. With a `defaultRole` set every authenticated user is a
 * viewer, so all projects are visible; with it null (`none`) only the owner
 * and explicit members are.
 *
 * Returns `null` when the entry predates `member_ids` and the caller is not the
 * owner — visibility is then indeterminate from the snapshot alone, so the
 * caller must fall back to loading `project.json`.
 *
 * A missing `member_emails` (entry written before email invites existed, or
 * stripped by an old replica's strict re-parse during a rolling deploy) is
 * treated as empty — fail closed rather than indeterminate, because returning
 * `null` here would force a `project.json` load per entry for every non-member
 * caller across all pre-existing entries. Worst case an email-pending member
 * briefly misses the project in their list; it self-heals on the next
 * membership write, and direct project access (which reads `project.json`)
 * is unaffected.
 */
export function canSeeProjectEntry(
	entry: { owner: UserId; member_ids?: UserId[]; member_emails?: string[] },
	subject: AuthSubject,
	policy?: AuthzPolicy,
): boolean | null {
	if (isSuperAdmin(subject, policy?.superAdmins)) return true;
	if (subjectDefaultRole(subject, policy) != null) return true;
	if (entry.owner === subject.id) return true;
	if (entry.member_ids === undefined) return null;
	if (entry.member_ids.includes(subject.id)) return true;
	// Normalize both sides (stored entries are lowercased but not trimmed by
	// ProjectMemberSchema), matching memberRefMatchesSubject — otherwise a pending
	// invitee with whitespace in their stored email could reach the project
	// directly yet be omitted from its listing.
	return (entry.member_emails ?? []).some((e) => emailsEqual(e, subject.email));
}

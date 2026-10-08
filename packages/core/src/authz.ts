/**
 * Authorization (role enforcement)
 *
 * Separate from authentication (`auth.ts`, *who* the caller is). This module
 * answers *what* an authenticated caller may do on a given project.
 *
 * Writes are gated by the role matrix (see development_docs/bucket_spec.md §12)
 * against the target project. Project reads require `viewer`; app access accepts
 * `app-user`. Project defaults override deployment and OIDC defaults for
 * non-members. A project's `owner` is implicitly admin.
 *
 * User ids and group ids match exactly; invite emails match case-insensitively.
 * Session ownership remains strict user-id equality.
 */

import type { AssignableRole, Role } from './constants';
import { ForbiddenError } from './errors';
import type { UserId } from './ids';
import { anyRefMatchesSubject, memberRefMatchesSubject } from './identityMatch';
import type { IdentitySubject } from './identityMatch';
import type { Project } from './schema';

const RANK: Record<Role, number> = { 'app-user': 0, viewer: 1, editor: 2, manager: 3, admin: 4 };
const ENTITLEMENT_ROLE: Partial<Record<string, AssignableRole>> = {
	'default-role:app-user': 'app-user',
	'default-role:viewer': 'viewer',
	'default-role:editor': 'editor',
	'default-role:manager': 'manager',
};

export function roleAtLeast(role: Role | null, minimum: Role): boolean {
	return role !== null && RANK[role] >= RANK[minimum];
}

export function subjectDefaultRole(
	subject: AuthSubject,
	policy?: AuthzPolicy,
): AssignableRole | null {
	let role: AssignableRole | null = policy?.defaultRole ?? null;
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
	defaultRole?: AssignableRole | null;
	/** MARIMOHUB_SUPER_ADMINS entries: emails (contain `@`) or user ids. */
	superAdmins?: readonly string[];
	/** Whether project creation requires super-admin or OIDC project-creator entitlement. */
	projectCreationRestricted?: boolean;
}

export type EffectiveRoleSource =
	| 'static-super-admin'
	| 'entitlement-super-admin'
	| 'owner'
	| 'member-id'
	| 'member-email'
	| 'member-group'
	| 'entitlement-default'
	| 'deployment-default'
	| 'project-default'
	| 'none';

export interface EffectiveRoleResolution {
	role: Role | null;
	source: EffectiveRoleSource;
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

export function canCreateProject(subject: AuthSubject, policy?: AuthzPolicy): boolean {
	if (!policy?.projectCreationRestricted) return true;
	return (
		isSuperAdmin(subject, policy.superAdmins) ||
		subject.entitlements?.includes('project-creator') === true
	);
}

/**
 * Membership overrides defaults; project defaults override deployment and OIDC defaults.
 * Matching user, email, and group memberships use the highest role, independent of row order.
 * Owners and super admins remain admin regardless of defaults or membership.
 */
export function effectiveRole(
	project: Project,
	subject: AuthSubject,
	policy?: AuthzPolicy,
): Role | null {
	return resolveEffectiveRole(project, subject, policy).role;
}

export function resolveEffectiveRole(
	project: Project,
	subject: AuthSubject,
	policy?: AuthzPolicy,
): EffectiveRoleResolution {
	if (subject.entitlements?.includes('super-admin') === true) {
		return { role: 'admin', source: 'entitlement-super-admin' };
	}
	if (anyRefMatchesSubject(policy?.superAdmins, subject)) {
		return { role: 'admin', source: 'static-super-admin' };
	}
	if (project.owner === subject.id) return { role: 'admin', source: 'owner' };
	let best: Role | null = null;
	const preference = { 'member-id': 2, 'member-email': 1, 'member-group': 0 };
	let source: keyof typeof preference | undefined;
	for (const member of project.members) {
		if (member.group !== undefined && member.role === 'admin') continue;
		if (!memberRefMatchesSubject(member, subject)) continue;
		const candidateSource =
			member.user_id !== undefined
				? 'member-id'
				: member.email !== undefined
					? 'member-email'
					: 'member-group';
		if (
			best === null ||
			RANK[member.role] > RANK[best] ||
			(RANK[member.role] === RANK[best] &&
				source !== undefined &&
				preference[candidateSource] > preference[source])
		) {
			best = member.role;
			source = candidateSource;
		}
		if (best === 'admin' && source === 'member-id') break;
	}
	if (best !== null) return { role: best, source: source ?? 'member-id' };

	if (project.default_role !== undefined && project.default_role !== 'inherit') {
		return {
			role: project.default_role === 'none' ? null : project.default_role,
			source: 'project-default',
		};
	}

	const role = subjectDefaultRole(subject, policy);
	if (role === null) return { role, source: 'none' };
	return {
		role,
		source: role === policy?.defaultRole ? 'deployment-default' : 'entitlement-default',
	};
}

/** True if the caller's role on the project is at least `min`. */
export function canAct(
	project: Project,
	subject: AuthSubject,
	min: Role,
	policy?: AuthzPolicy,
): boolean {
	return roleAtLeast(effectiveRole(project, subject, policy), min);
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
 * Snapshot rosters can lag membership changes and omit project defaults.
 * Non-owner decisions must load the authoritative project record.
 */
export function canSeeProjectEntry(
	entry: {
		owner: UserId;
		member_ids?: UserId[];
		member_emails?: string[];
		member_groups?: string[];
	},
	subject: AuthSubject,
	policy?: AuthzPolicy,
): boolean | null {
	if (isSuperAdmin(subject, policy?.superAdmins) || entry.owner === subject.id) return true;
	return null;
}

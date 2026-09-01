/**
 * Application authorization service.
 *
 * One owner for every resource-access decision: the baseline role matrix
 * (`effectiveRole`), lifecycle rules (a deleted project is nonexistent for
 * everyone, super admins included), read-visibility masking (a hidden project
 * is indistinguishable from a missing one), viewer-mode session admission
 * (`sessionCan` / `canStartSessionMode`), and deployment standing (super-admin,
 * project creation). Callers act on the returned {@link AuthorizationDecision}
 * — a bounded verdict with a denial category, never raw attributes — and map
 * it to their transport (403 vs 404) at the edge.
 *
 * The service reproduces the pre-existing rules exactly; it adds no
 * permissions. `effectiveRole` remains the baseline role calculation (and the
 * display value); it is not the complete authorization result. Resource
 * security labels and subject-context constraints, when they arrive, compose
 * here as additional restrictions — a future constraint adapter can deny an
 * access the role permits, never grant one the role denies.
 *
 * Decision methods are asynchronous from this first version so future
 * constraint evaluation (batch, possibly remote) fits without an API break.
 */
import {
	canCreateProject,
	canSeeProjectEntry,
	effectiveRole,
	isSuperAdmin,
	roleAtLeast,
	subjectDefaultRole,
} from '../../authz';
import type { AuthSubject, AuthzPolicy } from '../../authz';
import type { EditorSandboxSharing, Role, SessionMode, ViewerMode } from '../../constants';
import type { UserId } from '../../ids';
import type { Project, Session } from '../../schema';
import { canStartSessionMode, sessionCan } from '../runtime/sessionAuthz';
import type { SessionAction } from '../runtime/sessionAuthz';
import { ACTION_RULES } from './actions';
import type {
	AuthorizationAction,
	DeploymentAction,
	ProjectAction,
	SessionScopedAction,
} from './actions';

/** The deployment policy slice every authorization decision reads. */
export type AuthorizationPolicy = AuthzPolicy & {
	viewerMode?: ViewerMode;
	editorSandboxSharing?: EditorSandboxSharing;
};

/** The session fields admission decisions read. */
export type SessionAdmissionRecord = Pick<
	Session,
	'mode' | 'ephemeral' | 'user_id' | 'editor_sandbox_sharing'
>;

export type AuthorizationResource =
	| { kind: 'deployment' }
	| { kind: 'project'; project: Project }
	| { kind: 'session'; project: Project; session: SessionAdmissionRecord }
	| { kind: 'session-start'; project: Project; mode: SessionMode };

/**
 * Bounded denial categories. `lifecycle` and `visibility` present the resource
 * as nonexistent (404); `role`, `session`, and `standing` are plain forbidden
 * (403). The category carries no attribute or membership detail.
 */
export type AuthorizationDenialCategory =
	| 'lifecycle'
	| 'visibility'
	| 'role'
	| 'session'
	| 'standing';

export type AuthorizationDecision =
	| { allowed: true; role: Role | null }
	| { allowed: false; category: AuthorizationDenialCategory; role: Role | null };

const SESSION_ACTION_FOR: Record<SessionScopedAction, SessionAction> = {
	'session.attach': 'attach',
	'session.stop': 'stop',
	'session.surface': 'surface',
	'session.proxy': 'attach',
};

/** A catalog snapshot entry as list visibility reads it (denormalized members). */
export interface ProjectEntryVisibilityInput {
	owner: UserId;
	member_ids?: UserId[];
	member_emails?: string[];
}

export class AuthorizationService {
	constructor(private readonly policy: AuthorizationPolicy | undefined) {}

	async authorize(
		subject: AuthSubject,
		action: AuthorizationAction,
		resource: AuthorizationResource,
	): Promise<AuthorizationDecision> {
		const rule = ACTION_RULES[action];
		if (resource.kind !== rule.scope) {
			throw new Error(`Action ${action} requires a ${rule.scope} resource, got ${resource.kind}`);
		}
		if (resource.kind === 'deployment') {
			return this.decideDeployment(subject, action as DeploymentAction);
		}
		// Lifecycle precedes every project-scoped rule on purpose: a soft-deleted
		// project is unreachable for everyone, super admins included.
		if (resource.project.status === 'deleted') {
			return { allowed: false, category: 'lifecycle', role: null };
		}
		const role = effectiveRole(resource.project, subject, this.policy);
		switch (resource.kind) {
			case 'project': {
				const projectRule = ACTION_RULES[action as ProjectAction];
				if (roleAtLeast(role, projectRule.min)) return { allowed: true, role };
				return {
					allowed: false,
					category: projectRule.deniedAs === 'not-found' ? 'visibility' : 'role',
					role,
				};
			}
			case 'session': {
				const sessionAction = SESSION_ACTION_FOR[action as SessionScopedAction];
				return sessionCan(sessionAction, this.sessionActor(subject, role), resource.session)
					? { allowed: true, role }
					: { allowed: false, category: 'session', role };
			}
			case 'session-start':
				return canStartSessionMode({ role, viewerMode: this.policy?.viewerMode }, resource.mode)
					? { allowed: true, role }
					: { allowed: false, category: 'session', role };
		}
	}

	/** Batch form of {@link authorize} for list and sweep paths. */
	async authorizeMany(
		subject: AuthSubject,
		action: AuthorizationAction,
		resources: readonly AuthorizationResource[],
	): Promise<AuthorizationDecision[]> {
		return Promise.all(resources.map((resource) => this.authorize(subject, action, resource)));
	}

	/** The baseline role for display (`your_role`) and derived projections. */
	role(subject: AuthSubject, project: Project): Role | null {
		return effectiveRole(project, subject, this.policy);
	}

	isSuperAdmin(subject: AuthSubject): boolean {
		return isSuperAdmin(subject, this.policy?.superAdmins);
	}

	/**
	 * List fast path: subjects who see every project (super admins, or anyone a
	 * deployment default role makes at least a viewer) skip per-entry checks.
	 */
	listsAllProjects(subject: AuthSubject): boolean {
		return (
			subjectDefaultRole(subject, this.policy) != null ||
			isSuperAdmin(subject, this.policy?.superAdmins)
		);
	}

	/**
	 * Per-entry list visibility from the denormalized catalog snapshot. `null`
	 * means indeterminate (the entry predates `member_ids`): the caller must
	 * decide from the authoritative project record instead — never treat
	 * indeterminate as visible.
	 */
	projectEntryVisibility(subject: AuthSubject, entry: ProjectEntryVisibilityInput): boolean | null {
		return canSeeProjectEntry(entry, subject, this.policy);
	}

	private decideDeployment(subject: AuthSubject, action: DeploymentAction): AuthorizationDecision {
		const allowed =
			action === 'project.create'
				? canCreateProject(subject, this.policy)
				: isSuperAdmin(subject, this.policy?.superAdmins);
		return allowed
			? { allowed: true, role: null }
			: { allowed: false, category: 'standing', role: null };
	}

	private sessionActor(subject: AuthSubject, role: Role | null) {
		return {
			userId: subject.id,
			role,
			viewerMode: this.policy?.viewerMode,
			editorSandboxSharing: this.policy?.editorSandboxSharing,
		};
	}
}

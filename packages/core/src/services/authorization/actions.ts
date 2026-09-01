/**
 * The bounded authorization action vocabulary.
 *
 * Every resource-access decision names one of these actions; free-form
 * role-tier checks at call sites are the drift this table replaces. Each rule
 * pins the action's scope, its baseline minimum role, and how a role denial
 * presents at the transport edge:
 *
 * - `not-found` — visibility masking: the caller must not learn the resource
 *   exists (read-tier project access).
 * - `forbidden` — a plain 403: the caller may know the resource exists but
 *   lacks the role (writes, and reads that follow an existence-revealing
 *   guard).
 *
 * The tiers reproduce the pre-existing per-route checks exactly. Changing a
 * rule here changes live access control — treat every edit as a security
 * change.
 */
import type { Role } from '../../constants';

export const DEPLOYMENT_ACTIONS = [
	/** Create a project (restricted deployments: super-admin or `project-creator`). */
	'project.create',
	/** Super-admin surfaces: user directory, deployment config, diagnostics. */
	'admin.access',
	/** Manage organization-wide integrations. */
	'org-integration.manage',
	/** Read the deployment-wide audit log. */
	'audit.global.read',
] as const;

export const PROJECT_ACTIONS = [
	/** See the project and its read-tier content (metadata, notebooks, versions, downloads). */
	'project.read',
	'project.update',
	'project.delete',
	'project.members.manage',
	/** Read the project audit log. */
	'project.events.read',
	'project.alerts.manage',
	/** Modify notebook content, workspaces, and versions. */
	'notebook.write',
	/** Notebook administration (delete, restore, source rewiring). */
	'notebook.manage',
	/** Read integration configuration and browse through it. */
	'integration.read',
	/** Reach data through an integration: previews, queries, object access. */
	'integration.use',
	'integration.manage',
	/** Publish a change request (PR/MR) from a notebook session. */
	'change-request.publish',
	/** Add security labels or provably increase them (compartment superset). */
	'security-labels.raise',
	/** Lower, remove, or otherwise change security labels non-monotonically. */
	'security-labels.lower',
] as const;

export const SESSION_ACTIONS = [
	/** Reach a live session's kernel: proxy traffic, heartbeats, `sandbox_url`. */
	'session.attach',
	/** Stop, terminate, or restart a session. */
	'session.stop',
	/** Use a secondary editor surface on a session. */
	'session.surface',
	/** Forwarded kernel traffic through the app proxy (same admission as attach). */
	'session.proxy',
] as const;

export const SESSION_START_ACTIONS = [
	/** Start a session of a given mode (role + viewer-mode admission). */
	'session.start',
] as const;

export const AUTHORIZATION_ACTIONS = [
	...DEPLOYMENT_ACTIONS,
	...PROJECT_ACTIONS,
	...SESSION_ACTIONS,
	...SESSION_START_ACTIONS,
] as const;

export type DeploymentAction = (typeof DEPLOYMENT_ACTIONS)[number];
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];
export type SessionScopedAction = (typeof SESSION_ACTIONS)[number];
export type SessionStartAction = (typeof SESSION_START_ACTIONS)[number];
export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

export type ActionScope = 'deployment' | 'project' | 'session' | 'session-start';

export interface ProjectActionRule {
	scope: 'project';
	/** Baseline minimum role on the project. */
	min: Role;
	/** How a role denial presents: masked as nonexistent, or plain forbidden. */
	deniedAs: 'not-found' | 'forbidden';
	/**
	 * Security-sensitive mutations gated on deployment standing, NOT project
	 * role: an owner or manager does not hold label authority by default.
	 */
	requiresSuperAdmin?: true;
}

export interface NonProjectActionRule {
	scope: Exclude<ActionScope, 'project'>;
}

export type ActionRule = ProjectActionRule | NonProjectActionRule;

const project = (min: Role, deniedAs: 'not-found' | 'forbidden'): ProjectActionRule => ({
	scope: 'project',
	min,
	deniedAs,
});

export const ACTION_RULES: {
	[A in AuthorizationAction]: A extends ProjectAction ? ProjectActionRule : NonProjectActionRule;
} = {
	'project.create': { scope: 'deployment' },
	'admin.access': { scope: 'deployment' },
	'org-integration.manage': { scope: 'deployment' },
	'audit.global.read': { scope: 'deployment' },

	'project.read': project('viewer', 'not-found'),
	'project.update': project('manager', 'forbidden'),
	'project.delete': project('manager', 'forbidden'),
	'project.members.manage': project('manager', 'forbidden'),
	'project.events.read': project('manager', 'forbidden'),
	'project.alerts.manage': project('manager', 'forbidden'),
	'notebook.write': project('editor', 'forbidden'),
	'notebook.manage': project('manager', 'forbidden'),
	'integration.read': project('viewer', 'forbidden'),
	'integration.use': project('editor', 'forbidden'),
	'integration.manage': project('manager', 'forbidden'),
	'change-request.publish': project('manager', 'forbidden'),
	'security-labels.raise': {
		scope: 'project',
		min: 'viewer',
		deniedAs: 'forbidden',
		requiresSuperAdmin: true,
	},
	'security-labels.lower': {
		scope: 'project',
		min: 'viewer',
		deniedAs: 'forbidden',
		requiresSuperAdmin: true,
	},

	'session.attach': { scope: 'session' },
	'session.stop': { scope: 'session' },
	'session.surface': { scope: 'session' },
	'session.proxy': { scope: 'session' },

	'session.start': { scope: 'session-start' },
};

/** The baseline minimum role for a project-scoped action (guards' 403 message). */
export function projectActionMinRole(action: ProjectAction): Role {
	return ACTION_RULES[action].min;
}

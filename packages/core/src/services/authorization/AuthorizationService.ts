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
	isSuperAdmin,
	resolveEffectiveRole,
	roleAtLeast,
	subjectDefaultRole,
} from '../../authz';
import type { AuthSubject, AuthzPolicy } from '../../authz';
import { withDeadline } from '../../async';
import { logEvent } from '../../logs';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import type {
	ConstraintDecision,
	ConstraintDenialReason,
	ConstraintEvidence,
	ResourceConstraintPolicy,
} from '../../ports/resourceConstraints';
import { validateSubjectSecurityContext } from '../../ports/subjectContext';
import type {
	SubjectSecurityContext,
	SubjectSecurityContextProvider,
} from '../../ports/subjectContext';
import type { ResourceSecurityLabels } from '../../securityLabels';
import { MAX_SECURITY_COMPARTMENTS, SECURITY_LABEL_TOKEN } from '../../securityLabels';
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

/**
 * Resource-security wiring: the deny-only constraint adapter, the subject
 * context provider, and the shared deadline for both. Injected into the
 * service's constructor as collaborators — the policy object stays pure
 * env-derived data. A labeled resource WITHOUT this wiring fails closed —
 * labels must never open up because the deployment forgot an adapter.
 */
export interface ResourceSecurityPolicy {
	constraints: ResourceConstraintPolicy;
	subjectContext?: SubjectSecurityContextProvider;
	/** Per context-resolution / constraint-evaluation deadline (default 5s). */
	timeoutMs?: number;
}

/** The deployment policy slice every authorization decision reads. */
export type AuthorizationPolicy = AuthzPolicy & {
	viewerMode?: ViewerMode;
	editorSandboxSharing?: EditorSandboxSharing;
};

/**
 * A subject with credential provenance can carry a resolvable security
 * context; a bare subject never does and fails closed on labeled resources.
 * The union keeps that distinction in the signature instead of a cast.
 */
export type AuthorizationSubject = AuthSubject | AuthenticatedPrincipal;

/** The session fields admission decisions read. */
export type SessionAdmissionRecord = Pick<
	Session,
	'mode' | 'ephemeral' | 'user_id' | 'editor_sandbox_sharing'
>;

/**
 * Optional notebook security-label override carried alongside a project-scoped
 * resource. Both label sets must be satisfied, so an override can only add
 * restrictions. `null`/absent = no override.
 */
export interface NotebookLabelOverride {
	notebookLabels?: ResourceSecurityLabels | null;
}

export type AuthorizationResource =
	| { kind: 'deployment' }
	| ({ kind: 'project'; project: Project } & NotebookLabelOverride)
	| ({ kind: 'session'; project: Project; session: SessionAdmissionRecord } & NotebookLabelOverride)
	| ({ kind: 'session-start'; project: Project; mode: SessionMode } & NotebookLabelOverride);

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
	| 'standing'
	| 'constraint';

export type AuthorizationDecision =
	| {
			allowed: true;
			role: Role | null;
			/**
			 * Expiry of the subject security context that satisfied a labeled
			 * resource. Sessions and proxies must not outlive it.
			 */
			subjectContextExpiresAt?: string;
	  }
	| {
			allowed: false;
			category: AuthorizationDenialCategory;
			role: Role | null;
			/**
			 * For `constraint` denials only: why, in the port's bounded terms — an
			 * internal operational/audit signal ("no clearance" vs "adapter down").
			 * Transport mapping ignores it; every constraint denial masks the same.
			 */
			constraintReason?: ConstraintDenialReason;
	  };

export interface AuthorizationTraceStep {
	stage: 'action' | 'lifecycle' | 'role' | 'standing' | 'session' | 'constraint' | 'final';
	status: 'passed' | 'failed' | 'skipped';
	code: string;
	details?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationAnalysis {
	decision: AuthorizationDecision;
	presentation: 'allowed' | 'forbidden' | 'not-found';
	trace: readonly AuthorizationTraceStep[];
}

export type AuthorizationAnalysisContext =
	| { mode: 'live' }
	| { mode: 'synthetic'; value: SubjectSecurityContext | null };

const SESSION_ACTION_FOR: Record<SessionScopedAction, SessionAction> = {
	'session.attach': 'attach',
	'session.stop': 'stop',
	'session.surface': 'surface',
	'session.proxy': 'attach',
};

const DEFAULT_RESOURCE_SECURITY_TIMEOUT_MS = 5_000;

/** Discriminates a deadline expiry from an adapter failure at the swallow sites. */
class ResourceSecurityTimeoutError extends Error {
	constructor() {
		super('resource security evaluation timed out');
		this.name = 'ResourceSecurityTimeoutError';
	}
}

/**
 * Stable, content-free operational events for the fail-closed paths, following
 * the login-policy precedent: without them an adapter outage is
 * indistinguishable from "no clearance" — every labeled resource just 404s.
 * Fields never include labels, claims, or error text.
 */
const SECURITY_EVENTS = {
	contextTimeout: 'authz_subject_context_timeout',
	contextFailed: 'authz_subject_context_failed',
	contextInvalid: 'authz_subject_context_invalid',
	constraintUnwired: 'authz_constraint_unwired',
	constraintTimeout: 'authz_constraint_timeout',
	constraintFailed: 'authz_constraint_failed',
	constraintMiscount: 'authz_constraint_miscount',
	constraintInvalid: 'authz_constraint_invalid',
} as const;

const CONSTRAINT_DENIAL_REASONS: ReadonlySet<string> = new Set([
	'missing-context',
	'constraint',
	'unavailable',
]);

/**
 * Shape-validate an adapter's decision — external output, not a trusted type.
 * A truthy-but-not-`true` `satisfied` or an unknown denial reason yields
 * `null`, which the caller treats as an `unavailable` denial.
 */
function parseConstraintDecision(value: unknown): ConstraintDecision | null {
	if (typeof value !== 'object' || value === null) return null;
	const decision = value as { satisfied?: unknown; reason?: unknown; evidence?: unknown };
	const evidence = parseConstraintEvidence(decision.evidence);
	if (decision.evidence !== undefined && evidence === null) return null;
	if (decision.satisfied === true) {
		return { satisfied: true, ...(evidence ? { evidence } : {}) };
	}
	if (
		decision.satisfied === false &&
		typeof decision.reason === 'string' &&
		CONSTRAINT_DENIAL_REASONS.has(decision.reason)
	) {
		return {
			satisfied: false,
			reason: decision.reason as ConstraintDenialReason,
			...(evidence ? { evidence } : {}),
		};
	}
	return null;
}

function parseConstraintEvidence(value: unknown): ConstraintEvidence | null {
	if (value === undefined) return null;
	if (typeof value !== 'object' || value === null) return null;
	const evidence = value as Record<string, unknown>;
	if (
		(evidence.heldClassification !== null &&
			(typeof evidence.heldClassification !== 'string' ||
				!SECURITY_LABEL_TOKEN.test(evidence.heldClassification))) ||
		typeof evidence.requiredClassification !== 'string' ||
		!SECURITY_LABEL_TOKEN.test(evidence.requiredClassification) ||
		typeof evidence.classificationSatisfied !== 'boolean' ||
		!Array.isArray(evidence.missingCompartments) ||
		evidence.missingCompartments.length > MAX_SECURITY_COMPARTMENTS ||
		evidence.missingCompartments.some(
			(item) => typeof item !== 'string' || !SECURITY_LABEL_TOKEN.test(item),
		)
	) {
		return null;
	}
	return {
		heldClassification: evidence.heldClassification,
		requiredClassification: evidence.requiredClassification,
		classificationSatisfied: evidence.classificationSatisfied,
		missingCompartments: evidence.missingCompartments as string[],
	};
}

/** A catalog snapshot entry as list visibility reads it (denormalized members). */
export interface ProjectEntryVisibilityInput {
	owner: UserId;
	member_ids?: UserId[];
	member_emails?: string[];
}

export class AuthorizationService {
	constructor(
		private readonly policy: AuthorizationPolicy | undefined,
		private readonly security?: ResourceSecurityPolicy,
	) {}

	async authorize(
		subject: AuthorizationSubject,
		action: AuthorizationAction,
		resource: AuthorizationResource,
	): Promise<AuthorizationDecision> {
		const { decision, labelSets } = this.decideBaseline(subject, action, resource);
		if (!decision.allowed || labelSets.length === 0) return decision;
		const constraint = await this.evaluateLabelSets(
			action,
			labelSets,
			this.contextResolver(subject),
		);
		if (!constraint.satisfied) {
			return {
				allowed: false,
				category: 'constraint',
				role: decision.role,
				constraintReason: constraint.reason,
			};
		}
		return { ...decision, subjectContextExpiresAt: constraint.contextExpiresAt };
	}

	async analyze(
		subject: AuthorizationSubject,
		action: AuthorizationAction,
		resource: AuthorizationResource,
		context: AuthorizationAnalysisContext = { mode: 'live' },
	): Promise<AuthorizationAnalysis> {
		const trace: AuthorizationTraceStep[] = [];
		const { decision: baseline, labelSets } = this.decideBaseline(subject, action, resource, trace);
		let decision = baseline;
		if (baseline.allowed && labelSets.length > 0) {
			const constraint = await this.evaluateLabelSets(
				action,
				labelSets,
				context.mode === 'synthetic' ? async () => context.value : this.contextResolver(subject),
			);
			trace.push({
				stage: 'constraint',
				status: constraint.satisfied ? 'passed' : 'failed',
				code: constraint.satisfied
					? 'resource_constraints_satisfied'
					: `resource_constraints_${constraint.reason}`,
				details: {
					contextMode: context.mode,
					labelSetCount: labelSets.length,
					...(constraint.evidence ? { evidence: constraint.evidence } : {}),
				},
			});
			decision = constraint.satisfied
				? { ...baseline, subjectContextExpiresAt: constraint.contextExpiresAt }
				: {
						allowed: false,
						category: 'constraint',
						role: baseline.role,
						constraintReason: constraint.reason,
					};
		} else if (baseline.allowed) {
			trace.push({ stage: 'constraint', status: 'skipped', code: 'resource_unlabeled' });
		} else {
			trace.push({
				stage: 'constraint',
				status: 'skipped',
				code: 'baseline_denied',
			});
		}
		const presentation = decision.allowed
			? 'allowed'
			: decision.category === 'lifecycle' ||
				  decision.category === 'visibility' ||
				  decision.category === 'constraint'
				? 'not-found'
				: 'forbidden';
		trace.push({
			stage: 'final',
			status: decision.allowed ? 'passed' : 'failed',
			code: decision.allowed
				? 'authorization_allowed'
				: `authorization_denied_${decision.category}`,
			details: { presentation },
		});
		return { decision, presentation, trace };
	}

	/**
	 * Batch form of {@link authorize} for list and sweep paths: one subject
	 * context resolution AND one constraint-adapter round-trip for the whole
	 * batch — a decision per resource must never cost one call per resource.
	 * Label sets of role-allowed resources are flattened into a single
	 * `evaluateMany` and correlated back by per-resource set counts.
	 */
	async authorizeMany(
		subject: AuthorizationSubject,
		action: AuthorizationAction,
		resources: readonly AuthorizationResource[],
	): Promise<AuthorizationDecision[]> {
		const baselines = resources.map((resource) => this.decideBaseline(subject, action, resource));
		const labeled = baselines.flatMap((baseline, index) =>
			baseline.decision.allowed && baseline.labelSets.length > 0
				? [{ index, decision: baseline.decision, labelSets: baseline.labelSets }]
				: [],
		);
		const out = baselines.map((baseline) => baseline.decision);
		if (labeled.length === 0) return out;
		const batch = await this.constraintBatch(
			action,
			labeled.flatMap((entry) => entry.labelSets),
			this.contextResolver(subject),
		);
		let cursor = 0;
		for (const { index, decision, labelSets } of labeled) {
			const deny = (reason: ConstraintDenialReason): void => {
				out[index] = {
					allowed: false,
					category: 'constraint',
					role: decision.role,
					constraintReason: reason,
				};
			};
			if (!batch.ok) {
				deny(batch.reason);
				continue;
			}
			const slice = batch.decisions.slice(cursor, cursor + labelSets.length);
			cursor += labelSets.length;
			const denied = slice.find((entry) => !entry.satisfied);
			if (denied?.satisfied === false) {
				deny(denied.reason);
			} else {
				out[index] = { ...decision, subjectContextExpiresAt: batch.contextExpiresAt };
			}
		}
		return out;
	}

	/**
	 * The synchronous half of a decision: lifecycle, role, standing, and session
	 * admission — plus the label sets a constraint pass must then satisfy.
	 * `roleAllowed AND constraintsSatisfied`: labels only ever restrict, a role
	 * denial never consults constraints, and a notebook override is evaluated IN
	 * ADDITION to the project labels so it can never lower them.
	 */
	private decideBaseline(
		subject: AuthorizationSubject,
		action: AuthorizationAction,
		resource: AuthorizationResource,
		trace?: AuthorizationTraceStep[],
	): { decision: AuthorizationDecision; labelSets: readonly ResourceSecurityLabels[] } {
		const rule = ACTION_RULES[action];
		if (resource.kind !== rule.scope) {
			throw new Error(`Action ${action} requires a ${rule.scope} resource, got ${resource.kind}`);
		}
		trace?.push({
			stage: 'action',
			status: 'passed',
			code: 'action_rule_loaded',
			details: {
				action,
				scope: rule.scope,
				...('min' in rule
					? {
							minimumRole: rule.min,
							deniedAs: rule.deniedAs,
							requiresSuperAdmin: rule.requiresSuperAdmin === true,
						}
					: {}),
			},
		});
		if (resource.kind === 'deployment') {
			const decision = this.decideDeployment(subject, action as DeploymentAction);
			trace?.push({
				stage: 'standing',
				status: decision.allowed ? 'passed' : 'failed',
				code: decision.allowed ? 'deployment_standing_satisfied' : 'deployment_standing_missing',
				details: { entitlements: [...(subject.entitlements ?? [])] },
			});
			return {
				decision,
				labelSets: [],
			};
		}
		// Lifecycle precedes every project-scoped rule on purpose: a soft-deleted
		// project is unreachable for everyone, super admins included.
		if (resource.project.status === 'deleted') {
			trace?.push({ stage: 'lifecycle', status: 'failed', code: 'project_deleted' });
			return { decision: { allowed: false, category: 'lifecycle', role: null }, labelSets: [] };
		}
		trace?.push({ stage: 'lifecycle', status: 'passed', code: 'project_active' });
		const roleResolution = resolveEffectiveRole(resource.project, subject, this.policy);
		const role = roleResolution.role;
		trace?.push({
			stage: 'role',
			status: role === null ? 'failed' : 'passed',
			code: `effective_role_${roleResolution.source}`,
			details: { role, entitlements: [...(subject.entitlements ?? [])] },
		});
		const decision = ((): AuthorizationDecision => {
			switch (resource.kind) {
				case 'project': {
					const projectRule = ACTION_RULES[action as ProjectAction];
					if (projectRule.requiresSuperAdmin && !isSuperAdmin(subject, this.policy?.superAdmins)) {
						trace?.push({
							stage: 'standing',
							status: 'failed',
							code: 'super_admin_standing_missing',
						});
						return { allowed: false, category: 'standing', role };
					}
					if (projectRule.requiresSuperAdmin) {
						trace?.push({
							stage: 'standing',
							status: 'passed',
							code: 'super_admin_standing_satisfied',
						});
					}
					if (roleAtLeast(role, projectRule.min)) return { allowed: true, role };
					return {
						allowed: false,
						category: projectRule.deniedAs === 'not-found' ? 'visibility' : 'role',
						role,
					};
				}
				case 'session': {
					const sessionAction = SESSION_ACTION_FOR[action as SessionScopedAction];
					const allowed = sessionCan(
						sessionAction,
						this.sessionActor(subject, role),
						resource.session,
					);
					trace?.push({
						stage: 'session',
						status: allowed ? 'passed' : 'failed',
						code: allowed ? 'session_rule_satisfied' : 'session_rule_denied',
						details: { sessionAction, mode: resource.session.mode ?? 'edit' },
					});
					return allowed ? { allowed: true, role } : { allowed: false, category: 'session', role };
				}
				case 'session-start': {
					const allowed = canStartSessionMode(
						{ role, viewerMode: this.policy?.viewerMode },
						resource.mode,
					);
					trace?.push({
						stage: 'session',
						status: allowed ? 'passed' : 'failed',
						code: allowed ? 'session_start_satisfied' : 'session_start_denied',
						details: { mode: resource.mode, viewerMode: this.policy?.viewerMode ?? 'static' },
					});
					return allowed ? { allowed: true, role } : { allowed: false, category: 'session', role };
				}
			}
		})();
		const labelSets = [
			resource.project.security_labels ?? null,
			resource.notebookLabels ?? null,
		].filter((labels): labels is ResourceSecurityLabels => labels !== null);
		return { decision, labelSets };
	}

	/** The baseline role for display (`your_role`) and derived projections. */
	role(subject: AuthSubject, project: Project): Role | null {
		return resolveEffectiveRole(project, subject, this.policy).role;
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

	/**
	 * Whether the subject satisfies a resource's labels — the single-decision
	 * form used by list fallbacks (`null` = known unlabeled → satisfied).
	 */
	async constraintsSatisfied(
		subject: AuthorizationSubject,
		labels: ResourceSecurityLabels | null,
	): Promise<boolean> {
		if (labels === null) return true;
		const decision = await this.evaluateLabelSets(
			'project.read',
			[labels],
			this.contextResolver(subject),
		);
		return decision.satisfied;
	}

	/**
	 * Batch constraint decisions over resolved label states for the list path:
	 * one subject-context resolution and one adapter batch for the whole page's
	 * worth of entries. Callers resolve indeterminate (legacy/pending) snapshot
	 * label states from the authoritative record BEFORE calling.
	 */
	async projectLabelConstraints(
		subject: AuthorizationSubject,
		labelStates: readonly (ResourceSecurityLabels | null)[],
	): Promise<boolean[]> {
		if (labelStates.every((labels) => labels === null)) {
			return labelStates.map(() => true);
		}
		const security = this.security;
		if (!security) {
			this.emitSecurityEvent(SECURITY_EVENTS.constraintUnwired, 'project.read');
			return labelStates.map((labels) => labels === null);
		}
		const context = await this.contextResolver(subject)();
		// No valid context: labeled entries are denied without consulting the
		// adapter — same trust boundary as {@link constraintBatch}.
		if (context === null) {
			return labelStates.map((labels) => labels === null);
		}
		try {
			const decisions = await this.withSecurityDeadline(security, (signal) =>
				Promise.resolve(
					security.constraints.evaluateMany(
						context,
						'project.read',
						labelStates.map((labels) => ({ labels })),
						signal,
					),
				),
			);
			if (decisions.length !== labelStates.length) {
				// A miscounting adapter cannot be trusted for any entry.
				this.emitSecurityEvent(SECURITY_EVENTS.constraintMiscount, 'project.read');
				return labelStates.map((labels) => labels === null);
			}
			return decisions.map(
				(decision, index) =>
					labelStates[index] === null || parseConstraintDecision(decision)?.satisfied === true,
			);
		} catch (error) {
			this.emitConstraintFailure(error, 'project.read');
			return labelStates.map((labels) => labels === null);
		}
	}

	/**
	 * Lazy, per-call-memoized subject-context resolution: resolved at most once
	 * per authorize/authorizeMany invocation and only when a labeled resource
	 * actually needs it. Operational failures and timeouts yield null — a
	 * labeled resource then fails closed, never open.
	 */
	private contextResolver(
		subject: AuthorizationSubject,
	): () => Promise<SubjectSecurityContext | null> {
		let resolved: Promise<SubjectSecurityContext | null> | undefined;
		return () => (resolved ??= this.resolveSubjectContext(subject));
	}

	private async resolveSubjectContext(
		subject: AuthorizationSubject,
	): Promise<SubjectSecurityContext | null> {
		const security = this.security;
		const provider = security?.subjectContext;
		if (!security || !provider) return null;
		// Only a principal with credential provenance can resolve a context;
		// bare subjects (and unsupported credential kinds, per the provider's
		// contract) have none and fail closed on labeled resources.
		if (!('credential' in subject)) return null;
		try {
			const context = await this.withSecurityDeadline(security, (signal) =>
				Promise.resolve(provider.resolve(subject, signal)),
			);
			if (context === null) return null;
			const validated = validateSubjectSecurityContext(context);
			if (validated === null) this.emitSecurityEvent(SECURITY_EVENTS.contextInvalid);
			return validated;
		} catch (error) {
			this.emitSecurityEvent(
				error instanceof ResourceSecurityTimeoutError
					? SECURITY_EVENTS.contextTimeout
					: SECURITY_EVENTS.contextFailed,
			);
			return null;
		}
	}

	/**
	 * All of a decision's label sets (project labels plus any notebook override)
	 * through {@link constraintBatch}; every set must be satisfied.
	 */
	private async evaluateLabelSets(
		action: AuthorizationAction,
		labelSets: readonly ResourceSecurityLabels[],
		getContext: () => Promise<SubjectSecurityContext | null>,
	): Promise<
		| {
				satisfied: true;
				contextExpiresAt: string;
				evidence?: readonly ConstraintEvidence[];
		  }
		| {
				satisfied: false;
				reason: ConstraintDenialReason;
				evidence?: readonly ConstraintEvidence[];
		  }
	> {
		const batch = await this.constraintBatch(action, labelSets, getContext);
		if (!batch.ok) return { satisfied: false, reason: batch.reason };
		const evidence = batch.decisions.flatMap((decision) =>
			decision.evidence ? [decision.evidence] : [],
		);
		const denied = batch.decisions.find((decision) => !decision.satisfied);
		if (denied?.satisfied === false) {
			return {
				satisfied: false,
				reason: denied.reason,
				...(evidence.length > 0 ? { evidence } : {}),
			};
		}
		return {
			satisfied: true,
			contextExpiresAt: batch.contextExpiresAt,
			...(evidence.length > 0 ? { evidence } : {}),
		};
	}

	/**
	 * One adapter round-trip for a batch of label sets — a network PDP must not
	 * pay one call per resource (or per set). The adapter is a trust boundary:
	 * a labeled set is never delegated without a valid subject context (even an
	 * adapter that would wrongly satisfy it cannot open access), a wrong-length
	 * result discards the whole batch, and each decision is shape-validated
	 * rather than trusted from the TypeScript type.
	 */
	private async constraintBatch(
		action: AuthorizationAction,
		labelSets: readonly ResourceSecurityLabels[],
		getContext: () => Promise<SubjectSecurityContext | null>,
	): Promise<
		| { ok: true; decisions: readonly ConstraintDecision[]; contextExpiresAt: string }
		| { ok: false; reason: ConstraintDenialReason }
	> {
		const security = this.security;
		// Labeled resources without wiring fail closed: labels must never open
		// up because the deployment forgot an adapter.
		if (!security) {
			this.emitSecurityEvent(SECURITY_EVENTS.constraintUnwired, action);
			return { ok: false, reason: 'unavailable' };
		}
		const context = await getContext();
		if (context === null) {
			return { ok: false, reason: 'missing-context' };
		}
		const resources = labelSets.map((labels) => ({ labels }));
		try {
			const raw =
				resources.length === 1
					? [
							await this.withSecurityDeadline(security, (signal) =>
								Promise.resolve(
									security.constraints.evaluate(context, action, resources[0], signal),
								),
							),
						]
					: await this.withSecurityDeadline(security, (signal) =>
							Promise.resolve(
								security.constraints.evaluateMany(context, action, resources, signal),
							),
						);
			if (raw.length !== resources.length) {
				this.emitSecurityEvent(SECURITY_EVENTS.constraintMiscount, action);
				return { ok: false, reason: 'unavailable' };
			}
			let invalid = false;
			const decisions = raw.map((decision) => {
				const parsed = parseConstraintDecision(decision);
				if (parsed === null) invalid = true;
				return parsed ?? { satisfied: false as const, reason: 'unavailable' as const };
			});
			if (invalid) this.emitSecurityEvent(SECURITY_EVENTS.constraintInvalid, action);
			return { ok: true, decisions, contextExpiresAt: context.expiresAt };
		} catch (error) {
			this.emitConstraintFailure(error, action);
			return { ok: false, reason: 'unavailable' };
		}
	}

	private withSecurityDeadline<T>(
		security: ResourceSecurityPolicy,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		return withDeadline(work, {
			timeoutMs: security.timeoutMs ?? DEFAULT_RESOURCE_SECURITY_TIMEOUT_MS,
			timeoutError: () => new ResourceSecurityTimeoutError(),
		});
	}

	private emitConstraintFailure(error: unknown, action: AuthorizationAction): void {
		this.emitSecurityEvent(
			error instanceof ResourceSecurityTimeoutError
				? SECURITY_EVENTS.constraintTimeout
				: SECURITY_EVENTS.constraintFailed,
			action,
		);
	}

	private emitSecurityEvent(event: string, action?: AuthorizationAction): void {
		logEvent({ level: 'warn', event, ...(action ? { action } : {}) }, { channel: 'warn' });
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

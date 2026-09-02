/**
 * Resource constraint policy port — the deny-only half of resource security.
 *
 * The authorization service computes `roleAllowed AND constraintsSatisfied`:
 * a constraint decision can deny an access the role permits, never grant one
 * the role denies, and it is never the final authorization decision. The
 * built-in local implementation evaluates a configured classification order
 * plus required compartments; agency-library and network-PDP adapters can
 * implement the same port. The batch operation exists for list paths — a
 * decision per entry must not cost one network call per resource.
 */
import type { ResourceSecurityLabels } from '../securityLabels';
// Type-only: the port shares the service's bounded action vocabulary without a
// runtime dependency on the rules table.
import type { AuthorizationAction } from '../services/authorization/actions';
import type { SubjectSecurityContext } from './subjectContext';

/** The bounded resource slice a constraint decision reads. `null` labels = known unlabeled. */
export interface ConstraintResource {
	labels: ResourceSecurityLabels | null;
}

/**
 * Bounded reasons a constraint is not satisfied: `missing-context` (the
 * subject has no valid security context), `constraint` (the context does not
 * dominate the labels), `unavailable` (the adapter could not decide — always
 * treated as denial).
 */
export type ConstraintDenialReason = 'missing-context' | 'constraint' | 'unavailable';

/** Optional bounded evidence for an operator-facing policy analysis. */
export interface ConstraintEvidence {
	heldClassification: string | null;
	requiredClassification: string;
	classificationSatisfied: boolean;
	missingCompartments: readonly string[];
}

export interface SatisfiedConstraintEvidence extends ConstraintEvidence {
	classificationSatisfied: true;
	missingCompartments: readonly [];
}

export type UnsatisfiedConstraintEvidence =
	| (ConstraintEvidence & { classificationSatisfied: false })
	| (ConstraintEvidence & {
			classificationSatisfied: true;
			missingCompartments: readonly [string, ...string[]];
	  });

/** Whether the resource's extra restrictions are satisfied. */
export type ConstraintDecision =
	| { satisfied: true; evidence?: SatisfiedConstraintEvidence }
	| {
			satisfied: false;
			reason: 'constraint';
			evidence?: UnsatisfiedConstraintEvidence;
	  }
	| { satisfied: false; reason: 'missing-context' | 'unavailable' };

export interface ResourceConstraintPolicy {
	evaluate(
		context: SubjectSecurityContext | null,
		action: AuthorizationAction,
		resource: ConstraintResource,
		signal: AbortSignal,
	): Promise<ConstraintDecision>;

	/**
	 * MUST return exactly one decision per input resource, in input order —
	 * the caller correlates decisions to resources by index. A wrong-length
	 * result is discarded wholesale (every entry fails closed), but a
	 * same-length reordering is undetectable and would attach decisions to the
	 * wrong resources.
	 */
	evaluateMany(
		context: SubjectSecurityContext | null,
		action: AuthorizationAction,
		resources: readonly ConstraintResource[],
		signal: AbortSignal,
	): Promise<readonly ConstraintDecision[]>;
}

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
import type { SubjectSecurityContext } from './subjectContext';

/** The bounded resource slice a constraint decision reads. `null` labels = known unlabeled. */
export interface ConstraintResource {
	labels: ResourceSecurityLabels | null;
}

/**
 * Whether the resource's extra restrictions are satisfied. Bounded reasons
 * only: `missing-context` (the subject has no valid security context),
 * `constraint` (the context does not dominate the labels), `unavailable`
 * (the adapter could not decide — always treated as denial).
 */
export type ConstraintDecision =
	| { satisfied: true }
	| { satisfied: false; reason: 'missing-context' | 'constraint' | 'unavailable' };

export interface ResourceConstraintPolicy {
	evaluate(
		context: SubjectSecurityContext | null,
		action: string,
		resource: ConstraintResource,
		signal: AbortSignal,
	): Promise<ConstraintDecision>;

	evaluateMany(
		context: SubjectSecurityContext | null,
		action: string,
		resources: readonly ConstraintResource[],
		signal: AbortSignal,
	): Promise<readonly ConstraintDecision[]>;
}

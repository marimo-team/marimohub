/**
 * In-process resource constraint policy with a configured classification order.
 * The deployment lists classifications from lowest to highest. For example:
 * `PUBLIC,INTERNAL,CONFIDENTIAL,RESTRICTED`. A resource passes when the subject
 * has the required classification rank and every required compartment. An
 * unknown subject or resource classification fails closed.
 */
import type {
	ConstraintDecision,
	ConstraintResource,
	ResourceConstraintPolicy,
} from '../../ports/resourceConstraints';
import type { SubjectSecurityContext } from '../../ports/subjectContext';
import { SECURITY_LABEL_TOKEN } from '../../securityLabels';
import type { AuthorizationAction } from './actions';

export class LocalResourceConstraintPolicy implements ResourceConstraintPolicy {
	private readonly rank: ReadonlyMap<string, number>;

	constructor(options: { classificationOrder: readonly string[] }) {
		const order = options.classificationOrder;
		if (order.length === 0 || order.some((value) => !SECURITY_LABEL_TOKEN.test(value))) {
			throw new Error('classificationOrder must be a non-empty list of bounded label tokens');
		}
		if (new Set(order).size !== order.length) {
			throw new Error('classificationOrder must not repeat a classification');
		}
		this.rank = new Map(order.map((value, index) => [value, index]));
	}

	async evaluate(
		context: SubjectSecurityContext | null,
		_action: AuthorizationAction,
		resource: ConstraintResource,
		_signal?: AbortSignal,
	): Promise<ConstraintDecision> {
		if (resource.labels === null) return { satisfied: true };
		if (context === null) return { satisfied: false, reason: 'missing-context' };
		const required = this.rank.get(resource.labels.classification);
		const held = this.rank.get(context.classification);
		if (required === undefined || held === undefined || held < required) {
			return { satisfied: false, reason: 'constraint' };
		}
		const compartments = new Set(context.compartments);
		return resource.labels.compartments.every((compartment) => compartments.has(compartment))
			? { satisfied: true }
			: { satisfied: false, reason: 'constraint' };
	}

	async evaluateMany(
		context: SubjectSecurityContext | null,
		action: AuthorizationAction,
		resources: readonly ConstraintResource[],
		signal: AbortSignal,
	): Promise<readonly ConstraintDecision[]> {
		return Promise.all(
			resources.map((resource) => this.evaluate(context, action, resource, signal)),
		);
	}
}

/**
 * In-process resource constraint policy over a configured classification
 * order. The deployment names its lattice lowest→highest (e.g.
 * `UNCLASSIFIED,CUI,SECRET,TOP_SECRET`); a labeled resource is satisfied when
 * the subject context's classification ranks at least as high AND the context
 * holds every required compartment. Everything unknown fails closed: a
 * classification absent from the configured order — on either side — can not
 * be dominated.
 */
import type {
	ConstraintDecision,
	ConstraintResource,
	ResourceConstraintPolicy,
} from '../../ports/resourceConstraints';
import type { SubjectSecurityContext } from '../../ports/subjectContext';
import { SECURITY_LABEL_TOKEN } from '../../securityLabels';

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
		_action: string,
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
		action: string,
		resources: readonly ConstraintResource[],
		signal: AbortSignal,
	): Promise<readonly ConstraintDecision[]> {
		return Promise.all(
			resources.map((resource) => this.evaluate(context, action, resource, signal)),
		);
	}
}

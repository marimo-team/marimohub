/**
 * Resource security labels: an optional classification plus required
 * compartments attached to a project (and, by override, a notebook). Labels
 * only ever ADD restrictions on top of the role matrix — satisfying them never
 * grants a role, and the classification ORDER is deliberately not defined
 * here: the resource constraint adapter owns the lattice, so core can compare
 * labels only for the lattice-free monotonic case (same classification, a
 * superset of compartments).
 */
import { z } from 'zod';

/** Bounded label token: printable, no whitespace/control characters. */
export const SECURITY_LABEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

export const MAX_SECURITY_COMPARTMENTS = 64;

export const ResourceSecurityLabelsSchema = z.strictObject({
	classification: z.string().regex(SECURITY_LABEL_TOKEN),
	compartments: z.array(z.string().regex(SECURITY_LABEL_TOKEN)).max(MAX_SECURITY_COMPARTMENTS),
});

export type ResourceSecurityLabels = z.infer<typeof ResourceSecurityLabelsSchema>;

/** Canonical form: compartments deduplicated and sorted. */
export function normalizeSecurityLabels(labels: ResourceSecurityLabels): ResourceSecurityLabels {
	return {
		classification: labels.classification,
		compartments: [...new Set(labels.compartments)].sort(),
	};
}

/**
 * Whether `next` provably only adds restrictions over `previous` without
 * consulting the classification lattice: the classification is unchanged and
 * every previous compartment is retained. Anything else (a classification
 * change, a dropped compartment, a removal) must be treated as a potential
 * decrease and gated by the stricter lowering permission.
 */
export function isMonotonicRestrictionIncrease(
	previous: ResourceSecurityLabels,
	next: ResourceSecurityLabels,
): boolean {
	if (previous.classification !== next.classification) return false;
	const retained = new Set(next.compartments);
	return previous.compartments.every((compartment) => retained.has(compartment));
}

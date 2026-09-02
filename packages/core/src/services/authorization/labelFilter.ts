import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { ResourceSecurityLabels } from '../../securityLabels';
import type { AuthorizationService, AuthorizationSubject } from './AuthorizationService';

/** A catalog entry carrying the tri-state label projection. */
export interface LabelProjectedEntry {
	/** Labels, `null` = known unlabeled, absent = indeterminate (legacy or mutation in flight). */
	security_labels?: ResourceSecurityLabels | null;
}

/**
 * Security-label filter over already-visible list entries. Labels only remove
 * entries — super admins get no automatic bypass. Indeterminate projections
 * are resolved from the authoritative record via `resolveLabels` BEFORE one
 * batch constraint decision, so a page never costs one adapter call per
 * entry; an unreadable authoritative record fails closed (the entry is
 * dropped).
 */
export async function filterByLabelConstraints<T extends LabelProjectedEntry>(
	authz: AuthorizationService,
	subject: AuthorizationSubject,
	entries: T[],
	resolveLabels: (entry: T) => Promise<ResourceSecurityLabels | null>,
): Promise<T[]> {
	if (entries.every((entry) => entry.security_labels === null)) return entries;
	const states = await mapWithConcurrency(entries, BUCKET_SCAN_CONCURRENCY, async (entry) => {
		if (entry.security_labels !== undefined) return { labels: entry.security_labels };
		try {
			return { labels: await resolveLabels(entry) };
		} catch {
			return null;
		}
	});
	const readable = entries.filter((_, i) => states[i] !== null);
	const labelStates = states.flatMap((state) => (state === null ? [] : [state.labels]));
	const satisfied = await authz.projectLabelConstraints(subject, labelStates);
	return readable.filter((_, i) => satisfied[i]);
}

import { LocalResourceConstraintPolicy } from '../services/authorization/LocalResourceConstraintPolicy';
import type { ResourceSecurityPolicy } from '../services/authorization/AuthorizationService';
import type {
	SubjectSecurityContext,
	SubjectSecurityContextProvider,
} from '../ports/subjectContext';

/** A valid, unexpired subject context; override any field per test. */
export function makeSubjectContext(
	overrides: Partial<SubjectSecurityContext> = {},
): SubjectSecurityContext {
	return {
		schemaVersion: 1,
		classification: 'SECRET',
		compartments: ['element-a', 'element-b'],
		policyVersion: 'policy-1',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		...overrides,
	};
}

/** A provider that resolves the same context (or `null`) for every principal. */
export function staticSubjectContextProvider(
	context: SubjectSecurityContext | null,
): SubjectSecurityContextProvider {
	return { resolve: async () => context };
}

/**
 * Resource-security wiring over the local constraint adapter. Pass a context
 * (or `null` for "resolves to no context") to attach a static provider; omit
 * it to wire constraints only, so labeled resources fail closed.
 */
export function localResourceSecurity(
	classificationOrder: readonly string[],
	context?: SubjectSecurityContext | null,
): ResourceSecurityPolicy {
	return {
		constraints: new LocalResourceConstraintPolicy({ classificationOrder }),
		...(context === undefined ? {} : { subjectContext: staticSubjectContextProvider(context) }),
	};
}

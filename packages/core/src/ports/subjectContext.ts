/**
 * Runtime subject security context port.
 *
 * Resource-level security (project labels, clearance/compartment constraints)
 * needs normalized subject attributes at request time. Those attributes come
 * from this port — resolved per principal from bounded, validated data — and
 * NEVER from the raw JWT, UserInfo response, or a login-time policy result:
 * login-time state cannot express revocation, and the signed session cookie is
 * not encrypted, so raw attributes must not ride in it. Implementations live in
 * adapter packages (an agency package, an IdP sync, a static file); core owns
 * only the contract and the bounds.
 *
 * Resolution semantics by credential kind:
 * - `sso` — resolve from the provider's bounded record for the user (an
 *   adapter may use `credential.subjectContextRef` as the lookup key).
 * - `personal-access-token` / `service-account` — resolvable only when the
 *   deployment explicitly assigns those credentials a context; otherwise
 *   return null (the subject has no context).
 * - `development` — never resolves; return null.
 * - A delegated background operation resolves through the delegating
 *   principal's context, never an ambient administrator identity.
 *
 * `null` means "no context": an unlabeled resource is unaffected, and a
 * labeled resource must fail closed. A provider signals an *operational*
 * failure by throwing — callers treat that as no-context too (fail closed),
 * never as unlabeled access.
 */
import { z } from 'zod';
import { parseIsoTimestamp } from '../utcDate';
import type { AuthenticatedPrincipal } from './auth';

export const SUBJECT_SECURITY_CONTEXT_SCHEMA_VERSION = 1;

/** Bounded label token: printable, no whitespace/control characters. */
const LABEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

export const MAX_SUBJECT_COMPARTMENTS = 64;

/**
 * The bounded runtime security context. Strict: unknown fields are rejected so
 * an adapter cannot smuggle raw attributes past the boundary. The ordering of
 * `classification` values is deliberately NOT defined here — the resource
 * constraint adapter owns the classification lattice.
 */
export const SubjectSecurityContextSchema = z.strictObject({
	schemaVersion: z.literal(SUBJECT_SECURITY_CONTEXT_SCHEMA_VERSION),
	classification: z.string().regex(LABEL_TOKEN),
	compartments: z.array(z.string().regex(LABEL_TOKEN)).max(MAX_SUBJECT_COMPARTMENTS),
	/** Identifies the policy revision that produced this context. */
	policyVersion: z.string().regex(LABEL_TOKEN),
	/** Hard expiry; a stale context must be re-resolved, never trusted. */
	expiresAt: z.iso.datetime(),
});

export type SubjectSecurityContext = z.infer<typeof SubjectSecurityContextSchema>;

/**
 * Validate an adapter-supplied context, failing closed: malformed shapes,
 * unknown fields, out-of-bound values, and already-expired contexts all yield
 * null. Compartments are deduplicated and sorted so downstream comparisons see
 * one normalized shape.
 */
export function validateSubjectSecurityContext(
	value: unknown,
	now: Date = new Date(),
): SubjectSecurityContext | null {
	const parsed = SubjectSecurityContextSchema.safeParse(value);
	if (!parsed.success) return null;
	// parseIsoTimestamp, not Date.parse: engines normalize a nonexistent
	// calendar date (2025-02-30 → March 2), which would silently EXTEND an
	// expiry. An invalid `now` fails closed too — NaN comparisons would
	// otherwise report every context as unexpired.
	const expiresAtMs = parseIsoTimestamp(parsed.data.expiresAt);
	const nowMs = now.getTime();
	if (expiresAtMs === null || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) return null;
	return {
		...parsed.data,
		compartments: [...new Set(parsed.data.compartments)].sort(),
	};
}

export interface SubjectSecurityContextProvider {
	/**
	 * Resolve the bounded security context for a principal, or null when the
	 * subject has none (see the resolution semantics above). Implementations
	 * must return only values that pass {@link validateSubjectSecurityContext};
	 * callers re-validate regardless. A bounded cache is permitted, but a cached
	 * context must never outlive its `expiresAt`.
	 */
	resolve(
		principal: AuthenticatedPrincipal,
		signal: AbortSignal,
	): Promise<SubjectSecurityContext | null>;
}

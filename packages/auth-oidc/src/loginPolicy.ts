/**
 * OIDC login-policy extension contract and its host-side evaluator.
 *
 * A login-policy module is trusted, operator-supplied code that maps validated
 * OIDC claims to a bounded login decision plus coarse entitlements. The host
 * (the OIDC adapter) owns everything else — protocol validation, identity,
 * session cookies, expiry, logging — and rejects any result outside the
 * version-1 shapes below. This is a login-time seam only, never a per-request
 * (resource FGAC) authorization contract.
 *
 * `evaluateLoginPolicy` and `parseLoginPolicyDecision` are free of HTTP
 * concerns so other hosts (e.g. a policy analyzer dry-running a module against
 * sample claims) can reuse them and get the same bounded outcomes.
 */
import { z } from 'zod';
import { AUTH_ENTITLEMENTS, withDeadline } from '@marimo-hub/core';
import type { AuthEntitlement, UserId } from '@marimo-hub/core';

/** Bump on any breaking change to the module contract below. */
export const OIDC_LOGIN_POLICY_API_VERSION = 1;

export const OIDC_LOGIN_POLICY_KIND = 'oidc-login-policy';

/** Host-owned identity; the module can read it but never replace it. */
export interface OidcLoginPolicyIdentity {
	readonly id: UserId;
	readonly email: string;
}

export interface OidcLoginPolicyInput {
	readonly identity: OidcLoginPolicyIdentity;
	/** Deep-frozen clone of the validated ID-token claims. */
	readonly idTokenClaims: Readonly<Record<string, unknown>>;
	/** Deep-frozen clone of the validated, subject-bound UserInfo claims, when fetched. */
	readonly userInfoClaims?: Readonly<Record<string, unknown>>;
	/** Aborted when the host's evaluation timeout elapses. */
	readonly signal: AbortSignal;
}

export type OidcLoginPolicyDecision =
	| {
			readonly decision: 'allow';
			readonly entitlements?: readonly AuthEntitlement[];
	  }
	| {
			readonly decision: 'deny';
			/** Bounded operator-log token (`^[a-z][a-z0-9_]{0,63}$`); never shown to the user. */
			readonly reason?: string;
	  };

export interface OidcLoginPolicy {
	evaluate(input: OidcLoginPolicyInput): OidcLoginPolicyDecision | Promise<OidcLoginPolicyDecision>;
}

export interface OidcLoginPolicyFactoryContext {
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The manifest a login-policy library must default-export. */
export interface OidcLoginPolicyModule {
	readonly apiVersion: number;
	readonly kind: typeof OIDC_LOGIN_POLICY_KIND;
	create(context: OidcLoginPolicyFactoryContext): OidcLoginPolicy | Promise<OidcLoginPolicy>;
}

export function isOidcLoginPolicy(value: unknown): value is OidcLoginPolicy {
	return (
		((typeof value === 'object' && value !== null) || typeof value === 'function') &&
		typeof (value as { evaluate?: unknown }).evaluate === 'function'
	);
}

/**
 * Bounded, host-generated categories for a malformed module result. These are
 * safe to log and surface to operators — unlike the result itself, they can
 * never embed claim values.
 */
export type LoginPolicyResultProblem =
	| 'result_not_an_object'
	| 'unknown_result_field'
	| 'invalid_decision'
	| 'entitlements_not_an_array'
	| 'unknown_entitlement'
	| 'entitlements_on_deny'
	| 'invalid_reason';

export type ParsedLoginPolicyDecision =
	| { decision: 'allow'; entitlements: readonly AuthEntitlement[] }
	| { decision: 'deny'; reason?: string };

export type LoginPolicyParseResult =
	| { ok: true; value: ParsedLoginPolicyDecision }
	| { ok: false; problem: LoginPolicyResultProblem };

const DENY_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The bounded version-1 result shape. Strict objects reject unknown fields
 * (including a `subjectSecurityContext` — runtime subject state is a separate
 * provider, not this seam) and entitlements on a deny.
 */
export const OidcLoginPolicyDecisionSchema = z.discriminatedUnion('decision', [
	z.strictObject({
		decision: z.literal('allow'),
		entitlements: z.array(z.enum(AUTH_ENTITLEMENTS)).optional(),
	}),
	z.strictObject({
		decision: z.literal('deny'),
		reason: z.string().regex(DENY_REASON_PATTERN).optional(),
	}),
]);

function problemFromIssues(
	decision: 'allow' | 'deny',
	issues: z.ZodError['issues'],
): LoginPolicyResultProblem {
	// Contract violations (unknown fields) outrank value problems, so a result
	// smuggling extra state is reported as such even when a value is also bad.
	for (const issue of issues) {
		if (issue.code === 'unrecognized_keys') {
			return decision === 'deny' && issue.keys.includes('entitlements')
				? 'entitlements_on_deny'
				: 'unknown_result_field';
		}
	}
	for (const issue of issues) {
		if (issue.path[0] === 'entitlements') {
			return issue.path.length > 1 ? 'unknown_entitlement' : 'entitlements_not_an_array';
		}
		if (issue.path[0] === 'reason') return 'invalid_reason';
	}
	return 'invalid_decision';
}

/**
 * Validate a raw module result against {@link OidcLoginPolicyDecisionSchema},
 * failing closed with a bounded problem category. Entitlements are
 * deduplicated into canonical `AUTH_ENTITLEMENTS` order so downstream
 * consumers see one normalized shape.
 */
export function parseLoginPolicyDecision(value: unknown): LoginPolicyParseResult {
	if (!isRecord(value)) return { ok: false, problem: 'result_not_an_object' };
	if (value.decision !== 'allow' && value.decision !== 'deny') {
		return { ok: false, problem: 'invalid_decision' };
	}
	const result = OidcLoginPolicyDecisionSchema.safeParse(value);
	if (!result.success) {
		return { ok: false, problem: problemFromIssues(value.decision, result.error.issues) };
	}
	if (result.data.decision === 'deny') {
		const { reason } = result.data;
		return { ok: true, value: { decision: 'deny', ...(reason !== undefined ? { reason } : {}) } };
	}
	const granted = new Set(result.data.entitlements);
	return {
		ok: true,
		value: {
			decision: 'allow',
			entitlements: AUTH_ENTITLEMENTS.filter((entitlement) => granted.has(entitlement)),
		},
	};
}

/**
 * Deep-clone a JSON claim value and freeze every level, so the module can
 * neither observe later host mutations nor influence session construction by
 * mutating its input. Non-JSON values are dropped the way `JSON.stringify`
 * drops them (claims arrive from JSON parsing, so this is a boundary guard,
 * not a lossy path in practice).
 *
 * Cloned objects have a null prototype: a provider-controlled `__proto__` key
 * (an own property after JSON parsing) must become an own property of the
 * clone too — assigning it on a normal object would instead swap the clone's
 * prototype and let hostile claims satisfy policy reads via inheritance.
 */
export function frozenClaimsClone(claims: Record<string, unknown>): Record<string, unknown> {
	return cloneJsonValue(claims) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => cloneJsonValue(item) ?? null));
	}
	if (typeof value === 'object' && value !== null) {
		const clone: Record<string, unknown> = Object.create(null);
		for (const [key, entry] of Object.entries(value)) {
			const cloned = cloneJsonValue(entry);
			if (cloned !== undefined) clone[key] = cloned;
		}
		return Object.freeze(clone);
	}
	return typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value === null
		? value
		: undefined;
}

export const DEFAULT_LOGIN_POLICY_TIMEOUT_MS = 5_000;

/**
 * The bounded outcome of one evaluation. Deliberately carries no module
 * exception and no raw claims — an `error` or `invalid` outcome is safe to log
 * as-is. `durationMs` supports operational latency signals.
 */
export type LoginPolicyEvaluation = { durationMs: number } & (
	| { outcome: 'allow'; entitlements: readonly AuthEntitlement[] }
	| { outcome: 'deny'; reason?: string }
	| { outcome: 'timeout' }
	| { outcome: 'error' }
	| { outcome: 'invalid'; problem: LoginPolicyResultProblem }
);

export interface EvaluateLoginPolicyInput {
	readonly identity: OidcLoginPolicyIdentity;
	readonly idTokenClaims: Record<string, unknown>;
	readonly userInfoClaims?: Record<string, unknown>;
}

/**
 * Run one fail-closed evaluation: frozen-clone inputs, a hard deadline (the
 * abort signal is advisory — a module can ignore it, so `withDeadline`'s timer
 * race decides), and result validation. Every non-allow path collapses into a
 * bounded outcome; module exceptions are swallowed entirely because they can
 * embed claim data.
 */
export async function evaluateLoginPolicy(
	policy: OidcLoginPolicy,
	input: EvaluateLoginPolicyInput,
	options?: { timeoutMs?: number },
): Promise<LoginPolicyEvaluation> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_LOGIN_POLICY_TIMEOUT_MS;
	const started = Date.now();
	const elapsed = () => Date.now() - started;
	// Identity sentinel: distinguishes the deadline from anything the module
	// throws, which must never be inspected or logged.
	const timedOut = new Error('oidc login-policy evaluation timed out');
	let value: unknown;
	try {
		value = await withDeadline(
			(signal) =>
				Promise.resolve(
					policy.evaluate(
						Object.freeze({
							identity: Object.freeze({ id: input.identity.id, email: input.identity.email }),
							idTokenClaims: frozenClaimsClone(input.idTokenClaims),
							...(input.userInfoClaims !== undefined
								? { userInfoClaims: frozenClaimsClone(input.userInfoClaims) }
								: {}),
							signal,
						}),
					),
				),
			{ timeoutMs, timeoutError: () => timedOut },
		);
	} catch (error) {
		return { outcome: error === timedOut ? 'timeout' : 'error', durationMs: elapsed() };
	}

	const durationMs = elapsed();
	// A synchronous busy-loop blocks the event loop, so the deadline timer can
	// never fire while it runs; enforce the budget after the fact instead of
	// honoring an over-deadline decision. Preemption would need a worker.
	if (durationMs > timeoutMs) return { outcome: 'timeout', durationMs };
	const parsed = parseLoginPolicyDecision(value);
	if (!parsed.ok) return { outcome: 'invalid', problem: parsed.problem, durationMs };
	return parsed.value.decision === 'allow'
		? { outcome: 'allow', entitlements: parsed.value.entitlements, durationMs }
		: {
				outcome: 'deny',
				...(parsed.value.reason !== undefined ? { reason: parsed.value.reason } : {}),
				durationMs,
			};
}

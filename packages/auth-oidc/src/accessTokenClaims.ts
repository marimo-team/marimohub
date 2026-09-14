import { externalTokenGrant } from '@marimo-hub/core/token-grants';
import type { AuthenticatedPrincipal } from '@marimo-hub/core/ports/auth';
import { admitOidcIdentity } from './admission';
import type { OidcAdmissionPolicy } from './admission';
import { validSubject } from './claims';

const TOKEN_TYPES = new Set(['jwt', 'at+jwt', 'application/at+jwt']);
const MAX_SCOPE_LENGTH = 8192;
const SCOPE_LIST = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;

export interface AccessTokenPolicy {
	audience: string;
	browserClientId: string;
	maxLifetimeSeconds: number;
	admission: OidcAdmissionPolicy;
}
export type AccessTokenRejection =
	| 'invalid_token'
	| 'verification_failed'
	| 'invalid_claims'
	| 'admission_denied'
	| 'missing_grant_scope';
type PrincipalResult = { principal: AuthenticatedPrincipal } | { error: AccessTokenRejection };

function tokenExpiry(
	issuedAt: unknown,
	expiresAt: unknown,
	now: number,
	maxLifetime: number,
): string | null {
	if (
		typeof issuedAt !== 'number' ||
		!Number.isSafeInteger(issuedAt) ||
		typeof expiresAt !== 'number' ||
		!Number.isSafeInteger(expiresAt) ||
		issuedAt > now ||
		expiresAt <= now ||
		expiresAt <= issuedAt ||
		expiresAt - issuedAt > maxLifetime
	)
		return null;
	return new Date(expiresAt * 1000).toISOString();
}

export function parseAccessTokenScopes(value: unknown): string[] | null {
	if (typeof value !== 'string' || value.length > MAX_SCOPE_LENGTH || !SCOPE_LIST.test(value))
		return null;
	return [...new Set(value.split(' '))];
}

/** Signature, issuer, audience, and nbf must be verified before mapping claims to a principal. */
export function principalFromVerifiedAccessToken(
	payload: Record<string, unknown>,
	typ: unknown,
	policy: AccessTokenPolicy,
	now: number,
): PrincipalResult {
	if (
		payload.cnf !== undefined ||
		(typ !== undefined && (typeof typ !== 'string' || !TOKEN_TYPES.has(typ.toLowerCase()))) ||
		!validSubject(payload.client_id)
	) {
		return { error: 'invalid_claims' };
	}
	// ID tokens target OAuth clients; access tokens target the Hub resource.
	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (audiences.includes(policy.browserClientId)) return { error: 'invalid_claims' };
	const expiresAt = tokenExpiry(payload.iat, payload.exp, now, policy.maxLifetimeSeconds);
	const scopes = parseAccessTokenScopes(payload.scope);
	if (!expiresAt || !scopes) return { error: 'invalid_claims' };
	const admission = admitOidcIdentity(payload, policy.admission);
	if ('error' in admission)
		return { error: admission.error === 'auth_failed' ? 'invalid_claims' : 'admission_denied' };
	const grant = externalTokenGrant(scopes);
	if (!grant) return { error: 'missing_grant_scope' };
	return {
		principal: {
			...admission.user,
			...(policy.admission.groups ? { entitlementsExpiresAt: expiresAt } : {}),
			credential: {
				kind: 'external-access-token',
				expiresAt,
				grant,
				oauth: { clientId: payload.client_id, resource: policy.audience, scopes },
			},
		},
	};
}

import { UserId } from '@marimo-hub/core/ids';
import type { AuthEntitlement, AuthUser } from '@marimo-hub/core/ports/auth';
import {
	claimAtPointer,
	displayNameClaim,
	emailDomainAllowed,
	emailVerificationAllowed,
	mappedEntitlements,
	MAX_GROUPS,
	normalizeEmailDomains,
	parseGroups,
	pictureUrlClaim,
	validEmail,
	validJsonPointer,
	validSubject,
	validateGroupPolicy,
} from './claims';
import type { EmailVerificationPolicy, OidcGroupPolicy } from './claims';

export interface OidcAdmissionConfig {
	/** Exact email-domain allowlist; empty or absent permits any domain. */
	allowedEmailDomains?: string[];
	/** Handling for an absent `email_verified` claim (default `required`). */
	emailVerification?: EmailVerificationPolicy;
	groups?: OidcGroupPolicy;
}

export interface OidcAdmissionPolicy {
	allowedDomains: readonly string[];
	emailVerification: EmailVerificationPolicy;
	groups?: OidcGroupPolicy;
	maxGroups: number;
}

export function createAdmissionPolicy(config: OidcAdmissionConfig): OidcAdmissionPolicy {
	const emailVerification = config.emailVerification ?? 'required';
	if (emailVerification !== 'required' && emailVerification !== 'trusted-issuer') {
		throw new Error('Invalid OIDC email verification policy');
	}
	const maxGroups = config.groups?.maxGroups ?? MAX_GROUPS;
	if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > MAX_GROUPS) {
		throw new Error(`OIDC maxGroups must be between 1 and ${MAX_GROUPS}`);
	}
	if (config.groups) {
		if (!validJsonPointer(config.groups.claim)) {
			throw new Error('OIDC groups claim must be an RFC 6901 JSON Pointer');
		}
		validateGroupPolicy(config.groups);
	}
	return {
		emailVerification,
		maxGroups,
		allowedDomains: normalizeEmailDomains(config.allowedEmailDomains),
		...(config.groups ? { groups: config.groups } : {}),
	};
}

export type AdmissionFailure =
	| 'auth_failed'
	| 'email_not_verified'
	| 'domain_not_allowed'
	| 'invalid_groups'
	| 'group_not_allowed';
export type AdmissionResult = { user: AuthUser } | { error: AdmissionFailure };

export function admitOidcIdentity(
	claims: Record<string, unknown>,
	policy: OidcAdmissionPolicy,
	userInfo?: Record<string, unknown>,
): AdmissionResult {
	if (!validSubject(claims.sub) || (userInfo && userInfo.sub !== claims.sub))
		return { error: 'auth_failed' };
	const identityClaims = userInfo?.email !== undefined ? userInfo : claims;
	if (!validEmail(identityClaims.email)) return { error: 'auth_failed' };
	const email = identityClaims.email;
	// Every source must agree that email is verified because email participates in authorization.
	if (
		!emailVerificationAllowed(
			identityClaims.email_verified,
			[claims.email_verified, userInfo?.email_verified],
			policy.emailVerification,
		)
	) {
		return { error: 'email_not_verified' };
	}
	if (policy.allowedDomains.length > 0 && !emailDomainAllowed(email, policy.allowedDomains)) {
		return { error: 'domain_not_allowed' };
	}
	let entitlements: AuthEntitlement[] | undefined;
	if (policy.groups) {
		let rawGroups = userInfo ? claimAtPointer(userInfo, policy.groups.claim) : undefined;
		if (rawGroups === undefined) rawGroups = claimAtPointer(claims, policy.groups.claim);
		let groups: string[];
		try {
			groups = parseGroups(rawGroups, policy.maxGroups) ?? [];
		} catch {
			return { error: 'invalid_groups' };
		}
		if (
			policy.groups.allowed?.length &&
			!policy.groups.allowed.some((group) => groups.includes(group))
		) {
			return { error: 'group_not_allowed' };
		}
		entitlements = mappedEntitlements(groups, policy.groups);
	}
	const name = displayNameClaim(userInfo?.name) ?? displayNameClaim(claims.name);
	const pictureUrl = pictureUrlClaim(userInfo?.picture) ?? pictureUrlClaim(claims.picture);
	return {
		user: {
			id: UserId.parse(claims.sub),
			email,
			...(name ? { name } : {}),
			...(pictureUrl ? { pictureUrl } : {}),
			...(entitlements ? { entitlements } : {}),
		},
	};
}

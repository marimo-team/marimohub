/**
 * Authentication port.
 *
 * `Authenticator` establishes *who* a request comes from. Concrete adapters
 * (generic OIDC, Cloudflare Access, dev-bypass) live in their own packages and
 * implement this interface. The domain core stays framework- and vendor-free:
 * an adapter that needs to expose login/callback routes (e.g. the app-native
 * OIDC redirect flow) does so through its own package, not through this port.
 */
import type { UserId } from '../ids';
import type { TokenGrant } from '../tokenGrants';

export const AUTH_ENTITLEMENTS = [
	'super-admin',
	'project-creator',
	'default-role:app-user',
	'default-role:viewer',
	'default-role:editor',
	'default-role:manager',
] as const;

export type AuthEntitlement = (typeof AUTH_ENTITLEMENTS)[number];

/** 1–128 Unicode characters; no controls, commas, or edge whitespace. */
export const AUTH_GROUP_ID_PATTERN = /^[^\s,\p{Cc}](?:[^,\p{Cc}]{0,126}[^\s,\p{Cc}])?$/u;
// Cookie readers enforce these bounds; increases require a two-phase rollout.
export const MAX_AUTH_GROUPS = 32;
/** UTF-8 bytes of the normalized JSON array, reserving space for other session claims. */
export const MAX_AUTH_GROUPS_JSON_BYTES = 1280;

export type AuthGroupsProblem = 'groups_not_an_array' | 'invalid_group' | 'too_many_groups';

export function isAuthGroupId(value: unknown): value is string {
	return typeof value === 'string' && AUTH_GROUP_ID_PATTERN.test(value);
}

export function normalizeAuthGroups(
	value: unknown,
): { ok: true; groups: readonly string[] } | { ok: false; problem: AuthGroupsProblem } {
	try {
		if (!Array.isArray(value)) return { ok: false, problem: 'groups_not_an_array' };
		const unique = new Set<string>();
		for (const group of value) {
			if (!isAuthGroupId(group)) return { ok: false, problem: 'invalid_group' };
			unique.add(group);
		}
		const groups = [...unique].sort();
		if (
			groups.length > MAX_AUTH_GROUPS ||
			new TextEncoder().encode(JSON.stringify(groups)).byteLength > MAX_AUTH_GROUPS_JSON_BYTES
		)
			return { ok: false, problem: 'too_many_groups' };
		return { ok: true, groups };
	} catch {
		return { ok: false, problem: 'groups_not_an_array' };
	}
}

export interface AuthUser {
	id: UserId;
	email: string;
	/**
	 * Human-readable display name, when the identity provider supplies one (e.g.
	 * the OIDC `name` claim). Optional: adapters that can't source a name leave it
	 * undefined, and consumers fall back to the email. Persisted into the identity
	 * directory so opaque user ids (`sub`) can be rendered as a person.
	 */
	name?: string;
	/** Validated HTTPS profile-picture URL, used only for presentation. */
	pictureUrl?: string;
	/** Provider groups mapped to marimohub-owned authorization capabilities. */
	entitlements?: readonly AuthEntitlement[];
	/** Operator-selected, normalized IdP groups with host-enforced count and byte limits. */
	groups?: readonly string[];
	/** Expiry of the credential that supplied group-derived authorization (entitlements and groups). */
	entitlementsExpiresAt?: string;
}

export const CREDENTIAL_KINDS = [
	'sso',
	'personal-access-token',
	'external-access-token',
	'service-account',
	'development',
] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface OAuthCredentialBinding {
	readonly clientId: string;
	readonly resource: string;
	readonly scopes: readonly string[];
}

/**
 * Bounded provenance of the credential that authenticated a request. Owned by
 * the authenticator result — consumers must never re-derive it from request
 * headers, which can disagree with the adapter over parsing.
 */
export interface AuthCredential {
	readonly kind: CredentialKind;
	/** Stable credential identifier (e.g. the personal-access-token id). */
	readonly id?: string;
	/** ISO expiry of the credential itself, when it is bounded. */
	readonly expiresAt?: string;
	/** Authorization boundary attached to a scoped bearer credential. */
	readonly grant?: TokenGrant;
	readonly oauth?: OAuthCredentialBinding;
	/**
	 * Opaque reference a `SubjectSecurityContextProvider` can resolve into a
	 * bounded runtime security context. Never raw claims or attributes.
	 */
	readonly subjectContextRef?: string;
}

/**
 * An authenticated caller with credential provenance. Every adapter returns
 * this shape; runtime authorization keys subject-context resolution and
 * credential-scoped policy off `credential.kind` instead of inferring the
 * credential from the request.
 */
export interface AuthenticatedPrincipal extends AuthUser {
	credential: AuthCredential;
}

export interface Authenticator {
	/** Resolve the principal from the incoming request, or null if unauthenticated. */
	authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
	/** Optional provider end-session URL, surfaced by `GET /api/v1/me`. */
	logoutUrl?(): string | null;
}

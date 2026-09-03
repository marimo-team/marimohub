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
	'default-role:viewer',
	'default-role:editor',
	'default-role:manager',
] as const;

export type AuthEntitlement = (typeof AUTH_ENTITLEMENTS)[number];

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
	/** Expiry of the credential that supplied group authorization. */
	entitlementsExpiresAt?: string;
}

export const CREDENTIAL_KINDS = [
	'sso',
	'personal-access-token',
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
	/** Immutable authorization boundary attached to a scoped personal access token. */
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

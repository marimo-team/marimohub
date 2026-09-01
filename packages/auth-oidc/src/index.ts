/**
 * Generic OIDC authentication adapter — app-native Authorization Code + PKCE flow.
 *
 * marimohub itself runs the OAuth2 redirect dance (no reverse-proxy required) and
 * issues a signed, httpOnly session cookie. The API stays stateless (no
 * server-side session store), preserving the "no database" property.
 *
 * The OAuth2/OIDC protocol mechanics — discovery, PKCE, the token exchange, and
 * ID-token (JWKS) verification — are delegated to `oauth4webapi` (zero-dependency,
 * Workers-compatible, by the author of `jose`). `jose` is still used for the one
 * thing oauth4webapi does not do: minting/verifying our own symmetric (HS256)
 * session + transaction cookies.
 *
 * - `authenticator.authenticate(req)` validates the `mh_session` cookie.
 * - `routes` is a Hono sub-app exposing `/api/auth/{login,callback,logout}`,
 *   mounted by createApi BEFORE the authN guard so they stay public.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import * as oauth from 'oauth4webapi';
import { ASSIGNABLE_ROLES, AUTH_ENTITLEMENTS, logOperationalError, UserId } from '@marimo-hub/core';
import type { AssignableRole, AuthEntitlement, Authenticator, AuthUser } from '@marimo-hub/core';

export type EmailVerificationPolicy = 'required' | 'trusted-issuer';

export interface OidcGroupPolicy {
	/** JSON Pointer locating the provider's group array, e.g. `/groups`. */
	claim: string;
	/** At least one exact group match is required to sign in. */
	allowed?: string[];
	/** Groups mapped to deployment super-admin. */
	superAdmin?: string[];
	/** Groups permitted to create projects. */
	projectCreation?: string[];
	/** Groups mapped to a per-user deployment-wide default project role. */
	defaultRoles?: Partial<Record<AssignableRole, string[]>>;
	/** Maximum accepted group count (default 200, maximum 200). */
	maxGroups?: number;
}

export interface OidcConfig {
	/** OIDC issuer URL (its `/.well-known/openid-configuration` is discovered). */
	issuer: string;
	clientId: string;
	clientSecret: string;
	/** Absolute callback URL, e.g. `https://hub.example.com/api/auth/callback`. */
	redirectUri: string;
	/**
	 * Expected ID-token audience. Deprecated/unused: per the OIDC spec the ID
	 * token's `aud` must contain `clientId`, which oauth4webapi enforces
	 * automatically. Retained for backwards-compatible config wiring.
	 */
	audience?: string;
	/** OAuth scopes (default `openid email profile`). */
	scopes?: string;
	/** Handling for an absent `email_verified` claim (default `required`). */
	emailVerification?: EmailVerificationPolicy;
	/** Optional provider-group extraction and entitlement mapping. */
	groups?: OidcGroupPolicy;
	/** OAuth `prompt` parameter (default `select_account`). */
	prompt?: string;
	/** Secret used to sign the session + transaction cookies (HS256). */
	sessionSecret: string;
	/** Where to send the user after a successful login (default `/`). */
	postLoginRedirect?: string;
	/** Session cookie lifetime in seconds (default 8h). */
	sessionTtlSeconds?: number;
	/**
	 * Lowercase email domains allowed to sign in (e.g. `['marimo.io']`). When set
	 * and non-empty, the callback rejects any user whose `email` is not under one
	 * of these domains. Email verification follows `emailVerification`: a present
	 * claim must be true, while `trusted-issuer` permits omission. When exactly one
	 * domain is configured, it is also passed to the provider as the `hd`
	 * (hosted-domain) hint — a Google UX nudge, NOT a security boundary; the
	 * callback check is what actually enforces the restriction. Empty/undefined
	 * means any successfully-authenticated account is accepted.
	 */
	allowedEmailDomains?: string[];
}

const SESSION_COOKIE = 'mh_session';
const TXN_COOKIE = 'mh_oidc_txn';

/** Generous bound for an in-app deep link; anything longer is dropped, not truncated. */
const MAX_RETURN_TO_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 200;
const MAX_PICTURE_URL_INPUT_LENGTH = 2048;
const MAX_PICTURE_URL_BYTES = 2048;
// Leaves room for the cookie name and attributes under common 4096-byte limits.
const MAX_SESSION_JWT_BYTES = 3800;
const MAX_GROUPS = 200;
const MAX_GROUP_LENGTH = 256;
const AUTH_ENTITLEMENT_SET: ReadonlySet<string> = new Set(AUTH_ENTITLEMENTS);

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validSubject(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_SUBJECT_LENGTH &&
		!hasControlCharacters(value)
	);
}

function validEmail(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_EMAIL_LENGTH ||
		hasControlCharacters(value) ||
		/\s/.test(value)
	) {
		return false;
	}
	const at = value.lastIndexOf('@');
	return at > 0 && at < value.length - 1;
}

function displayNameClaim(value: unknown): string | undefined {
	if (typeof value !== 'string' || hasControlCharacters(value)) return undefined;
	const name = value.trim();
	return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : undefined;
}

export function pictureUrlClaim(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > MAX_PICTURE_URL_INPUT_LENGTH) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password) return undefined;
		const normalized = url.toString();
		return utf8ByteLength(normalized) <= MAX_PICTURE_URL_BYTES ? normalized : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve an RFC 6901 JSON Pointer without evaluating provider-controlled code. */
export function claimAtPointer(claims: unknown, pointer: string): unknown {
	if (!pointer.startsWith('/')) return undefined;
	let value: unknown = claims;
	for (const rawSegment of pointer.slice(1).split('/')) {
		if (!/^(?:[^~]|~[01])*$/.test(rawSegment)) return undefined;
		const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
		if (!Object.hasOwn(value, segment)) return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function validJsonPointer(pointer: string): boolean {
	return (
		pointer.startsWith('/') &&
		pointer
			.slice(1)
			.split('/')
			.every((segment) => /^(?:[^~]|~[01])*$/.test(segment))
	);
}

function parseUrl(value: string, label: string): URL {
	try {
		return new URL(value);
	} catch {
		throw new Error(`${label} must be a valid HTTPS URL`);
	}
}

function discoveredEndpoint(
	as: oauth.AuthorizationServer,
	endpoint: 'authorization_endpoint' | 'end_session_endpoint',
): URL | undefined {
	const value = as[endpoint];
	if (value === undefined) return undefined;
	let url: URL;
	try {
		url = new URL(value);
		oauth.checkProtocol(url, true);
	} catch {
		throw new Error(`OIDC ${endpoint} must be a valid HTTPS URL`);
	}
	if (url.username || url.password) {
		throw new Error(`OIDC ${endpoint} must not contain credentials`);
	}
	return url;
}

function validateGroupPolicy(policy: OidcGroupPolicy): void {
	const lists = [
		policy.allowed,
		policy.superAdmin,
		policy.projectCreation,
		...ASSIGNABLE_ROLES.map((role) => policy.defaultRoles?.[role]),
	].filter((list): list is string[] => list !== undefined);
	if (lists.length === 0) throw new Error('OIDC groups claim requires at least one group policy');
	for (const list of lists) {
		if (
			list.length === 0 ||
			list.length > MAX_GROUPS ||
			list.some(
				(group) =>
					typeof group !== 'string' ||
					group.length === 0 ||
					group.length > MAX_GROUP_LENGTH ||
					hasControlCharacters(group),
			)
		) {
			throw new Error('OIDC group policies must contain 1 to 200 valid group ids');
		}
	}
}

function parseGroups(value: unknown, maxGroups: number): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maxGroups) throw new Error('invalid groups claim');
	const groups: string[] = [];
	for (const group of value) {
		if (
			typeof group !== 'string' ||
			group.length === 0 ||
			group.length > MAX_GROUP_LENGTH ||
			hasControlCharacters(group)
		) {
			throw new Error('invalid groups claim');
		}
		groups.push(group);
	}
	return groups;
}

function mappedEntitlements(groups: readonly string[], policy: OidcGroupPolicy): AuthEntitlement[] {
	const memberships = new Set(groups);
	const entitlements = new Set<AuthEntitlement>();
	if (policy.superAdmin?.some((group) => memberships.has(group))) {
		entitlements.add('super-admin');
	}
	if (policy.projectCreation?.some((group) => memberships.has(group))) {
		entitlements.add('project-creator');
	}
	for (const role of ASSIGNABLE_ROLES) {
		if (policy.defaultRoles?.[role]?.some((group) => memberships.has(group))) {
			entitlements.add(`default-role:${role}`);
		}
	}
	return [...entitlements];
}

function sanitizeApplicationPath(value: string | null | undefined): string | null {
	if (!value || value.length > MAX_RETURN_TO_LENGTH) return null;
	if (!value.startsWith('/') || value.startsWith('//')) return null;
	// eslint-disable-next-line no-control-regex
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
	let url: URL;
	try {
		url = new URL(value, 'http://marimohub.invalid');
	} catch {
		return null;
	}
	if (url.origin !== 'http://marimohub.invalid') return null;
	const path = url.pathname + url.search + url.hash;
	// Dot-segment normalization can surface a scheme-relative `//` prefix that the
	// prefix check above did not see (e.g. `/..//evil.com`).
	if (!path.startsWith('/') || path.startsWith('//')) return null;
	return path;
}

/**
 * Validate an attacker-controlled `?redirect_url=`. API paths are excluded to
 * avoid redirecting the browser back into an auth or data endpoint.
 */
export function sanitizeReturnTo(value: string | null | undefined): string | null {
	const path = sanitizeApplicationPath(value);
	if (!path) return null;
	if (path === '/api' || path.startsWith('/api/')) return null;
	return path;
}

/**
 * Normalize an email-domain allowlist: lowercase, trimmed, leading-`@` stripped,
 * blanks dropped. Exported for direct unit testing of the (otherwise network-gated)
 * login/callback domain logic.
 */
export function normalizeEmailDomains(domains: readonly string[] | undefined): string[] {
	return (domains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

/** True when `email`'s domain is one of the (already-normalized) allowed domains. */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
	const at = email.lastIndexOf('@');
	if (at === -1) return false;
	return allowedDomains.includes(email.slice(at + 1).toLowerCase());
}

export function createOidcAuth(config: OidcConfig): { authenticator: Authenticator; routes: Hono } {
	const secretBytes = new TextEncoder().encode(config.sessionSecret);
	if (secretBytes.length < 32) {
		throw new Error(
			'MARIMOHUB_AUTH_SESSION_SECRET must be at least 32 bytes (256 bits) for HS256. ' +
				`Got ${secretBytes.length}. Generate one with: openssl rand -base64 48`,
		);
	}
	const secret = secretBytes;
	const scopes = config.scopes ?? 'openid email profile';
	const configuredPostLoginRedirect = config.postLoginRedirect ?? '/';
	const sanitizedPostLoginRedirect = sanitizeApplicationPath(configuredPostLoginRedirect);
	if (!sanitizedPostLoginRedirect) {
		throw new Error('OIDC post-login redirect must be a same-origin application path');
	}
	const postLoginRedirect = sanitizedPostLoginRedirect;
	const sessionTtl = config.sessionTtlSeconds ?? (config.groups ? 60 * 60 : 8 * 60 * 60);
	const emailVerification = config.emailVerification ?? 'required';
	const maxGroups = config.groups?.maxGroups ?? MAX_GROUPS;
	const scopeValues = new Set(scopes.split(/\s+/).filter(Boolean));
	if (!Number.isInteger(sessionTtl) || sessionTtl < 300 || sessionTtl > 86_400) {
		throw new Error('OIDC session TTL must be an integer between 300 and 86400 seconds');
	}
	if (config.groups && sessionTtl > 3600) {
		throw new Error('OIDC sessions containing group-derived access must not exceed 3600 seconds');
	}
	if (emailVerification !== 'required' && emailVerification !== 'trusted-issuer') {
		throw new Error('Invalid OIDC email verification policy');
	}
	if (!scopeValues.has('openid')) {
		throw new Error('OIDC scopes must include openid');
	}
	if (!scopeValues.has('email')) {
		throw new Error('OIDC scopes must include email');
	}
	if (scopeValues.has('offline_access')) {
		throw new Error('OIDC scopes must not include offline_access');
	}
	if (
		scopeValues.size > 20 ||
		[...scopeValues].some((scope) => scope.length > 200 || hasControlCharacters(scope))
	) {
		throw new Error('OIDC scopes contain an invalid scope value');
	}
	if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > MAX_GROUPS) {
		throw new Error(`OIDC maxGroups must be between 1 and ${MAX_GROUPS}`);
	}
	if (config.groups && !validJsonPointer(config.groups.claim)) {
		throw new Error('OIDC groups claim must be an RFC 6901 JSON Pointer');
	}
	if (config.groups) validateGroupPolicy(config.groups);
	// Normalize the email-domain allowlist once. Empty means "no restriction".
	const allowedDomains = normalizeEmailDomains(config.allowedEmailDomains);
	const restrictDomains = allowedDomains.length > 0;

	const issuerUrl = parseUrl(config.issuer, 'OIDC issuer');
	if (
		issuerUrl.protocol !== 'https:' ||
		issuerUrl.username ||
		issuerUrl.password ||
		issuerUrl.search ||
		issuerUrl.hash
	) {
		throw new Error('OIDC issuer must be an HTTPS URL without credentials, query, or fragment');
	}
	const redirectUrl = parseUrl(config.redirectUri, 'OIDC redirect URI');
	if (
		redirectUrl.protocol !== 'https:' ||
		redirectUrl.username ||
		redirectUrl.password ||
		redirectUrl.hash
	) {
		throw new Error('OIDC redirect URI must be an HTTPS URL without credentials or a fragment');
	}
	const sessionIssuer = issuerUrl.href;
	const client: oauth.Client = { client_id: config.clientId };
	const clientAuth = oauth.ClientSecretPost(config.clientSecret);

	// Discovery is cached for the lifetime of the adapter (one fetch per process).
	// A rejected discovery must not stay cached: null the slot so the next request
	// re-discovers instead of replaying a transient DNS/IdP failure forever.
	let asPromise: Promise<oauth.AuthorizationServer> | null = null;
	function authServer(): Promise<oauth.AuthorizationServer> {
		if (!asPromise) {
			asPromise = oauth
				.discoveryRequest(issuerUrl, { algorithm: 'oidc' })
				.then((res) => oauth.processDiscoveryResponse(issuerUrl, res))
				.catch((err: unknown) => {
					asPromise = null;
					throw err;
				});
		}
		return asPromise;
	}

	async function mintSession(
		user: AuthUser,
		name: string | undefined,
		pictureUrl: string | undefined,
		issuedAt: number,
		expiresAt: number,
	): Promise<string> {
		return new SignJWT({
			email: user.email,
			...(name !== undefined ? { name } : {}),
			...(pictureUrl !== undefined ? { picture_url: pictureUrl } : {}),
			...(user.entitlements !== undefined ? { entitlements: user.entitlements } : {}),
		})
			.setProtectedHeader({ alg: 'HS256', typ: 'mh-session+jwt' })
			.setIssuer(sessionIssuer)
			.setAudience(config.clientId)
			.setSubject(user.id)
			.setIssuedAt(issuedAt)
			.setExpirationTime(expiresAt)
			.sign(secret);
	}

	async function signSession(user: AuthUser): Promise<string> {
		const issuedAt = Math.floor(Date.now() / 1000);
		const expiresAt = issuedAt + sessionTtl;
		let token = await mintSession(user, user.name, user.pictureUrl, issuedAt, expiresAt);
		if (utf8ByteLength(token) <= MAX_SESSION_JWT_BYTES) return token;

		if (user.pictureUrl !== undefined) {
			token = await mintSession(user, user.name, undefined, issuedAt, expiresAt);
			if (utf8ByteLength(token) <= MAX_SESSION_JWT_BYTES) return token;
		}

		if (user.name !== undefined) {
			token = await mintSession(user, undefined, undefined, issuedAt, expiresAt);
			if (utf8ByteLength(token) <= MAX_SESSION_JWT_BYTES) return token;
		}

		throw new Error(`OIDC session JWT exceeds ${MAX_SESSION_JWT_BYTES} bytes`);
	}

	const authenticator: Authenticator = {
		async authenticate(request: Request): Promise<AuthUser | null> {
			const cookie = request.headers.get('cookie') ?? '';
			const match = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
			if (!match) return null;
			try {
				const { payload } = await jwtVerify(decodeURIComponent(match[1]), secret, {
					algorithms: ['HS256'],
					typ: 'mh-session+jwt',
					issuer: sessionIssuer,
					audience: config.clientId,
				});
				if (!validSubject(payload.sub) || !validEmail(payload.email)) return null;
				const name = displayNameClaim(payload.name);
				const pictureUrl = pictureUrlClaim(payload.picture_url);
				// Alias into a const: `Array.isArray` narrows a const binding, but not a
				// mutable index-signature access like `payload.entitlements`.
				const entitlementsClaim = payload.entitlements;
				const hasGroupAuthorization = Array.isArray(entitlementsClaim);
				const entitlements = hasGroupAuthorization
					? entitlementsClaim.filter(
							(value): value is AuthEntitlement =>
								typeof value === 'string' && AUTH_ENTITLEMENT_SET.has(value),
						)
					: undefined;
				const entitlementsExpiresAt =
					hasGroupAuthorization && typeof payload.exp === 'number'
						? new Date(payload.exp * 1000).toISOString()
						: undefined;
				return {
					id: UserId.parse(payload.sub),
					email: payload.email,
					...(name ? { name } : {}),
					...(pictureUrl ? { pictureUrl } : {}),
					...(entitlements?.length ? { entitlements } : {}),
					...(entitlementsExpiresAt ? { entitlementsExpiresAt } : {}),
				};
			} catch (err) {
				// Expired sessions are routine (every request until re-auth); anything
				// else — bad signature, malformed claims — is worth an operator trail.
				if ((err as { code?: string }).code !== 'ERR_JWT_EXPIRED') {
					logOperationalError('oidc_session_verify_failed', {}, err);
				}
				return null;
			}
		},
		logoutUrl(): string | null {
			// Point the SPA at our logout route (mounted public, before the authN guard).
			// Navigating there deletes the `mh_session` cookie and then redirects to the
			// IdP end-session endpoint (or postLoginRedirect). Returning null here would
			// leave the httpOnly cookie valid until TTL after a client-side "sign out".
			return '/api/auth/logout';
		},
	};

	/**
	 * Render a callback failure as a redirect back into the SPA, NOT raw JSON.
	 *
	 * The callback is reached by a top-level browser navigation (the IdP redirect),
	 * so returning a JSON error body would leave the user staring at a JSON blob
	 * with a dead-end URL. Instead we clear the in-flight transaction cookie and
	 * bounce to the post-login target with an `auth_error` code that the sign-in
	 * screen turns into a friendly, actionable message (e.g. "domain not allowed").
	 * No session cookie is set, so the user stays unauthenticated. When the
	 * transaction carried a `returnTo` deep link, the error bounces there instead
	 * of `/` so a retry from the sign-in screen keeps the destination.
	 */
	function callbackError(c: Context, code: string, returnTo?: string | null): Response {
		deleteCookie(c, TXN_COOKIE, { path: '/' });
		const target = returnTo ?? postLoginRedirect;
		// `auth_error` must land in the query string, before any `#fragment` — the
		// sign-in screen reads it via useSearchParams(), which never sees the hash.
		const hashIndex = target.indexOf('#');
		const base = hashIndex === -1 ? target : target.slice(0, hashIndex);
		const hash = hashIndex === -1 ? '' : target.slice(hashIndex);
		const sep = base.includes('?') ? '&' : '?';
		return c.redirect(`${base}${sep}auth_error=${code}${hash}`);
	}

	const routes = new Hono();

	routes.get('/api/auth/login', async (c) => {
		const as = await authServer();
		const codeVerifier = oauth.generateRandomCodeVerifier();
		const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
		const state = oauth.generateRandomState();
		const nonce = oauth.generateRandomNonce();
		// The post-login deep link rides in the SIGNED transaction cookie — never
		// through the IdP round-trip — so it cannot be tampered with mid-flow.
		// Anything that fails the open-redirect sanitizer is silently dropped.
		const returnTo = sanitizeReturnTo(c.req.query('redirect_url'));

		// Stash the PKCE/transaction values in a short-lived signed cookie.
		const txn = await new SignJWT({ verifier: codeVerifier, state, nonce, returnTo })
			.setProtectedHeader({ alg: 'HS256', typ: 'mh-oidc-txn+jwt' })
			.setIssuer(sessionIssuer)
			.setAudience(config.clientId)
			.setIssuedAt()
			.setExpirationTime('10m')
			.sign(secret);
		setCookie(c, TXN_COOKIE, txn, {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: '/',
			maxAge: 600,
		});

		let url: URL | undefined;
		try {
			url = discoveredEndpoint(as, 'authorization_endpoint');
		} catch (err) {
			logOperationalError('oidc_authorization_endpoint_invalid', {}, err);
			return c.json(
				{
					success: false,
					error: { code: 'OIDC_ERROR', message: 'Invalid authorization endpoint' },
				},
				500,
			);
		}
		if (!url) {
			return c.json(
				{ success: false, error: { code: 'OIDC_ERROR', message: 'No authorization endpoint' } },
				500,
			);
		}
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', config.clientId);
		url.searchParams.set('redirect_uri', config.redirectUri);
		url.searchParams.set('scope', scopes);
		url.searchParams.set('state', state);
		url.searchParams.set('nonce', nonce);
		url.searchParams.set('code_challenge', codeChallenge);
		url.searchParams.set('code_challenge_method', 'S256');
		// Hosted-domain hint: when a single domain is allowed, ask Google to
		// pre-scope the account chooser to it. Best-effort UX only — the callback
		// re-checks the verified email, since `hd` is client-supplied and spoofable.
		if (allowedDomains.length === 1) {
			url.searchParams.set('hd', allowedDomains[0]);
		}
		url.searchParams.set('prompt', config.prompt ?? 'select_account');
		return c.redirect(url.toString());
	});

	routes.get('/api/auth/callback', async (c) => {
		const txnCookie = getCookie(c, TXN_COOKIE);
		if (!txnCookie) {
			return callbackError(c, 'session_expired');
		}

		let verifier: string;
		let expectedState: string | undefined;
		let expectedNonce: string | undefined;
		let returnTo: string | null = null;
		try {
			const { payload } = await jwtVerify(txnCookie, secret, {
				algorithms: ['HS256'],
				typ: 'mh-oidc-txn+jwt',
				issuer: sessionIssuer,
				audience: config.clientId,
			});
			if (typeof payload.verifier !== 'string') throw new Error('missing verifier');
			verifier = payload.verifier;
			expectedState = typeof payload.state === 'string' ? payload.state : undefined;
			expectedNonce = typeof payload.nonce === 'string' ? payload.nonce : undefined;
			// Re-sanitize on the way out (defense in depth): the cookie is signed, but
			// the redirect below must hold even if the sanitizer or signing changes.
			returnTo = sanitizeReturnTo(typeof payload.returnTo === 'string' ? payload.returnTo : null);
		} catch (err) {
			// The transaction cookie lives ~10 minutes; expiry (a stale redirect or
			// slow IdP round-trip) is routine. Log only genuine signature/claim
			// failures, mirroring the session-verify path above.
			if ((err as { code?: string }).code !== 'ERR_JWT_EXPIRED') {
				logOperationalError('oidc_txn_cookie_invalid', {}, err);
			}
			return callbackError(c, 'session_expired');
		}

		const as = await authServer();
		let claims: oauth.IDToken | undefined;
		let userInfo: oauth.UserInfoResponse | undefined;
		try {
			// validateAuthResponse checks `state` and surfaces error responses; the
			// grant request + processing run the token exchange and verify the
			// ID token (signature via JWKS, issuer, audience, nonce, expiry).
			const params = oauth.validateAuthResponse(as, client, new URL(c.req.url), expectedState);
			const response = await oauth.authorizationCodeGrantRequest(
				as,
				client,
				clientAuth,
				params,
				config.redirectUri,
				verifier,
			);
			const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
				expectedNonce,
				requireIdToken: true,
			});
			claims = oauth.getValidatedIdTokenClaims(result);
			if (!claims || !validSubject(claims.sub)) throw new Error('invalid subject');
			if (as.userinfo_endpoint) {
				const userInfoResponse = await oauth.userInfoRequest(as, client, result.access_token);
				userInfo = await oauth.processUserInfoResponse(as, client, claims.sub, userInfoResponse);
				if (userInfo.sub !== claims.sub) throw new Error('userinfo subject mismatch');
			}
		} catch (err) {
			// A user declining consent at the IdP arrives as `error=access_denied` —
			// a normal outcome, not an operational failure. Duck-typed (name, not
			// instanceof) so the check holds even if the oauth4webapi class identity
			// differs across bundling or test mocks.
			const declined =
				err instanceof Error &&
				err.name === 'AuthorizationResponseError' &&
				(err as { error?: string }).error === 'access_denied';
			if (!declined) {
				logOperationalError('oidc_callback_exchange_failed', {}, err);
			}
			return callbackError(c, 'auth_failed', returnTo);
		}

		if (!claims || !validSubject(claims.sub)) {
			return callbackError(c, 'auth_failed', returnTo);
		}
		const identityClaims = userInfo?.email !== undefined ? userInfo : claims;
		if (!validEmail(identityClaims.email)) return callbackError(c, 'auth_failed', returnTo);
		const email = identityClaims.email;
		const emailVerified = identityClaims.email_verified;
		const emailVerificationClaims = [claims.email_verified, userInfo?.email_verified];

		// Email participates in project authorization, so every validated source
		// that provides a verification claim must set it to exactly true.
		if (
			emailVerificationClaims.some(
				(verification) => verification !== undefined && verification !== true,
			)
		) {
			return callbackError(c, 'email_not_verified', returnTo);
		}
		if (emailVerification === 'required' && emailVerified !== true) {
			return callbackError(c, 'email_not_verified', returnTo);
		}

		if (restrictDomains && !emailDomainAllowed(email, allowedDomains)) {
			return callbackError(c, 'domain_not_allowed', returnTo);
		}

		let entitlements: AuthEntitlement[] | undefined;
		if (config.groups) {
			let rawGroups = userInfo ? claimAtPointer(userInfo, config.groups.claim) : undefined;
			if (rawGroups === undefined) rawGroups = claimAtPointer(claims, config.groups.claim);
			let groups: string[];
			try {
				groups = parseGroups(rawGroups, maxGroups) ?? [];
			} catch (err) {
				logOperationalError('oidc_group_claim_invalid', {}, err);
				return callbackError(c, 'auth_failed', returnTo);
			}
			if (
				config.groups.allowed?.length &&
				!config.groups.allowed.some((group) => groups.includes(group))
			) {
				return callbackError(c, 'group_not_allowed', returnTo);
			}
			entitlements = mappedEntitlements(groups, config.groups);
		}

		const name = displayNameClaim(userInfo?.name) ?? displayNameClaim(claims.name);
		const pictureUrl = pictureUrlClaim(userInfo?.picture) ?? pictureUrlClaim(claims.picture);
		let session: string;
		try {
			session = await signSession({
				id: UserId.parse(claims.sub),
				email,
				...(name ? { name } : {}),
				...(pictureUrl ? { pictureUrl } : {}),
				...(config.groups ? { entitlements: entitlements ?? [] } : {}),
			});
		} catch (err) {
			logOperationalError('oidc_session_signing_failed', {}, err);
			return callbackError(c, 'auth_failed', returnTo);
		}
		setCookie(c, SESSION_COOKIE, session, {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: '/',
			maxAge: sessionTtl,
		});
		deleteCookie(c, TXN_COOKIE, { path: '/' });
		return c.redirect(returnTo ?? postLoginRedirect);
	});

	routes.get('/api/auth/logout', async (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: '/' });
		const as = await authServer();
		let url: URL | undefined;
		try {
			url = discoveredEndpoint(as, 'end_session_endpoint');
		} catch (err) {
			logOperationalError('oidc_end_session_endpoint_invalid', {}, err);
			return c.redirect(postLoginRedirect);
		}
		if (url) {
			url.searchParams.set('client_id', config.clientId);
			return c.redirect(url.toString());
		}
		return c.redirect(postLoginRedirect);
	});

	return { authenticator, routes };
}

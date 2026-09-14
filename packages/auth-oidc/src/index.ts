/**
 * Generic OIDC authentication adapter — app-native Authorization Code + PKCE flow.
 *
 * marimohub itself runs the OAuth2 redirect dance (no reverse-proxy required) and
 * issues a signed, httpOnly session cookie. The API stays stateless (no
 * server-side session store), preserving the "no database" property.
 *
 * The OAuth2/OIDC protocol mechanics — discovery, PKCE, the token exchange, and
 * ID-token (JWKS) verification — are delegated to `oauth4webapi`. `jose`
 * signs and verifies the Hub's session and transaction cookies.
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
import { AUTH_ENTITLEMENTS } from '@marimo-hub/core/ports/auth';
import { logEvent } from '@marimo-hub/core/logs';
import { logOperationalError } from '@marimo-hub/core/operational-log';
import { UserId } from '@marimo-hub/core/ids';
import type {
	AuthenticatedPrincipal,
	AuthEntitlement,
	Authenticator,
	AuthUser,
} from '@marimo-hub/core/ports/auth';
import { evaluateLoginPolicy } from './loginPolicy';
import type { OidcLoginPolicy } from './loginPolicy';

import {
	utf8ByteLength,
	hasControlCharacters,
	validSubject,
	validEmail,
	displayNameClaim,
	pictureUrlClaim,
} from './claims';
import { createAdmissionPolicy, admitOidcIdentity } from './admission';
import type { OidcAdmissionConfig } from './admission';
import { createOidcDiscovery, oidcIssuerUrl } from './discovery';
export type { EmailVerificationPolicy, OidcGroupPolicy } from './claims';
export {
	pictureUrlClaim,
	claimAtPointer,
	normalizeEmailDomains,
	emailDomainAllowed,
} from './claims';
export * from './accessTokens';
export * from './loginPolicy';

export interface OidcLoginPolicySettings {
	/** Preloaded, trusted login-policy instance (see `loginPolicy.ts`). */
	policy: OidcLoginPolicy;
	/** Evaluation timeout from 1 to 30 seconds (default 5). */
	timeoutSeconds?: number;
}

export interface OidcConfig extends OidcAdmissionConfig {
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
	/**
	 * Optional trusted login-policy module, mutually exclusive with `groups`.
	 * Called after all OIDC/email validation and before session signing; maps
	 * validated claims to a bounded allow/deny plus recognized entitlements.
	 */
	loginPolicy?: OidcLoginPolicySettings;
	/** OAuth `prompt` parameter (default `select_account`). */
	prompt?: string;
	/** Secret used to sign the session + transaction cookies (HS256). */
	sessionSecret: string;
	/** Where to send the user after a successful login (default `/`). */
	postLoginRedirect?: string;
	/** Session cookie lifetime in seconds (default 8h). */
	sessionTtlSeconds?: number;
}

const SESSION_COOKIE = 'mh_session';
const TXN_COOKIE = 'mh_oidc_txn';

/** Generous bound for an in-app deep link; anything longer is dropped, not truncated. */
const MAX_RETURN_TO_LENGTH = 512;
// Leaves room for the cookie name and attributes under common 4096-byte limits.
const MAX_SESSION_JWT_BYTES = 3800;
const AUTH_ENTITLEMENT_SET: ReadonlySet<string> = new Set(AUTH_ENTITLEMENTS);
/** Stable operational event per non-allow login-policy outcome. */
const LOGIN_POLICY_EVENTS = {
	deny: 'oidc_login_policy_denied',
	timeout: 'oidc_login_policy_timeout',
	error: 'oidc_login_policy_failed',
	invalid: 'oidc_login_policy_result_invalid',
} as const;

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
	// Sessions carrying provider-derived authorization (group- or policy-mapped
	// entitlements) default to the short lifetime that bounds deprovisioning delay.
	const derivedAuthorization = Boolean(config.groups || config.loginPolicy);
	const sessionTtl = config.sessionTtlSeconds ?? (derivedAuthorization ? 60 * 60 : 8 * 60 * 60);
	const admissionPolicy = createAdmissionPolicy(config);
	const scopeValues = new Set(scopes.split(/\s+/).filter(Boolean));
	if (!Number.isInteger(sessionTtl) || sessionTtl < 300 || sessionTtl > 86_400) {
		throw new Error('OIDC session TTL must be an integer between 300 and 86400 seconds');
	}
	if (derivedAuthorization && sessionTtl > 3600) {
		throw new Error(
			'OIDC sessions containing group- or policy-derived access must not exceed 3600 seconds',
		);
	}
	if (config.groups && config.loginPolicy) {
		throw new Error('OIDC groups and a login policy are mutually exclusive');
	}
	const loginPolicyTimeoutSeconds = config.loginPolicy?.timeoutSeconds ?? 5;
	if (
		!Number.isInteger(loginPolicyTimeoutSeconds) ||
		loginPolicyTimeoutSeconds < 1 ||
		loginPolicyTimeoutSeconds > 30
	) {
		throw new Error('OIDC login-policy timeout must be an integer between 1 and 30 seconds');
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
	const { allowedDomains } = admissionPolicy;
	const issuerUrl = oidcIssuerUrl(config.issuer);
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

	const authServer = createOidcDiscovery(issuerUrl, (metadata) => metadata);

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
		async authenticate(request: Request): Promise<AuthenticatedPrincipal | null> {
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
					credential: {
						kind: 'sso',
						...(typeof payload.exp === 'number'
							? { expiresAt: new Date(payload.exp * 1000).toISOString() }
							: {}),
					},
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

		if (!claims) return callbackError(c, 'auth_failed', returnTo);
		const admission = admitOidcIdentity(claims, admissionPolicy, userInfo);
		if ('error' in admission) {
			if (admission.error === 'invalid_groups') {
				logEvent({ level: 'error', event: 'oidc_group_claim_invalid' });
				return callbackError(c, 'auth_failed', returnTo);
			}
			return callbackError(c, admission.error, returnTo);
		}
		const user = admission.user;
		let entitlements = user.entitlements;
		if (config.loginPolicy) {
			const evaluation = await evaluateLoginPolicy(
				config.loginPolicy.policy,
				{
					identity: { id: user.id, email: user.email },
					idTokenClaims: claims as Record<string, unknown>,
					...(userInfo ? { userInfoClaims: userInfo as Record<string, unknown> } : {}),
				},
				{ timeoutMs: loginPolicyTimeoutSeconds * 1000 },
			);
			if (evaluation.outcome !== 'allow') {
				const denied = evaluation.outcome === 'deny';
				// Only bounded, host-generated fields are logged: never claims, the raw
				// result, or a module exception (any of which can carry agency attributes).
				logEvent(
					{
						level: denied ? 'warn' : 'error',
						event: LOGIN_POLICY_EVENTS[evaluation.outcome],
						duration_ms: evaluation.durationMs,
						...(denied && evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
						...(evaluation.outcome === 'invalid' ? { problem: evaluation.problem } : {}),
					},
					{ channel: 'warn' },
				);
				return callbackError(c, denied ? 'policy_denied' : 'auth_failed', returnTo);
			}
			entitlements = [...evaluation.entitlements];
		}

		let session: string;
		try {
			session = await signSession({
				...user,
				// Always present (possibly empty) under derived authorization: the claim
				// marks the session so `authenticate` exposes `entitlementsExpiresAt`.
				...(derivedAuthorization ? { entitlements: entitlements ?? [] } : {}),
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

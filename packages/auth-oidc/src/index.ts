/**
 * Generic OIDC authentication adapter — app-native Authorization Code + PKCE flow.
 *
 * MarimoHub itself runs the OAuth2 redirect dance (no reverse-proxy required) and
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
import { UserId } from '@marimo-hub/core';
import type { Authenticator, AuthUser } from '@marimo-hub/core';

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
	/** Secret used to sign the session + transaction cookies (HS256). */
	sessionSecret: string;
	/** Where to send the user after a successful login (default `/`). */
	postLoginRedirect?: string;
	/** Session cookie lifetime in seconds (default 8h). */
	sessionTtlSeconds?: number;
	/**
	 * Lowercase email domains allowed to sign in (e.g. `['marimo.io']`). When set
	 * and non-empty, the callback rejects any user whose `email` is not under one
	 * of these domains, and additionally requires the `email_verified` claim to be
	 * true (so a domain can't be spoofed via an unverified address). When exactly
	 * one domain is configured, it is also passed to the provider as the `hd`
	 * (hosted-domain) hint — a Google UX nudge, NOT a security boundary; the
	 * callback check is what actually enforces the restriction. Empty/undefined
	 * means any successfully-authenticated account is accepted.
	 */
	allowedEmailDomains?: string[];
}

const SESSION_COOKIE = 'mh_session';
const TXN_COOKIE = 'mh_oidc_txn';

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
	const postLoginRedirect = config.postLoginRedirect ?? '/';
	const sessionTtl = config.sessionTtlSeconds ?? 8 * 60 * 60;
	// Normalize the email-domain allowlist once. Empty means "no restriction".
	const allowedDomains = normalizeEmailDomains(config.allowedEmailDomains);
	const restrictDomains = allowedDomains.length > 0;

	const issuerUrl = new URL(config.issuer);
	const client: oauth.Client = { client_id: config.clientId };
	const clientAuth = oauth.ClientSecretPost(config.clientSecret);

	// Discovery is cached for the lifetime of the adapter (one fetch per process).
	let asPromise: Promise<oauth.AuthorizationServer> | null = null;
	function authServer(): Promise<oauth.AuthorizationServer> {
		if (!asPromise) {
			asPromise = oauth
				.discoveryRequest(issuerUrl, { algorithm: 'oidc' })
				.then((res) => oauth.processDiscoveryResponse(issuerUrl, res));
		}
		return asPromise;
	}

	async function signSession(user: AuthUser): Promise<string> {
		// `name` is carried in the session cookie (sourced from the OIDC `name`
		// claim, which the default `profile` scope provides) so the identity
		// directory can render this user without a second round-trip to the IdP.
		return new SignJWT({ email: user.email, name: user.name })
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject(user.id)
			.setIssuedAt()
			.setExpirationTime(`${sessionTtl}s`)
			.sign(secret);
	}

	const authenticator: Authenticator = {
		async authenticate(request: Request): Promise<AuthUser | null> {
			const cookie = request.headers.get('cookie') ?? '';
			const match = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
			if (!match) return null;
			try {
				const { payload } = await jwtVerify(decodeURIComponent(match[1]), secret);
				if (!payload.sub || typeof payload.email !== 'string') return null;
				const name = typeof payload.name === 'string' ? payload.name : undefined;
				return { id: UserId.parse(payload.sub), email: payload.email, name };
			} catch {
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
	 * No session cookie is set, so the user stays unauthenticated.
	 */
	function callbackError(c: Context, code: string): Response {
		deleteCookie(c, TXN_COOKIE, { path: '/' });
		const sep = postLoginRedirect.includes('?') ? '&' : '?';
		return c.redirect(`${postLoginRedirect}${sep}auth_error=${code}`);
	}

	const routes = new Hono();

	routes.get('/api/auth/login', async (c) => {
		const as = await authServer();
		const codeVerifier = oauth.generateRandomCodeVerifier();
		const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
		const state = oauth.generateRandomState();
		const nonce = oauth.generateRandomNonce();

		// Stash the PKCE/transaction values in a short-lived signed cookie.
		const txn = await new SignJWT({ verifier: codeVerifier, state, nonce })
			.setProtectedHeader({ alg: 'HS256' })
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

		if (!as.authorization_endpoint) {
			return c.json(
				{ success: false, error: { code: 'OIDC_ERROR', message: 'No authorization endpoint' } },
				500,
			);
		}
		const url = new URL(as.authorization_endpoint);
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
		try {
			const { payload } = await jwtVerify(txnCookie, secret);
			if (typeof payload.verifier !== 'string') throw new Error('missing verifier');
			verifier = payload.verifier;
			expectedState = typeof payload.state === 'string' ? payload.state : undefined;
			expectedNonce = typeof payload.nonce === 'string' ? payload.nonce : undefined;
		} catch {
			return callbackError(c, 'session_expired');
		}

		const as = await authServer();
		let claims: oauth.IDToken | undefined;
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
		} catch {
			return callbackError(c, 'auth_failed');
		}

		if (!claims?.sub || typeof claims.email !== 'string') {
			return callbackError(c, 'auth_failed');
		}

		if (restrictDomains) {
			// Require a provider-verified address before trusting its domain — an
			// unverified email could carry an attacker-chosen `@marimo.io` value.
			if (claims.email_verified !== true) {
				return callbackError(c, 'email_not_verified');
			}
			if (!emailDomainAllowed(claims.email, allowedDomains)) {
				return callbackError(c, 'domain_not_allowed');
			}
		}

		// The `name` claim rides along with the default `profile` scope. When the
		// provider omits it, the identity directory falls back to the email.
		const name = typeof claims.name === 'string' ? claims.name : undefined;
		const session = await signSession({ id: UserId.parse(claims.sub), email: claims.email, name });
		setCookie(c, SESSION_COOKIE, session, {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: '/',
			maxAge: sessionTtl,
		});
		deleteCookie(c, TXN_COOKIE, { path: '/' });
		return c.redirect(postLoginRedirect);
	});

	routes.get('/api/auth/logout', async (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: '/' });
		const as = await authServer();
		if (as.end_session_endpoint) {
			const url = new URL(as.end_session_endpoint);
			url.searchParams.set('client_id', config.clientId);
			return c.redirect(url.toString());
		}
		return c.redirect(postLoginRedirect);
	});

	return { authenticator, routes };
}

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
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import * as oauth from 'oauth4webapi';
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
}

const SESSION_COOKIE = 'mh_session';
const TXN_COOKIE = 'mh_oidc_txn';

export function createOidcAuth(config: OidcConfig): { authenticator: Authenticator; routes: Hono } {
	const secret = new TextEncoder().encode(config.sessionSecret);
	const scopes = config.scopes ?? 'openid email profile';
	const postLoginRedirect = config.postLoginRedirect ?? '/';
	const sessionTtl = config.sessionTtlSeconds ?? 8 * 60 * 60;

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
		return new SignJWT({ email: user.email })
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
				return { id: payload.sub, email: payload.email };
			} catch {
				return null;
			}
		},
		logoutUrl(): string | null {
			// The end-session endpoint is only known after discovery; the logout route
			// performs the redirect, so this hint is best-effort.
			return null;
		},
	};

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
		return c.redirect(url.toString());
	});

	routes.get('/api/auth/callback', async (c) => {
		const txnCookie = getCookie(c, TXN_COOKIE);
		if (!txnCookie) {
			return c.json(
				{ success: false, error: { code: 'OIDC_ERROR', message: 'Missing transaction' } },
				400,
			);
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
			return c.json(
				{ success: false, error: { code: 'OIDC_ERROR', message: 'Invalid transaction' } },
				400,
			);
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
			return c.json(
				{ success: false, error: { code: 'OIDC_ERROR', message: 'Authentication failed' } },
				401,
			);
		}

		if (!claims?.sub || typeof claims.email !== 'string') {
			return c.json(
				{ success: false, error: { code: 'OIDC_ERROR', message: 'Missing sub/email claim' } },
				401,
			);
		}

		const session = await signSession({ id: claims.sub, email: claims.email });
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

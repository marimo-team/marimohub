/**
 * Cloudflare Access authentication adapter.
 *
 * Verifies the `CF-Access-JWT-Assertion` header against the team's JWKS endpoint.
 * Cloudflare Access is a hosted OIDC gateway; this is a specialized OIDC verifier
 * with Access's header + team-URL conventions. Extracted from the original
 * `worker/auth.ts`.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Authenticator, AuthUser } from '@marimo-hub/core';

interface AccessJWTPayload extends JWTPayload {
	email?: string;
	sub?: string;
}

export interface CloudflareAccessConfig {
	/** Cloudflare Access team name (e.g. `myteam` for myteam.cloudflareaccess.com). */
	team: string;
	/** Expected Access application audience (AUD) tag. */
	aud: string;
}

export class CloudflareAccessAuthenticator implements Authenticator {
	private jwks: ReturnType<typeof createRemoteJWKSet>;

	constructor(private config: CloudflareAccessConfig) {
		this.jwks = createRemoteJWKSet(
			new URL(`https://${config.team}.cloudflareaccess.com/cdn-cgi/access/certs`),
		);
	}

	async authenticate(request: Request): Promise<AuthUser | null> {
		const jwt = request.headers.get('CF-Access-JWT-Assertion');
		if (!jwt) return null;

		try {
			const { payload } = await jwtVerify(jwt, this.jwks, { audience: this.config.aud });
			const claims = payload as AccessJWTPayload;
			if (!claims.sub || !claims.email) {
				console.error('Access JWT missing sub or email claim');
				return null;
			}
			return { id: claims.sub, email: claims.email };
		} catch (error) {
			console.error(
				'Access JWT verification failed',
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}
	}

	logoutUrl(): string {
		return `https://${this.config.team}.cloudflareaccess.com/cdn-cgi/access/logout`;
	}
}

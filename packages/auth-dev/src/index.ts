/**
 * Dev-bypass authentication adapter.
 *
 * Returns a fixed local user with no network identity. This is NOT an auth mode
 * in the product sense — it is an explicit "no identity" shortcut for running the
 * stack locally without a provider. Never enable it in a deployment serving real
 * users. Extracted from the original `worker/auth.ts` (`AUTH_MODE === 'none'`).
 */
import { UserId } from '@marimo-hub/core';
import type { Authenticator, AuthUser } from '@marimo-hub/core';

export interface DevAuthConfig {
	userId?: string;
	email?: string;
	name?: string;
}

export class DevAuthenticator implements Authenticator {
	private user: AuthUser;

	constructor(config: DevAuthConfig = {}) {
		this.user = {
			id: UserId.parse(config.userId || 'user'),
			email: config.email || 'user@localhost',
			name: config.name || 'Local Dev',
		};
		console.warn(
			'[marimohub] DEV AUTH ENABLED — every request is authenticated as a fixed local user. Do NOT use in production.',
		);
	}

	async authenticate(): Promise<AuthUser> {
		return this.user;
	}

	logoutUrl(): null {
		return null;
	}
}

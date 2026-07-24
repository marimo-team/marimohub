import { describe, expect, it } from 'vitest';
import { makeAuth } from './auth';
import { ConfigError } from './errors';

/**
 * `makeAuth` selector tests. The oidc backend requires a full set of vars; each
 * must fail closed when missing rather than construct a half-configured
 * authenticator.
 */
const oidcEnv = {
	MARIMOHUB_AUTH_BACKEND: 'oidc',
	MARIMOHUB_AUTH_OIDC_ISSUER: 'https://accounts.example.com',
	MARIMOHUB_AUTH_OIDC_CLIENT_ID: 'client',
	MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'secret',
	MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
	MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
	MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
};

describe('makeAuth oidc required vars', () => {
	it('throws when MARIMOHUB_AUTH_SESSION_SECRET is missing', () => {
		const { MARIMOHUB_AUTH_SESSION_SECRET: _omit, ...env } = oidcEnv;
		expect(() => makeAuth(env)).toThrow(/MARIMOHUB_AUTH_SESSION_SECRET/);
	});

	it.each([
		'MARIMOHUB_AUTH_OIDC_ISSUER',
		'MARIMOHUB_AUTH_OIDC_CLIENT_ID',
		'MARIMOHUB_AUTH_OIDC_CLIENT_SECRET',
		'MARIMOHUB_AUTH_OIDC_REDIRECT_URI',
	])('throws when %s is missing', (key) => {
		const env: Record<string, string | undefined> = { ...oidcEnv };
		delete env[key];
		expect(() => makeAuth(env)).toThrow(new RegExp(key));
	});
});

describe('makeAuth cloudflare-access', () => {
	it('refuses the cloudflare-access backend outside Workers', () => {
		expect(() => makeAuth({ MARIMOHUB_AUTH_BACKEND: 'cloudflare-access' })).toThrow(ConfigError);
		expect(() => makeAuth({ MARIMOHUB_AUTH_BACKEND: 'cloudflare-access' })).toThrow(
			/cloudflare-worker/,
		);
	});
});

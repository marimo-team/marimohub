import { describe, expect, it } from 'vitest';
import { checkSandboxHostIsolation, sandboxHostIsolationMessage } from './hostIsolation';

describe('checkSandboxHostIsolation', () => {
	it('flags a same-origin sandbox host as non-isolated', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		});
		expect(result.isolated).toBe(false);
	});

	it('treats a distinct-domain sandbox host as isolated', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'sandboxes.example.net',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		});
		expect(result.isolated).toBe(true);
	});

	// A malformed redirect is configured-but-unparseable, not absent: the app host
	// can't be derived, so isolation is unverifiable and must fail closed.
	it('fails closed when the OIDC redirect URI is malformed (isolation unverifiable)', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'not-a-valid-url',
		});
		expect(result.isolated).toBe(false);
		expect(result.reason).toBe('unverifiable-redirect');
	});

	// A hostless-but-parseable scheme (e.g. mailto:) yields an empty hostname, which
	// must be treated as unverifiable too — not silently isolated.
	it('fails closed when the redirect parses but yields no host (mailto:)', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'mailto:admin@example.com',
		});
		expect(result.isolated).toBe(false);
		expect(result.reason).toBe('unverifiable-redirect');
	});

	it.each(['::1', 'hub:bad-port'])('reports an invalid sandbox hostname: %s', (sandboxHost) => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: sandboxHost,
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/callback',
		});
		expect(result).toMatchObject({ isolated: false, reason: 'invalid-sandbox-host' });
		expect(sandboxHostIsolationMessage(result)).toBe(
			`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (${sandboxHost}) is not a valid hostname, so isolation cannot be verified.`,
		);
	});

	it.each([undefined, 'https://hub.example.com/callback'])(
		'rejects a URL in the sandbox hostname with redirect %s',
		(redirect) => {
			expect(
				checkSandboxHostIsolation({
					MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'https://sandboxes.example.net',
					MARIMOHUB_AUTH_OIDC_REDIRECT_URI: redirect,
				}),
			).toMatchObject({ isolated: false, reason: 'invalid-sandbox-host' });
		},
	);

	it('allows sibling subdomains of the same registrable domain', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'sandboxes.example.com',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		});
		expect(result.isolated).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it('flags a same-host sandbox hostname that only adds a port as non-isolated', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com:8443',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		});
		expect(result.isolated).toBe(false);
	});
});

describe('hostname boundaries', () => {
	it.each([
		['sandbox.example.co.uk', 'hub.example.co.uk', true],
		['sandbox.other.co.uk', 'hub.example.co.uk', true],
		['alice.github.io', 'bob.github.io', true],
		['sandbox.github.io', 'github.io', true],
		['github.io', 'sandbox.github.io', true],
		['sandbox.co.uk', 'co.uk', true],
		['co.uk', 'sandbox.co.uk', true],
		['sandbox.localhost', 'localhost', false],
		['sandbox.alice.github.io', 'hub.alice.github.io', true],
		['sandbox.hub.example.com', 'hub.example.com', false],
		['example.com', 'hub.example.com', false],
		['notexample.com', 'example.com', true],
		['SANDBOX.HUB.EXAMPLE.COM.:8443', 'hub.example.com', false],
		['HUB.EXAMPLE.COM.:8443', 'hub.example.com', false],
		['127.0.0.1:8443', '127.0.0.1', false],
		['127.0.0.2', '127.0.0.1', true],
	])('compares %s with %s', (sandbox, app, isolated) => {
		expect(
			checkSandboxHostIsolation({
				MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: sandbox,
				MARIMOHUB_AUTH_OIDC_REDIRECT_URI: `https://${app}/callback`,
			}).isolated,
		).toBe(isolated);
	});
});

describe('app URL isolation across authentication backends', () => {
	it.each([
		['https://hub.example.com', 'hub.example.com', false],
		['https://hub.example.com', 'kernels.example.com', true],
		['https://hub.example.com', 'kernels.example.net', true],
		[undefined, 'kernels.example.net', false],
		['invalid', 'kernels.example.net', false],
		['ftp://hub.example.com', 'kernels.example.net', false],
	])('checks app %s and sandbox %s', (app, sandbox, isolated) => {
		expect(
			checkSandboxHostIsolation({
				MARIMOHUB_AUTH_BACKEND: 'proxy-header',
				MARIMOHUB_APP_BASE_URL: app,
				MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: sandbox,
			}).isolated,
		).toBe(isolated);
	});

	it('rejects conflicting origins and malformed fallback even with a valid app URL', () => {
		for (const redirect of [
			'https://other.example.org/callback',
			'http://hub.example.com/callback',
			'invalid',
		]) {
			expect(
				checkSandboxHostIsolation({
					MARIMOHUB_APP_BASE_URL: 'https://hub.example.com',
					MARIMOHUB_AUTH_OIDC_REDIRECT_URI: redirect,
					MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'kernels.example.net',
				}).isolated,
			).toBe(false);
		}
	});
});

describe('configured origin edge cases', () => {
	it.each(['MARIMOHUB_APP_BASE_URL', 'MARIMOHUB_AUTH_OIDC_REDIRECT_URI'] as const)(
		'rejects malformed or credential-bearing origins from %s',
		(key) => {
			for (const value of [
				'',
				' ',
				'/relative',
				'//hub.example.com',
				'https://user:secret@hub.example.com',
				'https://user@hub.example.com',
				'file:///tmp/app',
				'data:text/html,hello',
			]) {
				const result = checkSandboxHostIsolation({
					MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'kernels.example.net',
					[key]: value,
				});
				expect(result.isolated, value).toBe(false);
				expect(result.reason).toMatch(/^unverifiable-/);
			}
		},
	);

	it.each([
		['https://HUB.EXAMPLE.COM:443/app', 'https://hub.example.com/callback?state=123', true],
		['http://hub.example.com:80', 'http://hub.example.com/callback', true],
		['https://hub.example.com:8443', 'https://hub.example.com:8443/callback', true],
		['https://hub.example.com:8443', 'https://hub.example.com/callback', false],
		['https://hub.example.com', 'http://hub.example.com/callback', false],
	])('compares complete origins: %s and %s', (app, callback, isolated) => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'kernels.example.net',
			MARIMOHUB_APP_BASE_URL: app,
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: callback,
		});
		expect(result.isolated).toBe(isolated);
		if (!isolated) expect(result.reason).toBe('conflicting-origins');
	});

	it('does not require an app origin when no public sandbox host is configured', () => {
		expect(checkSandboxHostIsolation({})).toEqual({ isolated: true });
	});
});

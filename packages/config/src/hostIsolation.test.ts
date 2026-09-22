import { describe, expect, it } from 'vitest';
import { checkSandboxHostIsolation, sandboxHostIsolationMessage } from './hostIsolation';

/**
 * Isolation guard: when a sandbox host is configured, the guard derives the app
 * host from the OIDC redirect URI and refuses a same-origin/parent-domain
 * sandbox (untrusted kernels must not share an origin with the control plane).
 */
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

	it('flags sibling subdomains of the same registrable domain as non-isolated', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'sandboxes.example.com',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		});
		expect(result.isolated).toBe(false);
		expect(result.reason).toBe('shared-origin');
	});

	it('flags a same-host sandbox hostname that only adds a port as non-isolated', () => {
		const result = checkSandboxHostIsolation({
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com:8443',
			MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		});
		expect(result.isolated).toBe(false);
	});
});

describe('cookie domain boundaries', () => {
	it.each([
		['sandbox.example.co.uk', 'hub.example.co.uk', false],
		['sandbox.other.co.uk', 'hub.example.co.uk', true],
		['alice.github.io', 'bob.github.io', true],
		['sandbox.github.io', 'github.io', true],
		['github.io', 'sandbox.github.io', true],
		['sandbox.co.uk', 'co.uk', true],
		['co.uk', 'sandbox.co.uk', true],
		['sandbox.localhost', 'localhost', false],
		['sandbox.alice.github.io', 'hub.alice.github.io', false],
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

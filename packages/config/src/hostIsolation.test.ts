import { describe, expect, it } from 'vitest';
import { checkSandboxHostIsolation } from './hostIsolation';

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
});

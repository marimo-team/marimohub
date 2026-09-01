/**
 * Composition proof for the OIDC login-policy library: the module loaded by
 * `createFromEnvAsync` must actually reach `createOidcAuth` as the wired
 * policy, not merely load. `createOidcAuth` is wrapped call-through so the
 * config it receives can be asserted without driving the OIDC network flow
 * (the callback → decision path is covered in @marimo-hub/auth-oidc tests).
 */
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthOidc from '@marimo-hub/auth-oidc';
import type { OidcConfig } from '@marimo-hub/auth-oidc';

const captured = vi.hoisted(() => ({ config: undefined as OidcConfig | undefined }));

vi.mock('@marimo-hub/auth-oidc', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthOidc>();
	return {
		...actual,
		createOidcAuth: (config: OidcConfig) => {
			captured.config = config;
			return actual.createOidcAuth(config);
		},
	};
});

import { createFromEnvAsync } from './index';

// The valid.mjs fixture allows `groups` containing `hub-users` with
// `default-role:editor` and denies everything else with `fixture_policy`.
const env = {
	MARIMOHUB_STORAGE_BACKEND: 'memory',
	MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
	MARIMOHUB_COMPUTE_BACKEND: 'none',
	MARIMOHUB_AUTH_BACKEND: 'oidc',
	MARIMOHUB_AUTH_OIDC_ISSUER: 'https://issuer.example.com',
	MARIMOHUB_AUTH_OIDC_CLIENT_ID: 'client-id',
	MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'client-secret',
	MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
	MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
	MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
	MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
	MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: fileURLToPath(
		new URL('./testdata/oidc-login-policies/valid.mjs', import.meta.url),
	),
};

beforeEach(() => {
	captured.config = undefined;
});

describe('createFromEnvAsync OIDC login-policy wiring', () => {
	it('passes the loaded module and bounded settings into the OIDC adapter', async () => {
		const deps = await createFromEnvAsync(env);

		expect(deps.authRoutes).toBeDefined();
		const loginPolicy = captured.config!.loginPolicy!;
		expect(loginPolicy).toBeDefined();
		expect(loginPolicy.timeoutSeconds).toBe(5);
		// Group policy must not co-exist with the module.
		expect(captured.config?.groups).toBeUndefined();
		// Policy-derived sessions carry the short deprovisioning lifetime.
		expect(captured.config?.sessionTtlSeconds).toBe(3600);

		// The wired policy is the fixture module's instance: it saw the full env
		// at create() and decides with the fixture's rule.
		const factoryEnv = (loginPolicy.policy as unknown as { factoryContext: { env: unknown } })
			.factoryContext.env;
		expect(factoryEnv).toBe(env);
		const input = (claims: Record<string, unknown>) => ({
			identity: { id: 'user-1' as never, email: 'user@example.com' },
			idTokenClaims: claims,
			signal: new AbortController().signal,
		});
		expect(loginPolicy.policy.evaluate(input({ groups: ['hub-users'] }))).toEqual({
			decision: 'allow',
			entitlements: ['default-role:editor'],
		});
		expect(loginPolicy.policy.evaluate(input({}))).toEqual({
			decision: 'deny',
			reason: 'fixture_policy',
		});
	});

	it('honors the configured timeout and session lifetime', async () => {
		await createFromEnvAsync({
			...env,
			MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS: '10',
			MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS: '900',
		});

		expect(captured.config?.loginPolicy?.timeoutSeconds).toBe(10);
		expect(captured.config?.sessionTtlSeconds).toBe(900);
	});
});

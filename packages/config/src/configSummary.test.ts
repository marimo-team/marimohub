import { describe, it, expect } from 'vitest';
import { buildConfigSummary } from './configSummary';
import { CONFIG_SPEC } from './spec';

function group(summary: ReturnType<typeof buildConfigSummary>, name: string) {
	const found = summary.groups.find((g) => g.name === name);
	if (!found) throw new Error(`no group ${name}`);
	return found;
}

describe('buildConfigSummary', () => {
	it('covers every spec group', () => {
		const summary = buildConfigSummary({});
		expect(summary.groups.map((g) => g.name)).toEqual(CONFIG_SPEC.map((g) => g.name));
	});

	it('redacts secret values while surfacing non-secrets', () => {
		const summary = buildConfigSummary({
			MARIMOHUB_AUTH_BACKEND: 'oidc',
			MARIMOHUB_AUTH_OIDC_ISSUER: 'https://accounts.example.com',
			MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'hunter2',
			MARIMOHUB_AUTH_SESSION_SECRET: 'a'.repeat(32),
			MARIMOHUB_STORAGE_S3_BUCKET: 'my-bucket',
			MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY: 'sekrit',
		});

		const auth = group(summary, 'Auth');
		expect(auth.backend).toBe('oidc');
		const byKey = Object.fromEntries(auth.settings.map((s) => [s.key, s]));
		expect(byKey.MARIMOHUB_AUTH_OIDC_ISSUER).toMatchObject({
			value: 'https://accounts.example.com',
			secret: false,
			set: true,
		});
		expect(byKey.MARIMOHUB_AUTH_OIDC_CLIENT_SECRET).toMatchObject({
			value: null,
			secret: true,
			set: true,
		});
		expect(byKey.MARIMOHUB_AUTH_OIDC_REDIRECT_URI).toMatchObject({ value: null, set: false });

		const storage = group(summary, 'Storage');
		expect(storage.backend).toBe('s3');
		const s3 = Object.fromEntries(storage.settings.map((s) => [s.key, s]));
		expect(s3.MARIMOHUB_STORAGE_S3_BUCKET).toMatchObject({ value: 'my-bucket', set: true });
		expect(s3.MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY).toMatchObject({ value: null, secret: true });

		expect(JSON.stringify(summary)).not.toContain('hunter2');
		expect(JSON.stringify(summary)).not.toContain('sekrit');
	});

	it('falls back to spec defaults for values and selectors', () => {
		const summary = buildConfigSummary({ MARIMOHUB_AUTH_BACKEND: 'dev' });

		const auth = group(summary, 'Auth');
		const byKey = Object.fromEntries(auth.settings.map((s) => [s.key, s]));
		expect(byKey.MARIMOHUB_AUTH_DEV_EMAIL).toMatchObject({ value: 'user@localhost', set: false });

		// Storage has a spec default selector; Server / API has no selector at all.
		expect(group(summary, 'Storage').backend).toBe('s3');
		expect(group(summary, 'Server / API').backend).toBeNull();
		expect(group(summary, 'Server / API').settings.length).toBeGreaterThan(0);
	});

	it('reports an unset or unknown backend as-is with no backend-specific settings', () => {
		expect(group(buildConfigSummary({}), 'Auth')).toEqual({
			backend: 'unset',
			name: 'Auth',
			settings: [],
		});
		expect(group(buildConfigSummary({ MARIMOHUB_AUTH_BACKEND: 'bogus' }), 'Auth')).toEqual({
			backend: 'bogus',
			name: 'Auth',
			settings: [],
		});
	});

	it('includes pseudo-backend (selector-less) vars alongside the selected backend', () => {
		const summary = buildConfigSummary({ MARIMOHUB_COMPUTE_BACKEND: 'coreweave' });
		const compute = group(summary, 'Compute');
		const keys = compute.settings.map((s) => s.key);
		// Shared vars apply to every compute backend.
		expect(keys).toContain('MARIMOHUB_COMPUTE_IMAGE');
		// Another backend's vars must not bleed in.
		expect(keys.some((k) => k.includes('_E2B_'))).toBe(false);
	});

	it('treats an explicitly-empty env var as set, with its empty value', () => {
		const summary = buildConfigSummary({
			MARIMOHUB_AUTH_BACKEND: 'oidc',
			MARIMOHUB_AUTH_OIDC_ISSUER: '',
		});
		const issuer = group(summary, 'Auth').settings.find(
			(s) => s.key === 'MARIMOHUB_AUTH_OIDC_ISSUER',
		);
		expect(issuer).toMatchObject({ value: '', set: true });
	});

	// Redaction rides on the spec's `secret` flags; this heuristic catches a
	// future spec entry that forgets to set one. A credential-looking id must
	// either be flagged secret or be listed here with a reason.
	it('flags every credential-looking spec var as secret', () => {
		const knownNonSecrets = new Set([
			// Names of k8s Secret objects, not their contents.
			'MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET',
			'MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET',
			// LLM token limits/TTLs, not credentials.
			'MARIMOHUB_AI_MAX_TOKENS',
			'MARIMOHUB_AI_TOKEN_TTL_SECONDS',
			// Key label, toggle, region, TTL for the secrets subsystem — no material.
			'MARIMOHUB_SECRETS_KEK_ID',
			'MARIMOHUB_SECRETS_AWS',
			'MARIMOHUB_SECRETS_AWS_REGION',
			'MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS',
		]);
		const suspicious = /SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE|CONNECTION_STRING/;
		const unflagged = CONFIG_SPEC.flatMap((g) => g.backends)
			.flatMap((b) => b.vars)
			.filter((v) => suspicious.test(v.id) && v.secret !== true && !knownNonSecrets.has(v.id))
			.map((v) => v.id);
		expect(unflagged).toEqual([]);
	});
});

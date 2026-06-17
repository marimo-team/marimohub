import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPreflight } from '@marimo-hub/core';
import type { ApiDeps } from '@marimo-hub/api';
import { buildPreflightChecks } from './preflightChecks';
import type { Env } from './env';

afterEach(() => vi.restoreAllMocks());

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
	return {
		bucket: {},
		compute: {},
		sandbox: {
			exposure: { mode: 'subdomain' },
			hostname: '',
			workdir: '/workspace',
			persistWorkspace: 'source',
			bucket: { name: '', endpoint: '' },
		},
		...overrides,
	} as unknown as ApiDeps;
}

async function run(env: Env, deps: ApiDeps) {
	const report = await runPreflight(buildPreflightChecks(env, deps));
	const by = (name: string) => report.checks.find((c) => c.name === name);
	return { report, by };
}

describe('storage check', () => {
	it('ok when the store honors conditional writes', async () => {
		const deps = makeDeps({ bucket: { verifyConditionalWrites: async () => {} } as never });
		expect((await run({}, deps)).by('storage')?.status).toBe('ok');
	});

	it('fatal when the store demonstrably ignores conditional writes', async () => {
		const deps = makeDeps({
			bucket: {
				verifyConditionalWrites: async () => {
					throw new Error('S3 target does NOT enforce conditional writes (If-Match)');
				},
			} as never,
		});
		const { report, by } = await run({}, deps);
		expect(by('storage')).toMatchObject({ status: 'fail', fatal: true });
		expect(report.fatal).toBe(true);
	});

	it('non-fatal fail when the store is merely unreachable', async () => {
		const deps = makeDeps({
			bucket: {
				verifyConditionalWrites: async () => {
					throw new Error('connect ECONNREFUSED');
				},
			} as never,
		});
		const { report, by } = await run({}, deps);
		expect(by('storage')?.status).toBe('fail');
		expect(by('storage')?.fatal).toBeUndefined();
		expect(report.fatal).toBe(false);
	});

	it('skipped when the bucket exposes no probe', async () => {
		expect((await run({}, makeDeps())).by('storage')?.status).toBe('skipped');
	});
});

describe('auth.oidc-discovery check', () => {
	it('skipped for non-oidc backends', async () => {
		const { by } = await run({ MARIMOHUB_AUTH_BACKEND: 'dev' }, makeDeps());
		expect(by('auth.oidc-discovery')?.status).toBe('skipped');
	});

	it('ok when the issuer discovery doc is reachable', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
		const { by } = await run(
			{ MARIMOHUB_AUTH_BACKEND: 'oidc', MARIMOHUB_AUTH_OIDC_ISSUER: 'https://idp.example.com' },
			makeDeps(),
		);
		expect(by('auth.oidc-discovery')?.status).toBe('ok');
	});

	it('fail on a non-2xx discovery response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
		const { by } = await run(
			{ MARIMOHUB_AUTH_BACKEND: 'oidc', MARIMOHUB_AUTH_OIDC_ISSUER: 'https://idp.example.com' },
			makeDeps(),
		);
		expect(by('auth.oidc-discovery')?.status).toBe('fail');
	});

	it('fail (non-fatal) when the issuer is unreachable', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
		const { report, by } = await run(
			{ MARIMOHUB_AUTH_BACKEND: 'oidc', MARIMOHUB_AUTH_OIDC_ISSUER: 'https://idp.example.com' },
			makeDeps(),
		);
		expect(by('auth.oidc-discovery')?.status).toBe('fail');
		expect(report.fatal).toBe(false);
	});
});

describe('sandbox.isolation check', () => {
	const env = {
		MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
	};

	it('ok when the kernel host is on a separate domain', async () => {
		const { by } = await run(
			{ ...env, MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'sandboxes.example.net' },
			makeDeps(),
		);
		expect(by('sandbox.isolation')?.status).toBe('ok');
	});

	it('fatal when the kernel host shares the app domain', async () => {
		const { report, by } = await run(
			{ ...env, MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com' },
			makeDeps(),
		);
		expect(by('sandbox.isolation')).toMatchObject({ status: 'fail', fatal: true });
		expect(report.fatal).toBe(true);
	});

	it('skipped in proxy mode (same-origin by design)', async () => {
		const deps = makeDeps({
			sandbox: { exposure: { mode: 'proxy' } } as never,
		});
		const { by } = await run(
			{ ...env, MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com' },
			deps,
		);
		expect(by('sandbox.isolation')?.status).toBe('skipped');
	});
});

describe('sandbox.config check', () => {
	it('warns when a subdomain backend has no kernel hostname', async () => {
		const { by } = await run(
			{ MARIMOHUB_COMPUTE_BACKEND: 'kubernetes', MARIMOHUB_COMPUTE_IMAGE: 'img' },
			makeDeps(),
		);
		expect(by('sandbox.config')?.status).toBe('warn');
		expect(by('sandbox.config')?.message).toContain('MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME');
	});

	it('ok for a complete modal config', async () => {
		const { by } = await run(
			{ MARIMOHUB_COMPUTE_BACKEND: 'modal', MARIMOHUB_COMPUTE_IMAGE: 'img' },
			makeDeps(),
		);
		expect(by('sandbox.config')?.status).toBe('ok');
	});
});

describe('compute check', () => {
	it('skipped when the adapter exposes no probe', async () => {
		expect((await run({}, makeDeps())).by('compute')?.status).toBe('skipped');
	});

	it('ok when the adapter probe succeeds', async () => {
		const deps = makeDeps({ compute: { healthCheck: async () => {} } as never });
		expect((await run({}, deps)).by('compute')?.status).toBe('ok');
	});

	it('fail when the adapter probe throws', async () => {
		const deps = makeDeps({
			compute: {
				healthCheck: async () => {
					throw new Error('unauthorized');
				},
			} as never,
		});
		expect((await run({}, deps)).by('compute')?.status).toBe('fail');
	});
});

describe('wif check', () => {
	it('is absent from the list when WIF is disabled', async () => {
		expect((await run({}, makeDeps())).by('wif')).toBeUndefined();
	});

	it('ok when the signing key loads', async () => {
		const deps = makeDeps({ wif: { issuer: { jwks: async () => [] } } as never });
		expect((await run({}, deps)).by('wif')?.status).toBe('ok');
	});

	it('fatal when the signing key is invalid', async () => {
		const deps = makeDeps({
			wif: {
				issuer: {
					jwks: async () => {
						throw new Error('not a PKCS8 key');
					},
				},
			} as never,
		});
		const { report, by } = await run({}, deps);
		expect(by('wif')).toMatchObject({ status: 'fail', fatal: true });
		expect(report.fatal).toBe(true);
	});
});

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

	it('warn (non-fatal) when the store only enforces CAS per-process', async () => {
		const deps = makeDeps({
			bucket: { verifyConditionalWrites: async () => {}, casScope: 'process' } as never,
		});
		const { report, by } = await run({ MARIMOHUB_STORAGE_BACKEND: 'fs' }, deps);
		expect(by('storage')?.status).toBe('warn');
		expect(by('storage')?.fatal).toBeUndefined();
		expect(report.fatal).toBe(false);
	});

	it('ok when the store enforces CAS globally', async () => {
		const deps = makeDeps({
			bucket: { verifyConditionalWrites: async () => {}, casScope: 'global' } as never,
		});
		expect((await run({}, deps)).by('storage')?.status).toBe('ok');
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

describe('auth.oidc-login-policy check', () => {
	it('skipped when no login-policy library is selected', async () => {
		const { by } = await run({ MARIMOHUB_AUTH_BACKEND: 'oidc' }, makeDeps());
		expect(by('auth.oidc-login-policy')?.status).toBe('skipped');
	});

	it('skipped for non-oidc backends even with a stale selector', async () => {
		const { by } = await run(
			{
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
			},
			makeDeps(),
		);
		expect(by('auth.oidc-login-policy')?.status).toBe('skipped');
	});

	it('reports the loaded module when selected', async () => {
		const { by } = await run(
			{
				MARIMOHUB_AUTH_BACKEND: 'oidc',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: '/etc/marimohub/agency-login-policy.mjs',
			},
			makeDeps(),
		);
		const check = by('auth.oidc-login-policy');
		expect(check?.status).toBe('ok');
		expect(check?.message).toContain('/etc/marimohub/agency-login-policy.mjs');
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

	it('does not require the built-in image setting for library compute', async () => {
		const { by } = await run({ MARIMOHUB_COMPUTE_BACKEND: 'library' }, makeDeps());
		expect(by('sandbox.config')).toMatchObject({ status: 'ok' });
		expect(by('sandbox.config')?.message).not.toContain('MARIMOHUB_COMPUTE_IMAGE');
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

	const remediationCases: {
		name: string;
		backend: string;
		error: string;
		expected: RegExp;
	}[] = [
		{
			name: 'docker missing CLI → install guidance',
			backend: 'docker',
			error: 'docker CLI is not installed or is not on PATH',
			expected: /Install the Docker CLI/i,
		},
		{
			name: 'docker unreachable daemon → check the daemon, not install',
			backend: 'docker',
			error: 'docker is not reachable: Cannot connect to the Docker daemon',
			expected: /Ensure the Docker daemon is running/i,
		},
		{
			name: 'podman missing CLI → install guidance',
			backend: 'podman',
			error: 'podman CLI is not installed or is not on PATH',
			expected: /Install the Podman CLI/i,
		},
		{
			name: 'podman unreachable engine → check the engine, not install',
			backend: 'podman',
			error: 'podman is not reachable: rootless storage not configured',
			expected: /Ensure Podman is configured and reachable/i,
		},
		{
			name: 'unknown backend → generic fallback',
			backend: 'kubernetes',
			error: 'unauthorized',
			expected: /Check the compute backend credentials and endpoint/i,
		},
	];

	it.each(remediationCases)('remediation: $name', async ({ backend, error, expected }) => {
		const deps = makeDeps({
			compute: {
				healthCheck: async () => {
					throw new Error(error);
				},
			} as never,
		});
		const { by } = await run({ MARIMOHUB_COMPUTE_BACKEND: backend } as Env, deps);

		expect(by('compute')).toMatchObject({
			status: 'fail',
			message: `${backend} compute unreachable: ${error}`,
			remediation: expect.stringMatching(expected),
		});
	});

	it('unreachable Docker remediation does not lead with "install the CLI"', async () => {
		const deps = makeDeps({
			compute: {
				healthCheck: async () => {
					throw new Error('docker is not reachable: Cannot connect to the Docker daemon');
				},
			} as never,
		});
		const { by } = await run({ MARIMOHUB_COMPUTE_BACKEND: 'docker' }, deps);
		expect(by('compute')?.remediation).not.toMatch(/Install the Docker CLI/i);
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

describe('integrations.secrets check', () => {
	it('is absent when integrations are disabled', async () => {
		expect((await run({}, makeDeps())).by('integrations.secrets')).toBeUndefined();
	});

	it('reports each configured integration secret source', async () => {
		const deps = makeDeps({
			integrations: {
				secretSources: () => ({
					inline: true,
					references: [
						{
							backend: 'aws-sm',
							title: 'AWS Secrets Manager',
							locator_placeholder: 'Secret ID',
							locator_help: 'Enter a secret ID.',
						},
					],
				}),
			} as never,
		});
		expect((await run({}, deps)).by('integrations.secrets')).toMatchObject({
			status: 'ok',
			message: 'integration secret sources: inline encryption, aws-sm',
		});
	});

	it('reports that integrations have no usable secret source', async () => {
		const deps = makeDeps({
			integrations: {
				secretSources: () => ({ inline: false, references: [] }),
			} as never,
		});
		expect((await run({}, deps)).by('integrations.secrets')).toMatchObject({
			status: 'warn',
			message: 'integration secret sources: none',
			remediation:
				'Configure MARIMOHUB_SECRETS_KEK or an external secret resolver before saving secret fields.',
		});
	});
});

describe('integrations.data-preview check', () => {
	it('marks the runtime ready only after its preflight succeeds', async () => {
		let ready = false;
		const deps = makeDeps({
			dataBrowser: {
				preview: true,
				checkPreview: async () => {
					ready = true;
				},
				close: async () => {},
			},
		});
		expect((await run({}, deps)).by('integrations.data-preview')).toMatchObject({ status: 'ok' });
		expect(ready).toBe(true);
	});

	it('invokes the preview check with its data-browser receiver', async () => {
		const dataBrowser = {
			preview: true,
			ready: false,
			async checkPreview() {
				this.ready = true;
			},
		};
		const deps = makeDeps({ dataBrowser });

		expect((await run({}, deps)).by('integrations.data-preview')).toMatchObject({ status: 'ok' });
		expect(dataBrowser.ready).toBe(true);
	});

	it('registers based on checkPreview rather than close', () => {
		const withCheckOnly = makeDeps({
			dataBrowser: { preview: true, checkPreview: async () => {} },
		});
		const withCloseOnly = makeDeps({
			dataBrowser: { preview: true, close: async () => {} },
		});

		expect(
			buildPreflightChecks({}, withCheckOnly).some(
				(candidate) => candidate.name === 'integrations.data-preview',
			),
		).toBe(true);
		expect(
			buildPreflightChecks({}, withCloseOnly).some(
				(candidate) => candidate.name === 'integrations.data-preview',
			),
		).toBe(false);
	});

	it('reports a failed runtime without making preflight fatal', async () => {
		const deps = makeDeps({
			dataBrowser: {
				preview: true,
				checkPreview: async () => {
					throw new Error('missing pyiceberg');
				},
				close: async () => {},
			},
		});
		const { report, by } = await run({}, deps);
		expect(by('integrations.data-preview')).toMatchObject({
			status: 'fail',
			remediation: expect.stringMatching(/compute credentials.*PyIceberg/i),
		});
		expect(report.fatal).toBe(false);
	});

	it('uses a bounded reporting timeout independent of sandbox lifecycle settings', () => {
		const deps = makeDeps({
			dataBrowser: {
				preview: true,
				checkPreview: () => new Promise(() => {}),
				close: async () => {},
			},
		});
		const check = buildPreflightChecks({}, deps).find(
			(candidate) => candidate.name === 'integrations.data-preview',
		);

		expect(check?.timeoutMs).toBe(30_000);
	});
});

describe('compute.object-storage-wif check', () => {
	const osEnv: Env = {
		MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
		MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS: 'org-data',
		MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'k',
	} as Env;
	const gateway = (body: unknown, status = 200) =>
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

	it('skipped without the coreweave backend or a bucket list', async () => {
		expect((await run({}, makeDeps())).by('compute.object-storage-wif')?.status).toBe('skipped');
		const { by } = await run({ MARIMOHUB_COMPUTE_BACKEND: 'coreweave' } as Env, makeDeps());
		expect(by('compute.object-storage-wif')?.status).toBe('skipped');
	});

	it('ok when the gateway has an enabled config covering the buckets', async () => {
		const spy = gateway({ enabled: true, allowedBuckets: ['org-data'] });
		const { by } = await run(osEnv, makeDeps());
		expect(by('compute.object-storage-wif')?.status).toBe('ok');
		expect(spy).toHaveBeenCalledWith(
			'https://api.cwsandbox.com/v1beta2/object-storage/wif-config',
			expect.objectContaining({ headers: { Authorization: 'Bearer k' } }),
		);
	});

	it('warn when no config is registered (404)', async () => {
		gateway({}, 404);
		const { report, by } = await run(osEnv, makeDeps());
		expect(by('compute.object-storage-wif')?.status).toBe('warn');
		expect(by('compute.object-storage-wif')?.message).toContain('CWSANDBOX_RESOURCE_NOT_FOUND');
		expect(report.fatal).toBe(false);
	});

	it('warn when a configured bucket is missing from a non-empty allowlist', async () => {
		gateway({ enabled: true, allowedBuckets: ['other'] });
		const { by } = await run(osEnv, makeDeps());
		expect(by('compute.object-storage-wif')?.message).toContain('org-data');
	});

	it('ok with an empty allowlist (allows all buckets)', async () => {
		gateway({ enabled: true, allowedBuckets: [] });
		expect((await run(osEnv, makeDeps())).by('compute.object-storage-wif')?.status).toBe('ok');
	});

	it('warn (never fail) when the probe itself errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
		const { report, by } = await run(osEnv, makeDeps());
		expect(by('compute.object-storage-wif')?.status).toBe('warn');
		expect(report.fatal).toBe(false);
	});
});

describe('ai.upstream check', () => {
	const ai = (overrides: Partial<ApiDeps['ai']> = {}) =>
		makeDeps({
			ai: {
				upstreamBaseUrl: 'https://api.example.com/v1',
				upstreamApiKey: 'key',
				model: 'm',
				signingSecret: 's',
				...overrides,
			} as ApiDeps['ai'],
		});
	const upstream = (status: number) =>
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));

	it('skipped when managed AI is disabled', async () => {
		expect((await run({}, makeDeps())).by('ai.upstream')).toBeUndefined();
	});

	it('ok when an unsigned upstream answers /models', async () => {
		const spy = upstream(200);
		expect((await run({}, ai())).by('ai.upstream')?.status).toBe('ok');
		expect(spy).toHaveBeenCalledWith(
			'https://api.example.com/v1/models',
			expect.objectContaining({ method: 'GET' }),
		);
	});

	it.each([401, 403])(
		'ok on %s for an unsigned upstream (providers may gate /models by key)',
		async (status) => {
			upstream(status);
			expect((await run({}, ai())).by('ai.upstream')?.status).toBe('ok');
		},
	);

	it('fail with a base-URL remediation when an unsigned upstream errors', async () => {
		upstream(502);
		const { by } = await run({}, ai());
		expect(by('ai.upstream')?.status).toBe('fail');
		expect(by('ai.upstream')?.remediation).toContain('MARIMOHUB_AI_UPSTREAM_BASE_URL');
	});

	describe('request-signed backend (Bedrock)', () => {
		const bedrockBase = 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1';
		const signedAi = (upstreamFetch: (request: Request) => Promise<Response>) =>
			ai({ upstreamBaseUrl: bedrockBase, upstreamApiKey: undefined, upstreamFetch });

		it('probes through the signing fetch, never the global one', async () => {
			const globalFetch = vi.spyOn(globalThis, 'fetch');
			const upstreamFetch = vi.fn(async () => new Response(null, { status: 200 }));
			const { by } = await run({}, signedAi(upstreamFetch));
			expect(by('ai.upstream')?.status).toBe('ok');
			expect(globalFetch).not.toHaveBeenCalled();
			expect(upstreamFetch).toHaveBeenCalledOnce();
			const [request] = upstreamFetch.mock.calls[0] as unknown as [Request];
			expect(request.url).toBe(`${bedrockBase}/models`);
			expect(request.method).toBe('GET');
		});

		it.each([401, 403])(
			'fail (non-fatal) on %s: the runtime identity lacks Bedrock access',
			async (status) => {
				const { report, by } = await run(
					{},
					signedAi(async () => new Response(null, { status })),
				);
				expect(by('ai.upstream')?.status).toBe('fail');
				expect(by('ai.upstream')?.fatal).toBeUndefined();
				expect(report.fatal).toBe(false);
				expect(by('ai.upstream')?.remediation).toContain('bedrock:InvokeModel');
				expect(by('ai.upstream')?.remediation).toContain('IRSA');
				expect(by('ai.upstream')?.remediation).not.toContain('MARIMOHUB_AI_UPSTREAM_BASE_URL');
			},
		);

		it('points at the region, not an upstream URL, on other errors', async () => {
			const { by } = await run(
				{},
				signedAi(async () => new Response(null, { status: 404 })),
			);
			expect(by('ai.upstream')?.status).toBe('fail');
			expect(by('ai.upstream')?.remediation).toContain('MARIMOHUB_AI_AWS_REGION');
			expect(by('ai.upstream')?.remediation).not.toContain('MARIMOHUB_AI_UPSTREAM_BASE_URL');
		});

		it('fail with a credential-chain remediation when signing itself throws', async () => {
			const { by } = await run(
				{},
				signedAi(async () => {
					throw new Error('Could not load credentials from any providers');
				}),
			);
			expect(by('ai.upstream')?.status).toBe('fail');
			expect(by('ai.upstream')?.message).toContain('Could not load credentials');
			expect(by('ai.upstream')?.remediation).toContain('IRSA');
		});
	});
});

import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
	generateCompose,
	generateEnv,
	generateHelm,
	generateLibrary,
	validateSelection,
} from './generate';
import type { WizardSelection } from './generate';
import { AUTH_WIRING } from './spec';

class StubProxyHeaderAuthenticator {
	constructor(readonly config: Record<string, unknown>) {}
}

function proxyHeaderLibraryConfig(
	env: Record<string, string | undefined>,
): Record<string, unknown> {
	const source = AUTH_WIRING['proxy-header']?.rhs(() => '');
	if (!source) throw new Error('Missing proxy-header Library wiring.');
	const authenticator = runInNewContext(`(${source})`, {
		process: { env },
		ProxyHeaderAuthenticator: StubProxyHeaderAuthenticator,
		URL,
	}) as StubProxyHeaderAuthenticator;
	return authenticator.config;
}

/** Representative backend combinations covering every adapter at least once. */
const CASES: Record<string, WizardSelection> = {
	'default-prod (s3 + modal + oidc)': {
		storage: 's3',
		compute: 'modal',
		auth: 'oidc',
		ai: 'none',
	},
	'gcs + kubernetes + oidc, persist workspace': {
		storage: 'gcs',
		compute: 'kubernetes',
		auth: 'oidc',
		ai: 'none',
		options: { MARIMOHUB_PERSIST_WORKSPACE: 'workspace' },
	},
	'azure + kubernetes + oidc': {
		storage: 'azure',
		compute: 'kubernetes',
		auth: 'oidc',
		ai: 'none',
	},
	'memory + local + dev (all-local)': {
		storage: 'memory',
		compute: 'local',
		auth: 'dev',
		ai: 'none',
	},
	'fs + docker + oidc (single-box)': {
		storage: 'fs',
		compute: 'docker',
		auth: 'oidc',
		ai: 'none',
		values: { MARIMOHUB_STORAGE_FS_ROOT: '/var/lib/marimohub/storage' },
	},
	'fs + podman + oidc': {
		storage: 'fs',
		compute: 'podman',
		auth: 'oidc',
		ai: 'none',
		values: { MARIMOHUB_STORAGE_FS_ROOT: '/var/lib/marimohub/storage' },
	},
	's3 + coreweave + oidc, custom image': {
		storage: 's3',
		compute: 'coreweave',
		auth: 'oidc',
		ai: 'none',
		options: { MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/acme/marimo-sandbox:v1' },
	},
	's3 + wandb + oidc': {
		storage: 's3',
		compute: 'wandb',
		auth: 'oidc',
		ai: 'none',
		values: { MARIMOHUB_COMPUTE_WANDB_ENTITY: 'my-team' },
	},
	's3 + docker + dev': { storage: 's3', compute: 'docker', auth: 'dev', ai: 'none' },
	's3 + docker + proxy-header': {
		storage: 's3',
		compute: 'docker',
		auth: 'proxy-header',
		ai: 'none',
	},
	's3 + e2b + oidc': { storage: 's3', compute: 'e2b', auth: 'oidc', ai: 'none' },
	's3 + none + dev': { storage: 's3', compute: 'none', auth: 'dev', ai: 'none' },
	's3 + modal + oidc, managed ai': {
		storage: 's3',
		compute: 'modal',
		auth: 'oidc',
		ai: 'openai-compatible',
		values: { MARIMOHUB_AI_MODEL: 'gpt-4o-mini' },
	},
	's3 + modal + oidc, bedrock ai': {
		storage: 's3',
		compute: 'modal',
		auth: 'oidc',
		ai: 'bedrock',
		values: {
			MARIMOHUB_AI_MODEL: 'eu.anthropic.claude-opus-4-7',
			MARIMOHUB_AI_AWS_REGION: 'eu-west-1',
		},
	},
	's3 + modal + oidc, value overrides': {
		storage: 's3',
		compute: 'modal',
		auth: 'oidc',
		ai: 'none',
		values: {
			MARIMOHUB_STORAGE_S3_BUCKET: 'my-bucket',
			MARIMOHUB_STORAGE_S3_REGION: 'eu-west-1',
			MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'acme.com',
		},
	},
};

describe('config -> code generators', () => {
	for (const [name, sel] of Object.entries(CASES)) {
		describe(name, () => {
			it('.env', () => expect(generateEnv(sel)).toMatchSnapshot());
			it('helm', () => expect(generateHelm(sel)).toMatchSnapshot());
			it('compose', () => expect(generateCompose(sel)).toMatchSnapshot());
			it('library', () => expect(generateLibrary(sel)).toMatchSnapshot());
		});
	}

	it('marks unresolved required values and retains useful examples as comments', () => {
		const env = generateEnv(CASES['default-prod (s3 + modal + oidc)']);
		expect(env).toContain('MARIMOHUB_STORAGE_S3_BUCKET=_replace_me_  # e.g. orgname-marimohub');
		expect(env).toContain(
			'MARIMOHUB_COMPUTE_IMAGE=_replace_me_  # e.g. ghcr.io/orgname/marimo-sandbox:latest',
		);
		expect(env).toContain('MARIMOHUB_COMPUTE_MODAL_TOKEN_ID=_replace_me_  # required, secret');
		expect(env).not.toContain('MARIMOHUB_STORAGE_S3_BUCKET=orgname-marimohub');
	});

	it('includes required proxy-header configuration and library wiring', () => {
		const selection = CASES['s3 + docker + proxy-header'];
		expect(generateEnv(selection)).toContain(
			'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=_replace_me_  # e.g. example.com,example.org',
		);
		expect(generateHelm(selection)).toContain(
			'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: _replace_me_ # e.g. example.com,example.org',
		);
		expect(generateCompose(selection)).toContain(
			'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: _replace_me_ # e.g. example.com,example.org',
		);

		const library = generateLibrary(selection);
		expect(library).toContain(
			`import { ProxyHeaderAuthenticator } from '@marimo-hub/auth-proxy-header';`,
		);
		expect(library).toContain(`mode: 'headers'`);
		expect(library).toContain(
			`throw new Error('MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS is required.');`,
		);
		expect(library).toContain('const authRoutes = undefined;');
	});

	it('uses proxy header defaults for an unset or blank Library setting', () => {
		for (const header of [undefined, '', '   ']) {
			const config = proxyHeaderLibraryConfig({
				MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
				MARIMOHUB_AUTH_PROXY_HEADER: header,
			});
			expect(config.mode).toBe('headers');
			expect(config.allowedEmailDomains).toEqual(['example.com']);
			expect(config).not.toHaveProperty('headers');
		}
	});

	it('validates custom proxy headers in generated Library wiring', () => {
		expect(
			proxyHeaderLibraryConfig({
				MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
				MARIMOHUB_AUTH_PROXY_HEADER: ' X-Auth-Email , X-Auth-Subject ',
			}),
		).toMatchObject({ mode: 'headers', headers: ['X-Auth-Email', 'X-Auth-Subject'] });

		for (const header of ['X-One,X-Two,X-Three', 'X-One,', 'Bad Header']) {
			expect(() =>
				proxyHeaderLibraryConfig({
					MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
					MARIMOHUB_AUTH_PROXY_HEADER: header,
				}),
			).toThrow('must contain one or two valid header names');
		}
	});

	it('rejects an empty domain list in generated Library wiring', () => {
		for (const domains of [undefined, '', '   ', ',,,', ' , , ']) {
			expect(() =>
				proxyHeaderLibraryConfig({
					MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: domains,
				}),
			).toThrow(/MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS/);
		}
	});

	it('generates JWT Library configuration from IAP settings', () => {
		const config = proxyHeaderLibraryConfig({
			MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: '*',
			MARIMOHUB_AUTH_PROXY_HEADER: ' X-Verified-Assertion ',
			MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: ' audience ',
			MARIMOHUB_AUTH_PROXY_JWT_ISSUER: ' https://issuer.example.com ',
			MARIMOHUB_AUTH_PROXY_JWKS_URL: ' https://issuer.example.com/jwks ',
		});
		expect(config).toEqual({
			mode: 'jwt',
			audience: 'audience',
			allowedEmailDomains: undefined,
			header: 'X-Verified-Assertion',
			issuer: 'https://issuer.example.com',
			jwksUrl: 'https://issuer.example.com/jwks',
		});
	});

	it('requires a JWT audience when another JWT setting enables JWT mode', () => {
		for (const jwtEnv of [
			{ MARIMOHUB_AUTH_PROXY_JWT_ISSUER: 'https://issuer.example.com' },
			{ MARIMOHUB_AUTH_PROXY_JWKS_URL: 'https://issuer.example.com/jwks' },
		]) {
			expect(() =>
				proxyHeaderLibraryConfig({
					MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
					...jwtEnv,
				}),
			).toThrow('MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE is required');
		}
	});

	it('rejects invalid JWT headers and JWKS URLs in generated Library wiring', () => {
		expect(() =>
			proxyHeaderLibraryConfig({
				MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
				MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: 'audience',
				MARIMOHUB_AUTH_PROXY_HEADER: 'X-Assertion,X-Other',
			}),
		).toThrow('must contain one valid JWT assertion header name');

		for (const jwksUrl of [
			'not-a-url',
			'http://issuer.example.com/jwks',
			'https://user:password@issuer.example.com/jwks',
		]) {
			expect(() =>
				proxyHeaderLibraryConfig({
					MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
					MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE: 'audience',
					MARIMOHUB_AUTH_PROXY_JWKS_URL: jwksUrl,
				}),
			).toThrow('must be an HTTPS URL without credentials');
		}
	});

	it('leaves compute profiles unset unless explicitly configured', () => {
		const selection = CASES['default-prod (s3 + modal + oidc)'];
		expect(generateEnv(selection)).not.toContain('MARIMOHUB_COMPUTE_PROFILES');
		expect(
			generateEnv({
				...selection,
				values: { MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1;mem=2Gi' },
			}),
		).toContain('MARIMOHUB_COMPUTE_PROFILES=small:cpu=1;mem=2Gi');
	});

	it('emits an OpenShift default-certificate configuration without a TLS secret', () => {
		const selection: WizardSelection = {
			...CASES['azure + kubernetes + oidc'],
			values: {
				MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS:
					'{"route.openshift.io/termination":"edge"}',
				MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE: 'controller-default',
			},
		};
		const env = generateEnv(selection);
		expect(env).toContain('MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=controller-default');
		expect(env).toContain(
			'MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS={"route.openshift.io/termination":"edge"}',
		);
		expect(env).not.toContain('MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET');
	});

	it('selects secret mode when a kubernetes TLS secret is provided', () => {
		const selection: WizardSelection = {
			...CASES['azure + kubernetes + oidc'],
			values: { MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET: 'wildcard-cert' },
		};
		const env = generateEnv(selection);
		expect(env).toContain('MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=secret');
		expect(env).toContain('MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET=wildcard-cert');
		expect(validateSelection(selection)).toEqual([]);
	});

	it('uses runtime ingress validators in generated kubernetes library wiring', () => {
		const library = generateLibrary(CASES['azure + kubernetes + oidc']);
		expect(library).toContain('parseIngressAnnotations(');
		expect(library).toContain('resolveIngressTlsMode(');
		expect(library).not.toContain('JSON.parse(');
	});

	it.each([
		['storage', { ...CASES['default-prod (s3 + modal + oidc)'], storage: 'library' }],
		['compute', { ...CASES['default-prod (s3 + modal + oidc)'], compute: 'library' }],
		[
			'both',
			{
				...CASES['default-prod (s3 + modal + oidc)'],
				storage: 'library',
				compute: 'library',
			},
		],
	] satisfies [string, WizardSelection][])('loads external %s adapters once', (_, selection) => {
		const library = generateLibrary(selection);
		expect(library.match(/loadAdapterLibraries/g)).toHaveLength(2);
		expect(library.match(/await loadAdapterLibraries/g)).toHaveLength(1);
		if (selection.storage === 'library')
			expect(library).toContain('const bucket = externalBucket!;');
		if (selection.compute === 'library')
			expect(library).toContain('const compute = externalCompute!;');
	});

	it('rejects a selection without programmatic wiring', () => {
		expect(() =>
			generateLibrary({
				...CASES['default-prod (s3 + modal + oidc)'],
				compute: 'unknown',
			}),
		).toThrow('No library wiring for s3/unknown/oidc');
	});
});

describe('validateSelection', () => {
	it('flags dev auth, volatile storage, and unisolated/absent compute', () => {
		expect(validateSelection(CASES['memory + local + dev (all-local)'])).toMatchSnapshot();
		expect(validateSelection(CASES['s3 + none + dev'])).toMatchSnapshot();
	});

	it('flags single-replica fs storage', () => {
		expect(validateSelection(CASES['fs + docker + oidc (single-box)'])).toMatchSnapshot();
	});

	it('is silent for a safe production combo', () => {
		expect(validateSelection(CASES['default-prod (s3 + modal + oidc)'])).toEqual([]);
	});

	it('warns that external adapters are trusted in-process code', () => {
		const selection = { ...CASES['default-prod (s3 + modal + oidc)'], storage: 'library' };
		expect(validateSelection(selection)).toEqual([
			expect.objectContaining({
				level: 'warning',
				title: expect.stringMatching(/server privileges/i),
			}),
		]);
	});

	it('flags plaintext or contradictory kubernetes TLS settings', () => {
		const selection = CASES['azure + kubernetes + oidc'];
		expect(
			validateSelection({
				...selection,
				values: { MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE: 'disabled' },
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ level: 'danger', title: expect.stringMatching(/plaintext/i) }),
				expect.objectContaining({ level: 'danger', title: expect.stringMatching(/scheme/i) }),
			]),
		);
		expect(
			validateSelection({
				...selection,
				values: {
					MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE: 'controller-default',
					MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET: 'wildcard-cert',
				},
			}),
		).toEqual([
			expect.objectContaining({ level: 'danger', title: expect.stringMatching(/conflict/i) }),
		]);
	});

	it('flags incomplete or invalid kubernetes TLS configurations', () => {
		const selection = CASES['azure + kubernetes + oidc'];
		expect(
			validateSelection({
				...selection,
				values: { MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET: 'wildcard-cert' },
			}),
		).toEqual([]);
		for (const [values, title] of [
			[{ MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE: 'secret' }, /secret is missing/i],
			[{ MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE: 'invalid' }, /mode is invalid/i],
			[
				{ MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE: 'http://{id}.{host}' },
				/scheme conflicts/i,
			],
		] as const) {
			expect(validateSelection({ ...selection, values })).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ level: 'danger', title: expect.stringMatching(title) }),
				]),
			);
		}
		expect(
			validateSelection({
				...selection,
				values: { MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE: 'HTTPS://{id}.{host}' },
			}),
		).toEqual([]);
	});
});

import { describe, expect, it } from 'vitest';
import {
	generateCompose,
	generateEnv,
	generateHelm,
	generateLibrary,
	validateSelection,
} from './generate';
import type { WizardSelection } from './generate';

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
	's3 + e2b + oidc': { storage: 's3', compute: 'e2b', auth: 'oidc', ai: 'none' },
	's3 + none + dev': { storage: 's3', compute: 'none', auth: 'dev', ai: 'none' },
	's3 + modal + oidc, managed ai': {
		storage: 's3',
		compute: 'modal',
		auth: 'oidc',
		ai: 'openai-compatible',
		values: { MARIMOHUB_AI_MODEL: 'gpt-4o-mini' },
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
				MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE: 'default',
			},
		};
		const env = generateEnv(selection);
		expect(env).toContain('MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=default');
		expect(env).toContain(
			'MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS={"route.openshift.io/termination":"edge"}',
		);
		expect(env).not.toContain('MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET');
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
});

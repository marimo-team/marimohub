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
});

describe('validateSelection', () => {
	it('flags dev auth, volatile storage, and unisolated/absent compute', () => {
		expect(validateSelection(CASES['memory + local + dev (all-local)'])).toMatchSnapshot();
		expect(validateSelection(CASES['s3 + none + dev'])).toMatchSnapshot();
	});

	it('is silent for a safe production combo', () => {
		expect(validateSelection(CASES['default-prod (s3 + modal + oidc)'])).toEqual([]);
	});
});

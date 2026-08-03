// Experiment tracking and model hubs. Their clients are configured entirely by
// the vendor's own environment variables — there is no per-connection object to
// hand a URL to — so these kinds render those names directly and are effectively
// one per session; a second instance with a different key fails the bundle.
import { z } from 'zod';
import { basicAuthHeader, defineIntegration, probeEndpoint } from '../sdk';
import { zSecret } from '../secretFields';
import { renderConnection, SERVICE_URL_REGEX, serviceUrl } from './common';

const NAME_REGEX = /^[A-Za-z0-9._-]+$/;

const wandbConfig = z.object({
	api_key: zSecret().describe('API key from wandb.ai/authorize'),
	base_url: z
		.string()
		.regex(SERVICE_URL_REGEX, 'Must be an http(s) URL with no credentials, query, or fragment')
		.default('https://api.wandb.ai')
		.describe('Set this for a self-hosted or dedicated-cloud deployment'),
	entity: z
		.string()
		.regex(NAME_REGEX, 'Not a valid entity name')
		.optional()
		.describe('Default team or user'),
	project: z.string().regex(NAME_REGEX, 'Not a valid project name').optional(),
	mode: z
		.enum(['online', 'offline'])
		.default('online')
		.describe('`offline` records runs to disk without contacting the server'),
});

/**
 * Runs land here rather than in the working directory, which the notebook's
 * workspace capture would otherwise sweep into a notebook version.
 */
const WANDB_DIR = '/tmp/marimohub-wandb';

export const wandb = defineIntegration({
	kind: 'wandb',
	title: 'Weights & Biases',
	description: 'Log runs to Weights & Biases from notebook code, with no wandb.login() call.',
	category: 'other',
	brand: { icon: 'weightsandbiases', color: '#FFBE00' },
	schemaVersion: 1,
	configSchema: wandbConfig,
	requirements: ['wandb>=0.18'],
	uiHints: {
		api_key: { group: 'Authentication', order: 1, widget: 'password' },
		base_url: { group: 'Authentication', order: 2 },
		entity: { group: 'Defaults', order: 10 },
		project: { group: 'Defaults', order: 11 },
		mode: { group: 'Defaults', order: 12 },
	},

	render({ config, instanceName }) {
		return renderConnection({
			tool: 'WANDB',
			dir: 'wandb',
			instanceName,
			fields: {},
			ambient: {
				WANDB_API_KEY: config.api_key,
				WANDB_BASE_URL: config.base_url,
				WANDB_ENTITY: config.entity,
				WANDB_PROJECT: config.project,
				WANDB_MODE: config.mode,
				WANDB_DIR,
			},
			descriptor: {
				base_url: config.base_url,
				entity: config.entity,
				project: config.project,
				mode: config.mode,
				api_key_env: 'WANDB_API_KEY',
			},
			manifestExtra: { base_url: config.base_url, entity: config.entity },
		});
	},

	testConnection(config, probe) {
		return probeEndpoint({
			probe,
			url: serviceUrl(config.base_url, 'graphql'),
			init: {
				method: 'POST',
				headers: {
					Authorization: basicAuthHeader('api', config.api_key),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ query: '{ viewer { username } }' }),
			},
			carriesSecrets: true,
			describe(body) {
				const viewer = (body as { data?: { viewer?: { username?: string } | null } } | undefined)
					?.data?.viewer;
				return viewer?.username ? `authenticated as ${viewer.username}` : 'reachable';
			},
		});
	},
});

/** Same reasoning as WANDB_DIR: the model cache is large and must not be captured. */
const HF_HOME = '/tmp/marimohub-huggingface';

const huggingFaceConfig = z.object({
	token: zSecret().describe('Access token from huggingface.co/settings/tokens'),
	endpoint: z
		.string()
		.regex(SERVICE_URL_REGEX, 'Must be an http(s) URL with no credentials, query, or fragment')
		.default('https://huggingface.co')
		.describe('Set this for an Enterprise Hub deployment'),
	enable_hf_transfer: z
		.boolean()
		.default(false)
		.describe('Faster large-file downloads; requires the hf_transfer package'),
});

export const huggingFace = defineIntegration({
	kind: 'huggingface',
	title: 'Hugging Face',
	description: 'Authenticate the Hub client for gated models and private datasets.',
	category: 'other',
	brand: { icon: 'huggingface', color: '#FFD21E' },
	schemaVersion: 1,
	configSchema: huggingFaceConfig,
	requirements: ['huggingface-hub>=0.25'],
	uiHints: {
		token: { group: 'Authentication', order: 1, widget: 'password' },
		endpoint: { group: 'Authentication', order: 2 },
		enable_hf_transfer: { group: 'Downloads', order: 10, widget: 'toggle', advanced: true },
	},

	render({ config, instanceName }) {
		return renderConnection({
			tool: 'HF',
			dir: 'huggingface',
			instanceName,
			fields: {},
			ambient: {
				HF_TOKEN: config.token,
				HF_ENDPOINT: config.endpoint,
				HF_HOME,
				HF_HUB_ENABLE_HF_TRANSFER: config.enable_hf_transfer ? '1' : undefined,
			},
			descriptor: { endpoint: config.endpoint, cache_dir: HF_HOME, token_env: 'HF_TOKEN' },
			manifestExtra: { endpoint: config.endpoint },
		});
	},

	testConnection(config, probe) {
		return probeEndpoint({
			probe,
			url: serviceUrl(config.endpoint, 'api/whoami-v2'),
			init: { headers: { Authorization: `Bearer ${config.token}` } },
			carriesSecrets: true,
			describe(body) {
				const name = (body as { name?: string } | undefined)?.name;
				return name ? `authenticated as ${name}` : 'authenticated';
			},
		});
	},
});

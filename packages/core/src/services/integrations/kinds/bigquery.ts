import { z } from 'zod';
import { defineIntegration, HOSTNAME_REGEX } from '../sdk';
import { zSecret } from '../secretFields';
import { AMBIENT_ENV_DESCRIPTION, connectionUrl, renderConnection, renderFile } from './common';

const bigQueryConfig = z.strictObject({
	// Sits in the authority position of the rendered URL, so it carries the same
	// no-scheme/no-path/no-userinfo restriction as a hostname.
	project_id: z
		.string()
		.regex(HOSTNAME_REGEX, 'Project ID only — no scheme, path, or credentials')
		.describe('Google Cloud project that owns the datasets'),
	dataset: z
		.string()
		.regex(/^[A-Za-z0-9_]+$/, 'Letters, digits, and underscores only')
		.optional()
		.describe('Default dataset for unqualified table names'),
	location: z.string().min(1).optional().describe('Dataset location, e.g. US or europe-west4'),
	auth: z
		.discriminatedUnion('method', [
			z.strictObject({ method: z.literal('ambient') }),
			z.strictObject({ method: z.literal('service_account'), credentials_json: zSecret() }),
		])
		.default({ method: 'ambient' }),
	// Off by default, unlike the storage kinds: this kind's URL already names its
	// key file, so it does not need the ambient Google variables to work — while a
	// GCS integration's client reads nothing else. Leaving them to GCS keeps the
	// common "warehouse plus its buckets" project from failing on a collision.
	ambient_env: z.boolean().default(false).describe(AMBIENT_ENV_DESCRIPTION),
});

export const bigquery = defineIntegration({
	kind: 'bigquery',
	title: 'BigQuery',
	description: 'Query BigQuery from SQL cells, with ADC or a service-account key.',
	category: 'database',
	brand: { icon: 'googlebigquery', color: '#669DF6' },
	schemaVersion: 1,
	configSchema: bigQueryConfig,
	environmentVariables: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
	requirements: ['google-cloud-bigquery>=3.25', 'sqlalchemy-bigquery>=1.11'],
	uiHints: {
		project_id: { group: 'Connection', order: 1 },
		dataset: { group: 'Connection', order: 2 },
		location: { group: 'Connection', order: 3 },
		auth: { group: 'Authentication', order: 10 },
		'auth.credentials_json': { widget: 'textarea' },
		ambient_env: { group: 'Authentication', order: 11, widget: 'toggle', advanced: true },
	},

	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const credentialsPath =
			config.auth.method === 'service_account'
				? renderFile(files, `bigquery/${instanceName}-sa.json`, config.auth.credentials_json)
				: undefined;
		// The key never appears in the URL — only the path to the file holding it —
		// so this one is safe to keep out of the secret set and readable in logs.
		const url = connectionUrl({
			scheme: 'bigquery',
			host: config.project_id,
			segments: [config.dataset],
			query: { credentials_path: credentialsPath, location: config.location },
		});
		return renderConnection({
			tool: 'BIGQUERY',
			dir: 'bigquery',
			instanceName,
			fields: {
				URL: url,
				PROJECT_ID: config.project_id,
				DATASET: config.dataset,
				LOCATION: config.location,
				CREDENTIALS_PATH: credentialsPath,
			},
			ambient: config.ambient_env
				? {
						GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
						GOOGLE_CLOUD_PROJECT: config.project_id,
					}
				: {},
			files,
			manifestExtra: { project_id: config.project_id, auth_method: config.auth.method },
		});
	},
});

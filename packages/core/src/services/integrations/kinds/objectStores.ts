// Object stores. Unlike a database kind, whose client takes an explicit URL,
// these are reached through libraries (duckdb, polars, s3fs, gcsfs, adlfs) that
// only read the vendor's standard environment variables — so each kind can also
// claim those names for the session. That makes an instance with `ambient_env`
// effectively a singleton: two claiming the same variable with different values
// fail the session at bundle time rather than silently picking a winner.
import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { QueryReadinessCheck } from '../../../ports/integrations';
import type { DuckDBHttpAccess } from '../data-preview/programs';
import { sqlIdentifier } from '../data-preview/sql';
import { defineIntegration, HOSTNAME_REGEX } from '../sdk';
import { zSecret } from '../secretFields';
import {
	AMBIENT_ENV_DESCRIPTION,
	AWS_REGION_REGEX,
	awsStaticCredentials,
	GCS_BUCKET_REGEX,
	httpUrlField,
	isInsecureHttpUrl,
	isValidGcsBucket,
	isValidS3Bucket,
	renderConnection,
	renderFile,
	S3_BUCKET_REGEX,
	s3BrokerReadLocationsSchema,
} from './common';

const s3Config = z.strictObject({
	bucket: z
		.string()
		.min(3)
		.max(63)
		.regex(S3_BUCKET_REGEX, 'Not a valid bucket name')
		.refine(isValidS3Bucket, 'Not a valid bucket name')
		.meta({
			'x-marimohub-refinement': 'No adjacent dots and not formatted as an IPv4 address',
		})
		.optional()
		.describe('Default bucket for notebook code; the credentials are not restricted to it'),
	region: z
		.string()
		.regex(AWS_REGION_REGEX, 'Region name only, e.g. us-east-1')
		.optional()
		.describe('Region name, e.g. us-east-1'),
	endpoint_url: httpUrlField()
		.optional()
		.describe('S3-compatible endpoint, e.g. https://minio.internal:9000; omit for AWS S3'),
	allow_insecure_transport: z
		.boolean()
		.default(false)
		.describe('Allow http:// endpoints to carry credentials — local development only'),
	auth: z
		.discriminatedUnion('method', [
			z.strictObject({ method: z.literal('ambient') }),
			z.strictObject({ method: z.literal('static'), ...awsStaticCredentials }),
			z.strictObject({ method: z.literal('anonymous') }),
		])
		.default({ method: 'ambient' }),
	path_style: z
		.boolean()
		.default(false)
		// Rendered into a markdown table, where a bare `<name>` would parse as HTML.
		.describe('Address buckets as `endpoint/bucket`, which most S3-compatible stores require'),
	broker_read_locations: s3BrokerReadLocationsSchema
		.default([])
		.describe('S3 bucket prefixes the guarded DuckDB broker may read'),
	ambient_env: z.boolean().default(true).describe(AMBIENT_ENV_DESCRIPTION),
});

export const s3 = defineIntegration({
	kind: 's3',
	title: 'S3 object storage',
	description: 'Amazon S3 or an S3-compatible store (MinIO, Cloudflare R2, Ceph).',
	category: 'storage',
	brand: { color: '#569A31' },
	schemaVersion: 2,
	migrations: [
		{
			from: 1,
			to: 2,
			description:
				'Preserve authenticated HTTP endpoints with an explicit insecure-transport override.',
		},
	],
	configSchema: s3Config,
	environmentVariables: [
		'AWS_ACCESS_KEY_ID',
		'AWS_SECRET_ACCESS_KEY',
		'AWS_SESSION_TOKEN',
		'AWS_REGION',
		'AWS_DEFAULT_REGION',
		'AWS_ENDPOINT_URL_S3',
		'AWS_CONFIG_FILE',
	],
	requirements: ['boto3>=1.35', 's3fs>=2024.6'],
	uiHints: {
		bucket: { group: 'Bucket', order: 1 },
		region: { group: 'Bucket', order: 2 },
		endpoint_url: { group: 'Bucket', order: 3 },
		allow_insecure_transport: { group: 'Bucket', order: 4, advanced: true, widget: 'toggle' },
		path_style: { group: 'Bucket', order: 5, widget: 'toggle' },
		broker_read_locations: { group: 'Bucket', order: 6, advanced: true },
		auth: { group: 'Authentication', order: 10 },
		'auth.access_key_id': { widget: 'password' },
		'auth.secret_access_key': { widget: 'password' },
		'auth.session_token': { widget: 'password' },
		ambient_env: { group: 'Authentication', order: 11, widget: 'toggle', advanced: true },
	},
	validate(config) {
		assertSecureS3Transport(config);
	},
	migrate(stored, fromVersion) {
		if (fromVersion !== 1 || typeof stored !== 'object' || stored === null) return stored;
		const next = structuredClone(stored) as Record<string, unknown>;
		const anonymous = (next.auth as { method?: unknown } | undefined)?.method === 'anonymous';
		if (
			!anonymous &&
			typeof next.endpoint_url === 'string' &&
			isInsecureHttpUrl(next.endpoint_url)
		) {
			next.allow_insecure_transport = true;
		}
		return next;
	},
	objectBrowse: {
		provider: 's3',
		source(config) {
			return {
				provider: 's3',
				configured_bucket: config.bucket,
				region: config.region,
				endpoint: config.endpoint_url,
				path_style: config.path_style,
				auth:
					config.auth.method === 'static'
						? {
								method: 'static',
								access_key_id: config.auth.access_key_id,
								secret_access_key: config.auth.secret_access_key,
								session_token: config.auth.session_token,
							}
						: { method: config.auth.method },
			};
		},
		snippet(instanceName, bucket, key) {
			const uri = JSON.stringify(objectStoreUri('s3', bucket, key));
			const descriptor = JSON.stringify(instanceName);
			const extension = key.split('.').at(-1)?.toLowerCase();
			if (extension === 'csv') {
				return `import polars as pl\n\ndf = pl.read_csv(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
			}
			if (extension === 'json') {
				return `import polars as pl\n\ndf = pl.read_json(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
			}
			if (extension === 'jsonl' || extension === 'ndjson') {
				return `import polars as pl\n\ndf = pl.read_ndjson(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
			}
			if (extension === 'parquet') {
				return `import polars as pl\n\ndf = pl.read_parquet(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
			}
			return `import fsspec\n\nwith fsspec.open(${uri}, "rb", marimohub_integration=${descriptor}) as source:\n    data = source.read()`;
		},
	},
	query: {
		readiness: s3QueryReadiness,
		available(config) {
			const reason = s3QueryBlocker(config);
			return reason ? { ok: false, reason } : { ok: true };
		},
		plan({ config, integration }) {
			const reason = s3QueryBlocker(config);
			if (reason) throw new ValidationError(reason);
			const endpoint = new URL(config.endpoint_url!);
			const secretName = sqlIdentifier(`marimohub_s3_${integration.id.replaceAll('-', '_')}`);
			const urlStyle = config.path_style ? 'path' : 'vhost';
			return {
				setup: [
					{ text: 'LOAD httpfs' },
					{ text: 'LOAD parquet' },
					{
						text:
							`CREATE TEMPORARY SECRET ${secretName} (` +
							"TYPE S3, KEY_ID 'marimohub-parent-broker', SECRET 'marimohub-parent-broker', " +
							`REGION ?, ENDPOINT ?, URL_STYLE '${urlStyle}', USE_SSL ?)`,
						params: [config.region ?? 'us-east-1', endpoint.host, endpoint.protocol === 'https:'],
					},
				],
				cleanup: [{ text: `DROP SECRET ${secretName}` }],
				httpAccess: s3HttpAccess(config),
			};
		},
	},
	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const staticAuth = config.auth.method === 'static' ? config.auth : undefined;
		// Addressing style has no environment variable of its own — boto3 reads it
		// from a config file — so claiming it means owning AWS_CONFIG_FILE too.
		const configFile =
			config.ambient_env && config.path_style
				? renderFile(
						files,
						`s3/${instanceName}-aws.conf`,
						'[default]\ns3 =\n    addressing_style = path\n',
					)
				: undefined;
		return renderConnection({
			tool: 'S3',
			dir: 's3',
			instanceName,
			fields: {
				BUCKET: config.bucket,
				REGION: config.region,
				ENDPOINT_URL: config.endpoint_url,
				ADDRESSING_STYLE: config.path_style ? 'path' : 'virtual',
				ACCESS_KEY_ID: staticAuth?.access_key_id,
				SECRET_ACCESS_KEY: staticAuth?.secret_access_key,
				SESSION_TOKEN: staticAuth?.session_token,
			},
			secretFields: ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN'],
			ambient: config.ambient_env
				? {
						AWS_ACCESS_KEY_ID: staticAuth?.access_key_id,
						AWS_SECRET_ACCESS_KEY: staticAuth?.secret_access_key,
						AWS_SESSION_TOKEN: staticAuth?.session_token,
						AWS_REGION: config.region,
						AWS_DEFAULT_REGION: config.region,
						// S3-scoped: the unscoped AWS_ENDPOINT_URL would point STS and every
						// other AWS service at this store as well.
						AWS_ENDPOINT_URL_S3: config.endpoint_url,
						AWS_CONFIG_FILE: configFile,
					}
				: {},
			files,
			manifestExtra: { bucket: config.bucket, auth_method: config.auth.method },
		});
	},
});

type S3Config = z.infer<typeof s3Config>;

function s3QueryReadiness(config: S3Config): QueryReadinessCheck[] {
	const endpoint = config.endpoint_url ? new URL(config.endpoint_url) : undefined;
	const locations = config.broker_read_locations;
	return [
		readinessCheck(
			's3-endpoint',
			'Set an explicit S3 endpoint',
			endpoint !== undefined,
			'endpoint_url',
			'DuckDB-Wasm Run SQL requires an explicit S3 endpoint',
		),
		readinessCheck(
			's3-endpoint-origin',
			'Use an origin-only S3 endpoint',
			endpoint?.pathname === '/' && endpoint.search === '' && endpoint.hash === '',
			'endpoint_url',
			'DuckDB-Wasm Run SQL requires an origin-only S3 endpoint',
		),
		readinessCheck(
			's3-secure-transport',
			'Use HTTPS for authenticated S3',
			!usesInsecureAuthenticatedS3(config),
			'endpoint_url',
			'authenticated S3 requires HTTPS unless insecure transport is explicitly enabled',
		),
		readinessCheck(
			's3-virtual-host-endpoint',
			'Use a DNS endpoint for virtual-hosted S3',
			config.path_style || (endpoint !== undefined && !isIpAddress(endpoint.hostname)),
			'endpoint_url',
			'virtual-hosted S3 addressing requires a DNS endpoint',
		),
		readinessCheck(
			's3-credentials',
			'Use static S3 credentials or anonymous access',
			config.auth.method === 'static' || config.auth.method === 'anonymous',
			'auth',
			'DuckDB-Wasm Run SQL requires static S3 credentials or anonymous access',
		),
		readinessCheck(
			's3-read-locations',
			'Add at least one guarded S3 read location',
			locations.length > 0,
			'broker_read_locations',
			'DuckDB-Wasm Run SQL requires at least one guarded S3 read location',
		),
		readinessCheck(
			's3-virtual-host-buckets',
			'Use DNS-compatible bucket names for virtual-hosted S3',
			config.path_style || locations.every((location) => isValidS3Bucket(location.bucket)),
			'broker_read_locations',
			'virtual-hosted S3 addressing requires DNS-compatible bucket names',
		),
	];
}

function readinessCheck(
	id: string,
	label: string,
	ready: boolean,
	field: string,
	reason: string,
): QueryReadinessCheck {
	return { id, label, ready, field, reason };
}

function s3QueryBlocker(config: S3Config): string | undefined {
	return s3QueryReadiness(config).find((check) => !check.ready)?.reason;
}

function s3HttpAccess(config: S3Config): DuckDBHttpAccess {
	assertSecureS3Transport(config);
	if (!config.endpoint_url || config.auth.method === 'ambient') {
		throw new ValidationError('DuckDB-Wasm requires explicit S3 storage configuration.');
	}
	return {
		kind: 's3-object-store',
		...(config.allow_insecure_transport ? { allowInsecureTransport: true } : {}),
		endpoint: config.endpoint_url,
		region: config.region ?? 'us-east-1',
		urlStyle: config.path_style ? 'path' : 'vhost',
		credentials:
			config.auth.method === 'anonymous'
				? { method: 'anonymous' }
				: {
						method: 'static',
						accessKeyId: config.auth.access_key_id,
						secretAccessKey: config.auth.secret_access_key,
						...(config.auth.session_token ? { sessionToken: config.auth.session_token } : {}),
					},
		locations: config.broker_read_locations.map((location) => ({
			bucket: location.bucket,
			prefix: location.prefix.replaceAll(/^\/+|\/+$/g, ''),
		})),
	};
}

function usesInsecureAuthenticatedS3(config: S3Config): boolean {
	return (
		config.auth.method !== 'anonymous' &&
		!config.allow_insecure_transport &&
		isInsecureHttpUrl(config.endpoint_url)
	);
}

function assertSecureS3Transport(config: S3Config): void {
	if (!usesInsecureAuthenticatedS3(config)) return;
	throw new ValidationError(
		'Authenticated S3 requires an https:// endpoint. Enable allow_insecure_transport to override ' +
			'for local development.',
	);
}

function isIpAddress(hostname: string): boolean {
	if (hostname.includes(':')) return true;
	const octets = hostname.split('.');
	return (
		octets.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
	);
}

const gcsConfig = z.strictObject({
	bucket: z
		.string()
		.min(3)
		.max(222)
		.regex(GCS_BUCKET_REGEX, 'Not a valid bucket name')
		.refine(isValidGcsBucket, 'Not a valid bucket name')
		.meta({
			'x-marimohub-refinement':
				'No adjacent dots, each dot-separated part is at most 63 characters, no goog/google reserved names, and not an IPv4 address',
		})
		.optional()
		.describe('Default bucket for notebook code; the credentials are not restricted to it'),
	project_id: z.string().min(1).optional().describe('Project billed for the requests'),
	auth: z
		.discriminatedUnion('method', [
			z.strictObject({ method: z.literal('ambient') }),
			z.strictObject({ method: z.literal('service_account'), credentials_json: zSecret() }),
		])
		.default({ method: 'ambient' }),
	ambient_env: z.boolean().default(true).describe(AMBIENT_ENV_DESCRIPTION),
});

export const gcs = defineIntegration({
	kind: 'gcs',
	title: 'Google Cloud Storage',
	description: 'GCS buckets for gcsfs, polars, and duckdb, with ADC or a service-account key.',
	category: 'storage',
	brand: { icon: 'googlecloudstorage', color: '#AECBFA' },
	schemaVersion: 1,
	configSchema: gcsConfig,
	environmentVariables: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
	requirements: ['gcsfs>=2024.6', 'google-cloud-storage>=2.18'],
	uiHints: {
		bucket: { group: 'Bucket', order: 1 },
		project_id: { group: 'Bucket', order: 2 },
		auth: { group: 'Authentication', order: 10 },
		'auth.credentials_json': { widget: 'textarea' },
		ambient_env: { group: 'Authentication', order: 11, widget: 'toggle', advanced: true },
	},
	objectBrowse: {
		provider: 'gcs',
		source(config) {
			return {
				provider: 'gcs',
				configured_bucket: config.bucket,
				project_id: config.project_id,
				auth:
					config.auth.method === 'service_account'
						? {
								method: 'service_account',
								credentials_json: config.auth.credentials_json,
							}
						: { method: 'ambient' },
			};
		},
		snippet(instanceName, bucket, key) {
			return objectStoreSnippet('gs', instanceName, bucket, key);
		},
	},

	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const credentialsPath =
			config.auth.method === 'service_account'
				? renderFile(files, `gcs/${instanceName}-sa.json`, config.auth.credentials_json)
				: undefined;
		return renderConnection({
			tool: 'GCS',
			dir: 'gcs',
			instanceName,
			fields: {
				BUCKET: config.bucket,
				PROJECT_ID: config.project_id,
				CREDENTIALS_PATH: credentialsPath,
			},
			ambient: config.ambient_env
				? {
						GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
						GOOGLE_CLOUD_PROJECT: config.project_id,
					}
				: {},
			files,
			manifestExtra: { bucket: config.bucket, auth_method: config.auth.method },
		});
	},
});

function objectStoreSnippet(
	scheme: 'gs' | 'az',
	instanceName: string,
	bucket: string,
	key: string,
): string {
	const uri = JSON.stringify(objectStoreUri(scheme, bucket, key));
	const descriptor = JSON.stringify(instanceName);
	const extension = key.split('.').at(-1)?.toLowerCase();
	if (extension === 'csv') {
		return `import polars as pl\n\ndf = pl.read_csv(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
	}
	if (extension === 'json') {
		return `import polars as pl\n\ndf = pl.read_json(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
	}
	if (extension === 'jsonl' || extension === 'ndjson') {
		return `import polars as pl\n\ndf = pl.read_ndjson(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
	}
	if (extension === 'parquet') {
		return `import polars as pl\n\ndf = pl.read_parquet(${uri}, storage_options={"marimohub_integration": ${descriptor}})`;
	}
	return `import fsspec\n\nwith fsspec.open(${uri}, "rb", marimohub_integration=${descriptor}) as source:\n    data = source.read()`;
}

function objectStoreUri(scheme: 's3' | 'gs' | 'az', bucket: string, key: string): string {
	const encodedKey = key
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return `${scheme}://${bucket}/${encodedKey}`;
}

const azureAuthSchema = z.discriminatedUnion('method', [
	z.strictObject({ method: z.literal('ambient') }),
	z.strictObject({ method: z.literal('account_key'), account_key: zSecret() }),
	z.strictObject({ method: z.literal('sas_token'), sas_token: zSecret() }),
	z.strictObject({ method: z.literal('connection_string'), connection_string: zSecret() }),
	z.strictObject({
		method: z.literal('service_principal'),
		tenant_id: z.string().min(1),
		client_id: z.string().min(1),
		client_secret: zSecret(),
	}),
]);

const azureBlobConfig = z.strictObject({
	account_name: z
		.string()
		.regex(/^[a-z0-9]{3,24}$/, 'Storage account names are 3–24 lowercase letters and digits'),
	container: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Not a valid container name')
		.optional()
		.describe('Default container for notebook code'),
	endpoint_suffix: z
		.string()
		.regex(HOSTNAME_REGEX, 'Hostname suffix only')
		.default('core.windows.net')
		.describe('Sovereign clouds use their own, e.g. core.chinacloudapi.cn'),
	auth: azureAuthSchema,
	ambient_env: z.boolean().default(true).describe(AMBIENT_ENV_DESCRIPTION),
});

export const azureBlob = defineIntegration({
	kind: 'azure_blob',
	title: 'Azure Blob Storage',
	description: 'Azure Blob or ADLS Gen2 containers for adlfs, polars, and duckdb.',
	category: 'storage',
	brand: { color: '#0078D4' },
	schemaVersion: 1,
	configSchema: azureBlobConfig,
	environmentVariables: [
		'AZURE_STORAGE_ACCOUNT_NAME',
		'AZURE_STORAGE_KEY',
		'AZURE_STORAGE_SAS_TOKEN',
		'AZURE_STORAGE_CONNECTION_STRING',
		'AZURE_TENANT_ID',
		'AZURE_CLIENT_ID',
		'AZURE_CLIENT_SECRET',
	],
	requirements: ['adlfs>=2024.7', 'azure-storage-blob>=12.22', 'azure-identity>=1.17'],
	uiHints: {
		account_name: { group: 'Account', order: 1 },
		container: { group: 'Account', order: 2 },
		endpoint_suffix: { group: 'Account', order: 3, advanced: true },
		auth: { group: 'Authentication', order: 10 },
		'auth.account_key': { widget: 'password' },
		'auth.sas_token': { widget: 'password' },
		'auth.connection_string': { widget: 'password' },
		'auth.client_secret': { widget: 'password' },
		ambient_env: { group: 'Authentication', order: 11, widget: 'toggle', advanced: true },
	},
	objectBrowse: {
		provider: 'azure_blob',
		source(config) {
			return {
				provider: 'azure_blob',
				configured_bucket: config.container,
				account_name: config.account_name,
				endpoint_suffix: config.endpoint_suffix,
				auth: config.auth,
			};
		},
		snippet(instanceName, container, key) {
			return objectStoreSnippet('az', instanceName, container, key);
		},
	},

	render({ config, instanceName }) {
		const { auth } = config;
		const accountUrl = `https://${config.account_name}.blob.${config.endpoint_suffix}`;
		const accountKey = auth.method === 'account_key' ? auth.account_key : undefined;
		const sasToken = auth.method === 'sas_token' ? auth.sas_token : undefined;
		const connectionString =
			auth.method === 'connection_string' ? auth.connection_string : undefined;
		const principal = auth.method === 'service_principal' ? auth : undefined;
		return renderConnection({
			tool: 'AZURE',
			dir: 'azure',
			instanceName,
			fields: {
				ACCOUNT_NAME: config.account_name,
				ACCOUNT_URL: accountUrl,
				CONTAINER: config.container,
				ACCOUNT_KEY: accountKey,
				SAS_TOKEN: sasToken,
				CONNECTION_STRING: connectionString,
				TENANT_ID: principal?.tenant_id,
				CLIENT_ID: principal?.client_id,
				CLIENT_SECRET: principal?.client_secret,
			},
			secretFields: ['ACCOUNT_KEY', 'SAS_TOKEN', 'CONNECTION_STRING', 'CLIENT_SECRET'],
			ambient: config.ambient_env
				? {
						AZURE_STORAGE_ACCOUNT_NAME: config.account_name,
						AZURE_STORAGE_KEY: accountKey,
						AZURE_STORAGE_SAS_TOKEN: sasToken,
						AZURE_STORAGE_CONNECTION_STRING: connectionString,
						AZURE_TENANT_ID: principal?.tenant_id,
						AZURE_CLIENT_ID: principal?.client_id,
						AZURE_CLIENT_SECRET: principal?.client_secret,
					}
				: {},
			manifestExtra: { account_name: config.account_name, auth_method: auth.method },
		});
	},
});

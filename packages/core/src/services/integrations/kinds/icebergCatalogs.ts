import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';
import {
	awsCredentialProperties,
	awsCredentialsSchema,
	extraPropertiesSchema,
	ICEBERG_BRAND_COLOR,
	icebergRuntimeSchema,
	icebergRequirements,
	icebergStorageSchema,
	icebergStorageUiHints,
	renderIcebergCatalog,
	runtimeCatalogProperties,
	runtimeRootProperties,
	storageProperties,
	THRIFT_URL_REGEX,
	unifiedAwsCredentialProperties,
	unifiedAwsCredentialsSchema,
	unifiedAwsUiHints,
	validateExtraProperties,
} from './icebergShared';
import { httpUrlField } from './common';

const commonUiHints = {
	warehouse: { group: 'Connection', order: 2 },
	...icebergStorageUiHints,
	extra_properties: { group: 'Advanced', order: 90, advanced: true, widget: 'kv-pairs' as const },
};

const sqlConfig = z.strictObject({
	uri: zSecret().describe('SQLAlchemy URI for PostgreSQL or SQLite'),
	warehouse: z.string().min(1).optional().describe('Default Iceberg table storage location'),
	init_catalog_tables: z.boolean().default(true),
	echo: z.boolean().default(false),
	pool_pre_ping: z.boolean().default(false),
	storage: icebergStorageSchema,
	runtime: icebergRuntimeSchema,
	extra_properties: extraPropertiesSchema,
});

const SQL_OWNED = new Set([
	'type',
	'uri',
	'warehouse',
	'init_catalog_tables',
	'echo',
	'pool_pre_ping',
]);

function sqlCatalogExtras(uri: string): string[] {
	const dialect = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri)?.[1].split('+')[0].toLowerCase();
	if (dialect === 'sqlite') return ['sql-sqlite'];
	if (dialect === 'postgres' || dialect === 'postgresql') return ['sql-postgres'];
	return ['sql-postgres', 'sql-sqlite'];
}

export const icebergSql = defineIntegration({
	kind: 'iceberg_sql',
	title: 'Iceberg SQL Catalog',
	description: 'Store Iceberg catalog metadata in PostgreSQL or SQLite through SQLAlchemy.',
	category: 'catalog',
	brand: { color: ICEBERG_BRAND_COLOR },
	schemaVersion: 1,
	configSchema: sqlConfig,
	requirements: ['pyiceberg[pyarrow,sql-postgres,sql-sqlite,s3fs,gcsfs,adlfs,hf]>=0.11'],
	resolveRequirements: (config) =>
		icebergRequirements(['pyarrow', ...sqlCatalogExtras(config.uri)], config),
	uiHints: {
		uri: { group: 'Connection', order: 1, widget: 'password' },
		...commonUiHints,
		init_catalog_tables: { group: 'SQL', order: 10, advanced: true, widget: 'toggle' },
		echo: { group: 'SQL', order: 11, advanced: true, widget: 'toggle' },
		pool_pre_ping: { group: 'SQL', order: 12, advanced: true, widget: 'toggle' },
	},
	validate(config) {
		validateExtraProperties(config.extra_properties, SQL_OWNED);
	},
	render({ config, instanceName }) {
		return renderIcebergCatalog({
			instanceName,
			catalogType: 'sql',
			properties: {
				uri: config.uri,
				...(config.warehouse ? { warehouse: config.warehouse } : {}),
				init_catalog_tables: String(config.init_catalog_tables),
				echo: String(config.echo),
				pool_pre_ping: String(config.pool_pre_ping),
				...storageProperties(config.storage),
				...runtimeCatalogProperties(config.runtime),
				...config.extra_properties,
			},
			rootProperties: runtimeRootProperties(config.runtime),
			descriptor: { storage: config.storage.scheme },
		});
	},
});

const hiveConfig = z.strictObject({
	uri: z.string().regex(THRIFT_URL_REGEX, 'Must be a thrift:// URL without embedded credentials'),
	warehouse: z.string().min(1).optional().describe('Default Iceberg table storage location'),
	hive2_compatible: z.boolean().default(false),
	kerberos: z
		.strictObject({
			enabled: z.boolean().default(false),
			service_name: z.string().min(1).default('hive'),
		})
		.default({ enabled: false, service_name: 'hive' }),
	ugi: zSecret().optional().describe('Hadoop user/group identity'),
	storage: icebergStorageSchema,
	runtime: icebergRuntimeSchema,
	extra_properties: extraPropertiesSchema,
});

const HIVE_OWNED = new Set([
	'type',
	'uri',
	'warehouse',
	'hive.hive2-compatible',
	'hive.kerberos-authentication',
	'hive.kerberos-service-name',
	'ugi',
]);

export const icebergHive = defineIntegration({
	kind: 'iceberg_hive',
	title: 'Iceberg Hive Catalog',
	description: 'Connect PyIceberg to a Hive Metastore over Thrift.',
	category: 'catalog',
	brand: { icon: 'apachehive', color: '#FDEE21' },
	schemaVersion: 1,
	configSchema: hiveConfig,
	requirements: ['pyiceberg[pyarrow,hive,hive-kerberos,s3fs,gcsfs,adlfs,hf]>=0.11'],
	resolveRequirements: (config) =>
		icebergRequirements(
			['pyarrow', 'hive', ...(config.kerberos.enabled ? ['hive-kerberos'] : [])],
			config,
		),
	uiHints: {
		uri: { group: 'Connection', order: 1 },
		...commonUiHints,
		hive2_compatible: { group: 'Hive', order: 10, widget: 'toggle' },
		kerberos: { group: 'Authentication', order: 11 },
		ugi: { group: 'Authentication', order: 12, widget: 'password' },
	},
	validate(config) {
		validateExtraProperties(config.extra_properties, HIVE_OWNED);
	},
	render({ config, instanceName }) {
		return renderIcebergCatalog({
			instanceName,
			catalogType: 'hive',
			properties: {
				uri: config.uri,
				...(config.warehouse ? { warehouse: config.warehouse } : {}),
				'hive.hive2-compatible': String(config.hive2_compatible),
				'hive.kerberos-authentication': String(config.kerberos.enabled),
				'hive.kerberos-service-name': config.kerberos.service_name,
				...(config.ugi ? { ugi: config.ugi } : {}),
				...storageProperties(config.storage),
				...runtimeCatalogProperties(config.runtime),
				...config.extra_properties,
			},
			rootProperties: runtimeRootProperties(config.runtime),
			descriptor: { uri: config.uri, storage: config.storage.scheme },
		});
	},
});

const glueConfig = z.strictObject({
	warehouse: z.string().min(1).optional().describe('Default Iceberg table storage location'),
	catalog_id: z
		.string()
		.regex(/^\d{12}$/, 'Must be a 12-digit AWS account ID')
		.optional(),
	region: z.string().min(1).optional(),
	endpoint: httpUrlField().optional(),
	credentials: awsCredentialsSchema
		.default({ method: 'ambient' })
		.describe(
			'Glue Catalog credentials only. When explicit, these override unified credentials for Glue calls. The catalog region uses the region field; PyIceberg exposes role assumption through unified credentials.',
		),
	unified_credentials: unifiedAwsCredentialsSchema.describe(
		'Client credentials shared by Glue and S3 FileIO. Glue-specific and storage-specific credentials override these.',
	),
	skip_archive: z.boolean().default(true),
	max_retries: z.number().int().nonnegative().default(10),
	retry_mode: z.enum(['legacy', 'standard', 'adaptive']).default('standard'),
	storage: icebergStorageSchema,
	runtime: icebergRuntimeSchema,
	extra_properties: extraPropertiesSchema,
});

const GLUE_OWNED = new Set([
	'type',
	'warehouse',
	'glue.id',
	'glue.region',
	'glue.endpoint',
	'glue.profile-name',
	'glue.access-key-id',
	'glue.secret-access-key',
	'glue.session-token',
	'glue.skip-archive',
	'glue.max-retries',
	'glue.retry-mode',
	'client.region',
	'client.profile-name',
	'client.access-key-id',
	'client.secret-access-key',
	'client.session-token',
	'client.role-arn',
	'client.role-session-name',
]);

export const icebergGlue = defineIntegration({
	kind: 'iceberg_glue',
	title: 'Iceberg AWS Glue Catalog',
	description:
		'Use AWS Glue as the Iceberg metastore with ambient, profile, or static credentials.',
	category: 'catalog',
	// No icon: simple-icons dropped all Amazon marks (trademark takedown).
	brand: { color: '#232F3E' },
	schemaVersion: 1,
	configSchema: glueConfig,
	requirements: ['pyiceberg[pyarrow,glue,s3fs,gcsfs,adlfs,hf]>=0.11'],
	resolveRequirements: (config) => icebergRequirements(['pyarrow', 'glue'], config),
	uiHints: {
		...commonUiHints,
		catalog_id: { group: 'Glue', order: 1 },
		region: { group: 'Glue', order: 2 },
		endpoint: { group: 'Glue', order: 3, advanced: true },
		credentials: { group: 'Authentication', order: 10 },
		'credentials.access_key_id': { widget: 'password' },
		'credentials.secret_access_key': { widget: 'password' },
		'credentials.session_token': { widget: 'password' },
		...unifiedAwsUiHints,
		skip_archive: { group: 'Glue', order: 4, advanced: true, widget: 'toggle' },
		max_retries: { group: 'Glue', order: 5, advanced: true, widget: 'number' },
		retry_mode: { group: 'Glue', order: 6, advanced: true },
	},
	validate(config) {
		validateExtraProperties(config.extra_properties, GLUE_OWNED);
	},
	render({ config, instanceName }) {
		return renderIcebergCatalog({
			instanceName,
			catalogType: 'glue',
			properties: {
				...(config.warehouse ? { warehouse: config.warehouse } : {}),
				...(config.catalog_id ? { 'glue.id': config.catalog_id } : {}),
				...(config.region ? { 'glue.region': config.region } : {}),
				...(config.endpoint ? { 'glue.endpoint': config.endpoint } : {}),
				...awsCredentialProperties('glue', config.credentials),
				...unifiedAwsCredentialProperties(config.unified_credentials),
				'glue.skip-archive': String(config.skip_archive),
				'glue.max-retries': String(config.max_retries),
				'glue.retry-mode': config.retry_mode,
				...storageProperties(config.storage),
				...runtimeCatalogProperties(config.runtime),
				...config.extra_properties,
			},
			rootProperties: runtimeRootProperties(config.runtime),
			descriptor: { region: config.region, storage: config.storage.scheme },
		});
	},
});

const dynamodbConfig = z.strictObject({
	table_name: z.string().min(1).default('iceberg'),
	warehouse: z.string().min(1).optional().describe('Default Iceberg table storage location'),
	region: z.string().min(1).optional(),
	credentials: awsCredentialsSchema
		.default({ method: 'ambient' })
		.describe(
			'DynamoDB Catalog credentials only. When explicit, these override unified credentials for DynamoDB calls. The catalog region uses the region field; PyIceberg exposes role assumption through unified credentials.',
		),
	unified_credentials: unifiedAwsCredentialsSchema.describe(
		'Client credentials shared by DynamoDB and S3 FileIO. DynamoDB-specific and storage-specific credentials override these.',
	),
	storage: icebergStorageSchema,
	runtime: icebergRuntimeSchema,
	extra_properties: extraPropertiesSchema,
});

const DYNAMODB_OWNED = new Set([
	'type',
	'table-name',
	'warehouse',
	'dynamodb.region',
	'dynamodb.profile-name',
	'dynamodb.access-key-id',
	'dynamodb.secret-access-key',
	'dynamodb.session-token',
	'client.region',
	'client.profile-name',
	'client.access-key-id',
	'client.secret-access-key',
	'client.session-token',
	'client.role-arn',
	'client.role-session-name',
]);

export const icebergDynamoDb = defineIntegration({
	kind: 'iceberg_dynamodb',
	title: 'Iceberg DynamoDB Catalog',
	description: 'Use an AWS DynamoDB table as the Iceberg catalog.',
	category: 'catalog',
	brand: { color: '#4053D6' },
	schemaVersion: 1,
	configSchema: dynamodbConfig,
	requirements: ['pyiceberg[pyarrow,dynamodb,s3fs,gcsfs,adlfs,hf]>=0.11'],
	resolveRequirements: (config) => icebergRequirements(['pyarrow', 'dynamodb'], config),
	uiHints: {
		...commonUiHints,
		table_name: { group: 'DynamoDB', order: 1 },
		region: { group: 'DynamoDB', order: 2 },
		credentials: { group: 'Authentication', order: 10 },
		'credentials.access_key_id': { widget: 'password' },
		'credentials.secret_access_key': { widget: 'password' },
		'credentials.session_token': { widget: 'password' },
		...unifiedAwsUiHints,
	},
	validate(config) {
		validateExtraProperties(config.extra_properties, DYNAMODB_OWNED);
	},
	render({ config, instanceName }) {
		return renderIcebergCatalog({
			instanceName,
			catalogType: 'dynamodb',
			properties: {
				'table-name': config.table_name,
				...(config.warehouse ? { warehouse: config.warehouse } : {}),
				...(config.region ? { 'dynamodb.region': config.region } : {}),
				...awsCredentialProperties('dynamodb', config.credentials),
				...unifiedAwsCredentialProperties(config.unified_credentials),
				...storageProperties(config.storage),
				...runtimeCatalogProperties(config.runtime),
				...config.extra_properties,
			},
			rootProperties: runtimeRootProperties(config.runtime),
			descriptor: { table_name: config.table_name, region: config.region },
		});
	},
});

const bigQueryConfig = z.strictObject({
	project_id: z.string().min(1),
	location: z.string().min(1).optional(),
	warehouse: z.string().min(1).describe('Default Iceberg table storage location'),
	credentials: z
		.discriminatedUnion('method', [
			z.strictObject({ method: z.literal('ambient') }),
			z.strictObject({ method: z.literal('service_account_json'), credentials_json: zSecret() }),
		])
		.default({ method: 'ambient' }),
	storage: icebergStorageSchema,
	runtime: icebergRuntimeSchema,
	extra_properties: extraPropertiesSchema,
});

const BIGQUERY_OWNED = new Set([
	'type',
	'gcp.bigquery.project-id',
	'gcp.bigquery.location',
	'gcp.bigquery.credentials-info',
	'warehouse',
]);

export const icebergBigQuery = defineIntegration({
	kind: 'iceberg_bigquery',
	title: 'Iceberg BigQuery Metastore Catalog',
	description: 'Use Google BigQuery as the Iceberg metastore.',
	category: 'catalog',
	brand: { icon: 'googlebigquery', color: '#669DF6' },
	schemaVersion: 1,
	configSchema: bigQueryConfig,
	requirements: ['pyiceberg[pyarrow,bigquery,gcsfs,s3fs,adlfs,hf]>=0.11'],
	resolveRequirements: (config) => icebergRequirements(['pyarrow', 'bigquery'], config),
	uiHints: {
		...commonUiHints,
		project_id: { group: 'BigQuery', order: 1 },
		location: { group: 'BigQuery', order: 2 },
		credentials: { group: 'Authentication', order: 10 },
		'credentials.credentials_json': { widget: 'password' },
	},
	validate(config) {
		if (config.runtime.legacy_current_snapshot_id === false) {
			throw new ValidationError('BigQuery requires legacy_current_snapshot_id to remain enabled.');
		}
		validateExtraProperties(config.extra_properties, BIGQUERY_OWNED);
	},
	render({ config, instanceName }) {
		return renderIcebergCatalog({
			instanceName,
			catalogType: 'bigquery',
			properties: {
				'gcp.bigquery.project-id': config.project_id,
				...(config.location ? { 'gcp.bigquery.location': config.location } : {}),
				warehouse: config.warehouse,
				...(config.credentials.method === 'service_account_json'
					? { 'gcp.bigquery.credentials-info': config.credentials.credentials_json }
					: {}),
				...storageProperties(config.storage),
				...runtimeCatalogProperties(config.runtime),
				...config.extra_properties,
			},
			rootProperties: {
				...runtimeRootProperties(config.runtime),
				'legacy-current-snapshot-id': 'true',
			},
			descriptor: {
				project_id: config.project_id,
				location: config.location,
				storage: config.storage.scheme,
			},
		});
	},
});

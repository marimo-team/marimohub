import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';
import {
	awsCredentialProperties,
	awsCredentialsSchema,
	extraPropertiesSchema,
	HTTP_URL_REGEX,
	ICEBERG_BRAND_COLOR,
	icebergRuntimeSchema,
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

const commonUiHints = {
	warehouse: { group: 'Connection', order: 2 },
	...icebergStorageUiHints,
	extra_properties: { group: 'Advanced', order: 90, advanced: true, widget: 'kv-pairs' as const },
};

const sqlConfig = z.object({
	uri: zSecret().describe('SQLAlchemy URI for PostgreSQL or SQLite'),
	warehouse: z.string().min(1).optional(),
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

export const icebergSql = defineIntegration({
	kind: 'iceberg_sql',
	title: 'Iceberg SQL Catalog',
	description: 'Store Iceberg catalog metadata in PostgreSQL or SQLite through SQLAlchemy.',
	category: 'catalog',
	brand: { color: ICEBERG_BRAND_COLOR },
	schemaVersion: 1,
	configSchema: sqlConfig,
	requirements: ['pyiceberg[pyarrow,sql-postgres,sql-sqlite,s3fs,gcsfs,adlfs,hf]>=0.11'],
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

const hiveConfig = z.object({
	uri: z.string().regex(THRIFT_URL_REGEX, 'Must be a thrift:// URL without embedded credentials'),
	warehouse: z.string().min(1).optional(),
	hive2_compatible: z.boolean().default(false),
	kerberos: z
		.object({
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

const glueConfig = z.object({
	warehouse: z.string().min(1).optional(),
	catalog_id: z
		.string()
		.regex(/^\d{12}$/, 'Must be a 12-digit AWS account ID')
		.optional(),
	region: z.string().min(1).optional(),
	endpoint: z
		.string()
		.regex(HTTP_URL_REGEX, 'Must be an http(s) URL without embedded credentials')
		.optional(),
	credentials: awsCredentialsSchema.default({ method: 'ambient' }),
	unified_credentials: unifiedAwsCredentialsSchema,
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

const dynamodbConfig = z.object({
	table_name: z.string().min(1).default('iceberg'),
	warehouse: z.string().min(1).optional(),
	region: z.string().min(1).optional(),
	credentials: awsCredentialsSchema.default({ method: 'ambient' }),
	unified_credentials: unifiedAwsCredentialsSchema,
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

const bigQueryConfig = z.object({
	project_id: z.string().min(1),
	location: z.string().min(1).optional(),
	warehouse: z.string().min(1),
	credentials: z
		.discriminatedUnion('method', [
			z.object({ method: z.literal('ambient') }),
			z.object({ method: z.literal('service_account_json'), credentials_json: zSecret() }),
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

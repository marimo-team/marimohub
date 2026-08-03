import { z } from 'zod';
import { defineIntegration } from '../sdk';
import {
	AWS_REGION_REGEX,
	awsAuthSchema,
	connectionUrl,
	hostField,
	portField,
	renderConnection,
	renderSqlConnection,
	SQL_CONNECTION_HINTS,
	sqlCredentials,
} from './common';

// redshift_connector reads `sslmode` from the connection string but takes
// TLS on/off as a real boolean, which a URL query argument cannot carry
// unambiguously — so only its two verifying modes are offered. Both check the
// chain against the driver's bundled Amazon trust store; `verify-full` also
// checks the hostname.
const sslModeSchema = z.enum(['verify-ca', 'verify-full']).default('verify-ca');

const redshiftConfig = z.object({
	host: hostField(
		'Cluster or workgroup endpoint, e.g. wg.123456789012.us-east-1.redshift-serverless.amazonaws.com',
	),
	port: portField(5439),
	database: z.string().min(1),
	...sqlCredentials,
	ssl_mode: sslModeSchema,
});

export const redshift = defineIntegration({
	kind: 'redshift',
	title: 'Amazon Redshift',
	description: 'Redshift cluster or serverless workgroup for SQL cells and SQLAlchemy.',
	category: 'database',
	brand: { color: '#8C4FFF' },
	schemaVersion: 1,
	configSchema: redshiftConfig,
	requirements: ['sqlalchemy-redshift>=0.14', 'redshift-connector>=2.1'],
	uiHints: {
		...SQL_CONNECTION_HINTS,
		ssl_mode: { group: 'Connection', order: 4 },
	},

	render({ config, instanceName }) {
		const url = connectionUrl({
			scheme: 'redshift+redshift_connector',
			host: config.host,
			port: config.port,
			segments: [config.database],
			username: config.username,
			password: config.password,
			query: { sslmode: config.ssl_mode },
		});
		return renderSqlConnection({
			tool: 'REDSHIFT',
			dir: 'redshift',
			instanceName,
			url,
			config,
			fields: { SSL_MODE: config.ssl_mode },
		});
	},
});

const athenaConfig = z.object({
	region: z.string().regex(AWS_REGION_REGEX, 'Region name only, e.g. us-east-1'),
	s3_staging_dir: z
		.string()
		.regex(/^s3:\/\/[^\s?#]+$/, 'Must be an s3:// URI')
		.describe('Bucket prefix Athena writes query results to'),
	database: z
		.string()
		.regex(/^[A-Za-z0-9_]+$/, 'Letters, digits, and underscores only')
		.default('default'),
	workgroup: z
		.string()
		.regex(/^[A-Za-z0-9._-]+$/, 'Not a valid workgroup name')
		.default('primary'),
	catalog: z
		.string()
		.regex(/^[A-Za-z0-9._-]+$/, 'Not a valid catalog name')
		.default('AwsDataCatalog'),
	auth: awsAuthSchema,
});

export const athena = defineIntegration({
	kind: 'athena',
	title: 'Amazon Athena',
	description: 'Query S3 data with Athena through PyAthena and SQLAlchemy.',
	category: 'engine',
	brand: { color: '#8C4FFF' },
	schemaVersion: 1,
	configSchema: athenaConfig,
	requirements: ['pyathena[sqlalchemy]>=3.9'],
	uiHints: {
		region: { group: 'Connection', order: 1 },
		s3_staging_dir: { group: 'Connection', order: 2 },
		database: { group: 'Defaults', order: 10 },
		workgroup: { group: 'Defaults', order: 11 },
		catalog: { group: 'Defaults', order: 12 },
		auth: { group: 'Authentication', order: 20 },
		'auth.access_key_id': { widget: 'password' },
		'auth.secret_access_key': { widget: 'password' },
		'auth.session_token': { widget: 'password' },
	},

	render({ config, instanceName }) {
		const isStatic = config.auth.method === 'static';
		// PyAthena's documented ambient form keeps the empty userinfo (`://:@`),
		// which is what makes it fall through to boto3's provider chain.
		const url = connectionUrl({
			scheme: 'awsathena+rest',
			host: `athena.${config.region}.amazonaws.com`,
			port: 443,
			segments: [config.database],
			username: isStatic ? config.auth.access_key_id : '',
			password: isStatic ? config.auth.secret_access_key : '',
			query: {
				s3_staging_dir: config.s3_staging_dir,
				work_group: config.workgroup,
				catalog_name: config.catalog,
				aws_session_token: isStatic ? config.auth.session_token : undefined,
			},
		});
		return renderConnection({
			tool: 'ATHENA',
			dir: 'athena',
			instanceName,
			fields: {
				URL: url,
				REGION: config.region,
				S3_STAGING_DIR: config.s3_staging_dir,
				DATABASE: config.database,
				WORKGROUP: config.workgroup,
				CATALOG: config.catalog,
				ACCESS_KEY_ID: isStatic ? config.auth.access_key_id : undefined,
				SECRET_ACCESS_KEY: isStatic ? config.auth.secret_access_key : undefined,
				SESSION_TOKEN: isStatic ? config.auth.session_token : undefined,
			},
			secretFields: ['URL', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN'],
			manifestExtra: { region: config.region, auth_method: config.auth.method },
		});
	},
});

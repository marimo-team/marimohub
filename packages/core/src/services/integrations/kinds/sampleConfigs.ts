/**
 * One representative authoring config per kind, shared by the kind test suites.
 * Not imported by production code.
 */
export const SAMPLE_CONFIGS: Record<string, unknown> = {
	postgres: {
		host: 'db.internal',
		database: 'analytics',
		username: 'svc user',
		password: 'p@ss:word',
	},
	trino: {
		host: 'trino.internal',
		auth: { method: 'basic', username: 'svc', password: 'pw' },
		default_catalog: 'hive',
	},
	pyspark: {
		host: 'spark.internal',
		auth: { method: 'token', token: 'spark-token' },
		app_name: 'marimohub',
	},
	iceberg_rest: {
		uri: 'https://catalog.internal/api/catalog',
		warehouse: 'wh',
		auth: {
			method: 'oauth2_client_credentials',
			token_endpoint: 'https://idp.internal/token',
			client_id: 'cid',
			client_secret: 'csec',
		},
		storage: { scheme: 's3', region: 'us-east-1' },
		extra_properties: { 'rest.sigv4-enabled': 'false' },
	},
	iceberg_sql: {
		uri: 'postgresql+psycopg2://catalog:secret@db.internal/iceberg',
		warehouse: 's3://warehouse/sql',
	},
	iceberg_hive: {
		uri: 'thrift://hive.internal:9083',
		warehouse: 's3://warehouse/hive',
	},
	iceberg_glue: {
		warehouse: 's3://warehouse/glue',
		region: 'us-east-1',
	},
	iceberg_dynamodb: {
		table_name: 'iceberg-catalog',
		warehouse: 's3://warehouse/dynamodb',
		region: 'us-east-1',
	},
	iceberg_bigquery: {
		project_id: 'analytics-prod',
		location: 'US',
		warehouse: 'gs://warehouse/bigquery',
	},
	mysql: {
		host: 'mysql.internal',
		database: 'analytics',
		username: 'svc user',
		password: 'p@ss:word',
	},
	sqlserver: {
		host: 'mssql.internal',
		database: 'analytics',
		username: 'svc',
		password: 'mssql-pw',
	},
	mongodb: {
		host: 'cluster0.abcde.mongodb.net',
		database: 'analytics',
		auth: { method: 'password', username: 'svc', password: 'mongo-pw' },
	},
	clickhouse: {
		host: 'ch.internal',
		database: 'analytics',
		username: 'svc',
		password: 'ch-pw',
	},
	snowflake: {
		account: 'myorg-account1',
		user: 'svc',
		auth: { method: 'password', password: 'sf-pw' },
		warehouse: 'compute_wh',
		database: 'analytics',
		schema: 'public',
	},
	bigquery: {
		project_id: 'analytics-prod',
		dataset: 'events',
		location: 'US',
		auth: { method: 'service_account', credentials_json: '{"private_key":"bq-key"}' },
	},
	redshift: {
		host: 'wg.123456789012.us-east-1.redshift-serverless.amazonaws.com',
		database: 'analytics',
		username: 'svc',
		password: 'rs-pw',
	},
	motherduck: { token: 'md-token', database: 'analytics' },
	databricks: {
		host: 'dbc-1234abcd-5678.cloud.databricks.com',
		http_path: '/sql/1.0/warehouses/abc123',
		auth: { method: 'personal_access_token', token: 'dapi-token' },
		catalog: 'main',
	},
	athena: {
		region: 'us-east-1',
		s3_staging_dir: 's3://staging/athena/',
		auth: { method: 'static', access_key_id: 'AKIAATHENA', secret_access_key: 'athena-secret' },
	},
	s3: {
		bucket: 'lake',
		region: 'us-east-1',
		endpoint_url: 'https://minio.internal:9000',
		path_style: true,
		auth: { method: 'static', access_key_id: 'AKIAEXAMPLE', secret_access_key: 's3-secret' },
	},
	gcs: {
		bucket: 'lake',
		project_id: 'analytics-prod',
		auth: { method: 'service_account', credentials_json: '{"type":"service_account"}' },
	},
	azure_blob: {
		account_name: 'lakeaccount',
		container: 'raw',
		auth: { method: 'account_key', account_key: 'azure-key' },
	},
	wandb: { api_key: 'wandb-key', entity: 'marimo', project: 'hub' },
	huggingface: { token: 'hf-token' },
	custom_env: {
		vars: { MY_FLAG: 'on' },
		secrets: [{ name: 'MY_TOKEN', value: 'tok' }],
	},
	duckdb_http: {
		url: 'https://data.example.test/snapshots/analytics.duckdb',
		auth: { method: 'none' },
	},
	ducklake: {
		metadata: {
			type: 'duckdb',
			url: 'https://data.example.test/releases/catalog.ducklake',
			auth: { method: 'none' },
		},
		storage: {
			scheme: 's3',
			endpoint: 'https://s3.example.test',
			region: 'us-east-1',
			credentials: {
				method: 'static',
				access_key_id: 'AKIAEXAMPLE',
				secret_access_key: 's3-secret',
			},
			broker_read_locations: [{ bucket: 'warehouse', prefix: 'ducklake/data/' }],
		},
	},
};

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ValidationError } from '../../../errors';
import { createIntegrationId, createProjectId, createSessionId, UserId } from '../../../ids';
import type {
	IntegrationProbe,
	ProbeConnectRequest,
	ProbeRequestInit,
} from '../../../ports/integrations';
import { bundleIntegrations, INTEGRATIONS_DIR } from '../bundle';
import { SECRET_MARK } from '../secretFields';
import type { IntegrationDefinition, RenderInput } from '../sdk';
import { athena } from './awsQueryEngines';
import { bigquery } from './bigquery';
import { customEnv } from './customEnv';
import { databricks } from './databricks';
import {
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergSql,
} from './icebergCatalogs';
import { icebergRest } from './icebergRest';
import { defaultRegistry } from './index';
import { huggingFace, wandb } from './mlPlatforms';
import { mongodb } from './mongodb';
import { motherduck } from './motherduck';
import { mysql } from './mysql';
import { azureBlob, gcs, s3 } from './objectStores';
import { postgres } from './postgres';
import { pyspark } from './pyspark';
import { snowflake } from './snowflake';
import { sqlserver } from './sqlserver';
import { trino } from './trino';

/** Fixed session context for deterministic render comparisons. */
function input<C>(config: unknown, def: { configSchema: { parse(v: unknown): C } }, name = 'prod') {
	return {
		config: def.configSchema.parse(config),
		instanceName: name,
		projectId: createProjectId(),
		principal: { userId: UserId.parse('user-1'), email: 'ada@example.com' },
		session: { sessionId: createSessionId() },
	} satisfies RenderInput<C>;
}

function renderedCatalog(
	output: ReturnType<typeof icebergRest.render>,
	name: string,
): Record<string, unknown> {
	const file = output.yamlFiles?.[0];
	if (!file) throw new Error('Expected a rendered PyIceberg YAML fragment');
	return (file.value as { catalog: Record<string, Record<string, unknown>> }).catalog[name];
}

function renderDefinition(def: IntegrationDefinition, config: unknown, name = 'prod') {
	return def.render(input(config, def, name));
}

/** The kind's fixture with the fields a single test cares about replaced. */
function fixtureFor(def: IntegrationDefinition, overrides: object = {}): object {
	return { ...(FIXTURES[def.kind] as object), ...overrides };
}

function renderFixture(def: IntegrationDefinition, overrides: object = {}, name = 'prod') {
	return renderDefinition(def, fixtureFor(def, overrides), name);
}

function icebergPreviewPrograms(
	config: unknown,
	overrides: Partial<{
		integrationName: string;
		namespace: string[];
		table: string;
		limit: number;
	}> = {},
) {
	return icebergRest.preview?.programs({
		config: icebergRest.configSchema.parse(config),
		integration: {
			id: createIntegrationId(),
			name: overrides.integrationName ?? 'lake',
			kind: 'iceberg_rest',
			version: 1,
		},
		projectId: createProjectId(),
		principal: { userId: UserId.parse('user-1'), email: 'ada@example.com' },
		sessionId: createSessionId(),
		namespace: overrides.namespace ?? ['sales'],
		table: overrides.table ?? 'orders',
		limit: overrides.limit ?? 20,
	});
}

/** Plaintext values sitting at a kind's schema-marked secret paths. */
function secretValuesOf(config: unknown, paths: string[][]): string[] {
	const marked = new Set(paths.map((path) => path.join('.')));
	const values: string[] = [];
	const walk = (value: unknown, path: string[]): void => {
		if (typeof value === 'string') {
			if (marked.has(path.join('.'))) values.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item, [...path, '*']);
		} else if (typeof value === 'object' && value !== null) {
			for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
		}
	};
	walk(config, []);
	return values;
}

function captureValidationError(run: () => unknown): ValidationError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ValidationError);
		return error as ValidationError;
	}
	throw new Error('Expected a ValidationError');
}

const FIXTURES: Record<string, unknown> = {
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
};

describe('kind renders (golden)', () => {
	it('postgres: URL-encodes credentials and points the descriptor at env vars', () => {
		const out = postgres.render(input(FIXTURES.postgres, postgres));
		expect(out.env).toEqual({
			MARIMOHUB_PG_PROD_URL:
				'postgresql://svc%20user:p%40ss%3Aword@db.internal:5432/analytics' +
				'?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fcerts%2Fca-certificates.crt',
			MARIMOHUB_PG_PROD_HOST: 'db.internal',
			MARIMOHUB_PG_PROD_PORT: '5432',
			MARIMOHUB_PG_PROD_DATABASE: 'analytics',
			MARIMOHUB_PG_PROD_USER: 'svc user',
			MARIMOHUB_PG_PROD_PASSWORD: 'p@ss:word',
		});
		const descriptor = JSON.parse(out.files?.[0]?.content ?? '') as Record<string, unknown>;
		expect(out.files?.[0]?.path).toBe('postgres/prod.json');
		expect(descriptor.password_env).toBe('MARIMOHUB_PG_PROD_PASSWORD');
		expect(JSON.stringify(descriptor)).not.toContain('p@ss');
	});

	it.each(['2001:db8::1', '::ffff:192.0.2.128'])(
		'postgres: brackets the IPv6 literal %s in the rendered URL but not in the env/descriptor',
		(host) => {
			const config = postgres.configSchema.parse({ ...(FIXTURES.postgres as object), host });
			const out = postgres.render(input(config, postgres));
			expect(out.env?.MARIMOHUB_PG_PROD_URL).toContain(`@[${host}]:5432/`);
			// libpq's PGHOST-style fields take the bare address.
			expect(out.env?.MARIMOHUB_PG_PROD_HOST).toBe(host);
			// A bracketed authority is what makes the DSN a parseable URL at all.
			expect(new URL(out.env?.MARIMOHUB_PG_PROD_URL ?? '').hostname).toMatch(/^\[.+]$/);
			const descriptor = JSON.parse(
				out.files?.find(({ path }) => path === 'postgres/prod.json')?.content ?? '',
			) as { host: string };
			expect(descriptor.host).toBe(host);
		},
	);

	// A hand-rolled hex-group alternation rejects every IPv4-embedded form, which
	// is how a dual-stack server's address is usually written.
	it('postgres: accepts every IPv6 literal form, including an IPv4-embedded tail', () => {
		const pgHost = (host: string) =>
			postgres.configSchema.safeParse({ ...(FIXTURES.postgres as object), host }).success;
		for (const host of [
			'::ffff:192.0.2.128',
			'::ffff:0:192.0.2.128',
			'64:ff9b::192.0.2.33',
			'2001:db8:0:0:0:0:192.0.2.128',
			'1:2:3:4:5:6:7:8',
			'2001:db8::',
			'::',
		]) {
			expect(pgHost(host), host).toBe(true);
		}
		// Structurally impossible addresses: two `::`, too many groups, a stray
		// colon, a misplaced or malformed dotted quad, a zone id.
		for (const host of [
			'1::2::3',
			'1:2:3:4:5:6:7:8:9',
			'1:2:3:4:5:6:7',
			':1',
			'1:::2',
			'192.0.2.1::1',
			'::ffff:192.0.2.128.5',
			'::ffff:999.0.2.1',
			'::ffff:192.0.2',
			'::12345',
			'fe80::1%eth0',
		]) {
			expect(pgHost(host), host).toBe(false);
		}
	});

	// Without an explicit `sslrootcert` a verifying sslmode resolves against
	// `~/.postgresql/root.crt`, which the sandbox image does not ship, so such a
	// default cannot reach ANY server — publicly trusted or not.
	it('postgres: the default names a trust source, so it can verify a publicly trusted server', () => {
		const parse = (ssl: unknown) =>
			postgres.configSchema.parse({ ...(FIXTURES.postgres as object), ssl });
		const params = (config: unknown) =>
			new URL(postgres.render(input(config, postgres)).env?.MARIMOHUB_PG_PROD_URL ?? '')
				.searchParams;

		const byDefault = params(parse(undefined));
		expect(byDefault.get('sslmode')).toBe('verify-full');
		expect(byDefault.get('sslrootcert')).toBe('/etc/ssl/certs/ca-certificates.crt');
		expect(params(parse({ mode: 'verify-ca' })).get('sslrootcert')).toBe(
			'/etc/ssl/certs/ca-certificates.crt',
		);

		// Non-verifying modes ignore sslrootcert; leaving it off keeps their DSN
		// byte-identical to what a v1 boolean config rendered.
		for (const mode of ['disable', 'prefer', 'require'] as const) {
			expect(params(parse({ mode })).get('sslmode'), mode).toBe(mode);
			expect(params(parse({ mode })).get('sslrootcert'), mode).toBe(null);
		}

		const defaultDescriptor = JSON.parse(
			postgres
				.render(input(parse(undefined), postgres))
				.files?.find(({ path }) => path === 'postgres/prod.json')?.content ?? '',
		) as { ssl: Record<string, unknown> };
		// The DSN and the JSON descriptor are read by the same notebook code.
		expect(defaultDescriptor.ssl).toEqual({
			mode: 'verify-full',
			ca_path: '/etc/ssl/certs/ca-certificates.crt',
		});
		// The image's bundle is referenced, never copied into the sandbox.
		expect(
			postgres.render(input(parse(undefined), postgres)).files?.map(({ path }) => path),
		).toEqual(['postgres/prod.json']);
	});

	it('postgres: a custom CA overrides the system trust store and lands outside the workspace', () => {
		const config = postgres.configSchema.parse({
			...(FIXTURES.postgres as object),
			ssl: { mode: 'verify-full', ca_bundle: 'CA' },
		});
		const withCa = postgres.render(input(config, postgres));
		const caPath = `${INTEGRATIONS_DIR}/postgres/prod-ca.pem`;
		expect(new URL(withCa.env?.MARIMOHUB_PG_PROD_URL ?? '').searchParams.get('sslrootcert')).toBe(
			caPath,
		);
		expect(withCa.files?.find(({ path }) => path === 'postgres/prod-ca.pem')?.content).toBe('CA');
		const descriptor = JSON.parse(
			withCa.files?.find(({ path }) => path === 'postgres/prod.json')?.content ?? '',
		) as { ssl: Record<string, unknown> };
		expect(descriptor.ssl).toEqual({ mode: 'verify-full', ca_path: caPath });
	});

	// The default names Debian's bundle because the images built here are Debian,
	// but an operator may run any base image and the `local` backend runs on the
	// developer's own machine — neither is guaranteed to keep a bundle there.
	it('postgres: the trust store path is overridable without pasting a CA bundle', () => {
		const config = postgres.configSchema.parse({
			...(FIXTURES.postgres as object),
			ssl: { mode: 'verify-full', ca_path: '/etc/pki/tls/certs/ca-bundle.crt' },
		});
		const out = postgres.render(input(config, postgres));
		expect(new URL(out.env?.MARIMOHUB_PG_PROD_URL ?? '').searchParams.get('sslrootcert')).toBe(
			'/etc/pki/tls/certs/ca-bundle.crt',
		);
		const descriptor = JSON.parse(
			out.files?.find(({ path }) => path === 'postgres/prod.json')?.content ?? '',
		) as { ssl: Record<string, unknown> };
		expect(descriptor.ssl).toEqual({
			mode: 'verify-full',
			ca_path: '/etc/pki/tls/certs/ca-bundle.crt',
		});
		// Naming a path copies nothing into the session.
		expect(out.files?.map(({ path }) => path)).toEqual(['postgres/prod.json']);
	});

	it('postgres: rejects an ambiguous or unusable trust source', () => {
		const parse = (ssl: unknown) =>
			postgres.configSchema.parse({ ...(FIXTURES.postgres as object), ssl });
		expect(() =>
			postgres.validate?.(parse({ mode: 'verify-full', ca_bundle: 'CA', ca_path: '/ca.pem' })),
		).toThrow(/only one/i);
		for (const ca_path of ['ca.pem', 'relative/ca.pem', '/etc/../ca.pem']) {
			expect(() => postgres.validate?.(parse({ mode: 'verify-ca', ca_path })), ca_path).toThrow(
				ValidationError,
			);
		}
		expect(() =>
			postgres.validate?.(parse({ mode: 'verify-full', ca_path: '/etc/ssl/cert.pem' })),
		).not.toThrow();
		expect(() => postgres.validate?.(parse(undefined))).not.toThrow();
	});

	it('postgres: the v1 boolean ssl flag migrates to its exact libpq mode', () => {
		const migrate = (ssl: unknown) =>
			postgres.migrate?.({ ...(FIXTURES.postgres as object), ssl }, 1) as { ssl: unknown };
		expect(migrate(true).ssl).toEqual({ mode: 'require' });
		// v1 `false` emitted no sslmode at all, i.e. libpq's `prefer`.
		expect(migrate(false).ssl).toEqual({ mode: 'prefer' });
		expect(migrate(undefined).ssl).toEqual({ mode: 'require' });
		expect(() => postgres.configSchema.parse(migrate(true))).not.toThrow();

		// The verify-full default is for NEW integrations only: a migrated config
		// picks up neither the stricter mode nor the system trust store, so an
		// existing connection keeps working exactly as it did.
		for (const stored of [true, false, undefined]) {
			const config = postgres.configSchema.parse(migrate(stored));
			const url = new URL(
				postgres.render(input(config, postgres)).env?.MARIMOHUB_PG_PROD_URL ?? '',
			);
			expect(url.searchParams.get('sslmode'), String(stored)).toBe(
				stored === false ? 'prefer' : 'require',
			);
			expect(url.searchParams.get('sslrootcert'), String(stored)).toBe(null);
		}
	});

	it('trino: basic auth rides the URL; auth "none" passes the principal email through', () => {
		const basic = trino.render(input(FIXTURES.trino, trino));
		expect(basic.env?.MARIMOHUB_TRINO_PROD_URL).toBe(
			'trino://svc:pw@trino.internal:443/hive?http_scheme=https',
		);
		expect(basic.env?.MARIMOHUB_TRINO_PROD_AUTH_USER).toBe('svc');
		expect(basic.env?.MARIMOHUB_TRINO_PROD_PASSWORD).toBe('pw');

		const passthrough = trino.render(
			input({ host: 'trino.internal', auth: { method: 'none' } }, trino),
		);
		expect(passthrough.env?.MARIMOHUB_TRINO_PROD_USER).toBe('ada@example.com');
		expect(passthrough.env?.MARIMOHUB_TRINO_PROD_PASSWORD).toBeUndefined();
	});

	it('trino: renders documented auth, TLS, session, and client options', () => {
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			port: 8443,
			user: 'query-user',
			auth: { method: 'jwt', token: 'jwt-token' },
			tls: { verification: 'custom_ca', ca_bundle: 'CA' },
			default_catalog: 'iceberg',
			default_schema: 'analytics',
			source: 'marimohub',
			session_properties: { query_max_run_time: '1h' },
			roles: { iceberg: 'analyst' },
			client_tags: [{ value: 'notebook' }],
			http_headers: [{ name: 'X-Trace', value: 'trace-secret' }],
			extra_credentials: [{ name: 'lake.password', value: 'extra-secret' }],
			timezone: 'America/New_York',
			encoding: [{ value: 'json+zstd' }, { value: 'json' }],
			max_attempts: 5,
			request_timeout_seconds: 30,
			heartbeat_interval_seconds: 10,
			isolation_level: 'REPEATABLE_READ',
			legacy_primitive_types: true,
			legacy_prepared_statements: false,
		});
		const out = trino.render(input(config, trino));
		const url = new URL(out.env?.MARIMOHUB_TRINO_PROD_URL ?? '');
		expect(url.searchParams.get('access_token')).toBe('jwt-token');
		expect(JSON.parse(url.searchParams.get('session_properties') ?? '{}')).toEqual({
			query_max_run_time: '1h',
		});
		expect(JSON.parse(url.searchParams.get('roles') ?? '{}')).toEqual({ iceberg: 'analyst' });
		expect(JSON.parse(url.searchParams.get('verify') ?? 'null')).toBe(
			`${INTEGRATIONS_DIR}/trino/prod-ca.pem`,
		);
		expect(out.env).toMatchObject({
			MARIMOHUB_TRINO_PROD_TOKEN: 'jwt-token',
			MARIMOHUB_TRINO_PROD_HTTP_HEADER_0: 'trace-secret',
			MARIMOHUB_TRINO_PROD_EXTRA_CREDENTIAL_0: 'extra-secret',
		});
		const descriptor = JSON.parse(
			out.files?.find(({ path }) => path === 'trino/prod.json')?.content ?? '',
		) as Record<string, unknown>;
		expect(descriptor).toMatchObject({
			http_scheme: 'https',
			user: 'query-user',
			timezone: 'America/New_York',
			encoding: ['json+zstd', 'json'],
			max_attempts: 5,
			request_timeout: 30,
			heartbeat_interval: 10,
			isolation_level: 'REPEATABLE_READ',
		});
		expect(JSON.stringify(descriptor)).not.toContain('jwt-token');
		expect(out.files?.map(({ path }) => path)).toContain('trino/prod-ca.pem');
	});

	it('trino: certificate auth material stays outside the workspace', () => {
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: {
				method: 'certificate',
				client_certificate: 'CERT',
				client_key: 'KEY',
			},
		});
		const out = trino.render(input(config, trino));
		expect(out.files?.map(({ path }) => path)).toEqual([
			'trino/prod-client.crt',
			'trino/prod-client.key',
			'trino/prod.json',
		]);
		const url = new URL(out.env?.MARIMOHUB_TRINO_PROD_URL ?? '');
		expect(url.searchParams.get('cert')).toBe(`${INTEGRATIONS_DIR}/trino/prod-client.crt`);
		expect(url.searchParams.get('key')).toBe(`${INTEGRATIONS_DIR}/trino/prod-client.key`);
	});

	it('trino: renders Kerberos and validates GSSAPI client options', () => {
		const kerberos = trino.render(
			input(
				{
					host: 'trino.internal',
					auth: {
						method: 'kerberos',
						krb5_config: '[libdefaults]\n default_realm = EXAMPLE.COM',
						service_name: 'trino',
						hostname_override: 'trino.example.com',
						principal: 'ada@EXAMPLE.COM',
						force_preemptive: true,
						delegate: true,
					},
					tls: { verification: 'custom_ca', ca_bundle: 'CA' },
				},
				trino,
			),
		);
		const descriptor = JSON.parse(
			kerberos.files?.find(({ path }) => path === 'trino/prod.json')?.content ?? '',
		) as { auth: Record<string, unknown> };
		expect(descriptor.auth).toMatchObject({
			method: 'kerberos',
			config: `${INTEGRATIONS_DIR}/trino/prod-krb5.conf`,
			service_name: 'trino',
			hostname_override: 'trino.example.com',
			mutual_authentication: 'required',
			force_preemptive: true,
			principal: 'ada@EXAMPLE.COM',
			delegate: true,
			ca_bundle: `${INTEGRATIONS_DIR}/trino/prod-ca.pem`,
		});
		expect(kerberos.files?.map(({ path }) => path)).toContain('trino/prod-krb5.conf');

		const gssapi = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'gssapi', service_name: 'trino' },
		});
		expect(() => trino.validate?.(gssapi)).toThrow(/hostname_override/);
	});

	it('trino rejects insecure auth and duplicate or reserved extensibility fields', () => {
		const parse = (patch: Record<string, unknown>) =>
			trino.configSchema.parse({
				host: 'trino.internal',
				auth: { method: 'none' },
				...patch,
			});
		expect(() =>
			trino.validate?.(
				parse({
					http_scheme: 'http',
					auth: { method: 'jwt', token: 'token' },
				}),
			),
		).toThrow(/HTTPS/);
		expect(() => parse({ client_tags: [{ value: 'batch' }, { value: 'batch' }] })).toThrow(
			/Duplicate client tag/,
		);
		expect(() =>
			trino.validate?.(
				parse({
					http_headers: [
						{ name: 'X-Trace', value: 'one' },
						{ name: 'x-trace', value: 'two' },
					],
				}),
			),
		).toThrow(/Duplicate/);
		expect(() =>
			trino.validate?.(parse({ http_headers: [{ name: 'Authorization', value: 'plain-secret' }] })),
		).toThrow(/reserved or managed/);
		expect(() =>
			trino.validate?.(parse({ http_headers: [{ name: 'X-Trino-User', value: 'other' }] })),
		).toThrow(/reserved or managed/);
		expect(() =>
			trino.validate?.(parse({ encoding: [{ value: 'json' }, { value: 'json' }] })),
		).toThrow(/Duplicate spooling encoding/);
	});

	it('trino publishes client-tag value uniqueness', () => {
		const properties = defaultRegistry().describe('trino').json_schema.properties as Record<
			string,
			Record<string, unknown>
		>;
		expect(properties.client_tags['x-unique-by']).toBe('value');
	});

	it('trino rejects invalid header names and line breaks before rendering', () => {
		expect(
			trino.configSchema.safeParse({
				...(FIXTURES.trino as object),
				http_headers: [{ name: 'Bad Header', value: 'value' }],
			}).success,
		).toBe(false);
		const config = trino.configSchema.parse({
			...(FIXTURES.trino as object),
			http_headers: [{ name: 'X-Trace', value: 'safe\r\nInjected: true' }],
		});
		expect(() => trino.render(input(config, trino))).toThrow(/line break/);
	});

	it('pyspark: renders a Spark Connect URL and SparkSession config', () => {
		const config = pyspark.configSchema.parse({
			host: 'spark.internal',
			port: 15003,
			auth: { method: 'token', token: 'spark-token' },
			user_id: 'ada',
			user_agent: 'marimohub',
			app_name: 'analytics',
			metadata: [{ name: 'x-project', value: 'project-value' }],
			spark_config: { 'spark.sql.session.timeZone': 'UTC' },
			secret_spark_config: [{ name: 'spark.hadoop.fs.s3a.secret.key', value: 's3-secret' }],
		});
		const out = pyspark.render(input(config, pyspark));
		const remote = out.env?.MARIMOHUB_PYSPARK_PROD_REMOTE ?? '';
		expect(remote).toContain('sc://spark.internal:15003/;use_ssl=true');
		expect(remote).toContain('token=spark-token');
		expect(remote).toContain('user_id=ada');
		expect(remote).toContain('x-project=project-value');
		expect(out.env?.MARIMOHUB_PYSPARK_PROD_TOKEN).toBe('spark-token');
		const descriptor = JSON.parse(out.files?.[0]?.content ?? '') as Record<string, unknown>;
		expect(descriptor).toMatchObject({
			remote_env: 'MARIMOHUB_PYSPARK_PROD_REMOTE',
			app_name: 'analytics',
			spark_config: {
				'spark.sql.session.timeZone': 'UTC',
				'spark.hadoop.fs.s3a.secret.key': 's3-secret',
			},
		});
	});

	it('pyspark rejects insecure tokens, reserved metadata, and plaintext credential config', () => {
		const parse = (patch: Record<string, unknown>) =>
			pyspark.configSchema.parse({
				host: 'spark.internal',
				...patch,
			});
		expect(() =>
			pyspark.validate?.(parse({ use_ssl: false, auth: { method: 'token', token: 'secret' } })),
		).toThrow(/requires TLS/);
		expect(() =>
			pyspark.validate?.(parse({ metadata: [{ name: 'token', value: 'secret' }] })),
		).toThrow(/typed field/);
		expect(() =>
			pyspark.validate?.(
				parse({ spark_config: { 'spark.hadoop.fs.s3a.secret.key': 'plain-secret' } }),
			),
		).toThrow(/secret Spark config/);
		// Spark property names use `_` as a word separator as freely as `.`/`-`.
		for (const key of [
			'api_key',
			'spark.myservice.access_key',
			'spark.myservice.private_key',
			'spark.myservice.account_key',
		]) {
			expect(
				() => pyspark.validate?.(parse({ spark_config: { [key]: 'plain-secret' } })),
				key,
			).toThrow(/secret Spark config/);
		}
		expect(() =>
			pyspark.validate?.(parse({ spark_config: { 'spark.sql.shuffle.partitions': '8' } })),
		).not.toThrow();
	});

	it('iceberg_rest: emits a PyIceberg catalog block for load_catalog(name)', () => {
		const out = icebergRest.render(input(FIXTURES.iceberg_rest, icebergRest, 'lake-house'));
		expect(out.env).toEqual({ PYICEBERG_HOME: INTEGRATIONS_DIR });
		const catalog = renderedCatalog(out, 'lake-house');
		expect(catalog).toMatchObject({
			type: 'rest',
			uri: 'https://catalog.internal/api/catalog',
			warehouse: 'wh',
			auth: {
				type: 'oauth2',
				oauth2: {
					client_id: 'cid',
					client_secret: 'csec',
					token_url: 'https://idp.internal/token',
					scope: 'catalog',
				},
			},
			's3.region': 'us-east-1',
			'header.X-Iceberg-Access-Delegation': 'vended-credentials',
			'snapshot-loading-mode': 'all',
			'rest-metrics-reporting-enabled': 'true',
			'scan-planning-mode': 'client',
		});
		const descriptor = JSON.parse(out.files?.[0]?.content ?? '') as Record<string, unknown>;
		expect(descriptor.catalog_name).toBe('lake-house');
		expect(JSON.stringify(descriptor)).not.toContain('csec');
	});

	it('iceberg_rest binds SQL values and formats identifiers', () => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.example.com/api',
			warehouse: "lake'house",
			auth: { method: 'bearer_token', token: "tok'en" },
			storage: {
				scheme: 's3',
				endpoint: 'https://objects.example.com',
				region: 'us-east-1',
				credentials: {
					method: 'static',
					access_key_id: 'access-key',
					secret_access_key: 'secret-key',
				},
				broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
			},
			access_delegation: 'none',
		});
		const programs = icebergPreviewPrograms(config, { namespace: ['sales"archive'] });

		expect(programs?.duckdbWasm).toMatchObject({ requires: ['iceberg-http'] });
		const attach = programs?.duckdbWasm?.setup.at(-1);
		expect(attach?.text).toContain("ATTACH 'lake''house'");
		expect(attach?.text).toContain('ENDPOINT ?');
		expect(attach?.text).toContain('WAREHOUSE ?');
		expect(attach?.text).toContain('TOKEN ?');
		expect(attach?.text).not.toContain("tok'en");
		expect(attach?.params).toEqual([
			'https://catalog.example.com/api',
			"lake'house",
			'marimohub-parent-broker',
			'none',
		]);
		expect(programs?.duckdbWasm?.httpAccess).toMatchObject({
			catalog: { authorization: "Bearer tok'en" },
			storage: {
				credentials: { method: 'static', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
			},
		});
		expect(programs?.duckdbWasm?.query).toEqual({
			text: expect.stringContaining('"sales""archive"."orders" LIMIT ?'),
			params: [20],
		});
		expect(programs?.python?.maxRows).toBe(20);
		expect(programs?.python?.input).toMatchObject({
			integration_name: 'lake',
			namespace: ['sales"archive'],
			table: 'orders',
			limit: 20,
		});
	});

	it('iceberg_rest derives query availability from its complete readiness result', () => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.example.com/api',
			auth: { method: 'none' },
			access_delegation: 'none',
			storage: {
				scheme: 's3',
				endpoint: 'https://objects.example.com',
				anonymous: true,
				broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
			},
		});
		const readyChecks = icebergRest.query?.readiness?.(config) ?? [];
		expect(readyChecks.length).toBeGreaterThan(0);
		expect(readyChecks.every((check) => check.ready)).toBe(true);
		expect(icebergRest.query?.available(config)).toEqual({ ok: true });

		const blocked = {
			...config,
			headers: { 'X-Custom': 'value' },
			extra_properties: { 'rest.custom-option': 'true' },
		};
		const blockedChecks = icebergRest.query?.readiness?.(blocked) ?? [];
		expect(blockedChecks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: 'Remove custom headers', field: 'headers', ready: false }),
				expect.objectContaining({
					label: 'Remove extra properties',
					field: 'extra_properties',
					ready: false,
				}),
			]),
		);
		expect(icebergRest.query?.available(blocked)).toEqual({
			ok: false,
			reason: blockedChecks.find((check) => !check.ready)?.reason,
		});
	});

	it('iceberg_rest keeps every remote value bound when optional warehouse is absent', () => {
		const uri = "https://catalog.example.com/a'b";
		const programs = icebergPreviewPrograms(
			{
				uri,
				auth: { method: 'none' },
				access_delegation: 'none',
				storage: {
					scheme: 's3',
					endpoint: 'https://objects.example.com',
					anonymous: true,
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
				},
			},
			{
				integrationName: "catalog'name",
				namespace: ['select', 'two.parts'],
				table: 'order"items',
				limit: 1,
			},
		);

		const attach = programs?.duckdbWasm?.setup.at(-1);
		expect(attach).toEqual({
			text: expect.stringContaining("ATTACH 'catalog''name'"),
			params: [uri, 'marimohub-parent-broker', 'none'],
		});
		expect(attach?.text).not.toContain(uri);
		expect(attach?.text).not.toContain('WAREHOUSE');
		expect(programs?.duckdbWasm?.query).toEqual({
			text: expect.stringContaining('"select"."two.parts"."order""items" LIMIT ?'),
			params: [1],
		});
	});

	it.each([
		{ bucket: 'warehouse/private', prefix: 'tables' },
		{ bucket: 'warehouse\\private', prefix: 'tables' },
		{ bucket: 'warehouse', prefix: 'allowed\\private' },
		{ bucket: '.', prefix: 'tables' },
		{ bucket: 'warehouse', prefix: '/' },
		{ bucket: 'warehouse', prefix: 'allowed/../private' },
	])('iceberg_rest rejects invalid broker read location $bucket/$prefix', (location) => {
		expect(
			icebergRest.configSchema.safeParse({
				...(FIXTURES.iceberg_rest as object),
				access_delegation: 'none',
				storage: {
					scheme: 's3',
					endpoint: 'https://objects.example.com',
					anonymous: true,
					broker_read_locations: [location],
				},
			}).success,
		).toBe(false);
	});

	it.each([icebergSql, icebergHive, icebergGlue, icebergDynamoDb, icebergBigQuery])(
		'$kind rejects REST-only broker read locations',
		(definition) => {
			expect(
				definition.configSchema.safeParse({
					...fixtureFor(definition),
					storage: {
						scheme: 's3',
						broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
				}).success,
			).toBe(false);
		},
	);

	it('iceberg_rest routes query-bearing catalog URLs to the sandbox', () => {
		const config = icebergRest.configSchema.parse({
			...(FIXTURES.iceberg_rest as object),
			uri: 'https://catalog.example.com/api?tenant=allowed',
			auth: { method: 'none' },
			extra_properties: {},
			access_delegation: 'none',
			storage: {
				scheme: 's3',
				endpoint: 'https://objects.example.com',
				anonymous: true,
				broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
			},
		});

		expect(icebergRest.preview?.available(config)).toEqual({
			ok: true,
			programs: { python: true },
		});
		expect(icebergRest.query?.available(config)).toEqual({
			ok: false,
			reason: 'catalog URLs with query parameters are not supported by DuckDB-Wasm preview',
		});
	});

	it.each(['%2F', '%5C'])(
		'iceberg_rest routes catalog URLs containing %s to the sandbox',
		(separator) => {
			const config = icebergRest.configSchema.parse({
				...(FIXTURES.iceberg_rest as object),
				uri: `https://catalog.example.com/iceberg${separator}tenant`,
				auth: { method: 'none' },
				extra_properties: {},
				access_delegation: 'none',
				storage: {
					scheme: 's3',
					endpoint: 'https://objects.example.com',
					anonymous: true,
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
				},
			});

			expect(icebergRest.preview?.available(config)).toEqual({
				ok: true,
				programs: { python: true },
			});
			expect(icebergRest.query?.available(config)).toEqual({
				ok: false,
				reason:
					'catalog URLs with encoded path separators are not supported by DuckDB-Wasm preview',
			});
		},
	);

	it.each([
		['basic auth', { auth: { method: 'basic', username: 'user', password: 'password' } }],
		[
			'OAuth2 auth',
			{
				auth: {
					method: 'oauth2_client_credentials',
					token_endpoint: 'https://identity.example.com/token',
					client_id: 'client',
					client_secret: 'secret',
				},
			},
		],
		['SigV4 auth', { auth: { method: 'sigv4', region: 'us-east-1' } }],
		['Google auth', { auth: { method: 'google' } }],
		['Entra auth', { auth: { method: 'entra' } }],
		['custom TLS', { tls: { ca_bundle: 'CA' } }],
		['custom headers', { headers: { 'X-Trace': 'trace' } }],
		['extra properties', { extra_properties: { 'rest.custom-option': 'true' } }],
		['explicit storage', { storage: { scheme: 's3', region: 'us-east-1' } }],
		[
			'advanced S3 client options',
			{
				access_delegation: 'none',
				storage: {
					scheme: 's3',
					endpoint: 'https://objects.example.com',
					anonymous: true,
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					role_arn: 'arn:aws:iam::123456789012:role/reader',
				},
			},
		],
		['runtime worker count', { runtime: { max_workers: 2 } }],
		['runtime snapshot compatibility', { runtime: { legacy_current_snapshot_id: false } }],
		['runtime timestamp downcast', { runtime: { downcast_ns_timestamp_to_us_on_write: false } }],
		['runtime Arrow types', { runtime: { pyarrow_use_large_types_on_read: false } }],
		['snapshot loading mode', { rest: { snapshot_loading_mode: 'refs' } }],
		['metrics reporting', { rest: { metrics_reporting_enabled: false } }],
		['REST page size', { rest: { page_size: 10 } }],
		['view endpoints', { rest: { view_endpoints_supported: true } }],
		['server scan planning', { rest: { scan_planning_mode: 'server' } }],
		['namespace separator', { rest: { namespace_separator: '.' } }],
		['table cache expiration', { rest: { table_cache_expire_after_write_ms: 0 } }],
		['table cache size', { rest: { table_cache_max_entries: 1 } }],
	] as const)('iceberg_rest routes %s previews only to the sandbox', (_name, patch) => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.example.com',
			auth: { method: 'none' },
			...patch,
		});

		expect(icebergRest.preview?.available(config)).toEqual({
			ok: true,
			programs: { python: true },
		});
		expect(icebergPreviewPrograms(config)).toEqual({
			python: expect.objectContaining({ maxRows: 20 }),
		});
	});

	it('iceberg_rest omits the DuckDB program for unsupported options', () => {
		const config = icebergRest.configSchema.parse(FIXTURES.iceberg_rest);
		expect(icebergRest.preview?.available(config)).toEqual({
			ok: true,
			programs: { python: true },
		});
	});

	it('iceberg_rest: rejects empty extra-property keys', () => {
		const config = icebergRest.configSchema.parse({
			...(FIXTURES.iceberg_rest as Record<string, unknown>),
			extra_properties: { '': 'x' },
		});
		expect(() => icebergRest.validate?.(config)).toThrow(ValidationError);
	});

	it('iceberg_rest: the extra-properties escape hatch cannot smuggle credentials', () => {
		const base = FIXTURES.iceberg_rest as Record<string, unknown>;
		const withExtra = (extra_properties: Record<string, string>) =>
			icebergRest.configSchema.parse({ ...base, extra_properties });
		// Extra properties are stored/displayed as plain text, so credential-shaped
		// keys must go through the typed (zSecret) auth fields instead.
		expect(() => icebergRest.validate?.(withExtra({ token: 'x' }))).toThrow(/typed fields/);
		expect(() => icebergRest.validate?.(withExtra({ 's3.secret-access-key': 'x' }))).toThrow(
			/credential-bearing/,
		);
		expect(() => icebergRest.validate?.(withExtra({ 's3.access-key-id': 'x' }))).toThrow(
			/credential-bearing/,
		);
		expect(() => icebergRest.validate?.(withExtra({ uri: 'http://evil' }))).toThrow(/typed fields/);
		expect(() => icebergRest.validate?.(withExtra({ 'rest.sigv4-enabled': 'true' }))).not.toThrow();
		expect(() => icebergRest.validate?.(withExtra({ 'rest.custom-option': 'true' }))).not.toThrow();
	});

	it('iceberg_rest rejects additional credential-shaped property aliases', () => {
		const base = FIXTURES.iceberg_rest as Record<string, unknown>;
		const withExtra = (extra_properties: Record<string, string>) =>
			icebergRest.configSchema.parse({ ...base, extra_properties });
		for (const key of ['header.authorization', 'tls.private-key', 'oauth.client-auth']) {
			expect(() => icebergRest.validate?.(withExtra({ [key]: 'secret' })), key).toThrow(
				/credential-bearing/,
			);
		}
	});

	it('iceberg_rest rejects header injection and credential-shaped custom headers', () => {
		const injected = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'none' },
			headers: { 'X-Trace': 'safe\r\nAuthorization: Bearer injected' },
		});
		expect(() => icebergRest.render(input(injected, icebergRest))).toThrow(ValidationError);

		const credential = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'none' },
			headers: { Authorization: 'Bearer plain-text-secret' },
		});
		expect(() => icebergRest.validate?.(credential)).toThrow(ValidationError);
	});

	it('iceberg_rest rejects credentials and TLS material over cleartext http', () => {
		const parse = (patch: Record<string, unknown>) =>
			icebergRest.configSchema.parse({
				uri: 'http://catalog.internal',
				auth: { method: 'none' },
				...patch,
			});
		expect(() =>
			icebergRest.validate?.(parse({ auth: { method: 'bearer_token', token: 'tok' } })),
		).toThrow(/requires an https:\/\/ URI/);
		expect(() =>
			icebergRest.validate?.(parse({ auth: { method: 'basic', username: 'u', password: 'p' } })),
		).toThrow(/requires an https:\/\/ URI/);
		expect(() => icebergRest.validate?.(parse({ tls: { ca_bundle: 'CA' } }))).toThrow(
			/no effect on an http:\/\/ catalog URI/,
		);
		expect(() =>
			icebergRest.validate?.(
				icebergRest.configSchema.parse({
					uri: 'https://catalog.internal',
					auth: {
						method: 'oauth2_client_credentials',
						token_endpoint: 'http://idp.internal/token',
						client_id: 'cid',
						client_secret: 'csec',
					},
				}),
			),
		).toThrow(/token endpoint must be https/);

		// Unauthenticated http stays legal, and the opt-in escape hatch unblocks
		// the rest for local development.
		expect(() => icebergRest.validate?.(parse({}))).not.toThrow();
		expect(() =>
			icebergRest.validate?.(
				parse({
					allow_insecure_transport: true,
					auth: { method: 'bearer_token', token: 'tok' },
				}),
			),
		).not.toThrow();
		expect(() =>
			icebergRest.validate?.(icebergRest.configSchema.parse(FIXTURES.iceberg_rest)),
		).not.toThrow();
	});

	it('iceberg_rest migrates the v1 delegation and obsolete S3 path-style fields', () => {
		const migrated = icebergRest.migrate?.(
			{
				...(FIXTURES.iceberg_rest as Record<string, unknown>),
				vended_credentials: false,
				storage: {
					scheme: 's3',
					region: 'us-east-1',
					path_style_access: true,
				},
			},
			1,
		) as Record<string, unknown>;
		expect(migrated.access_delegation).toBe('none');
		expect(migrated).not.toHaveProperty('vended_credentials');
		expect(migrated.storage).not.toHaveProperty('path_style_access');
		expect(() => icebergRest.configSchema.parse(migrated)).not.toThrow();
	});

	it.each([
		['bearer_token', { method: 'bearer_token', token: 'token' }, { token: 'token' }],
		[
			'basic',
			{ method: 'basic', username: 'user', password: 'password' },
			{ auth: { type: 'basic', basic: { username: 'user', password: 'password' } } },
		],
		[
			'sigv4',
			{ method: 'sigv4', region: 'us-east-1', signing_name: 'glue' },
			{
				'rest.sigv4-enabled': 'true',
				'rest.signing-region': 'us-east-1',
				'rest.signing-name': 'glue',
			},
		],
		[
			'google',
			{ method: 'google', scopes: 'scope-a, scope-b' },
			{ auth: { type: 'google', google: { scopes: ['scope-a', 'scope-b'] } } },
		],
		[
			'entra',
			{
				method: 'entra',
				scopes: 'https://storage.azure.com/.default',
				managed_identity_client_id: 'managed-client',
			},
			{
				auth: {
					type: 'entra',
					entra: {
						scopes: ['https://storage.azure.com/.default'],
						managed_identity_client_id: 'managed-client',
					},
				},
			},
		],
	] as const)('iceberg_rest renders %s catalog authentication', (_method, auth, expected) => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth,
		});
		expect(renderedCatalog(icebergRest.render(input(config, icebergRest)), 'prod')).toMatchObject(
			expected,
		);
	});

	it('iceberg_rest writes mTLS material outside the workspace and points PyIceberg at it', () => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'none' },
			tls: {
				ca_bundle: 'CA',
				client_certificate: 'CERT',
				client_key: 'KEY',
			},
		});
		const out = icebergRest.render(input(config, icebergRest));
		expect(renderedCatalog(out, 'prod').ssl).toEqual({
			cabundle: `${INTEGRATIONS_DIR}/iceberg/prod-ca.pem`,
			client: {
				cert: `${INTEGRATIONS_DIR}/iceberg/prod-client.crt`,
				key: `${INTEGRATIONS_DIR}/iceberg/prod-client.key`,
			},
		});
		expect(out.files?.map(({ path }) => path)).toEqual([
			'iceberg/prod-ca.pem',
			'iceberg/prod-client.crt',
			'iceberg/prod-client.key',
			'iceberg/prod.json',
		]);
	});

	it('iceberg_rest writes Google service-account credentials outside the workspace', () => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: {
				method: 'google',
				scopes: 'scope-a',
				credentials_json: '{"type":"service_account"}',
			},
		});
		const out = icebergRest.render(input(config, icebergRest));
		expect(renderedCatalog(out, 'prod').auth).toEqual({
			type: 'google',
			google: {
				scopes: ['scope-a'],
				credentials_path: `${INTEGRATIONS_DIR}/iceberg/prod-google-service-account.json`,
			},
		});
		expect(
			out.files?.find(({ path }) => path.endsWith('google-service-account.json'))?.content,
		).toBe('{"type":"service_account"}');
	});

	it('all production PyIceberg catalog types emit exact catalog properties', () => {
		const cases = [
			[icebergSql, FIXTURES.iceberg_sql, 'sql', { init_catalog_tables: 'true' }],
			[icebergHive, FIXTURES.iceberg_hive, 'hive', { 'hive.kerberos-service-name': 'hive' }],
			[icebergGlue, FIXTURES.iceberg_glue, 'glue', { 'glue.region': 'us-east-1' }],
			[icebergDynamoDb, FIXTURES.iceberg_dynamodb, 'dynamodb', { 'table-name': 'iceberg-catalog' }],
			[
				icebergBigQuery,
				FIXTURES.iceberg_bigquery,
				'bigquery',
				{ 'gcp.bigquery.project-id': 'analytics-prod' },
			],
		] as const;
		for (const [def, fixture, type, expected] of cases) {
			const out = renderDefinition(def, fixture, type);
			const properties = renderedCatalog(out, type);
			expect(properties.type).toBe(type);
			expect(properties).toMatchObject(expected);
		}
	});

	it.each([
		['iceberg_glue', icebergGlue],
		['iceberg_dynamodb', icebergDynamoDb],
	] as const)(
		'%s renders shared client AWS credentials for the catalog and S3 FileIO',
		(_kind, def) => {
			const fixture = FIXTURES[def.kind] as Record<string, unknown>;
			const config = def.configSchema.parse({
				...fixture,
				unified_credentials: {
					method: 'role',
					region: 'us-west-2',
					role_arn: 'arn:aws:iam::123456789012:role/iceberg',
					role_session_name: 'notebook',
				},
			});
			const catalog = renderedCatalog(renderDefinition(def, config), 'prod');
			expect(catalog).toMatchObject({
				'client.region': 'us-west-2',
				'client.role-arn': 'arn:aws:iam::123456789012:role/iceberg',
				'client.role-session-name': 'notebook',
			});
		},
	);

	it.each([
		['iceberg_glue', icebergGlue, 'glue'],
		['iceberg_dynamodb', icebergDynamoDb, 'dynamodb'],
	] as const)(
		'%s renders catalog-specific and shared AWS credentials independently',
		(_kind, def, prefix) => {
			const serviceCredentials = {
				method: 'static',
				access_key_id: 'SERVICE_KEY',
				secret_access_key: 'service-secret',
			};
			const clientCredentials = {
				method: 'static',
				access_key_id: 'CLIENT_KEY',
				secret_access_key: 'client-secret',
			};
			const cases = [
				[{ method: 'ambient' }, { method: 'none' }, {}],
				[
					serviceCredentials,
					{ method: 'none' },
					{
						[`${prefix}.access-key-id`]: 'SERVICE_KEY',
						[`${prefix}.secret-access-key`]: 'service-secret',
					},
				],
				[
					{ method: 'ambient' },
					clientCredentials,
					{
						'client.access-key-id': 'CLIENT_KEY',
						'client.secret-access-key': 'client-secret',
					},
				],
				[
					serviceCredentials,
					clientCredentials,
					{
						[`${prefix}.access-key-id`]: 'SERVICE_KEY',
						[`${prefix}.secret-access-key`]: 'service-secret',
						'client.access-key-id': 'CLIENT_KEY',
						'client.secret-access-key': 'client-secret',
					},
				],
			] as const;
			for (const [credentials, unifiedCredentials, expected] of cases) {
				const config = def.configSchema.parse({
					credentials,
					unified_credentials: unifiedCredentials,
				});
				const catalog = renderedCatalog(renderDefinition(def, config), 'prod');
				for (const key of [
					`${prefix}.access-key-id`,
					`${prefix}.secret-access-key`,
					'client.access-key-id',
					'client.secret-access-key',
				]) {
					expect(catalog[key], key).toBe(expected[key as keyof typeof expected]);
				}
			}
		},
	);

	it('renders catalog and process-wide PyIceberg runtime settings at the correct levels', () => {
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'none' },
			runtime: {
				max_workers: 8,
				legacy_current_snapshot_id: true,
				downcast_ns_timestamp_to_us_on_write: true,
				pyarrow_use_large_types_on_read: false,
			},
		});
		const fragment = icebergRest.render(input(config, icebergRest)).yamlFiles?.[0]?.value;
		expect(fragment).toMatchObject({
			'max-workers': '8',
			'legacy-current-snapshot-id': 'true',
			'downcast-ns-timestamp-to-us-on-write': 'true',
			catalog: {
				prod: {
					'pyarrow.use-large-types-on-read': 'false',
				},
			},
		});
	});

	it('iceberg_bigquery rejects disabling its required legacy snapshot compatibility', () => {
		const config = icebergBigQuery.configSchema.parse({
			...(FIXTURES.iceberg_bigquery as Record<string, unknown>),
			runtime: { legacy_current_snapshot_id: false },
		});
		expect(() => icebergBigQuery.validate?.(config)).toThrow(/BigQuery requires/);
	});

	it.each([
		[
			's3',
			{
				scheme: 's3',
				region: 'us-west-2',
				endpoint: 'https://s3.internal',
				credentials: {
					method: 'static',
					access_key_id: 'access',
					secret_access_key: 'secret',
					session_token: 'session',
				},
				role_arn: 'arn:aws:iam::123456789012:role/iceberg',
				role_session_name: 'notebook',
				resolve_region: true,
				force_virtual_addressing: true,
			},
			{
				's3.access-key-id': 'access',
				's3.secret-access-key': 'secret',
				's3.session-token': 'session',
				's3.role-arn': 'arn:aws:iam::123456789012:role/iceberg',
				's3.force-virtual-addressing': 'true',
			},
		],
		[
			'gcs',
			{
				scheme: 'gcs',
				project_id: 'analytics',
				auth: { method: 'oauth_token', token: 'gcs-token', token_expires_at_ms: 2_000_000_000_000 },
				requester_pays: true,
				service_host: 'https://storage.internal',
			},
			{
				'gcs.project-id': 'analytics',
				'gcs.oauth2.token': 'gcs-token',
				'gcs.requester-pays': 'true',
			},
		],
		[
			'adls',
			{
				scheme: 'adls',
				account_name: 'lake',
				auth: {
					method: 'service_principal',
					tenant_id: 'tenant',
					client_id: 'client',
					client_secret: 'secret',
				},
			},
			{
				'adls.account-name': 'lake',
				'adls.tenant-id': 'tenant',
				'adls.client-id': 'client',
				'adls.client-secret': 'secret',
			},
		],
		[
			'hdfs',
			{ scheme: 'hdfs', host: 'namenode.internal', port: 9000, user: 'iceberg' },
			{ 'hdfs.host': 'namenode.internal', 'hdfs.port': '9000', 'hdfs.user': 'iceberg' },
		],
		[
			'hugging_face',
			{ scheme: 'hugging_face', endpoint: 'https://huggingface.co', token: 'hf_secret' },
			{ 'hf.endpoint': 'https://huggingface.co', 'hf.token': 'hf_secret' },
		],
	] as const)(
		'iceberg_rest renders documented %s FileIO properties',
		(_name, storage, expected) => {
			const config = icebergRest.configSchema.parse({
				uri: 'https://catalog.internal',
				auth: { method: 'none' },
				storage,
			});
			const out = icebergRest.render(input(config, icebergRest));
			const properties = renderedCatalog(out, 'prod');
			expect(properties).toMatchObject(expected);
		},
	);

	it('custom_env: merges plain + secret vars; validate blocks reserved and duplicate names', () => {
		const out = customEnv.render(input(FIXTURES.custom_env, customEnv));
		expect(out.env).toEqual({ MY_FLAG: 'on', MY_TOKEN: 'tok' });

		const reserved = customEnv.configSchema.parse({ vars: { LD_PRELOAD: 'x' } });
		expect(() => customEnv.validate?.(reserved)).toThrow(ValidationError);
		const duplicate = customEnv.configSchema.parse({
			vars: { SAME: 'a' },
			secrets: [{ name: 'SAME', value: 'b' }],
		});
		expect(() => customEnv.validate?.(duplicate)).toThrow(/defined twice/);
		expect(() =>
			customEnv.configSchema.parse({
				secret_bundles: [
					{ name: 'APP_CONFIG', value: '{}' },
					{ name: 'APP_CONFIG', value: '{}' },
				],
			}),
		).toThrow(/Duplicate JSON secret bundle name/);
	});

	it('custom_env: validates names and collisions after secret JSON bundles resolve', () => {
		const validateAndRender = (raw: unknown) => {
			const config = customEnv.configSchema.parse(raw);
			customEnv.validate?.(config);
			return customEnv.render(input(config, customEnv));
		};
		const out = validateAndRender({
			vars: { PLAIN: 'yes' },
			secret_bundles: [
				{
					name: 'APP_CONFIG',
					prefix: 'APP_',
					value: '{"TOKEN":"secret","RETRIES":3,"ENABLED":true}',
				},
			],
		});
		expect(out.env).toEqual({
			PLAIN: 'yes',
			APP_TOKEN: 'secret',
			APP_RETRIES: '3',
			APP_ENABLED: 'true',
		});
		expect(() =>
			validateAndRender({
				vars: { APP_TOKEN: 'plain' },
				secret_bundles: [{ name: 'APP_CONFIG', prefix: 'APP_', value: '{"TOKEN":"secret"}' }],
			}),
		).toThrow(/defined more than once/);
		expect(() =>
			validateAndRender({
				secret_bundles: [{ name: 'BAD_KEYS', value: '{"bad-name":"x"}' }],
			}),
		).toThrow(ValidationError);
	});

	it('every kind renders deterministically (same input → identical output)', () => {
		for (const def of defaultRegistry().list()) {
			const fixture = FIXTURES[def.kind];
			const renderInput = input(fixture, def);
			expect(JSON.stringify(def.render(renderInput)), def.kind).toBe(
				JSON.stringify(def.render(renderInput)),
			);
		}
	});

	it('data-source kinds declare their pip requirements; custom_env needs none', () => {
		const byKind = Object.fromEntries(
			defaultRegistry()
				.describeAll()
				.map((d) => [d.kind, d.requirements]),
		);
		expect(byKind.postgres.length).toBeGreaterThan(0);
		expect(byKind.trino.length).toBeGreaterThan(0);
		expect(byKind.pyspark.length).toBeGreaterThan(0);
		expect(byKind.iceberg_rest.length).toBeGreaterThan(0);
		expect(byKind.custom_env).toEqual([]);
	});

	it('s3 maps configured and ambient sources without changing credential values', () => {
		const configured = s3.objectBrowse!.source(s3.configSchema.parse(FIXTURES.s3));
		expect(configured).toEqual({
			provider: 's3',
			configured_bucket: 'lake',
			region: 'us-east-1',
			endpoint: 'https://minio.internal:9000',
			path_style: true,
			auth: {
				method: 'static',
				access_key_id: 'AKIAEXAMPLE',
				secret_access_key: 's3-secret',
				session_token: undefined,
			},
		});
		const ambient = s3.objectBrowse!.source(s3.configSchema.parse({ auth: { method: 'ambient' } }));
		expect(ambient).toEqual({
			provider: 's3',
			configured_bucket: undefined,
			region: undefined,
			endpoint: undefined,
			path_style: false,
			auth: { method: 'ambient' },
		});
	});

	it.each([
		['records.json', 'pl.read_json('],
		['records.JSON', 'pl.read_json('],
		['records.jsonl', 'pl.read_ndjson('],
		['records.ndjson', 'pl.read_ndjson('],
	] as const)('s3 renders the correct Polars reader for %s', (key, reader) => {
		const snippet = s3.objectBrowse!.snippet('warehouse', 'lake', key);
		expect(snippet).toContain(reader);
		expect(snippet).toContain('s3://lake/');
	});

	it('maps GCS and Azure Blob browsing sources and URI schemes', () => {
		expect(gcs.objectBrowse?.source(gcs.configSchema.parse(FIXTURES.gcs))).toEqual({
			provider: 'gcs',
			configured_bucket: 'lake',
			project_id: 'analytics-prod',
			auth: {
				method: 'service_account',
				credentials_json: '{"type":"service_account"}',
			},
		});
		expect(
			azureBlob.objectBrowse?.source(azureBlob.configSchema.parse(FIXTURES.azure_blob)),
		).toEqual({
			provider: 'azure_blob',
			configured_bucket: 'raw',
			account_name: 'lakeaccount',
			endpoint_suffix: 'core.windows.net',
			auth: { method: 'account_key', account_key: 'azure-key' },
		});
		expect(gcs.objectBrowse?.snippet('warehouse', 'lake', 'records.csv')).toContain(
			'gs://lake/records.csv',
		);
		expect(azureBlob.objectBrowse?.snippet('warehouse', 'raw', 'records.parquet')).toContain(
			'az://raw/records.parquet',
		);
		expect(gcs.objectBrowse?.snippet('warehouse', 'lake', 'folder/a ?#%.csv')).toContain(
			'gs://lake/folder/a%20%3F%23%25.csv',
		);
		expect(azureBlob.objectBrowse?.snippet('warehouse', 'raw', 'folder/a ?#%.json')).toContain(
			'az://raw/folder/a%20%3F%23%25.json',
		);
		expect(s3.objectBrowse?.snippet('warehouse', 'lake', 'folder/a ?#%.jsonl')).toContain(
			's3://lake/folder/a%20%3F%23%25.jsonl',
		);
	});

	it('resolves requirements from the selected driver, storage, and authentication branches', () => {
		const odbc = sqlserver.configSchema.parse(FIXTURES.sqlserver);
		const pymssql = sqlserver.configSchema.parse({
			...(FIXTURES.sqlserver as object),
			driver: { name: 'pymssql' },
		});
		expect(sqlserver.resolveRequirements?.(odbc)).toEqual(['sqlalchemy>=2', 'pyodbc>=5.1']);
		expect(sqlserver.resolveRequirements?.(pymssql)).toEqual(['sqlalchemy>=2', 'pymssql>=2.3']);

		const rest = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'sigv4', region: 'us-east-1' },
			storage: { scheme: 's3' },
		});
		expect(icebergRest.resolveRequirements?.(rest)).toEqual([
			'pyiceberg[pyarrow,rest-sigv4,s3fs]>=0.11',
		]);

		const sqlPostgres = icebergSql.configSchema.parse({
			uri: 'postgresql+psycopg2://catalog:secret@db.internal/iceberg',
		});
		const sqlSqlite = icebergSql.configSchema.parse({ uri: 'sqlite:////tmp/iceberg.db' });
		expect(icebergSql.resolveRequirements?.(sqlPostgres)).toEqual([
			'pyiceberg[pyarrow,sql-postgres]>=0.11',
		]);
		expect(icebergSql.resolveRequirements?.(sqlSqlite)).toEqual([
			'pyiceberg[pyarrow,sql-sqlite]>=0.11',
		]);

		const hive = icebergHive.configSchema.parse({ uri: 'thrift://hive.internal:9083' });
		const hiveKerberos = icebergHive.configSchema.parse({
			uri: 'thrift://hive.internal:9083',
			kerberos: { enabled: true },
		});
		expect(icebergHive.resolveRequirements?.(hive)).toEqual(['pyiceberg[hive,pyarrow]>=0.11']);
		expect(icebergHive.resolveRequirements?.(hiveKerberos)).toEqual([
			'pyiceberg[hive,hive-kerberos,pyarrow]>=0.11',
		]);
	});

	it('rejects hosts, URIs, and identifiers that could smuggle URL structure', () => {
		const pgHost = (host: string) =>
			postgres.configSchema.safeParse({ ...(FIXTURES.postgres as object), host }).success;
		expect(pgHost('db.internal')).toBe(true);
		expect(pgHost('10.0.0.5')).toBe(true);
		expect(pgHost('2001:db8::1')).toBe(true);
		expect(pgHost('::1')).toBe(true);
		expect(pgHost('[::1]')).toBe(false);
		expect(pgHost('nothex::1')).toBe(false);
		expect(pgHost('::1/path')).toBe(false);
		expect(pgHost('db.internal/path')).toBe(false);
		expect(pgHost('db.internal:5432')).toBe(false);
		expect(pgHost('user@db.internal')).toBe(false);
		expect(pgHost('db internal')).toBe(false);

		// The exact IPv6 grammar is not expressible in JSON Schema, so the pattern
		// the web form validates against is a deliberate superset. It still carries
		// the whole security contract: no character of URL structure gets through.
		const schemas = Object.fromEntries(
			defaultRegistry()
				.describeAll()
				.map(({ kind, json_schema }) => [kind, json_schema]),
		) as Record<string, { properties: { host: { pattern: string } } }>;
		const pattern = new RegExp(schemas.postgres?.properties.host.pattern ?? '');
		for (const bad of ['[::1]', 'db.internal/x', 'a@b', 'a b', 'a?b', 'a#b', 'a%2fb', 'a\\b']) {
			expect(pattern.test(bad), bad).toBe(false);
		}
		expect(pattern.test('::ffff:192.0.2.128')).toBe(true);

		const trinoField = (field: Record<string, unknown>) =>
			trino.configSchema.safeParse({ ...(FIXTURES.trino as object), ...field }).success;
		expect(trinoField({ host: 'trino.internal' })).toBe(true);
		expect(trinoField({ host: 'trino.internal/x' })).toBe(false);
		expect(trinoField({ default_catalog: 'hive' })).toBe(true);
		expect(trinoField({ default_catalog: 'hive/../x' })).toBe(false);
		expect(trinoField({ default_schema: 'a b' })).toBe(false);

		const icebergUri = (uri: string) =>
			icebergRest.configSchema.safeParse({ ...(FIXTURES.iceberg_rest as object), uri }).success;
		expect(icebergUri('https://catalog.internal/api')).toBe(true);
		expect(icebergUri('catalog.internal')).toBe(false);
		expect(icebergUri('gopher://catalog.internal')).toBe(false);
	});

	it('iceberg_rest rejects embedded credentials in catalog and token endpoint URLs', () => {
		expect(
			icebergRest.configSchema.safeParse({
				...(FIXTURES.iceberg_rest as object),
				uri: 'https://user:password@catalog.internal/api',
			}).success,
		).toBe(false);
		expect(
			icebergRest.configSchema.safeParse({
				...(FIXTURES.iceberg_rest as object),
				auth: {
					method: 'oauth2_client_credentials',
					token_endpoint: 'https://client:secret@idp.internal/token',
					client_id: 'cid',
					client_secret: 'csec',
				},
			}).success,
		).toBe(false);
	});

	it('URL fields allow @ in paths but not in the authority', () => {
		expect(
			icebergRest.configSchema.safeParse({
				...(FIXTURES.iceberg_rest as object),
				uri: 'https://catalog.internal/users/alice@example.com',
			}).success,
		).toBe(true);
		expect(
			wandb.configSchema.safeParse({
				...(FIXTURES.wandb as object),
				base_url: 'https://api.example.com/users/alice@example.com',
			}).success,
		).toBe(true);
		expect(
			athena.configSchema.safeParse(
				fixtureFor(athena, { s3_staging_dir: 's3://staging/users/alice@example.com' }),
			).success,
		).toBe(true);
	});
});

/** Kinds whose sandbox contract is rendered by `renderConnection`. */
const CONNECTION_KINDS = [
	'mysql',
	'sqlserver',
	'mongodb',
	'clickhouse',
	'snowflake',
	'bigquery',
	'redshift',
	'motherduck',
	'databricks',
	'athena',
	's3',
	'gcs',
	'azure_blob',
	'wandb',
	'huggingface',
];

describe('connection kinds (golden)', () => {
	const descriptorOf = (output: { files?: { path: string; content: string }[] }, name = 'prod') =>
		JSON.parse(
			output.files?.find(({ path }) => path.endsWith(`/${name}.json`))?.content ?? '{}',
		) as Record<string, unknown>;

	it('mysql: verifies the chain and hostname against the image CA bundle by default', () => {
		const out = renderFixture(mysql);
		const url = new URL(out.env?.MARIMOHUB_MYSQL_PROD_URL ?? '');
		expect(url.protocol).toBe('mysql+pymysql:');
		expect(url.username).toBe('svc%20user');
		expect(url.searchParams.get('ssl_ca')).toBe('/etc/ssl/certs/ca-certificates.crt');
		expect(descriptorOf(out).ssl).toEqual({
			mode: 'verify_identity',
			ca_path: '/etc/ssl/certs/ca-certificates.crt',
		});
		// The image's bundle is referenced, never copied into the sandbox.
		expect(out.files?.map(({ path }) => path)).toEqual(['mysql/prod.json']);
	});

	it('mysql: a pasted CA lands outside the workspace and ssl_ca points at it', () => {
		const out = renderFixture(mysql, { ssl: { mode: 'verify_identity', ca_bundle: 'CA' } });
		const caPath = `${INTEGRATIONS_DIR}/mysql/prod-ca.pem`;
		expect(new URL(out.env?.MARIMOHUB_MYSQL_PROD_URL ?? '').searchParams.get('ssl_ca')).toBe(
			caPath,
		);
		expect(out.files?.find(({ path }) => path === 'mysql/prod-ca.pem')?.content).toBe('CA');
	});

	it('mysql: a disabled connection renders no TLS argument at all', () => {
		const out = renderFixture(mysql, { ssl: { mode: 'disabled' } });
		expect(out.env?.MARIMOHUB_MYSQL_PROD_URL).not.toContain('ssl_ca');
	});

	it.each([
		[{ mode: 'verify_identity', ca_bundle: 'CA', ca_path: '/etc/ssl/certs/ca.crt' }, /only one of/],
		[{ mode: 'verify_identity', ca_path: 'certs/ca.crt' }, /absolute path/],
		[{ mode: 'verify_identity', ca_path: '/etc/../ca.crt' }, /absolute path/],
	])('mysql: rejects the CA settings %j', (ssl, message) => {
		const config = mysql.configSchema.parse(fixtureFor(mysql, { ssl }));
		expect(() => mysql.validate?.(config)).toThrow(message);
	});

	it('s3: claims the ambient AWS variables and the addressing style boto3 has no variable for', () => {
		const out = renderFixture(s3);
		expect(out.env).toMatchObject({
			AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
			AWS_SECRET_ACCESS_KEY: 's3-secret',
			AWS_REGION: 'us-east-1',
			AWS_DEFAULT_REGION: 'us-east-1',
			// Scoped to S3 so unrelated AWS calls still reach their own endpoints.
			AWS_ENDPOINT_URL_S3: 'https://minio.internal:9000',
			AWS_CONFIG_FILE: `${INTEGRATIONS_DIR}/s3/prod-aws.conf`,
			MARIMOHUB_S3_PROD_BUCKET: 'lake',
		});
		expect(out.env?.AWS_ENDPOINT_URL).toBeUndefined();
		expect(out.files?.find(({ path }) => path === 's3/prod-aws.conf')?.content).toContain(
			'addressing_style = path',
		);
		expect(descriptorOf(out).ambient_env).toContain('AWS_ACCESS_KEY_ID');
	});

	it('s3: an instance that claims nothing ambient stays under its own prefix', () => {
		const out = renderFixture(s3, { ambient_env: false });
		expect(Object.keys(out.env ?? {}).every((name) => name.startsWith('MARIMOHUB_S3_PROD_'))).toBe(
			true,
		);
		expect(out.files?.some(({ path }) => path.endsWith('-aws.conf'))).toBe(false);
	});

	it('snowflake: a password rides in the URL, a key pair rides in a file', () => {
		expect(renderFixture(snowflake).env?.MARIMOHUB_SNOWFLAKE_PROD_URL).toBe(
			'snowflake://svc:sf-pw@myorg-account1/analytics/public?warehouse=compute_wh',
		);

		const keyPair = renderFixture(snowflake, {
			auth: { method: 'key_pair', private_key: 'PEM', private_key_passphrase: 'phrase' },
		});
		expect(keyPair.env?.MARIMOHUB_SNOWFLAKE_PROD_URL).toBeUndefined();
		expect(keyPair.env?.MARIMOHUB_SNOWFLAKE_PROD_PRIVATE_KEY_PATH).toBe(
			`${INTEGRATIONS_DIR}/snowflake/prod-key.pem`,
		);
		expect(keyPair.files?.find(({ path }) => path === 'snowflake/prod-key.pem')?.content).toBe(
			'PEM',
		);
	});

	it('bigquery: the service-account key is referenced by path, never inlined', () => {
		const out = renderFixture(bigquery);
		const path = `${INTEGRATIONS_DIR}/bigquery/prod-sa.json`;
		expect(out.env?.MARIMOHUB_BIGQUERY_PROD_URL).toBe(
			`bigquery://analytics-prod/events?credentials_path=${encodeURIComponent(path)}&location=US`,
		);
		expect(out.files?.find((file) => file.path === 'bigquery/prod-sa.json')?.content).toContain(
			'bq-key',
		);
		// Left to a GCS integration by default, so the two can coexist.
		expect(out.env?.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
		const claimed = renderFixture(bigquery, { ambient_env: true });
		expect(claimed.env?.GOOGLE_APPLICATION_CREDENTIALS).toBe(path);
	});

	it('bigquery and gcs can both hold a key without fighting over the Google variables', () => {
		const rendered = [bigquery, gcs].map((def, index) => ({
			id: `intg-000000000000000${index}` as never,
			name: def.kind,
			kind: def.kind,
			version: 1,
			output: renderFixture(def, {}, def.kind),
		}));
		const bundle = bundleIntegrations(rendered, createSessionId());
		expect(bundle.vars.GOOGLE_APPLICATION_CREDENTIALS).toBe(`${INTEGRATIONS_DIR}/gcs/gcs-sa.json`);
	});

	// The dialect reads both from the query string; a schema in the path is not a
	// default schema, it is dropped.
	it('databricks: catalog and schema ride in the query, not the path', () => {
		expect(renderFixture(databricks, { schema: 'sales' }).env?.MARIMOHUB_DATABRICKS_PROD_URL).toBe(
			'databricks://token:dapi-token@dbc-1234abcd-5678.cloud.databricks.com:443' +
				'?http_path=%2Fsql%2F1.0%2Fwarehouses%2Fabc123&catalog=main&schema=sales',
		);
	});

	it('databricks: token auth renders a URL, an OAuth service principal does not', () => {
		expect(renderFixture(databricks).env?.MARIMOHUB_DATABRICKS_PROD_URL).toBe(
			'databricks://token:dapi-token@dbc-1234abcd-5678.cloud.databricks.com:443' +
				'?http_path=%2Fsql%2F1.0%2Fwarehouses%2Fabc123&catalog=main',
		);

		const oauth = renderFixture(databricks, {
			auth: { method: 'oauth_m2m', client_id: 'cid', client_secret: 'csec' },
		});
		expect(oauth.env?.MARIMOHUB_DATABRICKS_PROD_URL).toBeUndefined();
		expect(oauth.env?.MARIMOHUB_DATABRICKS_PROD_CLIENT_SECRET).toBe('csec');
	});

	it('athena: ambient credentials keep the empty userinfo PyAthena needs', () => {
		const ambient = renderFixture(athena, { auth: { method: 'ambient' } });
		expect(ambient.env?.MARIMOHUB_ATHENA_PROD_URL).toBe(
			'awsathena+rest://:@athena.us-east-1.amazonaws.com:443/default' +
				'?s3_staging_dir=s3%3A%2F%2Fstaging%2Fathena%2F&work_group=primary&catalog_name=AwsDataCatalog',
		);
		expect(renderFixture(athena).env?.MARIMOHUB_ATHENA_PROD_URL).toContain(
			'awsathena+rest://AKIAATHENA:athena-secret@athena.us-east-1.amazonaws.com:443/',
		);
	});

	// China is a separate partition with its own DNS suffix; GovCloud is not.
	it.each([
		['cn-north-1', 'athena.cn-north-1.amazonaws.com.cn'],
		['us-gov-west-1', 'athena.us-gov-west-1.amazonaws.com'],
	])('athena: %s resolves to %s', (region, host) => {
		expect(renderFixture(athena, { region }).env?.MARIMOHUB_ATHENA_PROD_URL).toContain(
			`@${host}:443/`,
		);
	});

	// Stored and shown in plaintext, and kept in the version history — nothing
	// would ever decrypt a credential smuggled in here.
	it('athena: rejects a staging URI carrying credentials', () => {
		expect(
			athena.configSchema.safeParse(
				fixtureFor(athena, { s3_staging_dir: 's3://AKIA:secret@bucket/prefix' }),
			).success,
		).toBe(false);
	});

	it('mongodb: an SRV connection resolves its members from DNS, so it carries no port', () => {
		const out = renderFixture(mongodb);
		expect(out.env?.MARIMOHUB_MONGODB_PROD_URL).toBe(
			'mongodb+srv://svc:mongo-pw@cluster0.abcde.mongodb.net/analytics?authSource=admin&tls=true',
		);
		expect(out.env?.MARIMOHUB_MONGODB_PROD_PORT).toBeUndefined();

		const direct = renderFixture(mongodb, { scheme: 'mongodb' });
		expect(direct.env?.MARIMOHUB_MONGODB_PROD_URL).toContain('mongodb.net:27017/');
	});

	it('motherduck: the token rides in the md: string because DuckDB wants a lower-case name', () => {
		const out = renderFixture(motherduck);
		expect(out.env?.MARIMOHUB_MOTHERDUCK_PROD_URL).toBe('md:analytics?motherduck_token=md-token');
		expect(descriptorOf(out).url_env).toBe('MARIMOHUB_MOTHERDUCK_PROD_URL');
	});

	// `https:///api` parses to the host `api`, so an empty authority would send
	// credentials somewhere the operator never named. The out-of-range port and
	// the stray percent escape are where `new URL` throws — without them a save
	// succeeds and the connection test dies building its own URL.
	it.each([
		'https:///api',
		'https://user:pw@host',
		'https://',
		'https://ho st',
		'https://host:65536',
		'https://host:0',
		'https://%zz',
	])('endpoint fields reject %s', (endpoint) => {
		expect(huggingFace.configSchema.safeParse({ token: 't', endpoint }).success).toBe(false);
		expect(s3.configSchema.safeParse({ endpoint_url: endpoint }).success).toBe(false);
	});

	it.each(['https://host:65535', 'https://[::1]:8443/p', 'http://minio.internal:9000'])(
		'endpoint fields accept %s',
		(endpoint) => {
			expect(s3.configSchema.safeParse({ endpoint_url: endpoint }).success).toBe(true);
		},
	);

	it.each([
		['https://hub.internal', 'https://hub.internal/api/whoami-v2'],
		['https://hub.internal/', 'https://hub.internal/api/whoami-v2'],
		['https://hub.internal/prefix/', 'https://hub.internal/prefix/api/whoami-v2'],
	])('huggingface: probes %s at %s', async (endpoint, expected) => {
		const calls: string[] = [];
		const probe: IntegrationProbe = {
			connect: () => Promise.reject(new Error('unused')),
			fetch: (url) => {
				calls.push(url);
				return Promise.resolve({ ok: true, status: 200, json: async () => ({ name: 'ada' }) });
			},
		};
		const config = huggingFace.configSchema.parse({ token: 'hf-token', endpoint });
		await huggingFace.testConnection?.(config, probe);
		expect(calls[0]).toBe(expected);
	});

	it('sqlserver: the default driver the form shows is the one a save renders', () => {
		const shown = sqlserver.configSchema.shape.driver.def.defaultValue;
		expect(shown).toEqual({
			name: 'pyodbc',
			odbc_driver: 'ODBC Driver 18 for SQL Server',
			encrypt: true,
			trust_server_certificate: false,
		});
		const url = renderFixture(sqlserver).env?.MARIMOHUB_MSSQL_PROD_URL ?? '';
		expect(url).toContain('Encrypt=yes');
		expect(url).toContain('TrustServerCertificate=no');
	});

	it.each([
		['my..bucket', false],
		['192.168.1.1', false],
		['ab', false],
		['UPPER', false],
		['my-bucket', true],
		['my.bucket.name', true],
	])('object stores reject the invalid bucket name %s', (bucket, valid) => {
		expect(s3.configSchema.safeParse({ bucket }).success).toBe(valid);
		expect(gcs.configSchema.safeParse({ bucket }).success).toBe(valid);
	});

	// Validated apart because the provider rules genuinely differ; a shared
	// subset would reject buckets that exist.
	it('gcs takes the names its own rules allow, and refuses the reserved ones', () => {
		const dotted = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(30)].join('.');
		expect(dotted).toHaveLength(222);
		for (const [bucket, valid] of [
			['my_bucket', true],
			[dotted, true],
			[`${dotted}e`, false],
			// Each dot-separated part is still capped at 63.
			['x'.repeat(64), false],
			['goog-bucket', false],
			['my-google-bucket', false],
		] as const) {
			expect(gcs.configSchema.safeParse({ bucket }).success, bucket.slice(0, 20)).toBe(valid);
		}
		// S3 has neither the underscore nor the 222-character dotted form.
		expect(s3.configSchema.safeParse({ bucket: 'my_bucket' }).success).toBe(false);
		expect(s3.configSchema.safeParse({ bucket: dotted }).success).toBe(false);
	});

	it('wandb and huggingface keep their caches out of the notebook workspace', () => {
		expect(renderFixture(wandb).env).toEqual({
			WANDB_API_KEY: 'wandb-key',
			WANDB_BASE_URL: 'https://api.wandb.ai',
			WANDB_ENTITY: 'marimo',
			WANDB_PROJECT: 'hub',
			WANDB_MODE: 'online',
			WANDB_DIR: '/tmp/marimohub-wandb',
		});
		expect(renderFixture(huggingFace).env).toEqual({
			HF_TOKEN: 'hf-token',
			HF_ENDPOINT: 'https://huggingface.co',
			HF_HOME: '/tmp/marimohub-huggingface',
		});
	});

	// The descriptor exists so notebook code can introspect a connection. That is
	// only safe while it names each secret's variable instead of quoting its value.
	// The Iceberg and PySpark kinds are excluded on purpose: their rendered files
	// are the tool's own configuration document, which the tool expects to hold
	// credentials.
	it('every connection descriptor names its secrets rather than carrying them', () => {
		const registry = defaultRegistry();
		for (const kind of CONNECTION_KINDS) {
			const def = registry.get(kind);
			const descriptor = descriptorOf(renderFixture(def));
			const secrets = secretValuesOf(
				def.configSchema.parse(FIXTURES[kind]),
				registry.secretPathsOf(kind),
			);
			expect(secrets.length, `${kind} fixture must configure a secret`).toBeGreaterThan(0);
			for (const value of secrets) {
				expect(JSON.stringify(descriptor), `${def.kind} descriptor`).not.toContain(value);
			}
		}
	});
});

// These names are marimo's, not ours: each plugin under
// `marimo/_data/data_source_discovery/plugins` offers a connection only when
// every one of its required variables is set, so pinning them here is what keeps
// a rename — on either side — from silently turning discovery off.
const DISCOVERY_CONTRACT = [
	{ kind: 'postgres', required: ['PGHOST', 'PGUSER', 'PGDATABASE'], overrides: {} },
	{
		kind: 'mysql',
		required: ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_DATABASE', 'MYSQL_PASSWORD'],
		overrides: { ssl: { mode: 'disabled' } },
	},
	{ kind: 'trino', required: ['TRINO_HOST', 'TRINO_USER', 'TRINO_CATALOG'], overrides: {} },
	{ kind: 'pyspark', required: ['SPARK_REMOTE'], overrides: {} },
	{ kind: 's3', required: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], overrides: {} },
];

describe('marimo data-source discovery', () => {
	it.each(DISCOVERY_CONTRACT)(
		'$kind sets every variable the discovery plugin requires',
		({ kind, required, overrides }) => {
			const def = defaultRegistry().get(kind);
			const config = def.configSchema.parse(fixtureFor(def, { ambient_env: true, ...overrides }));
			expect(() => def.validate?.(config)).not.toThrow();
			const output = renderDefinition(def, config);
			const env = kind === 's3' ? (output.env ?? {}) : (output.discoveryEnv ?? {});
			for (const name of required) {
				expect(env[name], `${kind} must set ${name}`).toBeTruthy();
			}
		},
	);

	it.each(DISCOVERY_CONTRACT.filter(({ kind }) => kind !== 's3'))(
		'$kind enables discovery by default',
		({ kind, required, overrides }) => {
			const def = defaultRegistry().get(kind);
			const config = def.configSchema.parse(fixtureFor(def, overrides));
			const output = renderDefinition(def, config);
			for (const name of required) expect(output.discoveryEnv?.[name], name).toBeTruthy();
		},
	);

	it.each(DISCOVERY_CONTRACT.filter(({ kind }) => kind !== 's3'))(
		'$kind claims nothing outside its own prefix until asked',
		({ kind, required }) => {
			const env =
				renderFixture(defaultRegistry().get(kind), { ambient_env: false }).discoveryEnv ?? {};
			for (const name of required) expect(env[name], name).toBeUndefined();
		},
	);

	// libpq reads PGSSLMODE for any parameter the caller left unset, and the
	// connection marimo builds sets none — so these are what stop a discovered
	// connection from being a weaker one to the same server.
	it('postgres: the discovered connection verifies exactly like the rendered URL', () => {
		const env = renderFixture(postgres, { ambient_env: true }).discoveryEnv ?? {};
		expect(env.PGSSLMODE).toBe('verify-full');
		expect(env.PGSSLROOTCERT).toBe('/etc/ssl/certs/ca-certificates.crt');

		const custom = renderFixture(postgres, {
			ambient_env: true,
			ssl: { mode: 'verify-ca', ca_bundle: 'CA' },
		}).discoveryEnv;
		expect(custom?.PGSSLMODE).toBe('verify-ca');
		expect(custom?.PGSSLROOTCERT).toBe(`${INTEGRATIONS_DIR}/postgres/prod-ca.pem`);
	});

	it('mysql: falls back to its notebook snippet when discovery cannot preserve TLS', () => {
		const config = mysql.configSchema.parse(fixtureFor(mysql, { ambient_env: true }));
		expect(() => mysql.validate?.(config)).not.toThrow();
		const output = renderDefinition(mysql, config);
		expect(output.discoveryEnv).toBeUndefined();
		expect(output.warnings).toEqual([expect.stringMatching(/cannot carry its MySQL TLS settings/)]);
	});

	it('trino: exports the password so the discovered connection authenticates over HTTPS', () => {
		const env = renderFixture(trino, { ambient_env: true }).discoveryEnv ?? {};
		expect(env.TRINO_CATALOG).toBe('hive');
		expect(env.TRINO_PASSWORD).toBe('pw');
	});

	it('keeps discovery enabled when marimo omits optional connection settings', () => {
		const trinoOutput = renderFixture(trino, {
			ambient_env: true,
			legacy_prepared_statements: false,
		});
		expect(trinoOutput.discoveryEnv?.TRINO_HOST).toBe('trino.internal');
		expect(trinoOutput.warnings).toEqual([]);
		expect(
			new URL(trinoOutput.env?.MARIMOHUB_TRINO_PROD_URL ?? '').searchParams.get(
				'legacy_prepared_statements',
			),
		).toBe('false');

		const pysparkOutput = renderFixture(pyspark, { ambient_env: true, app_name: 'analytics' });
		expect(pysparkOutput.discoveryEnv?.SPARK_REMOTE).toContain('spark.internal');
		expect(pysparkOutput.warnings).toEqual([]);
		const descriptor = JSON.parse(pysparkOutput.files?.[0]?.content ?? '') as Record<
			string,
			unknown
		>;
		expect(descriptor.app_name).toBe('analytics');
	});

	it.each([
		[{ default_catalog: undefined }, /requires a default catalog/],
		[{ auth: { method: 'jwt', token: 'jwt-token' } }, /Basic authentication over HTTPS/],
		[{ auth: { method: 'none' } }, /Basic authentication over HTTPS/],
		// Nothing carries a private CA or a disabled check into the discovered
		// connection, so it would verify differently than the configured one.
		[{ tls: { verification: 'custom_ca', ca_bundle: 'CA' } }, /custom Trino TLS/],
		[{ tls: { verification: 'disabled' } }, /custom Trino TLS/],
		// marimo authenticates as TRINO_USER, so a separate query user cannot be
		// expressed — the discovered connection would use the wrong credential.
		[{ user: 'analyst' }, /same Trino query user/],
		[{ source: 'marimohub' }, /configured Trino source/],
		[{ session_properties: { join_distribution_type: 'BROADCAST' } }, /session properties/],
		[{ roles: { hive: 'analyst' } }, /configured Trino roles/],
		[{ client_tags: [{ value: 'interactive' }] }, /client tags/],
		[{ http_headers: [{ name: 'X-Trace', value: 'trace' }] }, /HTTP headers/],
		[{ extra_credentials: [{ name: 'tenant', value: 'acme' }] }, /extra credentials/],
		[{ timezone: 'America/New_York' }, /configured Trino timezone/],
		[{ encoding: [{ value: 'json+zstd' }] }, /configured Trino encoding/],
		[{ max_attempts: 5 }, /maximum attempts/],
		[{ request_timeout_seconds: 30 }, /request timeout/],
		[{ heartbeat_interval_seconds: 10 }, /heartbeat interval/],
		[{ isolation_level: 'READ_COMMITTED' }, /isolation level/],
		[{ legacy_primitive_types: true }, /legacy primitive types/],
	])('trino: falls back when discovery cannot express the config (%j)', (overrides, message) => {
		const config = trino.configSchema.parse(fixtureFor(trino, { ambient_env: true, ...overrides }));
		expect(() => trino.validate?.(config)).not.toThrow();
		const output = renderDefinition(trino, config);
		expect(output.discoveryEnv).toBeUndefined();
		expect(output.warnings?.join(' ')).toMatch(message);
	});

	it.each([
		[{ spark_config: { 'spark.sql.session.timeZone': 'UTC' } }, /Spark session properties/],
		[
			{
				secret_spark_config: [{ name: 'spark.hadoop.fs.s3a.secret.key', value: 's3-secret' }],
			},
			/secret Spark session properties/,
		],
	])('pyspark: falls back when discovery cannot express the config (%j)', (overrides, message) => {
		const config = pyspark.configSchema.parse(
			fixtureFor(pyspark, { ambient_env: true, ...overrides }),
		);
		expect(() => pyspark.validate?.(config)).not.toThrow();
		const output = renderDefinition(pyspark, config);
		expect(output.discoveryEnv).toBeUndefined();
		expect(output.env?.MARIMOHUB_PYSPARK_PROD_CONFIG).toBe(`${INTEGRATIONS_DIR}/pyspark/prod.json`);
		expect(output.files?.some(({ path }) => path === 'pyspark/prod.json')).toBe(true);
		expect(output.warnings?.join(' ')).toMatch(message);
	});

	it('two instances claiming the same variables discover one and warn about the fallback', () => {
		const rendered = ['prod', 'staging'].map((name, index) => ({
			id: `intg-00000000000000${index}0` as never,
			name,
			kind: 'postgres',
			version: 1,
			output: renderFixture(postgres, { ambient_env: true, host: `${name}.internal` }, name),
		}));
		const bundle = bundleIntegrations(rendered, createSessionId());
		expect(bundle.vars.PGHOST).toBe('prod.internal');
		expect(bundle.warnings).toEqual([
			expect.stringMatching(/"staging".*not automatic data-source discovery.*"prod"/),
		]);
	});
});

describe('cross-kind bundle', () => {
	const synthetic = (
		name: string,
		output: { files?: { path: string; content: string }[]; env?: Record<string, string> },
	) => ({
		id: 'intg-0000000000000001' as never,
		name,
		kind: 'synthetic',
		version: 1,
		output,
	});

	it('one instance of every kind bundles without path or env collisions', () => {
		const sessionId = createSessionId();
		const rendered = defaultRegistry()
			.list()
			.map((def, i) => ({
				id: `intg-000000000000000${i}` as never,
				name: `inst-${def.kind.replaceAll('_', '-')}`,
				kind: def.kind,
				version: 1,
				output: def.render(input(FIXTURES[def.kind], def, `inst-${def.kind.replaceAll('_', '-')}`)),
			}));
		const bundle = bundleIntegrations(rendered, sessionId);
		expect(bundle.attachments).toHaveLength(defaultRegistry().list().length);
		expect(bundle.files.every((f) => f.path.startsWith(`${INTEGRATIONS_DIR}/`))).toBe(true);
		const pyiceberg = bundle.files.find((file) => file.path.endsWith('/.pyiceberg.yaml'));
		const config = parse(pyiceberg?.content ?? '') as {
			catalog: Record<string, { type: string }>;
		};
		expect(
			Object.values(config.catalog)
				.map(({ type }) => type)
				.sort(),
		).toEqual(['bigquery', 'dynamodb', 'glue', 'hive', 'rest', 'sql']);
	});

	it('two instances of the same kind coexist (name-parameterized paths/env)', () => {
		const rendered = ['prod', 'staging'].map((name, i) => ({
			id: `intg-00000000000000${i}0` as never,
			name,
			kind: 'postgres',
			version: 1,
			output: postgres.render(input(FIXTURES.postgres, postgres, name)),
		}));
		expect(() => bundleIntegrations(rendered, createSessionId())).not.toThrow();
	});

	it("manifest.json echoes each instance's declared requirements", () => {
		const rendered = [
			{
				id: 'intg-0000000000000001' as never,
				name: 'prod',
				kind: 'postgres',
				version: 2,
				requirements: postgres.requirements,
				output: postgres.render(input(FIXTURES.postgres, postgres)),
			},
		];
		const bundle = bundleIntegrations(rendered, createSessionId());
		const manifestFile = bundle.files.find((f) => f.path.endsWith('/manifest.json'));
		const manifest = JSON.parse(manifestFile?.content ?? '') as {
			integrations: { requirements?: string[] }[];
		};
		expect(manifest.integrations[0].requirements).toEqual(postgres.requirements);
	});

	it.each([
		'/absolute.json',
		'../escape.json',
		'a/../escape.json',
		'a/./file.json',
		'a//file.json',
		'a\\file.json',
		'a/secret\0.json',
		'a/secret\n.json',
		'a/secret\u007f.json',
	])('rejects an unsafe rendered path: %s', (path) => {
		expect(() =>
			bundleIntegrations(
				[synthetic('unsafe', { files: [{ path, content: 'x' }] })],
				createSessionId(),
			),
		).toThrow(/invalid file path/);
	});

	it('escapes control characters in unsafe rendered path errors', () => {
		const error = captureValidationError(() =>
			bundleIntegrations(
				[synthetic('unsafe', { files: [{ path: 'a/secret\n.json', content: 'x' }] })],
				createSessionId(),
			),
		);
		expect(String(error)).toContain('a/secret\\n.json');
		expect(String(error)).not.toContain('a/secret\n.json');
	});

	it('rejects manifest replacement and cross-integration file collisions', () => {
		expect(() =>
			bundleIntegrations(
				[synthetic('unsafe', { files: [{ path: 'manifest.json', content: '{}' }] })],
				createSessionId(),
			),
		).toThrow(/may not render/);

		expect(() =>
			bundleIntegrations(
				[
					synthetic('first', { files: [{ path: 'shared.json', content: 'a' }] }),
					synthetic('second', { files: [{ path: 'shared.json', content: 'b' }] }),
				],
				createSessionId(),
			),
		).toThrow(/both render/);
	});

	it('rejects conflicting shared YAML leaves', () => {
		const withYaml = (name: string, value: string) => ({
			...synthetic(name, {}),
			output: {
				yamlFiles: [{ path: 'shared.yaml', value: { config: { same: value } } }],
			},
		});
		expect(() =>
			bundleIntegrations([withYaml('first', 'a'), withYaml('second', 'b')], createSessionId()),
		).toThrow(/Integrations "first" and "second" disagree on "same"/);
	});

	it.each(['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'lowercase', 'HAS-DASH'])(
		'rejects a forbidden or malformed environment name: %s',
		(name) => {
			expect(() =>
				bundleIntegrations([synthetic('unsafe', { env: { [name]: 'x' } })], createSessionId()),
			).toThrow(/forbidden or malformed env name/);
		},
	);

	it.each(['secret\0value', 'secret\nvalue', 'secret\tvalue', 'secret\u007fvalue'])(
		'rejects a rendered environment value containing a control character',
		(value) => {
			expect(() =>
				bundleIntegrations([synthetic('unsafe', { env: { SAFE_NAME: value } })], createSessionId()),
			).toThrow(/control character/);
		},
	);

	it('does not echo rendered environment or YAML values in validation errors', () => {
		const secret = 'do-not-log-this-secret';
		const messages = [
			[synthetic('unsafe', { env: { SAFE_NAME: `${secret}\n` } })],
			[
				synthetic('first', { env: { SHARED: secret } }),
				synthetic('second', { env: { SHARED: 'other' } }),
			],
		];
		for (const rendered of messages) {
			const error = captureValidationError(() => bundleIntegrations(rendered, createSessionId()));
			expect(String(error)).not.toContain(secret);
		}

		const error = captureValidationError(() =>
			bundleIntegrations(
				[
					{
						...synthetic('first', {}),
						output: { yamlFiles: [{ path: 'shared.yaml', value: { option: secret } }] },
					},
					{
						...synthetic('second', {}),
						output: { yamlFiles: [{ path: 'shared.yaml', value: { option: 'other' } }] },
					},
				],
				createSessionId(),
			),
		);
		expect(String(error)).not.toContain(secret);
	});

	it('rejects conflicting environment values but permits an identical shared value', () => {
		expect(() =>
			bundleIntegrations(
				[
					synthetic('first', { env: { SHARED: 'a' } }),
					synthetic('second', { env: { SHARED: 'b' } }),
				],
				createSessionId(),
			),
		).toThrow(/different values/);
		expect(() =>
			bundleIntegrations(
				[
					synthetic('first', { env: { SHARED: 'same' } }),
					synthetic('second', { env: { SHARED: 'same' } }),
				],
				createSessionId(),
			),
		).not.toThrow();
	});
});

// The schema dialect the web form renderer supports. Every registered kind's
// JSON Schema must stay inside it — fail at CI, not in front of a user.
describe('schema dialect', () => {
	type Node = Record<string, unknown>;

	function walk(node: Node, path: string, kind: string): void {
		if (node[SECRET_MARK] === true) {
			expect(node.type, `${kind}:${path} secret must be a string`).toBe('string');
			expect(node.minLength, `${kind}:${path} secret must be zSecret()`).toBe(1);
			expect(node.writeOnly, `${kind}:${path} secret must be write-only`).toBe(true);
			return;
		}
		const union = (node.oneOf ?? node.anyOf) as Node[] | undefined;
		if (union) {
			expect(node.discriminator, `${kind}:${path} union must declare its discriminator`).toEqual({
				propertyName: expect.any(String),
			});
			for (const branch of union) {
				expect(branch.type, `${kind}:${path} union branches must be objects`).toBe('object');
				const props = branch.properties as Record<string, Node>;
				const hasDiscriminator = Object.values(props).some((p) => typeof p.const === 'string');
				expect(hasDiscriminator, `${kind}:${path} union branch needs a const discriminator`).toBe(
					true,
				);
				walk(branch, path, kind);
			}
			return;
		}
		switch (node.type) {
			case 'object': {
				const props = (node.properties ?? {}) as Record<string, Node>;
				if (node.properties !== undefined) {
					expect(node.additionalProperties, `${kind}:${path} fixed object must be strict`).toBe(
						false,
					);
				}
				for (const [key, child] of Object.entries(props)) walk(child, `${path}.${key}`, kind);
				const additional = node.additionalProperties as Node | undefined;
				if (additional && typeof additional === 'object') {
					expect(additional.type, `${kind}:${path} record values must be strings`).toBe('string');
					expect(additional[SECRET_MARK], `${kind}:${path} record values must not be secret`).toBe(
						undefined,
					);
				}
				break;
			}
			case 'array': {
				// The form's only array widget is the object-list; scalar-item arrays
				// would render as empty, uneditable rows.
				const items = node.items as Node | undefined;
				expect(items?.type, `${kind}:${path} array items must be objects`).toBe('object');
				walk(items as Node, `${path}[*]`, kind);
				break;
			}
			case 'string':
			case 'number':
			case 'integer':
			case 'boolean':
				break;
			default:
				throw new Error(`${kind}:${path} uses unsupported schema node: ${JSON.stringify(node)}`);
		}
	}

	it('the walker itself rejects out-of-dialect nodes (guards the guard)', () => {
		expect(() => walk({ type: 'array', items: { type: 'string' } }, '$', 'synthetic')).toThrow();
		expect(() => walk({ type: 'tuple' }, '$', 'synthetic')).toThrow();
		expect(() => walk({ [SECRET_MARK]: true, type: 'number' } as Node, '$', 'synthetic')).toThrow();
	});

	it('every registered kind stays inside the supported dialect', () => {
		for (const descriptor of defaultRegistry().describeAll()) {
			walk(descriptor.json_schema, '$', descriptor.kind);
		}
	});

	it('rejects unknown fields in every root config', () => {
		for (const def of defaultRegistry().list()) {
			expect(
				def.configSchema.safeParse({ ...(FIXTURES[def.kind] as object), unknown_field: true })
					.success,
				def.kind,
			).toBe(false);
		}
	});

	it('publishes only portable regular expressions', () => {
		const unsupported = /\(\?[=!<]|\\[1-9]/;
		const visit = (node: unknown, kind: string): void => {
			if (typeof node !== 'object' || node === null) return;
			const record = node as Record<string, unknown>;
			if (typeof record.pattern === 'string') {
				expect(unsupported.test(record.pattern), `${kind}: ${record.pattern}`).toBe(false);
			}
			for (const value of Object.values(record)) {
				if (Array.isArray(value)) value.forEach((item) => visit(item, kind));
				else visit(value, kind);
			}
		};
		for (const descriptor of defaultRegistry().describeAll()) {
			visit(descriptor.json_schema, descriptor.kind);
		}
	});

	it('describes every migration step for versioned kinds', () => {
		for (const def of defaultRegistry().list()) {
			if (def.schemaVersion === 1) continue;
			expect(def.migrate, `${def.kind} migration function`).toBeTypeOf('function');
			const steps = new Set((def.migrations ?? []).map(({ from, to }) => `${from}:${to}`));
			for (let from = 1; from < def.schemaVersion; from++) {
				expect(steps.has(`${from}:${from + 1}`), `${def.kind} v${from} → v${from + 1}`).toBe(true);
			}
		}
	});

	it('a path marked secret in one union branch is marked in every branch it appears in', () => {
		for (const descriptor of defaultRegistry().describeAll()) {
			const byPath = new Map<string, boolean>();
			const visit = (node: Node, path: string): void => {
				if (typeof node !== 'object' || node === null) return;
				const marked = node[SECRET_MARK] === true;
				if (node.type === 'string') {
					const prior = byPath.get(path);
					expect(
						prior === undefined || prior === marked,
						`${descriptor.kind}:${path} is secret in one union branch but not another`,
					).toBe(true);
					byPath.set(path, marked);
				}
				const props = node.properties as Record<string, Node> | undefined;
				if (props) for (const [k, c] of Object.entries(props)) visit(c, `${path}.${k}`);
				const union = (node.oneOf ?? node.anyOf) as Node[] | undefined;
				if (union) for (const b of union) visit(b, path);
				if (node.items) visit(node.items as Node, `${path}[*]`);
			};
			visit(descriptor.json_schema, '$');
		}
	});

	it('ui hint keys reference real config paths', () => {
		for (const descriptor of defaultRegistry().describeAll()) {
			const valid = new Set<string>();
			const collect = (node: Node, path: string): void => {
				if (typeof node !== 'object' || node === null) return;
				if (path) valid.add(path);
				const props = node.properties as Record<string, Node> | undefined;
				if (props) {
					for (const [k, c] of Object.entries(props)) collect(c, path ? `${path}.${k}` : k);
				}
				const union = (node.oneOf ?? node.anyOf) as Node[] | undefined;
				if (union) for (const b of union) collect(b, path);
				if (node.items) collect(node.items as Node, `${path}.*`);
			};
			collect(descriptor.json_schema, '');
			for (const hintPath of Object.keys(descriptor.ui_hints)) {
				expect(
					valid.has(hintPath),
					`${descriptor.kind}: ui hint "${hintPath}" matches no field`,
				).toBe(true);
			}
		}
	});
});

describe('testConnection goes through the injected probe only', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function recordingProbe(respond: (url: string) => unknown) {
		const calls: { url: string; init?: ProbeRequestInit }[] = [];
		const connections: ProbeConnectRequest[] = [];
		const probe: IntegrationProbe = {
			connect: (request) => {
				connections.push(request);
				return Promise.resolve();
			},
			fetch: (url, init) => {
				calls.push({ url, init });
				return Promise.resolve({ ok: true, status: 200, json: async () => respond(url) });
			},
		};
		return { probe, calls, connections };
	}

	it('never touches ambient fetch (the SSRF boundary is the probe)', async () => {
		vi.stubGlobal('fetch', () => {
			throw new Error('ambient fetch used in testConnection');
		});
		const { probe } = recordingProbe(() => ({ access_token: 'tok' }));
		for (const def of defaultRegistry().list()) {
			if (!def.testConnection) continue;
			const config = def.configSchema.parse(FIXTURES[def.kind]);
			const result = await def.testConnection(config, probe);
			expect(result.ok, def.kind).toBe(true);
		}
	});

	it('trino: probes /v1/info with UTF-8-safe basic auth', async () => {
		const { probe, calls } = recordingProbe(() => ({ nodeVersion: { version: '444' } }));
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'basic', username: 'césar', password: 'pässwörd' },
		});
		const result = await trino.testConnection?.(config, probe);
		expect(result).toMatchObject({ ok: true, details: 'Trino 444' });
		expect(calls[0].url).toBe('https://trino.internal:443/v1/info');
		const auth = calls[0].init?.headers?.Authorization ?? '';
		// Bare btoa would throw on these credentials (→ a 500 instead of a result).
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(auth.replace('Basic ', '')), (c) => c.charCodeAt(0)),
		);
		expect(decoded).toBe('césar:pässwörd');
	});

	it('pyspark: probes only TCP/TLS reachability and reports the authentication limitation', async () => {
		const { probe, calls, connections } = recordingProbe(() => ({}));
		const config = pyspark.configSchema.parse(FIXTURES.pyspark);

		const result = await pyspark.testConnection?.(config, probe);

		expect(result).toMatchObject({
			ok: true,
			details: 'endpoint reachable over TLS; Spark authentication not verified',
		});
		expect(connections).toEqual([{ hostname: 'spark.internal', port: 15002, tls: true }]);
		expect(calls).toHaveLength(0);
	});

	it('pyspark: reports plaintext reachability without claiming TLS or authentication', async () => {
		const { probe, calls, connections } = recordingProbe(() => ({}));
		const config = pyspark.configSchema.parse({
			host: 'spark.internal',
			port: 15003,
			use_ssl: false,
			auth: { method: 'none' },
		});

		const result = await pyspark.testConnection?.(config, probe);

		expect(result).toMatchObject({
			ok: true,
			details: 'endpoint reachable; Spark authentication not verified',
			latency_ms: expect.any(Number),
		});
		expect(connections).toEqual([{ hostname: 'spark.internal', port: 15003, tls: false }]);
		expect(calls).toHaveLength(0);
	});

	it('pyspark: returns a failed test result when the socket probe rejects', async () => {
		const fetch = vi.fn<IntegrationProbe['fetch']>();
		const probe: IntegrationProbe = {
			connect: () => Promise.reject(new Error('connect ECONNREFUSED')),
			fetch,
		};
		const config = pyspark.configSchema.parse(FIXTURES.pyspark);

		const result = await pyspark.testConnection?.(config, probe);

		expect(result).toMatchObject({
			ok: false,
			details: 'connect ECONNREFUSED',
			latency_ms: expect.any(Number),
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('iceberg_rest: oauth2 token dance rides the probe, then hits /v1/config', async () => {
		const { probe, calls } = recordingProbe((url) =>
			url.includes('idp.internal') ? { access_token: 'tok' } : {},
		);
		const config = icebergRest.configSchema.parse(FIXTURES.iceberg_rest);
		const result = await icebergRest.testConnection?.(config, probe);
		expect(result?.ok).toBe(true);
		expect(calls.map((c) => c.url)).toEqual([
			'https://idp.internal/token',
			'https://catalog.internal/api/catalog/v1/config?warehouse=wh',
		]);
		expect(calls[0].init?.headers?.Authorization).toBe('Basic Y2lkOmNzZWM=');
		expect(calls[0].init?.body).toBe('grant_type=client_credentials&scope=catalog');
		expect(calls[1].init?.headers?.Authorization).toBe('Bearer tok');
	});

	it('iceberg_rest: the /v1/config probe survives a URI with a query and fragment', async () => {
		const { probe, calls } = recordingProbe(() => ({}));
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal/api/catalog?tenant=acme#frag',
			warehouse: 'wh',
			auth: { method: 'none' },
		});
		const result = await icebergRest.testConnection?.(config, probe);
		expect(result?.ok).toBe(true);
		expect(calls[0].url).toBe(
			'https://catalog.internal/api/catalog/v1/config?tenant=acme&warehouse=wh',
		);
	});

	it('iceberg_rest: custom TLS material is reported as sandbox-only, never probed', async () => {
		const { probe, calls } = recordingProbe(() => ({}));
		const config = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'none' },
			tls: { ca_bundle: 'CA' },
		});
		const result = await icebergRest.testConnection?.(config, probe);
		expect(result?.ok).toBe(false);
		expect(result?.details).toMatch(/inside the sandbox/);
		expect(calls).toHaveLength(0);
	});

	// A transport error can quote the request it failed on, so every probe has to
	// sanitize it. Driven off the registry rather than a hand-picked pair: a new
	// kind's probe is covered the moment it is registered.
	it('no probe echoes a configured secret when the transport fails', async () => {
		const registry = defaultRegistry();
		for (const def of registry.list()) {
			if (!def.testConnection) continue;
			const config = def.configSchema.parse(FIXTURES[def.kind]);
			const secrets = secretValuesOf(config, registry.secretPathsOf(def.kind));
			expect(secrets.length, `${def.kind} fixture must configure a secret`).toBeGreaterThan(0);
			const probe: IntegrationProbe = {
				connect: () => Promise.reject(new Error(`transport failed with ${secrets.join(' ')}`)),
				fetch: () => Promise.reject(new Error(`transport failed with ${secrets.join(' ')}`)),
			};
			const result = await def.testConnection(config, probe);
			// A kind that reported no detail at all would pass the check below for
			// the wrong reason.
			expect(typeof result.details, def.kind).toBe('string');
			for (const value of secrets) {
				expect(result.details, def.kind).not.toContain(value);
			}
		}
	});
});

describe('render purity', () => {
	it('kinds expose no async render (sync = cannot fetch/await hidden state)', () => {
		for (const def of defaultRegistry().list()) {
			const result = def.render(input(FIXTURES[def.kind], def));
			expect(result, def.kind).not.toBeInstanceOf(Promise);
		}
	});
});

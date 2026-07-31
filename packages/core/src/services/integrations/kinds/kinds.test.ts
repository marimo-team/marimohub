import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ValidationError } from '../../../errors';
import { createProjectId, createSessionId, UserId } from '../../../ids';
import type { IntegrationProbe, ProbeRequestInit } from '../../../ports/integrations';
import { bundleIntegrations, INTEGRATIONS_DIR } from '../bundle';
import { SECRET_MARK } from '../secretFields';
import type { IntegrationDefinition, RenderInput } from '../sdk';
import { customEnv } from './customEnv';
import {
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergSql,
} from './icebergCatalogs';
import { icebergRest } from './icebergRest';
import { defaultRegistry } from './index';
import { postgres } from './postgres';
import { pyspark } from './pyspark';
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
				'postgresql://svc%20user:p%40ss%3Aword@db.internal:5432/analytics?sslmode=verify-full',
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

	it('postgres: brackets an IPv6 literal in the rendered URL but not in the env/descriptor', () => {
		const config = postgres.configSchema.parse({
			...(FIXTURES.postgres as object),
			host: '2001:db8::1',
		});
		const out = postgres.render(input(config, postgres));
		expect(out.env?.MARIMOHUB_PG_PROD_URL).toContain('@[2001:db8::1]:5432/');
		// libpq's PGHOST-style fields take the bare address.
		expect(out.env?.MARIMOHUB_PG_PROD_HOST).toBe('2001:db8::1');
		expect(new URL(out.env?.MARIMOHUB_PG_PROD_URL ?? '').hostname).toBe('[2001:db8::1]');
	});

	it('postgres: TLS verification is the default and a custom CA lands outside the workspace', () => {
		const parse = (ssl: unknown) =>
			postgres.configSchema.parse({ ...(FIXTURES.postgres as object), ssl });
		const sslmode = (config: unknown) =>
			new URL(postgres.render(input(config, postgres)).env?.MARIMOHUB_PG_PROD_URL ?? '')
				.searchParams;

		expect(sslmode(parse(undefined)).get('sslmode')).toBe('verify-full');
		// `require` encrypts without authenticating the server: opt-in, never implied.
		expect(sslmode(parse({ mode: 'require' })).get('sslmode')).toBe('require');
		expect(sslmode(parse({ mode: 'disable' })).get('sslmode')).toBe('disable');

		const withCa = postgres.render(
			input(parse({ mode: 'verify-full', ca_bundle: 'CA' }), postgres),
		);
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

	it('postgres: the v1 boolean ssl flag migrates to its exact libpq mode', () => {
		const migrate = (ssl: unknown) =>
			postgres.migrate?.({ ...(FIXTURES.postgres as object), ssl }, 1) as { ssl: unknown };
		expect(migrate(true).ssl).toEqual({ mode: 'require' });
		// v1 `false` emitted no sslmode at all, i.e. libpq's `prefer`.
		expect(migrate(false).ssl).toEqual({ mode: 'prefer' });
		expect(migrate(undefined).ssl).toEqual({ mode: 'require' });
		expect(() => postgres.configSchema.parse(migrate(true))).not.toThrow();
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

	it('pyspark: renders a Spark Connect URL and SparkSession config', () => {
		const config = pyspark.configSchema.parse({
			host: 'spark.internal',
			port: 15003,
			auth: { method: 'token', token: 'spark-token' },
			user_id: 'ada',
			user_agent: 'marimohub',
			app_name: 'analytics',
			metadata: [{ name: 'x-project', value: 'project-secret' }],
			spark_config: { 'spark.sql.session.timeZone': 'UTC' },
			secret_spark_config: [{ name: 'spark.hadoop.fs.s3a.secret.key', value: 's3-secret' }],
		});
		const out = pyspark.render(input(config, pyspark));
		const remote = out.env?.MARIMOHUB_PYSPARK_PROD_REMOTE ?? '';
		expect(remote).toContain('sc://spark.internal:15003/;use_ssl=true');
		expect(remote).toContain('token=spark-token');
		expect(remote).toContain('user_id=ada');
		expect(remote).toContain('x-project=project-secret');
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
		for (const headers of [
			{ 'X-Trace': 'safe\r\nAuthorization: Bearer injected' },
			{ Authorization: 'Bearer plain-text-secret' },
		]) {
			const config = icebergRest.configSchema.parse({
				uri: 'https://catalog.internal',
				auth: { method: 'none' },
				headers,
			});
			expect(() => icebergRest.validate?.(config)).toThrow(ValidationError);
		}
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
		expect(bundle.attachments).toHaveLength(10);
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
	])('rejects an unsafe rendered path: %s', (path) => {
		expect(() =>
			bundleIntegrations(
				[synthetic('unsafe', { files: [{ path, content: 'x' }] })],
				createSessionId(),
			),
		).toThrow(/invalid file path/);
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
			return;
		}
		const union = (node.oneOf ?? node.anyOf) as Node[] | undefined;
		if (union) {
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
				for (const [key, child] of Object.entries(props)) walk(child, `${path}.${key}`, kind);
				const additional = node.additionalProperties as Node | undefined;
				if (additional && typeof additional === 'object') {
					// kv-pairs record: string values only, never secrets.
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
		const probe: IntegrationProbe = {
			fetch: (url, init) => {
				calls.push({ url, init });
				return Promise.resolve({ ok: true, status: 200, json: async () => respond(url) });
			},
		};
		return { probe, calls };
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

	it('probe failures never echo configured secret values in result details', async () => {
		const secret = 'do-not-return-this-secret';
		const probe: IntegrationProbe = {
			fetch: () => Promise.reject(new Error(`transport failed with ${secret}`)),
		};
		const trinoConfig = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'basic', username: 'svc', password: secret },
		});
		const icebergConfig = icebergRest.configSchema.parse({
			uri: 'https://catalog.internal',
			auth: { method: 'bearer_token', token: secret },
		});

		const results = await Promise.all([
			trino.testConnection?.(trinoConfig, probe),
			icebergRest.testConnection?.(icebergConfig, probe),
		]);
		for (const result of results) {
			expect(result?.details).not.toContain(secret);
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

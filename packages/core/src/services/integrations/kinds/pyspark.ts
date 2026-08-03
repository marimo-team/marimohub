import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { INTEGRATIONS_DIR } from '../bundle';
import { defineIntegration, envSegment, HOSTNAME_REGEX } from '../sdk';
import { zSecret } from '../secretFields';
import { discoveryEnvField } from './common';

const METADATA_KEY_REGEX = /^[0-9a-z_.-]+$/;
const SPARK_CONFIG_KEY_REGEX = /^[A-Za-z0-9._-]+$/;
// Spark property names separate words with `.`, `-`, or `_` interchangeably
// (`spark.foo.api_key`), so all three have to count as a separator here.
const SENSITIVE_CONFIG_REGEX =
	/token|credential|password|secret|access[._-]?key|api[._-]?key|authorization|private[._-]?key|account[._-]?key|sas/i;
const RESERVED_PARAMETERS = new Set([
	'token',
	'use_ssl',
	'user_id',
	'user_agent',
	'session_id',
	'grpc_keepalive_enabled',
	'grpc_keepalive_time_ms',
	'grpc_keepalive_timeout_ms',
	'grpc_keepalive_without_calls',
]);

const pysparkConfig = z.strictObject({
	host: z.string().regex(HOSTNAME_REGEX, 'Hostname only — no scheme, port, path, or credentials'),
	port: z.number().int().min(1).max(65535).default(15002),
	use_ssl: z.boolean().default(true),
	auth: z
		.discriminatedUnion('method', [
			z.strictObject({ method: z.literal('none') }),
			z.strictObject({ method: z.literal('token'), token: zSecret() }),
		])
		.default({ method: 'none' }),
	user_id: z.string().min(1).optional(),
	user_agent: z.string().min(1).max(512).optional(),
	app_name: z.string().min(1).optional(),
	keepalive: z
		.strictObject({
			enabled: z.boolean().default(true),
			time_ms: z.number().int().positive().default(60_000),
			timeout_ms: z.number().int().positive().default(20_000),
			without_calls: z.boolean().default(true),
		})
		.default({
			enabled: true,
			time_ms: 60_000,
			timeout_ms: 20_000,
			without_calls: true,
		}),
	metadata: z
		.array(z.strictObject({ name: z.string().regex(METADATA_KEY_REGEX), value: zSecret() }))
		.refine((items) => new Set(items.map(({ name }) => name)).size === items.length, {
			message: 'Metadata names must be unique',
		})
		.meta({ 'x-unique-by': 'name' })
		.default([]),
	spark_config: z.record(z.string(), z.string()).default({}),
	secret_spark_config: z
		.array(z.strictObject({ name: z.string().regex(SPARK_CONFIG_KEY_REGEX), value: zSecret() }))
		.refine((items) => new Set(items.map(({ name }) => name)).size === items.length, {
			message: 'Secret Spark configuration names must be unique',
		})
		.meta({ 'x-unique-by': 'name' })
		.default([]),
	ambient_env: discoveryEnvField('SPARK_REMOTE'),
});

export const pyspark = defineIntegration({
	kind: 'pyspark',
	title: 'PySpark (Spark Connect)',
	description: 'Remote PySpark DataFrame sessions over Spark Connect.',
	category: 'engine',
	brand: { icon: 'apachespark', color: '#E25A1C' },
	schemaVersion: 1,
	configSchema: pysparkConfig,
	environmentVariables: ['SPARK_REMOTE'],
	requirements: ['pyspark[connect]>=4.2'],
	uiHints: {
		host: { group: 'Connection', order: 1 },
		port: { group: 'Connection', order: 2, widget: 'number' },
		use_ssl: { group: 'Connection', order: 3, widget: 'toggle' },
		auth: { group: 'Authentication', order: 10 },
		'auth.token': { widget: 'password' },
		user_id: { group: 'Identity', order: 20, advanced: true },
		user_agent: { group: 'Identity', order: 21, advanced: true },
		app_name: { group: 'Session', order: 30 },
		keepalive: { group: 'Connection', order: 40, advanced: true },
		metadata: { group: 'Advanced', order: 50, advanced: true },
		'metadata.*.value': { widget: 'password' },
		spark_config: { group: 'Spark config', order: 60, advanced: true, widget: 'kv-pairs' },
		secret_spark_config: { group: 'Spark config', order: 61, advanced: true },
		'secret_spark_config.*.value': { widget: 'password' },
		ambient_env: { group: 'Discovery', order: 70, widget: 'toggle', advanced: true },
	},

	validate(config) {
		if (config.auth.method === 'token' && !config.use_ssl) {
			throw new ValidationError('Spark Connect token authentication requires TLS.');
		}
		const metadataNames = config.metadata.map(({ name }) => name);
		for (const name of metadataNames) {
			if (!METADATA_KEY_REGEX.test(name) || name.endsWith('-bin')) {
				throw new ValidationError(`Invalid Spark Connect metadata key "${name}".`);
			}
			if (RESERVED_PARAMETERS.has(name)) {
				throw new ValidationError(`Spark Connect parameter "${name}" has a typed field.`);
			}
		}
		const secretNames = new Set(config.secret_spark_config.map(({ name }) => name));
		for (const key of Object.keys(config.spark_config)) {
			if (key.trim() === '') throw new ValidationError('Spark configuration keys cannot be empty.');
			if (SENSITIVE_CONFIG_REGEX.test(key)) {
				throw new ValidationError(
					`Spark configuration "${key}" looks credential-bearing; use secret Spark config.`,
				);
			}
			if (secretNames.has(key)) {
				throw new ValidationError(`Spark configuration "${key}" is configured twice.`);
			}
		}
	},

	render({ config, instanceName }) {
		const seg = envSegment(instanceName);
		const prefix = `MARIMOHUB_PYSPARK_${seg}`;
		const parameters: [string, string][] = [
			['use_ssl', String(config.use_ssl)],
			['grpc_keepalive_enabled', String(config.keepalive.enabled)],
			['grpc_keepalive_time_ms', String(config.keepalive.time_ms)],
			['grpc_keepalive_timeout_ms', String(config.keepalive.timeout_ms)],
			['grpc_keepalive_without_calls', String(config.keepalive.without_calls)],
		];
		if (config.auth.method === 'token') parameters.push(['token', config.auth.token]);
		if (config.user_id) parameters.push(['user_id', config.user_id]);
		if (config.user_agent) parameters.push(['user_agent', config.user_agent]);
		for (const { name, value } of config.metadata) parameters.push([name, value]);
		const remote = `sc://${config.host}:${config.port}/;${parameters
			.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
			.join(';')}`;
		const configPath = `${INTEGRATIONS_DIR}/pyspark/${instanceName}.json`;
		const sparkConfig = {
			...config.spark_config,
			...Object.fromEntries(config.secret_spark_config.map(({ name, value }) => [name, value])),
		};

		return {
			env: {
				[`${prefix}_REMOTE`]: remote,
				[`${prefix}_CONFIG`]: configPath,
				...(config.auth.method === 'token' ? { [`${prefix}_TOKEN`]: config.auth.token } : {}),
				// The same string: SPARK_REMOTE is what `SparkSession.builder` reads on
				// its own, so this needs no separate contract.
				...(config.ambient_env ? { SPARK_REMOTE: remote } : {}),
			},
			files: [
				{
					path: `pyspark/${instanceName}.json`,
					content: `${JSON.stringify(
						{
							remote_env: `${prefix}_REMOTE`,
							...(config.app_name ? { app_name: config.app_name } : {}),
							spark_config: sparkConfig,
						},
						null,
						'\t',
					)}\n`,
				},
			],
			manifestExtra: {
				host: config.host,
				port: config.port,
				auth_method: config.auth.method,
			},
		};
	},
});

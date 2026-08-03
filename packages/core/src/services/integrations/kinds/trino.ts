import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { INTEGRATIONS_DIR } from '../bundle';
import {
	basicAuthHeader,
	defineIntegration,
	envSegment,
	HOSTNAME_REGEX,
	probeEndpoint,
} from '../sdk';
import { zSecret } from '../secretFields';
import { discoveryEnvField } from './common';

const IDENTIFIER_REGEX = /^[A-Za-z0-9_.-]+$/;
const HEADER_NAME_REGEX = /^[A-Za-z0-9-]+$/;
const TIMEZONE_REGEX = /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/;
const mutualAuthenticationSchema = z.enum(['required', 'optional', 'disabled']);

const authSchema = z.discriminatedUnion('method', [
	z.object({ method: z.literal('none') }),
	z.object({
		method: z.literal('basic'),
		username: z.string().min(1),
		password: zSecret(),
	}),
	z.object({ method: z.literal('jwt'), token: zSecret() }),
	z.object({ method: z.literal('oauth2') }),
	z.object({
		method: z.literal('certificate'),
		client_certificate: z.string().min(1),
		client_key: zSecret(),
	}),
	z.object({
		method: z.literal('kerberos'),
		krb5_config: z.string().min(1).optional(),
		service_name: z.string().min(1).optional(),
		mutual_authentication: mutualAuthenticationSchema.default('required'),
		force_preemptive: z.boolean().default(false),
		hostname_override: z.string().min(1).optional(),
		sanitize_mutual_error_response: z.boolean().default(true),
		principal: z.string().min(1).optional(),
		delegate: z.boolean().default(false),
	}),
	z.object({
		method: z.literal('gssapi'),
		krb5_config: z.string().min(1).optional(),
		service_name: z.string().min(1).optional(),
		mutual_authentication: mutualAuthenticationSchema.default('disabled'),
		force_preemptive: z.boolean().default(false),
		hostname_override: z.string().min(1).optional(),
		sanitize_mutual_error_response: z.boolean().default(true),
		principal: z.string().min(1).optional(),
		delegate: z.boolean().default(false),
	}),
]);

const tlsSchema = z
	.discriminatedUnion('verification', [
		z.object({ verification: z.literal('system') }),
		z.object({ verification: z.literal('disabled') }),
		z.object({ verification: z.literal('custom_ca'), ca_bundle: z.string().min(1) }),
	])
	.default({ verification: 'system' });

const trinoConfig = z.object({
	host: z
		.string()
		.regex(HOSTNAME_REGEX, 'Hostname only — no scheme, port, path, or credentials')
		.describe('Coordinator hostname, e.g. trino.internal'),
	port: z.number().int().min(1).max(65535).default(443),
	http_scheme: z.enum(['https', 'http']).default('https'),
	user: z.string().min(1).optional().describe('Query user; defaults to the signed-in user'),
	auth: authSchema,
	tls: tlsSchema,
	default_catalog: z.string().regex(IDENTIFIER_REGEX).optional(),
	default_schema: z.string().regex(IDENTIFIER_REGEX).optional(),
	source: z.string().min(1).optional(),
	session_properties: z.record(z.string(), z.string()).default({}),
	roles: z.record(z.string(), z.string()).default({}),
	client_tags: z.array(z.object({ value: z.string().min(1) })).default([]),
	http_headers: z.array(z.object({ name: z.string().min(1), value: zSecret() })).default([]),
	extra_credentials: z
		.array(z.object({ name: z.string().regex(IDENTIFIER_REGEX), value: zSecret() }))
		.default([]),
	timezone: z.string().regex(TIMEZONE_REGEX).optional(),
	encoding: z
		.array(z.object({ value: z.enum(['json', 'json+lz4', 'json+zstd']) }))
		.min(1)
		.optional(),
	max_attempts: z.number().int().positive().optional(),
	request_timeout_seconds: z.number().positive().optional(),
	heartbeat_interval_seconds: z.number().positive().optional(),
	isolation_level: z
		.enum(['AUTOCOMMIT', 'READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE'])
		.default('AUTOCOMMIT'),
	legacy_primitive_types: z.boolean().default(false),
	legacy_prepared_statements: z.boolean().optional(),
	ambient_env: discoveryEnvField(
		'TRINO_HOST, TRINO_PORT, TRINO_USER, TRINO_CATALOG, and TRINO_PASSWORD',
	),
});

export const trino = defineIntegration({
	kind: 'trino',
	title: 'Trino',
	description: 'Trino DBAPI and SQLAlchemy connection with authentication and session options.',
	category: 'engine',
	brand: { icon: 'trino', color: '#DD00A1' },
	schemaVersion: 2,
	configSchema: trinoConfig,
	requirements: ['trino[sqlalchemy,kerberos,gssapi]>=0.330'],
	uiHints: {
		host: { group: 'Connection', order: 1 },
		port: { group: 'Connection', order: 2, widget: 'number' },
		http_scheme: { group: 'Connection', order: 3 },
		user: { group: 'Connection', order: 4, advanced: true },
		auth: { group: 'Authentication', order: 10 },
		'auth.password': { widget: 'password' },
		'auth.token': { widget: 'password' },
		'auth.client_certificate': { widget: 'textarea' },
		'auth.client_key': { widget: 'password' },
		'auth.krb5_config': { widget: 'textarea' },
		tls: { group: 'TLS', order: 15, advanced: true },
		'tls.ca_bundle': { widget: 'textarea' },
		default_catalog: { group: 'Defaults', order: 20, advanced: true },
		default_schema: { group: 'Defaults', order: 21, advanced: true },
		source: { group: 'Session', order: 30, advanced: true },
		session_properties: { group: 'Session', order: 31, advanced: true, widget: 'kv-pairs' },
		roles: { group: 'Session', order: 32, advanced: true, widget: 'kv-pairs' },
		client_tags: { group: 'Session', order: 33, advanced: true },
		http_headers: { group: 'Session', order: 34, advanced: true },
		'http_headers.*.value': { widget: 'password' },
		extra_credentials: { group: 'Session', order: 35, advanced: true },
		'extra_credentials.*.value': { widget: 'password' },
		timezone: { group: 'Client', order: 40, advanced: true },
		encoding: { group: 'Client', order: 41, advanced: true },
		max_attempts: { group: 'Client', order: 42, advanced: true, widget: 'number' },
		request_timeout_seconds: { group: 'Client', order: 43, advanced: true, widget: 'number' },
		heartbeat_interval_seconds: {
			group: 'Client',
			order: 44,
			advanced: true,
			widget: 'number',
		},
		isolation_level: { group: 'Client', order: 45, advanced: true },
		legacy_primitive_types: { group: 'Compatibility', order: 50, advanced: true, widget: 'toggle' },
		legacy_prepared_statements: {
			group: 'Compatibility',
			order: 51,
			advanced: true,
			widget: 'toggle',
		},
		ambient_env: { group: 'Discovery', order: 60, widget: 'toggle', advanced: true },
	},

	validate(config) {
		if (config.auth.method !== 'none' && config.http_scheme !== 'https') {
			throw new ValidationError('Trino authentication requires HTTPS.');
		}
		if (config.tls.verification !== 'system' && config.http_scheme !== 'https') {
			throw new ValidationError('TLS verification settings require HTTPS.');
		}
		assertUnique(
			config.client_tags.map(({ value }) => value),
			'client tag',
		);
		assertUnique(
			config.http_headers.map(({ name }) => name.toLowerCase()),
			'HTTP header',
		);
		assertUnique(
			config.extra_credentials.map(({ name }) => name),
			'extra credential',
		);
		for (const { name } of config.http_headers) {
			if (!HEADER_NAME_REGEX.test(name)) {
				throw new ValidationError(`Invalid HTTP header name "${name}".`);
			}
			if (
				name.toLowerCase().startsWith('x-trino-') ||
				/authorization|cookie|token|secret|api-key/i.test(name)
			) {
				throw new ValidationError(
					`HTTP header "${name}" is reserved or managed through typed fields.`,
				);
			}
		}
		for (const key of Object.keys(config.session_properties)) {
			if (key.trim() === '') throw new ValidationError('Session property keys cannot be empty.');
		}
		for (const key of Object.keys(config.roles)) {
			if (!IDENTIFIER_REGEX.test(key)) {
				throw new ValidationError(`Invalid role catalog "${key}".`);
			}
		}
		if (
			config.auth.method === 'gssapi' &&
			config.auth.service_name &&
			!config.auth.hostname_override
		) {
			throw new ValidationError(
				'GSSAPI service_name requires hostname_override in the Trino client.',
			);
		}
		if (config.encoding) {
			assertUnique(
				config.encoding.map(({ value }) => value),
				'spooling encoding',
			);
		}
		if (config.ambient_env) {
			if (!config.default_catalog) {
				throw new ValidationError(
					'marimo discovers a Trino connection only when a catalog is set, so ambient_env ' +
						'requires default_catalog.',
				);
			}
			// The connection marimo builds from TRINO_* uses Basic auth over HTTPS when
			// it sees a password and plain HTTP otherwise. Any other combination here
			// would advertise a connection that cannot authenticate or cannot reach the
			// coordinator, so it is refused rather than rendered.
			const discoverable =
				config.auth.method === 'basic' ||
				(config.auth.method === 'none' && config.http_scheme === 'http');
			if (!discoverable) {
				throw new ValidationError(
					'marimo discovers Trino as Basic auth over HTTPS, or no auth over HTTP. This ' +
						'authentication mode cannot be expressed that way — leave ambient_env off and ' +
						'connect through MARIMOHUB_TRINO_<NAME>_URL.',
				);
			}
		}
	},

	migrate(stored) {
		return stored;
	},

	render({ config, instanceName, principal }) {
		const seg = envSegment(instanceName);
		const prefix = `MARIMOHUB_TRINO_${seg}`;
		const user =
			config.user ?? (config.auth.method === 'basic' ? config.auth.username : principal.email);
		const files: { path: string; content: string }[] = [];
		const env: Record<string, string> = {};
		const tls = renderTls(config.tls, instanceName, files);
		const auth = renderAuth(config.auth, instanceName, prefix, files, env, tls);
		const headers = config.http_headers.map(({ name, value }, index) => {
			const envName = `${prefix}_HTTP_HEADER_${index}`;
			env[envName] = value;
			return { name, value, value_env: envName };
		});
		const extraCredentials = config.extra_credentials.map(({ name, value }, index) => {
			const envName = `${prefix}_EXTRA_CREDENTIAL_${index}`;
			env[envName] = value;
			return { name, value, value_env: envName };
		});
		const url = sqlalchemyUrl({
			config,
			user,
			auth,
			tls,
			headers,
			extraCredentials,
		});
		const configPath = `${INTEGRATIONS_DIR}/trino/${instanceName}.json`;
		Object.assign(env, {
			[`${prefix}_URL`]: url,
			[`${prefix}_CONFIG`]: configPath,
			[`${prefix}_HOST`]: config.host,
			[`${prefix}_PORT`]: String(config.port),
			[`${prefix}_SCHEME`]: config.http_scheme,
			[`${prefix}_USER`]: user,
			...(config.auth.method === 'basic'
				? {
						[`${prefix}_AUTH_USER`]: config.auth.username,
						[`${prefix}_PASSWORD`]: config.auth.password,
					}
				: {}),
			...(config.ambient_env
				? {
						TRINO_HOST: config.host,
						TRINO_PORT: String(config.port),
						TRINO_USER: user,
						TRINO_CATALOG: config.default_catalog ?? '',
						...(config.default_schema ? { TRINO_SCHEMA: config.default_schema } : {}),
						...(config.auth.method === 'basic' ? { TRINO_PASSWORD: config.auth.password } : {}),
					}
				: {}),
		});

		files.push({
			path: `trino/${instanceName}.json`,
			content: `${JSON.stringify(
				{
					host: config.host,
					port: config.port,
					http_scheme: config.http_scheme,
					user,
					auth,
					tls,
					...(config.default_catalog ? { catalog: config.default_catalog } : {}),
					...(config.default_schema ? { schema: config.default_schema } : {}),
					...(config.source ? { source: config.source } : {}),
					session_properties: config.session_properties,
					roles: config.roles,
					client_tags: config.client_tags.map(({ value }) => value),
					http_headers: headers.map(({ name, value_env }) => ({ name, value_env })),
					extra_credentials: extraCredentials.map(({ name, value_env }) => ({
						name,
						value_env,
					})),
					...(config.timezone ? { timezone: config.timezone } : {}),
					...(config.encoding ? { encoding: config.encoding.map(({ value }) => value) } : {}),
					...(config.max_attempts ? { max_attempts: config.max_attempts } : {}),
					...(config.request_timeout_seconds
						? { request_timeout: config.request_timeout_seconds }
						: {}),
					...(config.heartbeat_interval_seconds
						? { heartbeat_interval: config.heartbeat_interval_seconds }
						: {}),
					isolation_level: config.isolation_level,
					legacy_primitive_types: config.legacy_primitive_types,
					...(config.legacy_prepared_statements === undefined
						? {}
						: { legacy_prepared_statements: config.legacy_prepared_statements }),
					url_env: `${prefix}_URL`,
				},
				null,
				'\t',
			)}\n`,
		});

		return {
			env,
			files,
			manifestExtra: { host: config.host, auth_method: config.auth.method },
		};
	},

	testConnection(config, probe) {
		if (
			config.auth.method === 'oauth2' ||
			config.auth.method === 'certificate' ||
			config.auth.method === 'kerberos' ||
			config.auth.method === 'gssapi' ||
			config.tls.verification !== 'system'
		) {
			return Promise.resolve({
				ok: false,
				latency_ms: 0,
				details: 'This authentication or TLS mode can only be exercised inside the sandbox',
			});
		}
		const headers = Object.fromEntries(config.http_headers.map(({ name, value }) => [name, value]));
		addProbeAuth(headers, config.auth);
		return probeEndpoint({
			probe,
			url: `${config.http_scheme}://${config.host}:${config.port}/v1/info`,
			init: { headers },
			carriesSecrets: config.auth.method !== 'none',
			describe(body) {
				const version = (body as { nodeVersion?: { version?: string } } | undefined)?.nodeVersion
					?.version;
				return version ? `Trino ${version}` : 'reachable';
			},
		});
	},
});

type Auth = z.infer<typeof authSchema>;
type Tls = z.infer<typeof tlsSchema>;

function renderAuth(
	auth: Auth,
	instanceName: string,
	prefix: string,
	files: { path: string; content: string }[],
	env: Record<string, string>,
	tls: Record<string, unknown>,
): Record<string, unknown> {
	switch (auth.method) {
		case 'none':
			return { method: 'none' };
		case 'basic':
			return {
				method: 'basic',
				username: auth.username,
				password_env: `${prefix}_PASSWORD`,
			};
		case 'jwt':
			env[`${prefix}_TOKEN`] = auth.token;
			return { method: 'jwt', token_env: `${prefix}_TOKEN` };
		case 'oauth2':
			return { method: 'oauth2' };
		case 'certificate': {
			const cert = `${INTEGRATIONS_DIR}/trino/${instanceName}-client.crt`;
			const key = `${INTEGRATIONS_DIR}/trino/${instanceName}-client.key`;
			files.push(
				{ path: `trino/${instanceName}-client.crt`, content: auth.client_certificate },
				{ path: `trino/${instanceName}-client.key`, content: auth.client_key },
			);
			return { method: 'certificate', cert, key };
		}
		case 'kerberos':
		case 'gssapi': {
			const krb5Config = auth.krb5_config
				? `${INTEGRATIONS_DIR}/trino/${instanceName}-krb5.conf`
				: undefined;
			if (krb5Config) {
				files.push({
					path: `trino/${instanceName}-krb5.conf`,
					content: auth.krb5_config ?? '',
				});
			}
			return {
				method: auth.method,
				...(krb5Config ? { config: krb5Config } : {}),
				...(auth.service_name ? { service_name: auth.service_name } : {}),
				mutual_authentication: auth.mutual_authentication,
				force_preemptive: auth.force_preemptive,
				...(auth.hostname_override ? { hostname_override: auth.hostname_override } : {}),
				sanitize_mutual_error_response: auth.sanitize_mutual_error_response,
				...(auth.principal ? { principal: auth.principal } : {}),
				delegate: auth.delegate,
				...(tls.verification === 'custom_ca' ? { ca_bundle: tls.ca } : {}),
			};
		}
	}
}

function renderTls(
	tls: Tls,
	instanceName: string,
	files: { path: string; content: string }[],
): Record<string, unknown> {
	if (tls.verification !== 'custom_ca') return { verification: tls.verification };
	const ca = `${INTEGRATIONS_DIR}/trino/${instanceName}-ca.pem`;
	files.push({ path: `trino/${instanceName}-ca.pem`, content: tls.ca_bundle });
	return { verification: 'custom_ca', ca };
}

function sqlalchemyUrl(options: {
	config: z.infer<typeof trinoConfig>;
	user: string;
	auth: Record<string, unknown>;
	tls: Record<string, unknown>;
	headers: { name: string; value: string }[];
	extraCredentials: { name: string; value: string }[];
}): string {
	const { config, user, auth, tls, headers, extraCredentials } = options;
	const credentials =
		config.auth.method === 'basic'
			? `${encodeURIComponent(user)}:${encodeURIComponent(config.auth.password)}`
			: encodeURIComponent(user);
	const catalogPath = config.default_catalog
		? `/${config.default_catalog}${config.default_schema ? `/${config.default_schema}` : ''}`
		: '';
	const query = new URLSearchParams({ http_scheme: config.http_scheme });
	if (config.source) query.set('source', config.source);
	if (Object.keys(config.session_properties).length > 0) {
		query.set('session_properties', JSON.stringify(config.session_properties));
	}
	if (headers.length > 0) {
		query.set(
			'http_headers',
			JSON.stringify(Object.fromEntries(headers.map((h) => [h.name, h.value]))),
		);
	}
	if (extraCredentials.length > 0) {
		query.set(
			'extra_credential',
			JSON.stringify(extraCredentials.map(({ name, value }) => [name, value])),
		);
	}
	if (config.client_tags.length > 0) {
		query.set('client_tags', JSON.stringify(config.client_tags.map(({ value }) => value)));
	}
	if (Object.keys(config.roles).length > 0) query.set('roles', JSON.stringify(config.roles));
	if (config.legacy_primitive_types) query.set('legacy_primitive_types', 'true');
	if (config.legacy_prepared_statements !== undefined) {
		query.set('legacy_prepared_statements', String(config.legacy_prepared_statements));
	}
	if (auth.method === 'jwt')
		query.set('access_token', config.auth.method === 'jwt' ? config.auth.token : '');
	if (auth.method === 'oauth2') query.set('externalAuthentication', 'true');
	if (auth.method === 'certificate') {
		query.set('cert', String(auth.cert));
		query.set('key', String(auth.key));
	}
	if (tls.verification === 'disabled') query.set('verify', 'false');
	if (tls.verification === 'custom_ca') query.set('verify', JSON.stringify(tls.ca));
	return `trino://${credentials}@${config.host}:${config.port}${catalogPath}?${query}`;
}

function addProbeAuth(headers: Record<string, string>, auth: Auth): void {
	if (auth.method === 'basic') {
		headers.Authorization = basicAuthHeader(auth.username, auth.password);
	} else if (auth.method === 'jwt') {
		headers.Authorization = `Bearer ${auth.token}`;
	}
}

function assertUnique(values: string[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw new ValidationError(`Duplicate ${label}.`);
	}
}

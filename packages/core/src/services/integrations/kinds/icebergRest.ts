import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { IntegrationProbe } from '../../../ports/integrations';
import { INTEGRATIONS_DIR } from '../bundle';
import { basicAuthHeader, defineIntegration, probeErrorDetails } from '../sdk';
import { zSecret } from '../secretFields';
import {
	extraPropertiesSchema,
	HTTP_URL_REGEX,
	icebergRuntimeSchema,
	icebergStorageSchema,
	icebergStorageUiHints,
	renderIcebergCatalog,
	runtimeCatalogProperties,
	runtimeRootProperties,
	storageProperties,
	validateExtraProperties,
} from './icebergShared';

const httpUrl = () =>
	z.string().regex(HTTP_URL_REGEX, 'Must be an http(s) URL without embedded credentials');

const authSchema = z.discriminatedUnion('method', [
	z.object({ method: z.literal('none') }),
	z.object({ method: z.literal('bearer_token'), token: zSecret() }),
	z.object({
		method: z.literal('basic'),
		username: z.string().min(1),
		password: zSecret(),
	}),
	z.object({
		method: z.literal('oauth2_client_credentials'),
		token_endpoint: httpUrl(),
		client_id: z.string().min(1),
		client_secret: zSecret(),
		scope: z.string().default('catalog'),
		refresh_margin_seconds: z.number().int().nonnegative().default(60),
		expires_in_seconds: z.number().int().positive().optional(),
	}),
	z.object({
		method: z.literal('sigv4'),
		region: z.string().min(1),
		signing_name: z.string().min(1).default('execute-api'),
	}),
	z.object({
		method: z.literal('google'),
		scopes: z.string().optional().describe('Comma-separated OAuth scopes; uses Google ADC'),
		credentials_json: zSecret().optional().describe('Google service-account JSON'),
	}),
	z.object({
		method: z.literal('entra'),
		scopes: z.string().optional().describe('Comma-separated OAuth scopes; uses Azure credentials'),
		managed_identity_client_id: z.string().min(1).optional(),
	}),
]);

const isInsecureUrl = (url: string) => url.startsWith('http://');

const icebergRestConfig = z.object({
	uri: httpUrl().describe('REST catalog base URI, e.g. https://catalog.internal/api/catalog'),
	warehouse: z.string().optional().describe('Warehouse name/path if the server hosts several'),
	allow_insecure_transport: z
		.boolean()
		.default(false)
		.describe('Allow http:// endpoints to carry credentials — local development only'),
	auth: authSchema,
	storage: icebergStorageSchema,
	runtime: icebergRuntimeSchema,
	access_delegation: z
		.enum(['none', 'vended_credentials', 'remote_signing', 'both'])
		.default('vended_credentials'),
	tls: z
		.object({
			ca_bundle: z.string().min(1).optional(),
			client_certificate: z.string().min(1).optional(),
			client_key: zSecret().optional(),
		})
		.default({}),
	rest: z
		.object({
			snapshot_loading_mode: z.enum(['all', 'refs']).default('all'),
			metrics_reporting_enabled: z.boolean().default(true),
			page_size: z.number().int().positive().optional(),
			view_endpoints_supported: z.boolean().default(false),
			scan_planning_mode: z.enum(['client', 'server']).default('client'),
			namespace_separator: z.string().min(1).default('%1F'),
			table_cache_expire_after_write_ms: z.number().int().nonnegative().default(300_000),
			table_cache_max_entries: z.number().int().positive().default(100),
		})
		.default({
			snapshot_loading_mode: 'all',
			metrics_reporting_enabled: true,
			view_endpoints_supported: false,
			scan_planning_mode: 'client',
			namespace_separator: '%1F',
			table_cache_expire_after_write_ms: 300_000,
			table_cache_max_entries: 100,
		}),
	headers: z
		.record(z.string(), z.string())
		.default({})
		.describe('Additional HTTP headers sent to the REST catalog'),
	extra_properties: extraPropertiesSchema,
});

const OWNED_PROP_KEYS = new Set([
	'type',
	'uri',
	'warehouse',
	'token',
	'credential',
	'scope',
	'oauth2-server-uri',
	'header.X-Iceberg-Access-Delegation',
	'snapshot-loading-mode',
	'rest-metrics-reporting-enabled',
	'rest-page-size',
	'view-endpoints-supported',
	'scan-planning-mode',
	'namespace-separator',
	'rest-table-cache.expire-after-write-ms',
	'rest-table-cache.max-entries',
]);

export const icebergRest = defineIntegration({
	kind: 'iceberg_rest',
	title: 'Iceberg REST Catalog',
	description: 'Connect to an Iceberg REST catalog such as Polaris, Unity, Gravitino, or Glue.',
	category: 'catalog',
	schemaVersion: 2,
	configSchema: icebergRestConfig,
	requirements: ['pyiceberg[pyarrow,s3fs,gcsfs,adlfs,hf,rest-sigv4,gcp-auth,entra-auth]>=0.11'],
	uiHints: {
		uri: { group: 'Connection', order: 1 },
		warehouse: { group: 'Connection', order: 2 },
		allow_insecure_transport: { group: 'Connection', order: 3, advanced: true, widget: 'toggle' },
		auth: { group: 'Authentication', order: 10 },
		'auth.token': { widget: 'password' },
		'auth.password': { widget: 'password' },
		'auth.client_secret': { widget: 'password' },
		'auth.credentials_json': { widget: 'password' },
		...icebergStorageUiHints,
		access_delegation: { group: 'Storage', order: 21 },
		tls: { group: 'TLS', order: 25, advanced: true },
		'tls.ca_bundle': { widget: 'textarea' },
		'tls.client_certificate': { widget: 'textarea' },
		'tls.client_key': { widget: 'password' },
		rest: { group: 'REST client', order: 30, advanced: true },
		headers: { group: 'Advanced', order: 40, advanced: true, widget: 'kv-pairs' },
		extra_properties: { group: 'Advanced', order: 41, advanced: true, widget: 'kv-pairs' },
	},

	validate(config) {
		if ((config.tls.client_certificate === undefined) !== (config.tls.client_key === undefined)) {
			throw new ValidationError('TLS client certificate and client key must be provided together.');
		}
		if (!config.allow_insecure_transport) {
			if (isInsecureUrl(config.uri) && config.auth.method !== 'none') {
				throw new ValidationError(
					'An authenticated REST catalog requires an https:// URI — bearer tokens, Basic ' +
						'passwords, and OAuth2 tokens would cross the network in cleartext. Enable ' +
						'allow_insecure_transport to override for local development.',
				);
			}
			if (
				isInsecureUrl(config.uri) &&
				(config.tls.ca_bundle !== undefined || config.tls.client_certificate !== undefined)
			) {
				throw new ValidationError('TLS material has no effect on an http:// catalog URI.');
			}
			if (
				config.auth.method === 'oauth2_client_credentials' &&
				isInsecureUrl(config.auth.token_endpoint)
			) {
				throw new ValidationError(
					'The OAuth2 token endpoint must be https:// — the client secret is sent to it as ' +
						'Basic auth. Enable allow_insecure_transport to override for local development.',
				);
			}
		}
		for (const [key, value] of Object.entries(config.headers)) {
			if (!/^[A-Za-z0-9-]+$/.test(key)) {
				throw new ValidationError(`Invalid HTTP header name "${key}".`);
			}
			if (/[\r\n]/.test(value)) {
				throw new ValidationError(`HTTP header "${key}" contains a line break.`);
			}
			if (key.toLowerCase() === 'x-iceberg-access-delegation') {
				throw new ValidationError(
					'X-Iceberg-Access-Delegation is managed by the access delegation field.',
				);
			}
			if (/authorization|cookie|token|secret|api-key/i.test(key)) {
				throw new ValidationError(
					`Header "${key}" looks credential-bearing; use a typed authentication field.`,
				);
			}
		}
		if (
			config.auth.method === 'sigv4' &&
			Object.keys(config.extra_properties).some((key) => key.startsWith('rest.sigv4'))
		) {
			throw new ValidationError('SigV4 extra properties conflict with the typed auth fields.');
		}
		validateExtraProperties(config.extra_properties, OWNED_PROP_KEYS);
	},

	migrate(stored, fromVersion) {
		if (fromVersion !== 1 || typeof stored !== 'object' || stored === null) return stored;
		const next = structuredClone(stored) as Record<string, unknown>;
		if (typeof next.vended_credentials === 'boolean' && next.access_delegation === undefined) {
			next.access_delegation = next.vended_credentials ? 'vended_credentials' : 'none';
		}
		delete next.vended_credentials;
		const storage = next.storage;
		if (typeof storage === 'object' && storage !== null) {
			delete (storage as Record<string, unknown>).path_style_access;
		}
		return next;
	},

	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const properties: Record<string, unknown> = {
			uri: config.uri,
			...(config.warehouse ? { warehouse: config.warehouse } : {}),
			...authProperties(config.auth, instanceName, files),
			...storageProperties(config.storage),
			...runtimeCatalogProperties(config.runtime),
			...delegationProperties(config.access_delegation),
			'snapshot-loading-mode': config.rest.snapshot_loading_mode,
			'rest-metrics-reporting-enabled': String(config.rest.metrics_reporting_enabled),
			...(config.rest.page_size ? { 'rest-page-size': String(config.rest.page_size) } : {}),
			'view-endpoints-supported': String(config.rest.view_endpoints_supported),
			'scan-planning-mode': config.rest.scan_planning_mode,
			'namespace-separator': config.rest.namespace_separator,
			'rest-table-cache.expire-after-write-ms': String(
				config.rest.table_cache_expire_after_write_ms,
			),
			'rest-table-cache.max-entries': String(config.rest.table_cache_max_entries),
			...Object.fromEntries(
				Object.entries(config.headers).map(([key, value]) => [`header.${key}`, value]),
			),
			...config.extra_properties,
		};
		const ssl: Record<string, unknown> = {};
		if (config.tls.ca_bundle) {
			const path = `${INTEGRATIONS_DIR}/iceberg/${instanceName}-ca.pem`;
			files.push({ path: `iceberg/${instanceName}-ca.pem`, content: config.tls.ca_bundle });
			ssl.cabundle = path;
		}
		if (config.tls.client_certificate && config.tls.client_key) {
			const cert = `${INTEGRATIONS_DIR}/iceberg/${instanceName}-client.crt`;
			const key = `${INTEGRATIONS_DIR}/iceberg/${instanceName}-client.key`;
			files.push(
				{ path: `iceberg/${instanceName}-client.crt`, content: config.tls.client_certificate },
				{ path: `iceberg/${instanceName}-client.key`, content: config.tls.client_key },
			);
			ssl.client = { cert, key };
		}
		if (Object.keys(ssl).length > 0) properties.ssl = ssl;

		return renderIcebergCatalog({
			instanceName,
			catalogType: 'rest',
			properties,
			rootProperties: runtimeRootProperties(config.runtime),
			descriptor: {
				uri: config.uri,
				...(config.warehouse ? { warehouse: config.warehouse } : {}),
				auth_method: config.auth.method,
				storage: config.storage.scheme,
			},
			files,
		});
	},

	async testConnection(config, probe) {
		const start = performance.now();
		if (
			config.auth.method === 'sigv4' ||
			config.auth.method === 'google' ||
			config.auth.method === 'entra'
		) {
			return {
				ok: false,
				latency_ms: 0,
				details: `${config.auth.method} authentication can only be exercised inside the sandbox`,
			};
		}
		// The probe has no seam for per-connection TLS material, so it would test a
		// different (hub-trusted) connection than the sandbox will make.
		if (config.tls.ca_bundle !== undefined || config.tls.client_certificate !== undefined) {
			return {
				ok: false,
				latency_ms: 0,
				details: 'a custom CA or client certificate can only be exercised inside the sandbox',
			};
		}
		try {
			const headers: Record<string, string> = { ...config.headers };
			if (config.auth.method === 'bearer_token') {
				headers.Authorization = `Bearer ${config.auth.token}`;
			} else if (config.auth.method === 'basic') {
				headers.Authorization = basicAuthHeader(config.auth.username, config.auth.password);
			} else if (config.auth.method === 'oauth2_client_credentials') {
				const token = await oauth2Token(config.auth, probe);
				if (!token.ok) {
					return {
						ok: false,
						latency_ms: Math.round(performance.now() - start),
						details: token.details,
					};
				}
				headers.Authorization = `Bearer ${token.value}`;
			}
			const res = await probe.fetch(configEndpoint(config.uri, config.warehouse), { headers });
			const latency_ms = Math.round(performance.now() - start);
			return res.ok
				? { ok: true, latency_ms, details: 'catalog reachable' }
				: { ok: false, latency_ms, details: `HTTP ${res.status}` };
		} catch (err) {
			return {
				ok: false,
				latency_ms: Math.round(performance.now() - start),
				details: probeErrorDetails(err, config.auth.method !== 'none'),
			};
		}
	},
});

/**
 * `/v1/config` under the catalog URI's path. String concatenation would append
 * the suffix to a query or fragment instead ("…/api?tenant=1/v1/config").
 */
function configEndpoint(uri: string, warehouse?: string): string {
	const url = new URL(uri);
	url.hash = '';
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/config`;
	if (warehouse) url.searchParams.set('warehouse', warehouse);
	return url.toString();
}

function authProperties(
	auth: z.infer<typeof authSchema>,
	instanceName: string,
	files: { path: string; content: string }[],
): Record<string, unknown> {
	switch (auth.method) {
		case 'none':
			return { auth: { type: 'noop' } };
		case 'bearer_token':
			return { token: auth.token };
		case 'basic':
			return {
				auth: {
					type: 'basic',
					basic: { username: auth.username, password: auth.password },
				},
			};
		case 'oauth2_client_credentials':
			return {
				auth: {
					type: 'oauth2',
					oauth2: {
						client_id: auth.client_id,
						client_secret: auth.client_secret,
						token_url: auth.token_endpoint,
						scope: auth.scope,
						refresh_margin: auth.refresh_margin_seconds,
						...(auth.expires_in_seconds ? { expires_in: auth.expires_in_seconds } : {}),
					},
				},
			};
		case 'sigv4':
			return {
				'rest.sigv4-enabled': 'true',
				'rest.signing-region': auth.region,
				'rest.signing-name': auth.signing_name,
			};
		case 'google':
			if (auth.credentials_json) {
				const relativePath = `iceberg/${instanceName}-google-service-account.json`;
				files.push({ path: relativePath, content: auth.credentials_json });
				return {
					auth: {
						type: 'google',
						google: {
							...(auth.scopes ? { scopes: commaSeparated(auth.scopes) } : {}),
							credentials_path: `${INTEGRATIONS_DIR}/${relativePath}`,
						},
					},
				};
			}
			return {
				auth: {
					type: 'google',
					google: auth.scopes ? { scopes: commaSeparated(auth.scopes) } : {},
				},
			};
		case 'entra':
			return {
				auth: {
					type: 'entra',
					entra: {
						...(auth.scopes ? { scopes: commaSeparated(auth.scopes) } : {}),
						...(auth.managed_identity_client_id
							? { managed_identity_client_id: auth.managed_identity_client_id }
							: {}),
					},
				},
			};
	}
}

function delegationProperties(
	mode: z.infer<typeof icebergRestConfig>['access_delegation'],
): Record<string, string> {
	switch (mode) {
		case 'none':
			return { 'header.X-Iceberg-Access-Delegation': '' };
		case 'vended_credentials':
			return { 'header.X-Iceberg-Access-Delegation': 'vended-credentials' };
		case 'remote_signing':
			return { 'header.X-Iceberg-Access-Delegation': 'remote-signing' };
		case 'both':
			return {
				'header.X-Iceberg-Access-Delegation': 'vended-credentials,remote-signing',
			};
	}
}

function commaSeparated(value: string): string[] {
	return value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

async function oauth2Token(
	auth: {
		token_endpoint: string;
		client_id: string;
		client_secret: string;
		scope: string;
	},
	probe: IntegrationProbe,
): Promise<{ ok: true; value: string } | { ok: false; details: string }> {
	const res = await probe.fetch(auth.token_endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: basicAuthHeader(auth.client_id, auth.client_secret),
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope: auth.scope,
		}).toString(),
	});
	if (!res.ok) return { ok: false, details: `token endpoint: HTTP ${res.status}` };
	const body = (await res.json()) as { access_token?: string } | undefined;
	return body?.access_token
		? { ok: true, value: body.access_token }
		: { ok: false, details: 'token endpoint returned no access_token' };
}

import { z } from 'zod';
import { NotFoundError, UnavailableError, ValidationError } from '../../../errors';
import { asRecord } from '../../../internal/validation';
import type {
	BrowsePageRequest,
	IntegrationProbe,
	QueryReadinessCheck,
	TableColumn,
	TableSchema,
} from '../../../ports/integrations';
import { INTEGRATIONS_DIR } from '../bundle';
import type { DuckDBHttpAccess } from '../data-preview/programs';
import { sqlIdentifier, sqlLiteral } from '../data-preview/sql';
import { basicAuthHeader, defineIntegration, probeErrorDetails } from '../sdk';
import { zSecret } from '../secretFields';
import {
	extraPropertiesSchema,
	ICEBERG_BRAND_COLOR,
	ICEBERG_RUNTIME_DEFAULTS,
	icebergRuntimeSchema,
	icebergRequirements,
	icebergRestStorageSchema,
	icebergStorageUiHints,
	renderIcebergCatalog,
	runtimeCatalogProperties,
	runtimeRootProperties,
	storageProperties,
	validateExtraProperties,
} from './icebergShared';
import { HTTP_HEADER_NAME_REGEX, httpUrlField, isInsecureHttpUrl } from './common';

const httpUrl = httpUrlField;

const authSchema = z.discriminatedUnion('method', [
	z.strictObject({ method: z.literal('none') }),
	z.strictObject({ method: z.literal('bearer_token'), token: zSecret() }),
	z.strictObject({
		method: z.literal('basic'),
		username: z.string().min(1),
		password: zSecret(),
	}),
	z.strictObject({
		method: z.literal('oauth2_client_credentials'),
		token_endpoint: httpUrl(),
		client_id: z.string().min(1),
		client_secret: zSecret(),
		scope: z.string().default('catalog'),
		refresh_margin_seconds: z.number().int().nonnegative().default(60),
		expires_in_seconds: z.number().int().positive().optional(),
	}),
	z.strictObject({
		method: z.literal('sigv4'),
		region: z.string().min(1),
		signing_name: z.string().min(1).default('execute-api'),
	}),
	z.strictObject({
		method: z.literal('google'),
		scopes: z.string().optional().describe('Comma-separated OAuth scopes; uses Google ADC'),
		credentials_json: zSecret().optional().describe('Google service-account JSON'),
	}),
	z.strictObject({
		method: z.literal('entra'),
		scopes: z.string().optional().describe('Comma-separated OAuth scopes; uses Azure credentials'),
		managed_identity_client_id: z.string().min(1).optional(),
	}),
]);

const ICEBERG_REST_DEFAULTS = {
	snapshot_loading_mode: 'all' as const,
	metrics_reporting_enabled: true,
	view_endpoints_supported: false,
	scan_planning_mode: 'client' as const,
	namespace_separator: '%1F',
	table_cache_expire_after_write_ms: 300_000,
	table_cache_max_entries: 100,
};

const icebergRestConfig = z.strictObject({
	uri: httpUrl().describe('REST catalog base URI, e.g. https://catalog.internal/api/catalog'),
	warehouse: z.string().optional().describe('Warehouse name/path if the server hosts several'),
	allow_insecure_transport: z
		.boolean()
		.default(false)
		.describe('Allow http:// endpoints to carry credentials — local development only'),
	auth: authSchema,
	storage: icebergRestStorageSchema,
	runtime: icebergRuntimeSchema,
	access_delegation: z
		.enum(['none', 'vended_credentials', 'remote_signing', 'both'])
		.default('vended_credentials')
		.describe('Catalog delegation mode. Guarded Run SQL supports none or R2 vended credentials.'),
	tls: z
		.strictObject({
			ca_bundle: z.string().min(1).optional(),
			client_certificate: z.string().min(1).optional(),
			client_key: zSecret().optional(),
		})
		.default({}),
	rest: z
		.strictObject({
			snapshot_loading_mode: z
				.enum(['all', 'refs'])
				.default(ICEBERG_REST_DEFAULTS.snapshot_loading_mode),
			metrics_reporting_enabled: z
				.boolean()
				.default(ICEBERG_REST_DEFAULTS.metrics_reporting_enabled),
			page_size: z.number().int().positive().optional(),
			view_endpoints_supported: z.boolean().default(ICEBERG_REST_DEFAULTS.view_endpoints_supported),
			scan_planning_mode: z
				.enum(['client', 'server'])
				.default(ICEBERG_REST_DEFAULTS.scan_planning_mode),
			namespace_separator: z.string().min(1).default(ICEBERG_REST_DEFAULTS.namespace_separator),
			table_cache_expire_after_write_ms: z
				.number()
				.int()
				.nonnegative()
				.default(ICEBERG_REST_DEFAULTS.table_cache_expire_after_write_ms),
			table_cache_max_entries: z
				.number()
				.int()
				.positive()
				.default(ICEBERG_REST_DEFAULTS.table_cache_max_entries),
		})
		.default(ICEBERG_REST_DEFAULTS),
	headers: z
		.record(z.string().regex(HTTP_HEADER_NAME_REGEX), z.string())
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
	brand: { color: ICEBERG_BRAND_COLOR },
	schemaVersion: 2,
	migrations: [
		{
			from: 1,
			to: 2,
			description:
				'Replace vended_credentials with access_delegation and remove obsolete S3 path-style configuration.',
		},
	],
	configSchema: icebergRestConfig,
	requirements: ['pyiceberg[pyarrow,s3fs,gcsfs,adlfs,hf,rest-sigv4,gcp-auth,entra-auth]>=0.11'],
	resolveRequirements: (config) => icebergRequirements(['pyarrow'], config),
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
		'storage.broker_read_locations': { advanced: true },
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
			if (isInsecureHttpUrl(config.uri) && config.auth.method !== 'none') {
				throw new ValidationError(
					'An authenticated REST catalog requires an https:// URI — bearer tokens, Basic ' +
						'passwords, and OAuth2 tokens would cross the network in cleartext. Enable ' +
						'allow_insecure_transport to override for local development.',
				);
			}
			if (
				isInsecureHttpUrl(config.uri) &&
				(config.tls.ca_bundle !== undefined || config.tls.client_certificate !== undefined)
			) {
				throw new ValidationError('TLS material has no effect on an http:// catalog URI.');
			}
			if (
				config.auth.method === 'oauth2_client_credentials' &&
				isInsecureHttpUrl(config.auth.token_endpoint)
			) {
				throw new ValidationError(
					'The OAuth2 token endpoint must be https:// — the client secret is sent to it as ' +
						'Basic auth. Enable allow_insecure_transport to override for local development.',
				);
			}
			if (usesInsecureAuthenticatedS3(config)) {
				throw new ValidationError(
					'Authenticated S3 storage requires an https:// endpoint. Enable ' +
						'allow_insecure_transport to override for local development.',
				);
			}
		}
		assertSafeHeaders(config.headers);
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
		return renderIcebergRest(config, instanceName);
	},

	preview: {
		available(config) {
			return {
				ok: true,
				programs: {
					...(duckdbPreviewBlocker(config) === undefined
						? { duckdbWasm: ['iceberg-http'] as const }
						: {}),
					python: true,
				},
			};
		},

		programs(input) {
			const render = renderIcebergRest(input.config, input.integration.name);
			const python = {
				script: PYICEBERG_PREVIEW_SCRIPT,
				maxRows: input.limit,
				input: {
					integration_name: input.integration.name,
					namespace: input.namespace,
					table: input.table,
					limit: input.limit,
				},
				render,
				integration: input.integration,
				sessionId: input.sessionId,
				credentialVars: input.credentialVars,
			};
			if (duckdbPreviewBlocker(input.config)) return { python };
			const alias = `preview_${input.integration.id.replaceAll('-', '_')}`;
			const secret = duckdbS3Secret(input.config, alias);
			const attachParams: (string | number | boolean | null)[] = [input.config.uri];
			const options = ['TYPE iceberg', 'ENDPOINT ?'];
			if (input.config.warehouse) {
				options.push('WAREHOUSE ?');
				attachParams.push(input.config.warehouse);
			}
			options.push(...duckdbAuthOptions(input.config.auth, attachParams));
			options.push('ACCESS_DELEGATION_MODE ?', 'READ_ONLY');
			attachParams.push(input.config.access_delegation);
			return {
				duckdbWasm: {
					setup: [
						{ text: 'LOAD iceberg' },
						{ text: 'LOAD httpfs' },
						...(secret ? [secret.create] : []),
						{
							text: `ATTACH ${sqlLiteral(duckdbWarehouse(input.config, input.integration.name))} AS ${sqlIdentifier(alias)} (${options.join(', ')})`,
							params: attachParams,
						},
					],
					query: {
						text: `SELECT * FROM ${[alias, ...input.namespace, input.table].map(sqlIdentifier).join('.')} LIMIT ?`,
						params: [input.limit],
					},
					cleanup: [...(secret ? [secret.drop] : []), { text: `DETACH ${sqlIdentifier(alias)}` }],
					requires: ['iceberg-http'],
					httpAccess: duckdbHttpAccess(input.config),
				},
				python,
			};
		},
	},

	query: {
		readiness: duckdbPreviewReadiness,
		available(config) {
			const reason = duckdbPreviewBlocker(config);
			return reason ? { ok: false as const, reason } : { ok: true as const };
		},
		plan({ config, integration }) {
			const reason = duckdbPreviewBlocker(config);
			if (reason) throw new ValidationError(reason);
			const params: (string | number | boolean | null)[] = [config.uri];
			const options = ['TYPE iceberg', 'ENDPOINT ?'];
			if (config.warehouse) {
				options.push('WAREHOUSE ?');
				params.push(config.warehouse);
			}
			options.push(...duckdbAuthOptions(config.auth, params));
			options.push('ACCESS_DELEGATION_MODE ?', 'READ_ONLY');
			params.push(config.access_delegation);
			const alias = sqlIdentifier(integration.name);
			const secret = duckdbS3Secret(config, integration.id.replaceAll('-', '_'));
			return {
				setup: [
					{ text: 'LOAD iceberg' },
					{ text: 'LOAD httpfs' },
					...(secret ? [secret.create] : []),
					{
						text: `ATTACH ${sqlLiteral(duckdbWarehouse(config, integration.name))} AS ${alias} (${options.join(', ')})`,
						params,
					},
				],
				cleanup: [...(secret ? [secret.drop] : []), { text: `DETACH ${alias}` }],
				httpAccess: duckdbHttpAccess(config),
			};
		},
	},

	async testConnection(config, probe) {
		assertSafeHeaders(config.headers);
		const start = performance.now();
		const blocker = hubProbeBlocker(config);
		if (blocker) {
			return { ok: false, latency_ms: 0, details: blocker };
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

	browse: {
		available(config) {
			const blocker = hubProbeBlocker(config);
			return blocker ? { ok: false, reason: blocker } : { ok: true };
		},

		async listNamespaces(config, probe, request) {
			const catalog = await openCatalog(config, probe, request.signal);
			const parent = request.parent ?? [];
			const body = await catalogGet(catalog, '/namespaces', {
				...pageParams(request),
				...(parent.length > 0 ? { parent: parent.join(decodedSeparator(catalog.separator)) } : {}),
			});
			const namespaces = (asRecord(body)?.namespaces ?? []) as unknown;
			const raw = Array.isArray(namespaces)
				? namespaces.filter(
						(ns): ns is string[] =>
							Array.isArray(ns) &&
							ns.length > 0 &&
							ns.every((part) => typeof part === 'string' && part !== ''),
					)
				: [];
			return {
				items: childNamespaces(raw, parent),
				next_cursor: advancedPageToken(body, request.cursor),
			};
		},

		async listTables(config, probe, namespace, request) {
			const catalog = await openCatalog(config, probe, request.signal);
			const body = await catalogGet(
				catalog,
				`/namespaces/${namespacePathSegment(catalog, namespace)}/tables`,
				pageParams(request),
			);
			const identifiers = (asRecord(body)?.identifiers ?? []) as unknown;
			const items = Array.isArray(identifiers)
				? identifiers
						.map(asRecord)
						// A mis-scoped listing (separator drift) must not surface another
						// namespace's tables; identifiers without a namespace are kept —
						// some servers omit the field on this route.
						.filter((identifier) => {
							const ns = identifier?.namespace;
							if (!Array.isArray(ns)) return true;
							return ns.length === namespace.length && namespace.every((part, i) => ns[i] === part);
						})
						.map((identifier) => identifier?.name)
						.filter((name): name is string => typeof name === 'string' && name !== '')
				: [];
			return {
				items: [...new Set(items)],
				next_cursor: advancedPageToken(body, request.cursor),
			};
		},

		async getTableSchema(config, probe, namespace, table, request) {
			const catalog = await openCatalog(config, probe, request?.signal);
			const body = await catalogGet(
				catalog,
				`/namespaces/${namespacePathSegment(catalog, namespace)}/tables/${encodeURIComponent(table)}`,
			);
			return tableSchemaOf(body);
		},

		snippet(instanceName, namespace, table) {
			const parts = [...namespace, table];
			// PyIceberg splits a string identifier on dots, so a namespace part
			// containing one must be passed as a tuple instead.
			const identifier = parts.some((part) => part.includes('.'))
				? `(${parts.map((part) => JSON.stringify(part)).join(', ')})`
				: JSON.stringify(parts.join('.'));
			return [
				'from pyiceberg.catalog import load_catalog',
				'',
				`catalog = load_catalog(${JSON.stringify(instanceName)})`,
				`table = catalog.load_table(${identifier})`,
				// scan() alone is a lazy DataScan; Arrow materializes rows without
				// dragging in pandas, and marimo renders Arrow tables natively.
				'df = table.scan(limit=100).to_arrow()',
				'df',
			].join('\n');
		},
	},
});

type IcebergRestConfig = z.infer<typeof icebergRestConfig>;

function renderIcebergRest(config: IcebergRestConfig, instanceName: string) {
	assertSafeHeaders(config.headers);
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
		'rest-table-cache.expire-after-write-ms': String(config.rest.table_cache_expire_after_write_ms),
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
}

const PYICEBERG_PREVIEW_SCRIPT = `import json
import math
from pyiceberg.catalog import load_catalog

def json_safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value

with open("/tmp/marimohub-data-preview-request.json", encoding="utf-8") as request_file:
    request = json.load(request_file)

catalog = load_catalog(request["integration_name"])
identifier = tuple([*request["namespace"], request["table"]])
arrow = catalog.load_table(identifier).scan(limit=request["limit"]).to_arrow()
columns = [str(field.name) for field in arrow.schema]
rows = [[json_safe(record.get(column)) for column in columns] for record in arrow.to_pylist()]
print(json.dumps({"columns": columns, "rows": rows}, allow_nan=False, default=str, separators=(",", ":")))
`;

const advancedS3Fields = [
	'role_arn',
	'role_session_name',
	'signer',
	'signer_uri',
	'signer_endpoint',
	'resolve_region',
	'proxy_uri',
	'connect_timeout',
	'request_timeout',
] as const;

function readinessCheck(
	id: string,
	label: string,
	ready: boolean,
	field: string,
	reason: string,
): QueryReadinessCheck {
	return { id, label, ready, field, reason };
}

function parsedUrl(value: unknown): URL | undefined {
	if (typeof value !== 'string') return undefined;
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

function isDnsCompatibleS3Bucket(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		value.length >= 3 &&
		value.length <= 63 &&
		/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) &&
		!value.includes('..') &&
		!isIpv4Address(value)
	);
}

function isIpAddressHost(hostname: string): boolean {
	return hostname.includes(':') || isIpv4Address(hostname);
}

function isIpv4Address(value: string): boolean {
	const octets = value.split('.');
	return (
		octets.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
	);
}

interface R2CatalogAccess {
	endpoint: string;
	bucket: string;
	warehouse: string;
}

function r2CatalogAccess(config: IcebergRestConfig): R2CatalogAccess | undefined {
	if (config.storage.scheme !== 'catalog') return undefined;
	const url = parsedUrl(config.uri);
	if (
		url?.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash
	) {
		return undefined;
	}
	let segments: string[];
	try {
		const pathSegments = url.pathname.split('/');
		pathSegments.shift();
		if (pathSegments.at(-1) === '') pathSegments.pop();
		if (pathSegments.some((segment) => !segment)) return undefined;
		segments = pathSegments.map((segment) => decodeURIComponent(segment));
	} catch {
		return undefined;
	}
	if (url.hostname === 'catalog.cloudflarestorage.com' && segments.length === 2) {
		const [account, bucket] = segments;
		if (!isR2CatalogPart(account) || !isR2Bucket(bucket)) return undefined;
		return {
			endpoint: `https://${account}.r2.cloudflarestorage.com`,
			bucket,
			warehouse: `${account}_${bucket}`,
		};
	}
	const accountMatch = /^([a-z0-9-]+)\.r2\.cloudflarestorage\.com$/.exec(url.hostname);
	if (
		accountMatch &&
		isR2CatalogPart(accountMatch[1]) &&
		segments.length === 2 &&
		segments[0] === 'iceberg'
	) {
		const bucket = segments[1];
		if (!isR2Bucket(bucket)) return undefined;
		return { endpoint: url.origin, bucket, warehouse: bucket };
	}
	return undefined;
}

function isR2CatalogPart(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function isR2Bucket(value: string): boolean {
	return value.length >= 3 && value.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(value);
}

function r2CatalogRoutesOverlap(config: IcebergRestConfig, access: R2CatalogAccess): boolean {
	const catalog = parsedUrl(config.uri);
	const storage = parsedUrl(access.endpoint);
	if (!catalog || !storage || catalog.origin !== storage.origin) return false;
	const catalogPrefix = catalog.pathname.replace(/\/$/, '');
	const storagePrefix = `/${encodeURIComponent(access.bucket)}`;
	return (
		catalogPrefix === storagePrefix ||
		catalogPrefix.startsWith(`${storagePrefix}/`) ||
		storagePrefix.startsWith(`${catalogPrefix}/`)
	);
}

function duckdbPreviewReadiness(value: IcebergRestConfig): QueryReadinessCheck[] {
	const config = asRecord(value) ?? {};
	const auth = asRecord(config.auth) ?? {};
	const tls = asRecord(config.tls) ?? {};
	const headers = asRecord(config.headers) ?? {};
	const extraProperties = asRecord(config.extra_properties) ?? {};
	const storage = asRecord(config.storage) ?? {};
	const credentials = asRecord(storage.credentials) ?? {};
	const runtime = asRecord(config.runtime) ?? {};
	const rest: Record<string, unknown> = asRecord(config.rest) ?? ICEBERG_REST_DEFAULTS;
	const catalogUrl = parsedUrl(config.uri);
	const endpoint = parsedUrl(storage.endpoint);
	const hasEndpoint = typeof storage.endpoint === 'string' && storage.endpoint.length > 0;
	const storageIsS3 = storage.scheme === 's3';
	const r2Catalog = r2CatalogAccess(value);
	const supportedStorage = storageIsS3 || r2Catalog !== undefined;
	const endpointOriginOnly = endpoint
		? endpoint.pathname === '/' && endpoint.search === '' && endpoint.hash === ''
		: false;
	const authMethod = auth.method;
	const credentialsMethod = credentials.method;
	const advancedField = advancedS3Fields.find((field) => {
		const fieldValue = storage[field];
		return field === 'connect_timeout' || field === 'request_timeout'
			? fieldValue !== undefined
			: Boolean(fieldValue);
	});
	const supportedCredentials =
		storageIsS3 &&
		(storage.anonymous === true || (storage.anonymous !== true && credentialsMethod === 'static'));
	const credentialsReason =
		credentialsMethod === 'ambient'
			? 'ambient S3 credentials are not supported by DuckDB-Wasm preview'
			: credentialsMethod === 'profile'
				? 'profile S3 credentials are not supported by DuckDB-Wasm preview'
				: 'DuckDB-Wasm preview requires static or anonymous S3 credentials';
	const defaultRestOptions =
		(rest.snapshot_loading_mode ?? ICEBERG_REST_DEFAULTS.snapshot_loading_mode) ===
			ICEBERG_REST_DEFAULTS.snapshot_loading_mode &&
		(rest.metrics_reporting_enabled ?? ICEBERG_REST_DEFAULTS.metrics_reporting_enabled) ===
			ICEBERG_REST_DEFAULTS.metrics_reporting_enabled &&
		rest.page_size === undefined &&
		(rest.view_endpoints_supported ?? ICEBERG_REST_DEFAULTS.view_endpoints_supported) ===
			ICEBERG_REST_DEFAULTS.view_endpoints_supported &&
		(rest.scan_planning_mode ?? ICEBERG_REST_DEFAULTS.scan_planning_mode) ===
			ICEBERG_REST_DEFAULTS.scan_planning_mode &&
		(rest.namespace_separator ?? ICEBERG_REST_DEFAULTS.namespace_separator) ===
			ICEBERG_REST_DEFAULTS.namespace_separator &&
		(rest.table_cache_expire_after_write_ms ??
			ICEBERG_REST_DEFAULTS.table_cache_expire_after_write_ms) ===
			ICEBERG_REST_DEFAULTS.table_cache_expire_after_write_ms &&
		(rest.table_cache_max_entries ?? ICEBERG_REST_DEFAULTS.table_cache_max_entries) ===
			ICEBERG_REST_DEFAULTS.table_cache_max_entries;

	return [
		readinessCheck(
			'catalog-auth',
			r2Catalog
				? 'Use a catalog bearer token'
				: 'Use no catalog authentication, a bearer token, or parent-owned OAuth2',
			r2Catalog
				? authMethod === 'bearer_token'
				: authMethod === 'none' ||
						authMethod === 'bearer_token' ||
						authMethod === 'oauth2_client_credentials',
			'auth',
			`${String(authMethod)} authentication is not supported by DuckDB-Wasm preview`,
		),
		readinessCheck(
			'system-tls',
			'Use system TLS without custom certificates',
			!tls.ca_bundle && !tls.client_certificate,
			'tls',
			'custom TLS material is not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			'no-custom-headers',
			'Remove custom headers',
			Object.keys(headers).length === 0,
			'headers',
			'custom headers are not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			'no-extra-properties',
			'Remove extra properties',
			Object.keys(extraProperties).length === 0,
			'extra_properties',
			'extra properties are not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			'catalog-url-query',
			'Use a catalog URL without query parameters',
			catalogUrl?.search === '',
			'uri',
			'catalog URLs with query parameters are not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			'catalog-url-path',
			'Use a catalog URL without encoded path separators',
			catalogUrl !== undefined && !/%2f|%5c/i.test(catalogUrl.pathname),
			'uri',
			'catalog URLs with encoded path separators are not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			'no-access-delegation',
			r2Catalog ? 'Use catalog-vended credentials' : 'Set access delegation to none',
			r2Catalog
				? config.access_delegation === 'vended_credentials'
				: config.access_delegation === 'none',
			'access_delegation',
			'catalog access delegation is not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			's3-storage',
			'Use explicit S3 storage or a supported R2 Data Catalog',
			supportedStorage,
			'storage',
			'DuckDB-Wasm preview requires explicit S3 storage or a supported R2 Data Catalog',
		),
		readinessCheck(
			'r2-route-separation',
			'Use the catalog.cloudflarestorage.com R2 catalog URI',
			r2Catalog === undefined || !r2CatalogRoutesOverlap(value, r2Catalog),
			'uri',
			'account-scoped R2 catalog and path-style storage routes overlap; use the catalog.cloudflarestorage.com catalog URI',
		),
		...(storageIsS3
			? [
					readinessCheck(
						's3-endpoint',
						'Set an explicit S3 endpoint',
						storageIsS3 && hasEndpoint,
						storageIsS3 ? 'storage.endpoint' : 'storage',
						'DuckDB-Wasm preview requires an explicit S3 endpoint',
					),
					readinessCheck(
						's3-endpoint-origin',
						'Use an origin-only S3 endpoint',
						storageIsS3 && endpointOriginOnly,
						storageIsS3 ? 'storage.endpoint' : 'storage',
						'DuckDB-Wasm preview requires an origin-only S3 endpoint',
					),
					readinessCheck(
						's3-secure-transport',
						'Use HTTPS for authenticated S3',
						!usesInsecureAuthenticatedS3(value),
						'storage.endpoint',
						'authenticated S3 requires HTTPS unless insecure transport is explicitly enabled',
					),
					readinessCheck(
						's3-virtual-host-endpoint',
						'Use a DNS endpoint for virtual-hosted S3',
						storageIsS3 &&
							(storage.force_virtual_addressing !== true ||
								(endpoint !== undefined && !isIpAddressHost(endpoint.hostname))),
						storageIsS3 ? 'storage.endpoint' : 'storage',
						'virtual-hosted S3 addressing requires a DNS endpoint',
					),
					readinessCheck(
						's3-basic-options',
						'Remove advanced S3 client options',
						storageIsS3 && advancedField === undefined,
						storageIsS3 && advancedField ? `storage.${advancedField}` : 'storage',
						'advanced S3 client options are not supported by DuckDB-Wasm preview',
					),
					readinessCheck(
						's3-credentials',
						'Use static S3 credentials or anonymous access',
						supportedCredentials,
						storageIsS3 ? 'storage.credentials' : 'storage',
						credentialsReason,
					),
					readinessCheck(
						's3-read-locations',
						'Add at least one guarded S3 read location',
						storageIsS3 &&
							Array.isArray(storage.broker_read_locations) &&
							storage.broker_read_locations.length > 0,
						storageIsS3 ? 'storage.broker_read_locations' : 'storage',
						'DuckDB-Wasm preview requires at least one guarded S3 read location',
					),
					readinessCheck(
						's3-virtual-host-buckets',
						'Use DNS-compatible bucket names for virtual-hosted S3',
						storageIsS3 &&
							(storage.force_virtual_addressing !== true ||
								(Array.isArray(storage.broker_read_locations) &&
									storage.broker_read_locations.every((location) =>
										isDnsCompatibleS3Bucket(asRecord(location)?.bucket),
									))),
						storageIsS3 ? 'storage.broker_read_locations' : 'storage',
						'virtual-hosted S3 addressing requires DNS-compatible bucket names',
					),
				]
			: []),
		readinessCheck(
			'default-runtime-options',
			'Keep PyIceberg runtime options at their defaults',
			Object.keys(runtime).length === Object.keys(ICEBERG_RUNTIME_DEFAULTS).length,
			'runtime',
			'PyIceberg runtime options are not supported by DuckDB-Wasm preview',
		),
		readinessCheck(
			'default-rest-options',
			'Keep REST client options at their defaults',
			defaultRestOptions,
			'rest',
			'custom REST client options are not supported by DuckDB-Wasm preview',
		),
	];
}

function duckdbPreviewBlocker(config: IcebergRestConfig): string | undefined {
	return duckdbPreviewReadiness(config).find((check) => !check.ready)?.reason;
}

function duckdbAuthOptions(
	config: IcebergRestConfig['auth'],
	params: (string | number | boolean | null)[],
): string[] {
	switch (config.method) {
		case 'none':
			params.push('marimohub-parent-broker');
			return ['TOKEN ?'];
		case 'bearer_token':
			params.push('marimohub-parent-broker');
			return ['TOKEN ?'];
		case 'oauth2_client_credentials':
			params.push('marimohub-parent-broker');
			return ['TOKEN ?'];
		case 'basic':
		case 'entra':
		case 'google':
		case 'sigv4':
		default:
			throw new ValidationError('This authentication method requires the preview sandbox.');
	}
}

function duckdbS3Secret(config: IcebergRestConfig, suffix: string) {
	if (r2CatalogAccess(config)) return;
	if (config.storage.scheme !== 's3' || !config.storage.endpoint) {
		throw new ValidationError('DuckDB-Wasm requires explicit S3 storage configuration.');
	}
	const endpoint = new URL(config.storage.endpoint);
	const name = sqlIdentifier(`marimohub_s3_${suffix}`);
	const urlStyle = config.storage.force_virtual_addressing ? 'vhost' : 'path';
	return {
		create: {
			text:
				`CREATE TEMPORARY SECRET ${name} (` +
				"TYPE S3, KEY_ID 'marimohub-parent-broker', SECRET 'marimohub-parent-broker', " +
				`REGION ?, ENDPOINT ?, URL_STYLE '${urlStyle}', USE_SSL ?)`,
			params: [config.storage.region ?? 'us-east-1', endpoint.host, endpoint.protocol === 'https:'],
		},
		drop: { text: `DROP SECRET ${name}` },
	};
}

function duckdbHttpAccess(config: IcebergRestConfig): DuckDBHttpAccess {
	const r2Catalog = r2CatalogAccess(config);
	if (r2Catalog) {
		return {
			kind: 'iceberg-rest',
			...(config.allow_insecure_transport ? { allowInsecureTransport: true } : {}),
			catalog: {
				url: config.uri,
				...(config.auth.method === 'bearer_token'
					? { authorization: `Bearer ${config.auth.token}` }
					: {}),
			},
			storage: {
				kind: 'r2-catalog',
				endpoint: r2Catalog.endpoint,
				bucket: r2Catalog.bucket,
			},
		};
	}
	if (config.storage.scheme !== 's3' || !config.storage.endpoint) {
		throw new ValidationError('DuckDB-Wasm requires explicit S3 storage configuration.');
	}
	const credentials =
		config.storage.anonymous || config.storage.credentials.method !== 'static'
			? ({ method: 'anonymous' } as const)
			: {
					method: 'static' as const,
					accessKeyId: config.storage.credentials.access_key_id,
					secretAccessKey: config.storage.credentials.secret_access_key,
					...(config.storage.credentials.session_token
						? { sessionToken: config.storage.credentials.session_token }
						: {}),
				};
	return {
		kind: 'iceberg-rest',
		...(config.allow_insecure_transport ? { allowInsecureTransport: true } : {}),
		catalog: {
			url: config.uri,
			...(config.auth.method === 'bearer_token'
				? { authorization: `Bearer ${config.auth.token}` }
				: {}),
			...(config.auth.method === 'oauth2_client_credentials'
				? {
						oauth2: {
							tokenEndpoint: config.auth.token_endpoint,
							clientId: config.auth.client_id,
							clientSecret: config.auth.client_secret,
							scope: config.auth.scope,
							refreshMarginSeconds: config.auth.refresh_margin_seconds,
							...(config.auth.expires_in_seconds
								? { fallbackExpiresInSeconds: config.auth.expires_in_seconds }
								: {}),
						},
					}
				: {}),
		},
		storage: {
			kind: 's3',
			endpoint: config.storage.endpoint,
			region: config.storage.region ?? 'us-east-1',
			urlStyle: config.storage.force_virtual_addressing ? 'vhost' : 'path',
			credentials,
			locations: config.storage.broker_read_locations,
		},
	};
}

function usesInsecureAuthenticatedS3(config: IcebergRestConfig): boolean {
	return (
		config.storage.scheme === 's3' &&
		!config.storage.anonymous &&
		!config.allow_insecure_transport &&
		isInsecureHttpUrl(config.storage.endpoint)
	);
}

function duckdbWarehouse(config: IcebergRestConfig, fallback: string): string {
	return config.warehouse ?? r2CatalogAccess(config)?.warehouse ?? fallback;
}

/**
 * Auth methods and TLS material the guarded probe cannot exercise; testing and
 * browsing both defer them to the sandbox, which runs the real client. The
 * probe has no seam for per-connection TLS material, so it would exercise a
 * different (hub-trusted) connection than the sandbox will make.
 */
function hubProbeBlocker(config: IcebergRestConfig): string | undefined {
	if (
		config.auth.method === 'sigv4' ||
		config.auth.method === 'google' ||
		config.auth.method === 'entra'
	) {
		return `${config.auth.method} authentication can only be exercised inside the sandbox`;
	}
	if (config.tls.ca_bundle !== undefined || config.tls.client_certificate !== undefined) {
		return 'a custom CA or client certificate can only be exercised inside the sandbox';
	}
	return undefined;
}

interface OpenedCatalog {
	config: IcebergRestConfig;
	probe: IntegrationProbe;
	headers: Record<string, string>;
	signal?: AbortSignal;
	/** Server-supplied route prefix from `/v1/config` (Polaris et al. require it). */
	prefix?: string;
	/** Effective URL-encoded namespace joiner (see {@link effectiveSeparator}). */
	separator: string;
}

/**
 * Authenticates and resolves the server's route prefix — the same handshake
 * PyIceberg performs before any catalog route.
 */
async function openCatalog(
	config: IcebergRestConfig,
	probe: IntegrationProbe,
	signal?: AbortSignal,
): Promise<OpenedCatalog> {
	assertSafeHeaders(config.headers);
	const headers: Record<string, string> = { ...config.headers };
	if (config.auth.method === 'bearer_token') {
		headers.Authorization = `Bearer ${config.auth.token}`;
	} else if (config.auth.method === 'basic') {
		headers.Authorization = basicAuthHeader(config.auth.username, config.auth.password);
	} else if (config.auth.method === 'oauth2_client_credentials') {
		const token = await oauth2Token(config.auth, probe, signal);
		if (!token.ok) throw new UnavailableError(`The catalog is not reachable: ${token.details}.`);
		headers.Authorization = `Bearer ${token.value}`;
	}
	const res = await probe.fetch(configEndpoint(config.uri, config.warehouse), { headers, signal });
	if (!res.ok) {
		throw new UnavailableError(`The catalog config endpoint answered HTTP ${res.status}.`);
	}
	const body = asRecord(await res.json());
	if (!body) {
		throw new UnavailableError(
			'The catalog config response was not JSON or exceeded the size limit.',
		);
	}
	const overrides = asRecord(body?.overrides);
	const defaults = asRecord(body?.defaults);
	const prefix = [overrides?.prefix, defaults?.prefix].find(
		(value): value is string => typeof value === 'string' && value !== '',
	);
	return {
		config,
		probe,
		headers,
		signal,
		prefix,
		separator: effectiveSeparator(config, overrides, defaults),
	};
}

/** Percent-encoded byte or a single URL-safe character — nothing that could restructure a path. */
const SAFE_SEPARATOR = /^(?:%[0-9A-Fa-f]{2}|[.\-_~])$/;

/**
 * The `/v1/config` handshake can pin the namespace separator: `overrides`
 * beat the client's property, the client beats `defaults` (the spec's merge
 * order — the fixture's `latest` image, for one, overrides it to `%2E`).
 * Ignoring an override would 404 every nested-namespace route there.
 *
 * Every candidate — including the CONFIGURED one, which the schema leaves
 * free-form for the sandbox render — must pass {@link SAFE_SEPARATOR}: a
 * value like `/` would restructure the catalog path. Nothing safe declared
 * falls back to the spec's `%1F`.
 *
 * Exported so the live conformance seeding resolves the separator with the
 * exact rules the client under test applies.
 */
export function resolveNamespaceSeparator(
	configured: string,
	overrides: Record<string, unknown> | undefined,
	defaults: Record<string, unknown> | undefined,
): string {
	const candidates = [
		overrides?.['namespace-separator'],
		configured,
		defaults?.['namespace-separator'],
	];
	for (const value of candidates) {
		if (typeof value === 'string' && SAFE_SEPARATOR.test(value)) return value;
	}
	return '%1F';
}

function effectiveSeparator(
	config: IcebergRestConfig,
	overrides: Record<string, unknown> | undefined,
	defaults: Record<string, unknown> | undefined,
): string {
	return resolveNamespaceSeparator(config.rest.namespace_separator, overrides, defaults);
}

async function catalogGet(
	catalog: OpenedCatalog,
	route: string,
	params: Record<string, string> = {},
): Promise<unknown> {
	const url = new URL(catalog.config.uri);
	url.hash = '';
	// The configured URI's query string is kept: some catalogs route tenants
	// through it, and dropping it would 404 every request past /v1/config.
	const prefixPart = catalog.prefix
		? `/${catalog.prefix.split('/').map(encodeURIComponent).join('/')}`
		: '';
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1${prefixPart}${route}`;
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const res = await catalog.probe.fetch(url.toString(), {
		headers: catalog.headers,
		signal: catalog.signal,
	});
	if (res.status === 404) {
		throw new NotFoundError('The catalog reports no such namespace or table.');
	}
	if (!res.ok) throw new UnavailableError(`The catalog answered HTTP ${res.status}.`);
	const body = await res.json();
	if (body === undefined) {
		throw new UnavailableError(
			'The catalog response was not JSON or exceeded the size limit — request a smaller page.',
		);
	}
	return body;
}

function pageParams(request: BrowsePageRequest): Record<string, string> {
	return {
		pageSize: String(request.limit),
		...(request.cursor !== undefined ? { pageToken: request.cursor } : {}),
	};
}

/**
 * The next upstream page token — null when the server sends none, and null
 * when it echoes the token it was just given: following an unchanged token
 * would page forever without advancing (observed spec drift; servers that do
 * not support `pageToken` sometimes reflect the request's params).
 */
function advancedPageToken(body: unknown, requested: string | undefined): string | null {
	const token = asRecord(body)?.['next-page-token'];
	if (typeof token !== 'string' || token === '') return null;
	return token === requested ? null : token;
}

/**
 * The direct children of `parent` from a namespace listing. Compliant servers
 * return exactly that as full paths, making this a no-op; servers that ignore
 * `parent` (or return the whole tree flat) return ancestors, the parent
 * itself, and unrelated roots — filtering by prefix and depth keeps the tree
 * correct against both, and deeper descendants stay reachable by expansion.
 */
function childNamespaces(items: string[][], parent: string[]): string[][] {
	const seen = new Set<string>();
	const children: string[][] = [];
	for (const namespace of items) {
		if (namespace.length !== parent.length + 1) continue;
		if (!parent.every((part, index) => namespace[index] === part)) continue;
		const key = namespace.join('\u001f');
		if (seen.has(key)) continue;
		seen.add(key);
		children.push(namespace);
	}
	return children;
}

/**
 * The effective separator is the URL-encoded joiner for namespace parts in
 * catalog routes (`%1F` = the REST spec's unit separator). Parts are encoded
 * individually and joined with it verbatim; for query params the decoded form
 * is used and re-encoded by URLSearchParams.
 */
function namespacePathSegment(catalog: OpenedCatalog, namespace: string[]): string {
	return namespace.map(encodeURIComponent).join(catalog.separator);
}

function decodedSeparator(separator: string): string {
	try {
		return decodeURIComponent(separator);
	} catch {
		return separator;
	}
}

function tableSchemaOf(body: unknown): TableSchema {
	const metadata = asRecord(asRecord(body)?.metadata);
	const schemas = metadata?.schemas;
	const currentId = metadata?.['current-schema-id'];
	let schema = Array.isArray(schemas)
		? (schemas.map(asRecord).find((s) => s?.['schema-id'] === currentId) ??
			asRecord(schemas.at(-1)))
		: undefined;
	// Format-v1 metadata carries a single `schema` instead of a `schemas` list.
	schema ??= asRecord(metadata?.schema);
	const fields = Array.isArray(schema?.fields) ? schema.fields.map(asRecord) : [];
	const columnNamesById = new Map<unknown, string>();
	const columns: TableColumn[] = [];
	for (const field of fields) {
		if (field === undefined || typeof field.name !== 'string') continue;
		columnNamesById.set(field.id, field.name);
		columns.push({
			name: field.name,
			type: typeText(field.type),
			nullable: field.required !== true,
			...(typeof field.doc === 'string' && field.doc !== '' ? { comment: field.doc } : {}),
		});
	}
	const partitioning = partitionFields(metadata, columnNamesById);
	const snapshot = currentSnapshot(metadata);
	return {
		columns,
		...(partitioning.length > 0 ? { partitioning } : {}),
		...(typeof metadata?.location === 'string' ? { location: metadata.location } : {}),
		...(typeof metadata?.['format-version'] === 'number'
			? { format_version: metadata['format-version'] }
			: {}),
		...(snapshot ? { current_snapshot: snapshot } : {}),
	};
}

function currentSnapshot(
	metadata: Record<string, unknown> | undefined,
): TableSchema['current_snapshot'] | undefined {
	const snapshots = metadata?.snapshots;
	const currentId = metadata?.['current-snapshot-id'];
	if (!Array.isArray(snapshots) || currentId === undefined) return undefined;
	const snapshot = snapshots.map(asRecord).find((s) => s?.['snapshot-id'] === currentId);
	if (!snapshot) return undefined;
	const summary = asRecord(snapshot.summary);
	const committedMs = snapshot['timestamp-ms'];
	const result = {
		...(typeof committedMs === 'number'
			? { committed_at: new Date(committedMs).toISOString() }
			: {}),
		...numericSummary(summary, 'total-records', 'total_records'),
		...numericSummary(summary, 'total-files-size', 'total_data_size_bytes'),
	};
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Iceberg snapshot summaries carry numbers as strings; parse defensively. */
function numericSummary(
	summary: Record<string, unknown> | undefined,
	key: string,
	as: string,
): Record<string, number> {
	const raw = summary?.[key];
	const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
	return Number.isFinite(value) ? { [as]: value } : {};
}

function partitionFields(
	metadata: Record<string, unknown> | undefined,
	columnNamesById: Map<unknown, string>,
): string[] {
	const specs = metadata?.['partition-specs'];
	const defaultSpecId = metadata?.['default-spec-id'];
	const spec = Array.isArray(specs)
		? (specs.map(asRecord).find((s) => s?.['spec-id'] === defaultSpecId) ?? asRecord(specs.at(-1)))
		: undefined;
	let fields = Array.isArray(spec?.fields) ? spec.fields : undefined;
	// Format-v1 metadata carries the fields as a flat singular `partition-spec`.
	fields ??= Array.isArray(metadata?.['partition-spec']) ? metadata['partition-spec'] : undefined;
	if (!fields) return [];
	const rendered: string[] = [];
	for (const field of fields.map(asRecord)) {
		if (field === undefined) continue;
		const source = columnNamesById.get(field['source-id']);
		const name = source ?? (typeof field.name === 'string' ? field.name : undefined);
		if (name === undefined) continue;
		const transform = typeof field.transform === 'string' ? field.transform : 'identity';
		rendered.push(transform === 'identity' ? name : `${transform}(${name})`);
	}
	return rendered;
}

/** Renders an Iceberg type (string or nested struct/list/map object) as display text. */
function typeText(type: unknown): string {
	if (typeof type === 'string') return type;
	const record = asRecord(type);
	if (!record) return 'unknown';
	switch (record.type) {
		case 'struct': {
			const fields = Array.isArray(record.fields) ? record.fields.map(asRecord) : [];
			const parts = fields
				.filter((f): f is Record<string, unknown> => f !== undefined)
				.map((f) => `${String(f.name)}: ${typeText(f.type)}`);
			return `struct<${parts.join(', ')}>`;
		}
		case 'list':
			return `list<${typeText(record.element)}>`;
		case 'map':
			return `map<${typeText(record.key)}, ${typeText(record.value)}>`;
		default:
			return typeof record.type === 'string' ? record.type : 'unknown';
	}
}

function assertSafeHeaders(headers: Record<string, string>): void {
	for (const [key, value] of Object.entries(headers)) {
		if (!HTTP_HEADER_NAME_REGEX.test(key)) {
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
}

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
	signal?: AbortSignal,
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
		signal,
	});
	if (!res.ok) return { ok: false, details: `token endpoint: HTTP ${res.status}` };
	const body = (await res.json()) as { access_token?: string } | undefined;
	return body?.access_token
		? { ok: true, value: body.access_token }
		: { ok: false, details: 'token endpoint returned no access_token' };
}

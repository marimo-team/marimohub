import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { RenderOutput } from '../sdk';
import { zSecret } from '../secretFields';
import { INTEGRATIONS_DIR } from '../bundle';

export const HTTP_URL_REGEX = /^https?:\/\/(?![^/?#]*@)\S+$/;
export const THRIFT_URL_REGEX = /^thrift:\/\/(?![^/?#]*@)\S+$/;

const url = () =>
	z.string().regex(HTTP_URL_REGEX, 'Must be an http(s) URL without embedded credentials');

export const awsCredentialsSchema = z.discriminatedUnion('method', [
	z.object({ method: z.literal('ambient') }),
	z.object({
		method: z.literal('static'),
		access_key_id: zSecret(),
		secret_access_key: zSecret(),
		session_token: zSecret().optional(),
	}),
	z.object({
		method: z.literal('profile'),
		profile_name: z.string().min(1),
	}),
]);

export const unifiedAwsCredentialsSchema = z
	.discriminatedUnion('method', [
		z.object({ method: z.literal('none') }),
		z.object({
			method: z.literal('static'),
			region: z.string().min(1).optional(),
			access_key_id: zSecret(),
			secret_access_key: zSecret(),
			session_token: zSecret().optional(),
		}),
		z.object({
			method: z.literal('profile'),
			region: z.string().min(1).optional(),
			profile_name: z.string().min(1),
		}),
		z.object({
			method: z.literal('role'),
			region: z.string().min(1).optional(),
			role_arn: z.string().min(1),
			role_session_name: z.string().min(1).optional(),
		}),
	])
	.default({ method: 'none' });

export const icebergRuntimeSchema = z
	.object({
		max_workers: z.number().int().positive().optional(),
		legacy_current_snapshot_id: z.boolean().optional(),
		downcast_ns_timestamp_to_us_on_write: z.boolean().optional(),
		pyarrow_use_large_types_on_read: z.boolean().optional(),
	})
	.default({});

const s3Storage = z.object({
	scheme: z.literal('s3'),
	region: z.string().min(1).optional(),
	endpoint: url().optional(),
	credentials: awsCredentialsSchema.default({ method: 'ambient' }),
	role_arn: z.string().min(1).optional(),
	role_session_name: z.string().min(1).optional(),
	signer: z.string().min(1).optional(),
	signer_uri: url().optional(),
	signer_endpoint: z.string().min(1).optional(),
	resolve_region: z.boolean().default(false),
	proxy_uri: url().optional(),
	connect_timeout: z.number().positive().optional(),
	request_timeout: z.number().positive().optional(),
	force_virtual_addressing: z.boolean().default(false),
	anonymous: z.boolean().default(false),
});

const gcsStorage = z.object({
	scheme: z.literal('gcs'),
	project_id: z.string().min(1).optional(),
	auth: z
		.discriminatedUnion('method', [
			z.object({ method: z.literal('ambient') }),
			z.object({
				method: z.literal('oauth_token'),
				token: zSecret(),
				token_expires_at_ms: z.number().int().positive().optional(),
			}),
		])
		.default({ method: 'ambient' }),
	access: z.enum(['read_only', 'read_write', 'full_control']).default('full_control'),
	consistency: z.enum(['none', 'size', 'md5']).default('none'),
	cache_timeout: z.number().nonnegative().optional(),
	requester_pays: z.boolean().default(false),
	session_kwargs: z.record(z.string(), z.string()).default({}),
	service_host: url().optional(),
	default_location: z.string().min(1).optional(),
	version_aware: z.boolean().default(false),
});

const adlsStorage = z.object({
	scheme: z.literal('adls'),
	account_name: z.string().min(1).optional(),
	auth: z
		.discriminatedUnion('method', [
			z.object({ method: z.literal('ambient') }),
			z.object({ method: z.literal('connection_string'), connection_string: zSecret() }),
			z.object({ method: z.literal('account_key'), account_key: zSecret() }),
			z.object({ method: z.literal('sas_token'), sas_token: zSecret() }),
			z.object({
				method: z.literal('service_principal'),
				tenant_id: z.string().min(1),
				client_id: z.string().min(1),
				client_secret: zSecret(),
			}),
			z.object({ method: z.literal('access_token'), token: zSecret() }),
			z.object({ method: z.literal('credential'), credential: zSecret() }),
		])
		.default({ method: 'ambient' }),
	account_host: z.string().min(1).optional(),
	blob_storage_authority: z.string().min(1).optional(),
	dfs_storage_authority: z.string().min(1).optional(),
	blob_storage_scheme: z.enum(['http', 'https']).default('https'),
	dfs_storage_scheme: z.enum(['http', 'https']).default('https'),
});

const hdfsStorage = z.object({
	scheme: z.literal('hdfs'),
	host: z.string().min(1),
	port: z.number().int().positive().max(65_535).default(8020),
	user: z.string().min(1).optional(),
	kerberos_ticket: z.string().min(1).optional(),
});

const huggingFaceStorage = z.object({
	scheme: z.literal('hugging_face'),
	endpoint: url().default('https://huggingface.co'),
	token: zSecret().optional(),
});

export const icebergStorageSchema = z
	.discriminatedUnion('scheme', [
		z.object({ scheme: z.literal('catalog') }),
		s3Storage,
		gcsStorage,
		adlsStorage,
		hdfsStorage,
		huggingFaceStorage,
	])
	.default({ scheme: 'catalog' });

export const extraPropertiesSchema = z
	.record(z.string(), z.string())
	.default({})
	.describe('Raw PyIceberg catalog properties not represented by typed fields');

const SENSITIVE_PROP_REGEX =
	/token|credential|password|secret|access-key|api-key|authorization|private-key|account-key|sas|auth/;

const STORAGE_PROP_KEYS = new Set([
	's3.region',
	's3.endpoint',
	's3.profile-name',
	's3.role-arn',
	's3.role-session-name',
	's3.signer',
	's3.signer.uri',
	's3.signer.endpoint',
	's3.resolve-region',
	's3.proxy-uri',
	's3.connect-timeout',
	's3.request-timeout',
	's3.force-virtual-addressing',
	's3.anonymous',
	'gcs.project-id',
	'gcs.access',
	'gcs.consistency',
	'gcs.cache-timeout',
	'gcs.requester-pays',
	'gcs.session-kwargs',
	'gcs.service.host',
	'gcs.default-location',
	'gcs.version-aware',
	'adls.account-name',
	'adls.account-host',
	'adls.blob-storage-authority',
	'adls.dfs-storage-authority',
	'adls.blob-storage-scheme',
	'adls.dfs-storage-scheme',
	'hdfs.host',
	'hdfs.port',
	'hdfs.user',
	'hdfs.kerberos_ticket',
	'hf.endpoint',
	'pyarrow.use-large-types-on-read',
]);

export function validateExtraProperties(
	extra: Record<string, string>,
	owned: ReadonlySet<string>,
): void {
	for (const key of Object.keys(extra)) {
		if (key.trim() === '') throw new ValidationError('Extra property keys cannot be empty.');
		if (owned.has(key) || STORAGE_PROP_KEYS.has(key)) {
			throw new ValidationError(
				`Extra property "${key}" is managed by this integration's typed fields.`,
			);
		}
		if (SENSITIVE_PROP_REGEX.test(key.toLowerCase())) {
			throw new ValidationError(
				`Extra property "${key}" looks credential-bearing. Extra properties are stored ` +
					'and displayed as plain text — use a typed secret field.',
			);
		}
	}
}

export function awsCredentialProperties(
	prefix: string,
	credentials: z.infer<typeof awsCredentialsSchema>,
): Record<string, string> {
	switch (credentials.method) {
		case 'ambient':
			return {};
		case 'static':
			return {
				[`${prefix}.access-key-id`]: credentials.access_key_id,
				[`${prefix}.secret-access-key`]: credentials.secret_access_key,
				...(credentials.session_token
					? { [`${prefix}.session-token`]: credentials.session_token }
					: {}),
			};
		case 'profile':
			return { [`${prefix}.profile-name`]: credentials.profile_name };
	}
}

export function unifiedAwsCredentialProperties(
	credentials: z.infer<typeof unifiedAwsCredentialsSchema>,
): Record<string, string> {
	switch (credentials.method) {
		case 'none':
			return {};
		case 'static':
			return {
				...(credentials.region ? { 'client.region': credentials.region } : {}),
				'client.access-key-id': credentials.access_key_id,
				'client.secret-access-key': credentials.secret_access_key,
				...(credentials.session_token ? { 'client.session-token': credentials.session_token } : {}),
			};
		case 'profile':
			return {
				...(credentials.region ? { 'client.region': credentials.region } : {}),
				'client.profile-name': credentials.profile_name,
			};
		case 'role':
			return {
				...(credentials.region ? { 'client.region': credentials.region } : {}),
				'client.role-arn': credentials.role_arn,
				...(credentials.role_session_name
					? { 'client.role-session-name': credentials.role_session_name }
					: {}),
			};
	}
}

export function runtimeCatalogProperties(
	runtime: z.infer<typeof icebergRuntimeSchema>,
): Record<string, string> {
	return runtime.pyarrow_use_large_types_on_read === undefined
		? {}
		: {
				'pyarrow.use-large-types-on-read': String(runtime.pyarrow_use_large_types_on_read),
			};
}

export function runtimeRootProperties(
	runtime: z.infer<typeof icebergRuntimeSchema>,
): Record<string, string> {
	return {
		...(runtime.max_workers === undefined ? {} : { 'max-workers': String(runtime.max_workers) }),
		...(runtime.legacy_current_snapshot_id === undefined
			? {}
			: { 'legacy-current-snapshot-id': String(runtime.legacy_current_snapshot_id) }),
		...(runtime.downcast_ns_timestamp_to_us_on_write === undefined
			? {}
			: {
					'downcast-ns-timestamp-to-us-on-write': String(
						runtime.downcast_ns_timestamp_to_us_on_write,
					),
				}),
	};
}

export function storageProperties(
	storage: z.infer<typeof icebergStorageSchema>,
): Record<string, string> {
	switch (storage.scheme) {
		case 'catalog':
			return {};
		case 's3':
			return {
				...(storage.region ? { 's3.region': storage.region } : {}),
				...(storage.endpoint ? { 's3.endpoint': storage.endpoint } : {}),
				...awsCredentialProperties('s3', storage.credentials),
				...(storage.role_arn ? { 's3.role-arn': storage.role_arn } : {}),
				...(storage.role_session_name ? { 's3.role-session-name': storage.role_session_name } : {}),
				...(storage.signer ? { 's3.signer': storage.signer } : {}),
				...(storage.signer_uri ? { 's3.signer.uri': storage.signer_uri } : {}),
				...(storage.signer_endpoint ? { 's3.signer.endpoint': storage.signer_endpoint } : {}),
				's3.resolve-region': String(storage.resolve_region),
				...(storage.proxy_uri ? { 's3.proxy-uri': storage.proxy_uri } : {}),
				...(storage.connect_timeout !== undefined
					? { 's3.connect-timeout': String(storage.connect_timeout) }
					: {}),
				...(storage.request_timeout !== undefined
					? { 's3.request-timeout': String(storage.request_timeout) }
					: {}),
				's3.force-virtual-addressing': String(storage.force_virtual_addressing),
				's3.anonymous': String(storage.anonymous),
			};
		case 'gcs':
			return {
				...(storage.project_id ? { 'gcs.project-id': storage.project_id } : {}),
				...(storage.auth.method === 'oauth_token'
					? {
							'gcs.oauth2.token': storage.auth.token,
							...(storage.auth.token_expires_at_ms
								? {
										'gcs.oauth2.token-expires-at': String(storage.auth.token_expires_at_ms),
									}
								: {}),
						}
					: {}),
				'gcs.access': storage.access,
				'gcs.consistency': storage.consistency,
				...(storage.cache_timeout !== undefined
					? { 'gcs.cache-timeout': String(storage.cache_timeout) }
					: {}),
				'gcs.requester-pays': String(storage.requester_pays),
				'gcs.session-kwargs': JSON.stringify(storage.session_kwargs),
				...(storage.service_host ? { 'gcs.service.host': storage.service_host } : {}),
				...(storage.default_location ? { 'gcs.default-location': storage.default_location } : {}),
				'gcs.version-aware': String(storage.version_aware),
			};
		case 'adls':
			return {
				...(storage.account_name ? { 'adls.account-name': storage.account_name } : {}),
				...(storage.auth.method === 'connection_string'
					? { 'adls.connection-string': storage.auth.connection_string }
					: {}),
				...(storage.auth.method === 'account_key'
					? { 'adls.account-key': storage.auth.account_key }
					: {}),
				...(storage.auth.method === 'sas_token'
					? { 'adls.sas-token': storage.auth.sas_token }
					: {}),
				...(storage.auth.method === 'service_principal'
					? {
							'adls.tenant-id': storage.auth.tenant_id,
							'adls.client-id': storage.auth.client_id,
							'adls.client-secret': storage.auth.client_secret,
						}
					: {}),
				...(storage.auth.method === 'access_token' ? { 'adls.token': storage.auth.token } : {}),
				...(storage.auth.method === 'credential'
					? { 'adls.credential': storage.auth.credential }
					: {}),
				...(storage.account_host ? { 'adls.account-host': storage.account_host } : {}),
				...(storage.blob_storage_authority
					? { 'adls.blob-storage-authority': storage.blob_storage_authority }
					: {}),
				...(storage.dfs_storage_authority
					? { 'adls.dfs-storage-authority': storage.dfs_storage_authority }
					: {}),
				'adls.blob-storage-scheme': storage.blob_storage_scheme,
				'adls.dfs-storage-scheme': storage.dfs_storage_scheme,
			};
		case 'hdfs':
			return {
				'hdfs.host': storage.host,
				'hdfs.port': String(storage.port),
				...(storage.user ? { 'hdfs.user': storage.user } : {}),
				...(storage.kerberos_ticket ? { 'hdfs.kerberos_ticket': storage.kerberos_ticket } : {}),
			};
		case 'hugging_face':
			return {
				'hf.endpoint': storage.endpoint,
				...(storage.token ? { 'hf.token': storage.token } : {}),
			};
	}
}

export function renderIcebergCatalog(options: {
	instanceName: string;
	catalogType: string;
	properties: Record<string, unknown>;
	descriptor?: Record<string, unknown>;
	rootProperties?: Record<string, unknown>;
	files?: { path: string; content: string }[];
}): RenderOutput {
	const { instanceName, catalogType, properties, descriptor, rootProperties, files } = options;
	return {
		env: { PYICEBERG_HOME: INTEGRATIONS_DIR },
		yamlFiles: [
			{
				path: '.pyiceberg.yaml',
				value: {
					...rootProperties,
					catalog: {
						[instanceName]: {
							type: catalogType,
							...properties,
						},
					},
				},
			},
		],
		files: [
			...(files ?? []),
			{
				path: `iceberg/${instanceName}.json`,
				content: `${JSON.stringify(
					{ catalog_name: instanceName, catalog_type: catalogType, ...descriptor },
					null,
					'\t',
				)}\n`,
			},
		],
		manifestExtra: { catalog_type: catalogType, ...descriptor },
	};
}

export const icebergStorageUiHints = {
	storage: { group: 'Storage', order: 20 },
	'storage.credentials.access_key_id': { widget: 'password' as const },
	'storage.credentials.secret_access_key': { widget: 'password' as const },
	'storage.credentials.session_token': { widget: 'password' as const },
	'storage.auth.token': { widget: 'password' as const },
	'storage.auth.connection_string': { widget: 'password' as const },
	'storage.auth.account_key': { widget: 'password' as const },
	'storage.auth.sas_token': { widget: 'password' as const },
	'storage.auth.client_secret': { widget: 'password' as const },
	'storage.auth.credential': { widget: 'password' as const },
	'storage.token': { widget: 'password' as const },
	runtime: { group: 'PyIceberg runtime', order: 80, advanced: true },
};

export const unifiedAwsUiHints = {
	unified_credentials: { group: 'Authentication', order: 11, advanced: true },
	'unified_credentials.access_key_id': { widget: 'password' as const },
	'unified_credentials.secret_access_key': { widget: 'password' as const },
	'unified_credentials.session_token': { widget: 'password' as const },
};

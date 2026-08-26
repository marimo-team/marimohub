import type { ProjectId, UserId } from '../ids';
import type { TempS3Creds } from './credentialBroker';

export type BrowseSurface = 'tables' | 'objects';

export type ObjectStoreProvider = 's3' | 'gcs' | 'azure_blob';

export interface S3ObjectStoreSource {
	provider: 's3';
	configured_bucket?: string;
	region?: string;
	endpoint?: string;
	path_style: boolean;
	auth:
		| {
				method: 'static';
				access_key_id: string;
				secret_access_key: string;
				session_token?: string;
		  }
		| { method: 'ambient' }
		| { method: 'anonymous' };
}

export interface GcsObjectStoreSource {
	provider: 'gcs';
	configured_bucket?: string;
	project_id?: string;
	auth: { method: 'service_account'; credentials_json: string } | { method: 'ambient' };
}

export interface AzureBlobObjectStoreSource {
	provider: 'azure_blob';
	configured_bucket?: string;
	account_name: string;
	endpoint_suffix: string;
	auth:
		| { method: 'ambient' }
		| { method: 'account_key'; account_key: string }
		| { method: 'sas_token'; sas_token: string }
		| { method: 'connection_string'; connection_string: string }
		| {
				method: 'service_principal';
				tenant_id: string;
				client_id: string;
				client_secret: string;
		  };
}

export type ObjectStoreSource =
	| S3ObjectStoreSource
	| GcsObjectStoreSource
	| AzureBlobObjectStoreSource;

export type ObjectStoreSourceFor<P extends ObjectStoreProvider> = Extract<
	ObjectStoreSource,
	{ provider: P }
>;

export interface S3FederationContext {
	provider: 's3';
	credentials: TempS3Creds;
	storage: { endpoint?: string; region?: string };
}

export interface ObjectBrowseContext {
	project_id?: ProjectId;
	user_id: UserId;
	user_email: string;
	federation?: S3FederationContext;
	allow_server_ambient: Partial<Record<ObjectStoreProvider, boolean>>;
	signal?: AbortSignal;
}

export interface ObjectPageRequest {
	limit: number;
	cursor?: string;
}

export interface ObjectListRequest extends ObjectPageRequest {
	bucket: string;
	prefix?: string;
}

export interface ObjectIdentity {
	bucket: string;
	key: string;
	version_id?: string;
}

export interface ObjectSearchFilters {
	formats?: string[];
	modified_after?: string;
	modified_before?: string;
	min_size?: number;
	max_size?: number;
}

export interface ObjectSearchRequest extends ObjectPageRequest, ObjectSearchFilters {
	bucket: string;
	prefix?: string;
	query: string;
}

export interface ObjectVersionRequest extends ObjectPageRequest, ObjectIdentity {}

export interface ObjectPreviewRequest extends ObjectIdentity {
	limit: number;
	content_url: string;
}

export interface ObjectOpenRequest extends ObjectIdentity {
	range?: string;
	if_match?: string;
	inline?: boolean;
}

export interface ObjectBucket {
	name: string;
	created_at?: string;
	configured: boolean;
}

export interface ObjectEntry {
	kind: 'prefix' | 'object';
	name: string;
	key: string;
	size?: number;
	last_modified?: string;
	etag?: string;
	storage_class?: string;
}

export interface ObjectPage<T> {
	items: T[];
	next_cursor: string | null;
}

export interface ObjectSearchPage extends ObjectPage<ObjectEntry> {
	scanned: number;
	complete: boolean;
}

export interface ObjectChecksum {
	algorithm: string;
	value: string;
}

export interface ObjectTag {
	key: string;
	value: string;
}

export interface ObjectDetail extends ObjectIdentity {
	size: number;
	last_modified?: string;
	etag?: string;
	storage_class?: string;
	content_type?: string;
	content_encoding?: string;
	cache_control?: string;
	checksums: ObjectChecksum[];
	metadata: Record<string, string>;
	tags?: ObjectTag[];
	tags_available: boolean;
	snippet?: string;
}

export interface ObjectVersion extends ObjectIdentity {
	kind: 'version' | 'delete-marker';
	is_latest: boolean;
	last_modified?: string;
	size?: number;
	etag?: string;
	storage_class?: string;
	owner?: { id?: string; display_name?: string };
}

export interface TabularPreview {
	kind: 'tabular';
	format: 'table' | 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet';
	columns: { name: string; type?: string }[];
	rows: unknown[][];
	truncated: boolean;
	bytes_read?: number;
	total_bytes?: number;
	warnings: string[];
}

export type ObjectPreview =
	| TabularPreview
	| {
			kind: 'text';
			format: 'text' | 'markdown' | 'code' | 'log' | 'json';
			text: string;
			truncated: boolean;
			bytes_read: number;
			total_bytes: number;
			warnings: string[];
	  }
	| {
			kind: 'image';
			format: 'png' | 'jpeg' | 'gif' | 'webp';
			content_url: string;
			width?: number;
			height?: number;
			total_bytes: number;
			warnings: string[];
	  }
	| {
			kind: 'unsupported';
			reason: string;
			detected_type?: string;
			total_bytes: number;
	  };

export interface ObjectBody {
	body: ReadableStream<Uint8Array>;
	status: 200 | 206;
	content_type: string;
	content_length: number;
	total_size: number;
	content_range?: string;
	etag?: string;
	version_id?: string;
	close(): void;
}

export type ObjectBrowseErrorCode =
	| 'access_denied'
	| 'not_found'
	| 'precondition_failed'
	| 'range_not_satisfiable'
	| 'unsupported'
	| 'invalid_cursor'
	| 'unavailable'
	| 'aborted';

export class ObjectBrowseError extends Error {
	readonly name = 'ObjectBrowseError';

	constructor(
		readonly code: ObjectBrowseErrorCode,
		message: string,
		readonly request_id?: string,
	) {
		super(message);
	}
}

export interface ObjectBrowseCapability {
	provider: ObjectStoreProvider;
	root_kind: 'bucket' | 'container';
	uri_scheme: 's3' | 'gs' | 'az';
	available: boolean;
	preview: boolean;
	download: boolean;
	search: 'none' | 'bounded-key-name';
	versions: boolean;
	preview_formats: string[];
	reason?: string;
}

export interface ObjectBrowser<P extends ObjectStoreProvider = ObjectStoreProvider> {
	readonly provider: P;
	capability(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
	): Promise<ObjectBrowseCapability> | ObjectBrowseCapability;
	listBuckets(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectPageRequest,
	): Promise<ObjectPage<ObjectBucket>>;
	listObjects(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>>;
	searchObjects(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage>;
	headObject(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail>;
	listVersions(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>>;
	previewObject(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview>;
	openObject(
		source: ObjectStoreSourceFor<P>,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody>;
}

export type ObjectBrowserRegistry = {
	[P in ObjectStoreProvider]?: ObjectBrowser<P>;
};

export const OBJECT_BROWSE_PROVIDER_METADATA = {
	s3: { provider: 's3', root_kind: 'bucket', uri_scheme: 's3' },
	gcs: { provider: 'gcs', root_kind: 'bucket', uri_scheme: 'gs' },
	azure_blob: { provider: 'azure_blob', root_kind: 'container', uri_scheme: 'az' },
} as const satisfies Record<
	ObjectStoreProvider,
	Pick<ObjectBrowseCapability, 'provider' | 'root_kind' | 'uri_scheme'>
>;

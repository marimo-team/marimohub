import type { ProjectId, UserId } from '../ids';
import type { TempS3Creds } from './credentialBroker';

export type BrowseSurface = 'tables' | 'objects';

export interface ObjectStoreSource {
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
		| { method: 'ambient' };
}

export interface ObjectBrowseContext {
	project_id: ProjectId;
	user_id: UserId;
	user_email: string;
	temporary_s3_credentials?: TempS3Creds;
	temporary_storage?: { endpoint?: string; region?: string };
	allow_server_ambient: boolean;
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
	available: boolean;
	preview: boolean;
	download: boolean;
	search: 'bounded-key-name';
	versions: boolean;
	preview_formats: string[];
	reason?: string;
}

export interface ObjectBrowser {
	capability(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
	): Promise<ObjectBrowseCapability> | ObjectBrowseCapability;
	listBuckets(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPageRequest,
	): Promise<ObjectPage<ObjectBucket>>;
	listObjects(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>>;
	searchObjects(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage>;
	headObject(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail>;
	listVersions(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>>;
	previewObject(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview>;
	openObject(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody>;
}

import {
	GetObjectTaggingCommand,
	HeadObjectCommand,
	ListBucketsCommand,
	ListObjectsV2Command,
	ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type {
	ObjectBody,
	ObjectBrowseCapability,
	ObjectBrowseContext,
	ObjectBrowser,
	ObjectBucket,
	ObjectDetail,
	ObjectEntry,
	ObjectIdentity,
	ObjectListRequest,
	ObjectOpenRequest,
	ObjectPage,
	ObjectPageRequest,
	ObjectPreview,
	ObjectPreviewRequest,
	ObjectSearchPage,
	ObjectSearchRequest,
	ObjectStoreSource,
	ObjectVersion,
	ObjectVersionRequest,
} from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import { createS3ClientFactory, credentialsFor } from './client';
import type { GuardedHostResolver, S3ClientFactory } from './client';
import { decodeCursor, encodeCursor } from './cursors';
import { mapS3Error } from './errors';
import { S3_PREVIEW_FORMATS } from './formats';
import { openS3Object } from './open';
import { previewS3Object } from './preview';
import { sendS3, withOperationDeadline, withS3Client } from './s3Request';
import { assertBucket, assertObjectIdentity } from './validation';

export interface S3ObjectBrowserLimits {
	previewMaxBytes: number;
	inlineImageMaxBytes: number;
	parquetMaxRangedBytes: number;
	searchMaxKeys: number;
	metadataTimeoutMs: number;
	previewTimeoutMs: number;
}

export interface S3ObjectBrowserOptions {
	mode: 'metadata' | 'full';
	limits?: Partial<S3ObjectBrowserLimits>;
	resolveHost?: GuardedHostResolver;
	clientFactory?: S3ClientFactory;
}

export const DEFAULT_S3_OBJECT_BROWSER_LIMITS: S3ObjectBrowserLimits = {
	previewMaxBytes: 8 * 1024 * 1024,
	inlineImageMaxBytes: 10 * 1024 * 1024,
	parquetMaxRangedBytes: 32 * 1024 * 1024,
	searchMaxKeys: 5_000,
	metadataTimeoutMs: 30_000,
	previewTimeoutMs: 30_000,
};

const SEARCH_BATCH_SIZE = 1_000;

export class S3ObjectBrowser implements ObjectBrowser {
	private readonly mode: 'metadata' | 'full';
	private readonly limits: S3ObjectBrowserLimits;
	private readonly clientFactory: S3ClientFactory;

	constructor(options: S3ObjectBrowserOptions) {
		this.mode = options.mode;
		this.limits = { ...DEFAULT_S3_OBJECT_BROWSER_LIMITS, ...options.limits };
		if (options.clientFactory) this.clientFactory = options.clientFactory;
		else if (options.resolveHost) {
			const transportTimeoutMs = Math.max(
				this.limits.metadataTimeoutMs,
				this.limits.previewTimeoutMs,
			);
			this.clientFactory = createS3ClientFactory({
				resolveHost: options.resolveHost,
				connectionTimeoutMs: transportTimeoutMs,
				requestTimeoutMs: transportTimeoutMs,
			});
		} else {
			throw new Error('S3ObjectBrowser requires a guarded host resolver.');
		}
	}

	capability(source: ObjectStoreSource, context: ObjectBrowseContext): ObjectBrowseCapability {
		try {
			credentialsFor(source, context);
			return {
				available: true,
				preview: this.mode === 'full',
				download: this.mode === 'full',
				search: 'bounded-key-name',
				versions: true,
				preview_formats: this.mode === 'full' ? [...S3_PREVIEW_FORMATS] : [],
			};
		} catch (error) {
			const mapped = mapS3Error(error);
			return {
				available: false,
				preview: false,
				download: false,
				search: 'none',
				versions: false,
				preview_formats: [],
				reason: mapped.message,
			};
		}
	}

	async listBuckets(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPageRequest,
	): Promise<ObjectPage<ObjectBucket>> {
		if (source.configured_bucket) {
			if (request.cursor) throw new ObjectBrowseError('invalid_cursor', 'The cursor is invalid.');
			return {
				items: [{ name: source.configured_bucket, configured: true }],
				next_cursor: null,
			};
		}
		const cursor = decodeCursor(request.cursor, ['token']);
		return this.metadataOperation(context, (scopedContext) =>
			withS3Client(this.clientFactory, source, scopedContext, async (client) => {
				const output = await sendS3<{
					Buckets?: { Name?: string; CreationDate?: Date }[];
					ContinuationToken?: string;
				}>(
					client,
					new ListBucketsCommand({
						MaxBuckets: request.limit,
						ContinuationToken: cursor.token,
					}),
					scopedContext.signal,
				);
				return {
					items: (output.Buckets ?? [])
						.filter((bucket): bucket is { Name: string; CreationDate?: Date } =>
							Boolean(bucket.Name),
						)
						.map((bucket) => ({
							name: bucket.Name,
							created_at: bucket.CreationDate?.toISOString(),
							configured: false,
						})),
					next_cursor: output.ContinuationToken
						? encodeCursor({ token: output.ContinuationToken })
						: null,
				};
			}),
		);
	}

	async listObjects(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>> {
		assertBucket(source, request.bucket);
		const prefix = request.prefix ?? '';
		const cursor = decodeCursor(request.cursor, ['token']);
		return this.metadataOperation(context, (scopedContext) =>
			withS3Client(this.clientFactory, source, scopedContext, async (client) => {
				const output = await sendS3<ListObjectsOutput>(
					client,
					new ListObjectsV2Command({
						Bucket: request.bucket,
						Prefix: prefix,
						Delimiter: '/',
						MaxKeys: request.limit,
						ContinuationToken: cursor.token,
					}),
					scopedContext.signal,
				);
				const prefixes = new Set(
					(output.CommonPrefixes ?? []).flatMap(({ Prefix }) => (Prefix ? [Prefix] : [])),
				);
				const items: ObjectEntry[] = [
					...prefixes.values().map((key) => ({
						kind: 'prefix' as const,
						key,
						name: key.slice(prefix.length).replace(/\/$/, ''),
					})),
					...(output.Contents ?? [])
						.filter(({ Key, Size }) => Key && !(Size === 0 && prefixes.has(Key)))
						.map((object) => objectEntry(object, prefix)),
				].sort((left, right) => left.key.localeCompare(right.key));
				return {
					items,
					next_cursor: output.NextContinuationToken
						? encodeCursor({ token: output.NextContinuationToken })
						: null,
				};
			}),
		);
	}

	async searchObjects(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage> {
		assertBucket(source, request.bucket);
		const prefix = request.prefix ?? '';
		const cursor = decodeCursor(request.cursor, ['token', 'start_after']);
		if (cursor.token && cursor.start_after) {
			throw new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
		}
		const query = request.query.toLocaleLowerCase();
		return this.metadataOperation(context, (scopedContext) =>
			withS3Client(this.clientFactory, source, scopedContext, async (client) => {
				const items: ObjectEntry[] = [];
				let scanned = 0;
				let token = cursor.token;
				let startAfter = cursor.start_after;
				let complete = false;
				let nextCursor: string | null = null;
				while (scanned < this.limits.searchMaxKeys && items.length < request.limit) {
					const remainingScan = this.limits.searchMaxKeys - scanned;
					const requestToken = token;
					const output = await sendS3<ListObjectsOutput>(
						client,
						new ListObjectsV2Command({
							Bucket: request.bucket,
							Prefix: prefix,
							MaxKeys: Math.min(remainingScan, SEARCH_BATCH_SIZE),
							ContinuationToken: token,
							StartAfter: token ? undefined : startAfter,
						}),
						scopedContext.signal,
					);
					const contents = (output.Contents ?? []).filter(
						(object): object is typeof object & { Key: string } => object.Key !== undefined,
					);
					for (let index = 0; index < contents.length; index += 1) {
						const object = contents[index];
						scanned += 1;
						if (object.Key.slice(prefix.length).toLocaleLowerCase().includes(query)) {
							const entry = objectEntry(object, prefix);
							if (matchesFilters(entry, request)) items.push(entry);
						}
						if (scanned < this.limits.searchMaxKeys && items.length < request.limit) {
							continue;
						}
						if (index < contents.length - 1) {
							nextCursor = encodeCursor({ start_after: object.Key });
						} else if (output.IsTruncated && output.NextContinuationToken) {
							nextCursor = encodeCursor({ token: output.NextContinuationToken });
						} else {
							complete = true;
						}
						break;
					}
					if (items.length >= request.limit || scanned >= this.limits.searchMaxKeys) break;
					if (!output.IsTruncated) {
						complete = true;
						break;
					}
					token = output.NextContinuationToken;
					startAfter = undefined;
					if (!token || token === requestToken) {
						throw new ObjectBrowseError(
							'invalid_cursor',
							'The object-store cursor did not advance.',
						);
					}
				}
				if (!complete && !nextCursor && token) nextCursor = encodeCursor({ token });
				return {
					items,
					scanned,
					complete,
					next_cursor: complete ? null : nextCursor,
				};
			}),
		);
	}

	async headObject(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail> {
		assertObjectIdentity(source, request);
		return this.metadataOperation(context, (scopedContext) =>
			withS3Client(this.clientFactory, source, scopedContext, async (client) => {
				const input = {
					Bucket: request.bucket,
					Key: request.key,
					VersionId: request.version_id,
				};
				let head: HeadOutput;
				try {
					head = await sendS3<HeadOutput>(
						client,
						new HeadObjectCommand({ ...input, ChecksumMode: 'ENABLED' }),
						scopedContext.signal,
					);
				} catch (error) {
					if (!(error instanceof ObjectBrowseError) || error.code !== 'access_denied') throw error;
					head = await sendS3<HeadOutput>(
						client,
						new HeadObjectCommand(input),
						scopedContext.signal,
					);
				}
				let tags: { key: string; value: string }[] | undefined;
				let tagsAvailable = false;
				try {
					const tagged = await sendS3<{ TagSet?: { Key?: string; Value?: string }[] }>(
						client,
						new GetObjectTaggingCommand({
							Bucket: request.bucket,
							Key: request.key,
							VersionId: request.version_id,
						}),
						scopedContext.signal,
					);
					tags = (tagged.TagSet ?? []).flatMap((tag) =>
						tag.Key !== undefined && tag.Value !== undefined
							? [{ key: tag.Key, value: tag.Value }]
							: [],
					);
					tagsAvailable = true;
				} catch (error) {
					const mapped = mapS3Error(error);
					if (mapped.code !== 'access_denied' && mapped.code !== 'unsupported') throw mapped;
				}
				return detailFromHead(request, head, tags, tagsAvailable);
			}),
		);
	}

	async listVersions(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>> {
		assertObjectIdentity(source, request);
		const cursor = decodeCursor(request.cursor, ['key', 'version']);
		return this.metadataOperation(context, (scopedContext) =>
			withS3Client(this.clientFactory, source, scopedContext, async (client) => {
				const output = await sendS3<VersionsOutput>(
					client,
					new ListObjectVersionsCommand({
						Bucket: request.bucket,
						Prefix: request.key,
						MaxKeys: request.limit,
						KeyMarker: cursor.key,
						VersionIdMarker: cursor.version,
					}),
					scopedContext.signal,
				);
				const versions: ObjectVersion[] = [
					...(output.Versions ?? []).flatMap((version) =>
						version.Key === request.key && version.VersionId
							? [versionEntry(request.bucket, version, 'version')]
							: [],
					),
					...(output.DeleteMarkers ?? []).flatMap((version) =>
						version.Key === request.key && version.VersionId
							? [versionEntry(request.bucket, version, 'delete-marker')]
							: [],
					),
				].sort((left, right) =>
					(right.last_modified ?? '').localeCompare(left.last_modified ?? ''),
				);
				return {
					items: versions,
					next_cursor:
						output.IsTruncated && output.NextKeyMarker
							? encodeCursor({ key: output.NextKeyMarker, version: output.NextVersionIdMarker })
							: null,
				};
			}),
		);
	}

	previewObject(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview> {
		if (this.mode !== 'full') {
			throw new ObjectBrowseError('access_denied', 'Object previews are disabled.');
		}
		assertObjectIdentity(source, request);
		return previewS3Object(this.clientFactory, this.limits, source, context, request);
	}

	openObject(
		source: ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody> {
		if (this.mode !== 'full') {
			throw new ObjectBrowseError('access_denied', 'Object downloads are disabled.');
		}
		assertObjectIdentity(source, request);
		return openS3Object(this.clientFactory, this.limits, source, context, request);
	}

	private metadataOperation<T>(
		context: ObjectBrowseContext,
		run: (context: ObjectBrowseContext) => Promise<T>,
	): Promise<T> {
		return withOperationDeadline(context, this.limits.metadataTimeoutMs, run);
	}
}

interface ListObjectsOutput {
	Contents?: {
		Key?: string;
		Size?: number;
		LastModified?: Date;
		ETag?: string;
		StorageClass?: string;
	}[];
	CommonPrefixes?: { Prefix?: string }[];
	IsTruncated?: boolean;
	NextContinuationToken?: string;
}

interface HeadOutput {
	ContentLength?: number;
	LastModified?: Date;
	ETag?: string;
	StorageClass?: string;
	ContentType?: string;
	ContentEncoding?: string;
	CacheControl?: string;
	VersionId?: string;
	Metadata?: Record<string, string>;
	ChecksumCRC32?: string;
	ChecksumCRC32C?: string;
	ChecksumCRC64NVME?: string;
	ChecksumSHA1?: string;
	ChecksumSHA256?: string;
}

interface VersionsOutput {
	Versions?: VersionOutput[];
	DeleteMarkers?: VersionOutput[];
	IsTruncated?: boolean;
	NextKeyMarker?: string;
	NextVersionIdMarker?: string;
}

interface VersionOutput {
	Key?: string;
	VersionId?: string;
	IsLatest?: boolean;
	LastModified?: Date;
	Size?: number;
	ETag?: string;
	StorageClass?: string;
	Owner?: { ID?: string; DisplayName?: string };
}

function objectEntry(
	object: NonNullable<ListObjectsOutput['Contents']>[number],
	prefix: string,
): ObjectEntry {
	return {
		kind: 'object',
		name: object.Key!.slice(prefix.length),
		key: object.Key!,
		size: object.Size,
		last_modified: object.LastModified?.toISOString(),
		etag: object.ETag,
		storage_class: object.StorageClass,
	};
}

function matchesFilters(entry: ObjectEntry, filters: ObjectSearchRequest): boolean {
	const extension = entry.key.split('.').at(-1)?.toLowerCase();
	if (filters.formats?.length && (!extension || !filters.formats.includes(extension))) return false;
	if (filters.min_size !== undefined && (entry.size ?? 0) < filters.min_size) return false;
	if (filters.max_size !== undefined && (entry.size ?? 0) > filters.max_size) return false;
	if (
		filters.modified_after &&
		(!entry.last_modified || Date.parse(entry.last_modified) < Date.parse(filters.modified_after))
	)
		return false;
	if (
		filters.modified_before &&
		entry.last_modified &&
		Date.parse(entry.last_modified) > Date.parse(filters.modified_before)
	)
		return false;
	return true;
}

function detailFromHead(
	request: ObjectIdentity,
	head: HeadOutput,
	tags: { key: string; value: string }[] | undefined,
	tagsAvailable: boolean,
): ObjectDetail {
	const checksums = [
		['crc32', head.ChecksumCRC32],
		['crc32c', head.ChecksumCRC32C],
		['crc64nvme', head.ChecksumCRC64NVME],
		['sha1', head.ChecksumSHA1],
		['sha256', head.ChecksumSHA256],
	].flatMap(([algorithm, value]) => (value ? [{ algorithm: algorithm!, value }] : []));
	return {
		...request,
		version_id: head.VersionId ?? request.version_id,
		size: head.ContentLength ?? 0,
		last_modified: head.LastModified?.toISOString(),
		etag: head.ETag,
		storage_class: head.StorageClass,
		content_type: head.ContentType,
		content_encoding: head.ContentEncoding,
		cache_control: head.CacheControl,
		checksums,
		metadata: head.Metadata ?? {},
		tags,
		tags_available: tagsAvailable,
	};
}

function versionEntry(
	bucket: string,
	version: VersionOutput & { Key?: string; VersionId?: string },
	kind: 'version' | 'delete-marker',
): ObjectVersion {
	return {
		kind,
		bucket,
		key: version.Key!,
		version_id: version.VersionId!,
		is_latest: version.IsLatest ?? false,
		last_modified: version.LastModified?.toISOString(),
		size: version.Size,
		etag: version.ETag,
		storage_class: version.StorageClass,
		owner: version.Owner
			? { id: version.Owner.ID, display_name: version.Owner.DisplayName }
			: undefined,
	};
}

export type { GuardedHostResolver, S3ClientFactory, S3ClientLike } from './client';

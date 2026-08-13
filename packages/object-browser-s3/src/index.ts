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
	ObjectVersion,
	ObjectVersionRequest,
	Metrics,
	S3ObjectStoreSource,
} from '@marimo-hub/core';
import { OBJECT_BROWSE_PROVIDER_METADATA, ObjectBrowseError } from '@marimo-hub/core';
import {
	decodeCursor,
	DEFAULT_OBJECT_BROWSER_LIMITS,
	encodeCursor,
	matchesObjectSearchFilters,
	OBJECT_PREVIEW_FORMATS,
	ObjectBrowserObserver,
	assertBucket,
	assertObjectIdentity,
	previewObject,
	withOperationDeadline,
} from '@marimo-hub/object-browser-commons';
import type { ObjectBrowserLimits, ObjectPreviewReader } from '@marimo-hub/object-browser-commons';
import { createS3ClientFactory, credentialsFor } from './client';
import type { GuardedHostResolver, S3ClientFactory } from './client';
import { mapS3Error } from './errors';
import { openS3Object } from './open';
import { readObjectRange, sendS3, withS3Client } from './s3Request';

export type S3ObjectBrowserLimits = ObjectBrowserLimits;

export interface S3ObjectBrowserOptions {
	mode: 'metadata' | 'full';
	metrics?: Metrics;
	limits?: Partial<S3ObjectBrowserLimits>;
	resolveHost?: GuardedHostResolver;
	clientFactory?: S3ClientFactory;
}

export const DEFAULT_S3_OBJECT_BROWSER_LIMITS = DEFAULT_OBJECT_BROWSER_LIMITS;

const SEARCH_BATCH_SIZE = 1_000;

export class S3ObjectBrowser implements ObjectBrowser<'s3'> {
	readonly provider = 's3' as const;
	private readonly mode: 'metadata' | 'full';
	private readonly limits: S3ObjectBrowserLimits;
	private readonly clientFactory: S3ClientFactory;
	private readonly observer: ObjectBrowserObserver;

	constructor(options: S3ObjectBrowserOptions) {
		this.mode = options.mode;
		this.observer = new ObjectBrowserObserver(this.provider, options.mode, options.metrics);
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

	capability(source: S3ObjectStoreSource, context: ObjectBrowseContext): ObjectBrowseCapability {
		try {
			credentialsFor(source, context);
			return {
				...OBJECT_BROWSE_PROVIDER_METADATA.s3,
				available: true,
				preview: this.mode === 'full',
				download: this.mode === 'full',
				search: 'bounded-key-name',
				versions: true,
				preview_formats: this.mode === 'full' ? [...OBJECT_PREVIEW_FORMATS] : [],
			};
		} catch (error) {
			const mapped = mapS3Error(error);
			return {
				...OBJECT_BROWSE_PROVIDER_METADATA.s3,
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
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPageRequest,
	): Promise<ObjectPage<ObjectBucket>> {
		return this.observe('list_buckets', context, async () => {
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
						items: providerArray(output.Buckets)
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
		});
	}

	async listObjects(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>> {
		return this.observe('list_objects', context, async () => {
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
						providerArray(output.CommonPrefixes).flatMap(({ Prefix }) => (Prefix ? [Prefix] : [])),
					);
					const items: ObjectEntry[] = [
						...prefixes.values().map((key) => ({
							kind: 'prefix' as const,
							key,
							name: key.slice(prefix.length).replace(/\/$/, ''),
						})),
						...providerArray(output.Contents)
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
		});
	}

	async searchObjects(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage> {
		return this.observe('search_objects', context, async () => {
			assertBucket(source, request.bucket);
			const prefix = request.prefix ?? '';
			const cursor = decodeCursor(request.cursor, ['token', 'start_after']);
			if (cursor.token && cursor.start_after) {
				throw new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
			}
			const query = request.query.toLocaleLowerCase();
			const result = await this.metadataOperation(context, (scopedContext) =>
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
						const contents = providerArray(output.Contents).filter(
							(object): object is typeof object & { Key: string } => object.Key !== undefined,
						);
						for (let index = 0; index < contents.length; index += 1) {
							const object = contents[index];
							scanned += 1;
							if (object.Key.slice(prefix.length).toLocaleLowerCase().includes(query)) {
								const entry = objectEntry(object, prefix);
								if (matchesObjectSearchFilters(entry, request)) items.push(entry);
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
			this.observer.keysScanned(result.scanned);
			return result;
		});
	}

	async headObject(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail> {
		return this.observe('head_object', context, async () => {
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
						if (!(error instanceof ObjectBrowseError) || error.code !== 'access_denied')
							throw error;
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
						tags = providerArray(tagged.TagSet).flatMap((tag) =>
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
		});
	}

	async listVersions(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>> {
		return this.observe('list_versions', context, async () => {
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
						...providerArray(output.Versions).flatMap((version) =>
							version.Key === request.key && version.VersionId
								? [versionEntry(request.bucket, version, 'version')]
								: [],
						),
						...providerArray(output.DeleteMarkers).flatMap((version) =>
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
		});
	}

	previewObject(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview> {
		return this.observe('preview_object', context, async () => {
			if (this.mode !== 'full') {
				throw new ObjectBrowseError('access_denied', 'Object previews are disabled.');
			}
			assertObjectIdentity(source, request);
			const result = await this.preview(source, context, request);
			this.observer.previewRead(result, this.limits);
			return result;
		});
	}

	openObject(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody> {
		return this.observe('open_object', context, async () => {
			if (this.mode !== 'full') {
				throw new ObjectBrowseError('access_denied', 'Object downloads are disabled.');
			}
			assertObjectIdentity(source, request);
			const object = await openS3Object(this.clientFactory, this.limits, source, context, request);
			return this.observer.observeBody(
				object,
				request.inline ? Math.min(object.total_size, 16) : 0,
			);
		});
	}

	private async observe<T>(
		operation: string,
		context: ObjectBrowseContext,
		run: () => Promise<T>,
	): Promise<T> {
		return this.observer.observe(operation, context, run);
	}

	private preview(
		source: S3ObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview> {
		return withS3Client(this.clientFactory, source, context, (client) => {
			const reader: ObjectPreviewReader = {
				async head(identity, signal) {
					const head = await sendS3<HeadOutput>(
						client,
						new HeadObjectCommand({
							Bucket: identity.bucket,
							Key: identity.key,
							VersionId: identity.version_id,
						}),
						signal,
					);
					return {
						total_bytes: head.ContentLength ?? 0,
						content_type: head.ContentType,
						etag: head.ETag,
					};
				},
				readRange: (identity, start, end, options) =>
					readObjectRange(client, identity, start, end, options),
			};
			return previewObject(reader, this.limits, context, request);
		});
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

function providerArray<T>(value: T[] | undefined): T[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value;
	throw new ObjectBrowseError('unavailable', 'The object-store request failed.');
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

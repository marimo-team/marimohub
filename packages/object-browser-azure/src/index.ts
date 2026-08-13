import { Buffer } from 'node:buffer';
import type { BlobItem, BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import type {
	AzureBlobObjectStoreSource,
	Metrics,
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
} from '@marimo-hub/core';
import { OBJECT_BROWSE_PROVIDER_METADATA, ObjectBrowseError } from '@marimo-hub/core';
import {
	assertBucket,
	assertObjectIdentity,
	decodeCursor,
	DEFAULT_OBJECT_BROWSER_LIMITS,
	detectRasterImage,
	encodeCursor,
	guardObjectStream,
	matchesObjectSearchFilters,
	OBJECT_PREVIEW_FORMATS,
	ObjectBrowserObserver,
	previewObject,
	rasterContentType,
	readBoundedBody,
	toWebStream,
	withOperationDeadline,
} from '@marimo-hub/object-browser-commons';
import type {
	GuardedHostResolver,
	ObjectBrowserLimits,
	ObjectPreviewReader,
} from '@marimo-hub/object-browser-commons';
import { createAzureClient } from './client';

export interface AzureBlobObjectBrowserOptions {
	mode: 'metadata' | 'full';
	metrics?: Metrics;
	limits?: Partial<ObjectBrowserLimits>;
	resolveHost: GuardedHostResolver;
	fetchImpl?: typeof fetch;
}

export class AzureBlobObjectBrowser implements ObjectBrowser<'azure_blob'> {
	readonly provider = 'azure_blob' as const;
	private readonly mode: 'metadata' | 'full';
	private readonly limits: ObjectBrowserLimits;
	private readonly observer: ObjectBrowserObserver;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: AzureBlobObjectBrowserOptions) {
		this.mode = options.mode;
		this.limits = { ...DEFAULT_OBJECT_BROWSER_LIMITS, ...options.limits };
		this.observer = new ObjectBrowserObserver(this.provider, options.mode, options.metrics);
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	capability(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
	): ObjectBrowseCapability {
		try {
			this.client(source, context);
			return {
				...OBJECT_BROWSE_PROVIDER_METADATA.azure_blob,
				available: true,
				preview: this.mode === 'full',
				download: this.mode === 'full',
				search: 'bounded-key-name',
				versions: true,
				preview_formats: this.mode === 'full' ? [...OBJECT_PREVIEW_FORMATS] : [],
			};
		} catch (error) {
			const mapped = mapAzureError(error);
			return {
				...OBJECT_BROWSE_PROVIDER_METADATA.azure_blob,
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

	listBuckets(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPageRequest,
	): Promise<ObjectPage<ObjectBucket>> {
		return this.observe('list_buckets', context, async () => {
			if (source.configured_bucket) {
				if (request.cursor) throw invalidCursor();
				return {
					items: [{ name: source.configured_bucket, configured: true }],
					next_cursor: null,
				};
			}
			return this.metadata(context, async (scoped) => {
				try {
					const cursor = decodeCursor(request.cursor, ['token']);
					const pages = this.client(source, scoped)
						.listContainers()
						.byPage({ continuationToken: cursor.token, maxPageSize: request.limit });
					const next = await pages.next();
					if (next.done) return { items: [], next_cursor: null };
					if (next.value.continuationToken && next.value.continuationToken === cursor.token) {
						throw nonAdvancingCursor();
					}
					return {
						items: next.value.containerItems.map((container) => ({
							name: container.name,
							created_at: container.properties.lastModified?.toISOString(),
							configured: false,
						})),
						next_cursor: next.value.continuationToken
							? encodeCursor({ token: next.value.continuationToken })
							: null,
					};
				} catch (error) {
					throw mapAzureError(error);
				}
			});
		});
	}

	listObjects(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>> {
		return this.observe('list_objects', context, async () => {
			assertBucket(source, request.bucket);
			return this.metadata(context, async (scoped) => {
				try {
					const cursor = decodeCursor(request.cursor, ['token']);
					const prefix = request.prefix ?? '';
					const pages = this.container(source, scoped, request.bucket)
						.listBlobsByHierarchy('/', { prefix })
						.byPage({ continuationToken: cursor.token, maxPageSize: request.limit });
					const next = await pages.next();
					if (next.done) return { items: [], next_cursor: null };
					const page = next.value;
					if (page.continuationToken && page.continuationToken === cursor.token) {
						throw nonAdvancingCursor();
					}
					const prefixes = (page.segment.blobPrefixes ?? []).map(({ name: key }) => ({
						kind: 'prefix' as const,
						key,
						name: key.slice(prefix.length).replace(/\/$/, ''),
					}));
					const objects = page.segment.blobItems.map((item) => blobEntry(item, prefix));
					return {
						items: [...prefixes, ...objects].sort((left, right) =>
							left.key.localeCompare(right.key),
						),
						next_cursor: page.continuationToken
							? encodeCursor({ token: page.continuationToken })
							: null,
					};
				} catch (error) {
					throw mapAzureError(error);
				}
			});
		});
	}

	searchObjects(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage> {
		return this.observe('search_objects', context, async () => {
			assertBucket(source, request.bucket);
			const result = await this.metadata(context, async (scoped) => {
				try {
					const cursor = decodeCursor(request.cursor, ['token', 'skip']);
					const initialSkip = cursor.skip === undefined ? 0 : Number(cursor.skip);
					if (!Number.isSafeInteger(initialSkip) || initialSkip < 0) throw invalidCursor();
					let token = cursor.token || undefined;
					let skip = initialSkip;
					let scanned = 0;
					let complete = false;
					let nextCursor: string | null = null;
					const items: ObjectEntry[] = [];
					const container = this.container(source, scoped, request.bucket);
					const prefix = request.prefix ?? '';
					const query = request.query.toLocaleLowerCase();
					while (scanned < this.limits.searchMaxKeys && items.length < request.limit) {
						const pageToken = token;
						const pages = container.listBlobsFlat({ prefix }).byPage({
							continuationToken: token,
							maxPageSize: Math.min(1_000, this.limits.searchMaxKeys - scanned),
						});
						const next = await pages.next();
						if (next.done) {
							complete = true;
							break;
						}
						const blobs = next.value.segment.blobItems;
						if (skip > blobs.length) throw invalidCursor();
						for (let index = skip; index < blobs.length; index += 1) {
							const entry = blobEntry(blobs[index], prefix);
							scanned += 1;
							if (
								entry.key.slice(prefix.length).toLocaleLowerCase().includes(query) &&
								matchesObjectSearchFilters(entry, request)
							) {
								items.push(entry);
							}
							if (scanned >= this.limits.searchMaxKeys || items.length >= request.limit) {
								nextCursor =
									index < blobs.length - 1
										? encodeCursor({ token: pageToken ?? '', skip: String(index + 1) })
										: next.value.continuationToken
											? encodeCursor({ token: next.value.continuationToken, skip: '0' })
											: null;
								complete = nextCursor === null;
								break;
							}
						}
						if (nextCursor || complete) break;
						if (!next.value.continuationToken) {
							complete = true;
							break;
						}
						if (next.value.continuationToken === pageToken) throw nonAdvancingCursor();
						token = next.value.continuationToken;
						skip = 0;
					}
					return { items, scanned, complete, next_cursor: complete ? null : nextCursor };
				} catch (error) {
					throw mapAzureError(error);
				}
			});
			this.observer.keysScanned(result.scanned);
			return result;
		});
	}

	headObject(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail> {
		return this.observe('head_object', context, async () => {
			assertObjectIdentity(source, request);
			return this.metadata(context, async (scoped) => {
				try {
					const blob = this.blob(source, scoped, request);
					const properties = await blob.getProperties({ abortSignal: scoped.signal });
					let tags: { key: string; value: string }[] | undefined;
					let tagsAvailable = false;
					try {
						const result = await blob.getTags({ abortSignal: scoped.signal });
						tags = Object.entries(result.tags).map(([key, value]) => ({ key, value }));
						tagsAvailable = true;
					} catch (error) {
						const mapped = mapAzureError(error);
						if (mapped.code !== 'access_denied' && mapped.code !== 'unsupported') throw mapped;
					}
					return {
						...request,
						version_id: properties.versionId ?? request.version_id,
						size: requiredSize(properties.contentLength),
						last_modified: properties.lastModified?.toISOString(),
						etag: properties.etag,
						storage_class: properties.accessTier,
						content_type: properties.contentType,
						content_encoding: properties.contentEncoding,
						cache_control: properties.cacheControl,
						checksums: properties.contentMD5
							? [
									{
										algorithm: 'md5',
										value: Buffer.from(properties.contentMD5).toString('base64'),
									},
								]
							: [],
						metadata: properties.metadata ?? {},
						tags,
						tags_available: tagsAvailable,
					};
				} catch (error) {
					throw mapAzureError(error);
				}
			});
		});
	}

	listVersions(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>> {
		return this.observe('list_versions', context, async () => {
			assertObjectIdentity(source, request);
			try {
				return await this.metadata(context, async (scoped) => {
					const cursor = decodeCursor(request.cursor, ['token']);
					const pages = this.container(source, scoped, request.bucket)
						.listBlobsFlat({ prefix: request.key, includeVersions: true })
						.byPage({ continuationToken: cursor.token, maxPageSize: request.limit });
					const next = await pages.next();
					if (next.done) return { items: [], next_cursor: null };
					if (next.value.continuationToken && next.value.continuationToken === cursor.token) {
						throw nonAdvancingCursor();
					}
					return {
						items: next.value.segment.blobItems.flatMap((item): ObjectVersion[] =>
							item.name === request.key && item.versionId && !item.deleted
								? [
										{
											kind: 'version',
											bucket: request.bucket,
											key: item.name,
											version_id: item.versionId,
											is_latest: item.isCurrentVersion ?? false,
											last_modified: item.properties.lastModified?.toISOString(),
											size: requiredSize(item.properties.contentLength),
											etag: item.properties.etag,
											storage_class: item.properties.accessTier,
										},
									]
								: [],
						),
						next_cursor: next.value.continuationToken
							? encodeCursor({ token: next.value.continuationToken })
							: null,
					};
				});
			} catch (error) {
				const mapped = mapAzureError(error);
				if (mapped.code === 'unsupported') return { items: [], next_cursor: null };
				throw mapped;
			}
		});
	}

	previewObject(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview> {
		return this.observe('preview_object', context, async () => {
			if (this.mode !== 'full') {
				throw new ObjectBrowseError('access_denied', 'Object previews are disabled.');
			}
			assertObjectIdentity(source, request);
			const result = await previewObject(
				this.previewReader(source, context),
				this.limits,
				context,
				request,
			);
			this.observer.previewRead(result, this.limits);
			return result;
		});
	}

	openObject(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody> {
		return this.observe('open_object', context, async () => {
			if (this.mode !== 'full') {
				throw new ObjectBrowseError('access_denied', 'Object downloads are disabled.');
			}
			assertObjectIdentity(source, request);
			try {
				const blob = this.blob(source, context, request);
				let verifiedType: string | undefined;
				let ifMatch = request.if_match;
				if (request.inline) {
					const properties = await blob.getProperties({ abortSignal: context.signal });
					const size = requiredSize(properties.contentLength);
					if (size === 0) {
						throw new ObjectBrowseError('unsupported', 'An empty object is not a raster image.');
					}
					if (size > this.limits.inlineImageMaxBytes) {
						throw new ObjectBrowseError(
							'unsupported',
							'The image exceeds the inline preview limit.',
						);
					}
					ifMatch ??= request.version_id ? undefined : properties.etag;
					const probe = await blob.download(0, Math.min(16, size), {
						abortSignal: context.signal,
						conditions: ifMatch ? { ifMatch } : undefined,
					});
					const bytes = await readBoundedBody(probe.readableStreamBody, Math.min(16, size));
					const format = detectRasterImage(bytes);
					if (!format) {
						throw new ObjectBrowseError(
							'unsupported',
							'Only safe raster images can be shown inline.',
						);
					}
					verifiedType = rasterContentType(format);
				}
				const range = await azureRange(blob, request.range, context.signal);
				const response = await blob.download(range.offset, range.count, {
					abortSignal: context.signal,
					conditions: ifMatch ? { ifMatch } : undefined,
				});
				if (!response.readableStreamBody) {
					throw new ObjectBrowseError('unavailable', 'The object body was empty.');
				}
				const contentLength = requiredSize(response.contentLength);
				const guarded = guardObjectStream(
					toWebStream(response.readableStreamBody),
					context.signal,
					mapAzureError,
				);
				const object: ObjectBody = {
					body: guarded.body,
					status: response.contentRange ? 206 : 200,
					content_type: verifiedType ?? response.contentType ?? 'application/octet-stream',
					content_length: contentLength,
					total_size: totalSize(response.contentRange, contentLength),
					content_range: response.contentRange,
					etag: response.etag,
					version_id: response.versionId ?? request.version_id,
					close() {
						guarded.close();
					},
				};
				return this.observer.observeBody(
					object,
					request.inline ? Math.min(object.total_size, 16) : 0,
				);
			} catch (error) {
				throw mapAzureError(error);
			}
		});
	}

	private previewReader(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
	): ObjectPreviewReader {
		const client = this.client(source, context);
		const blobFor = (request: ObjectIdentity) => {
			const blob = client.getContainerClient(request.bucket).getBlobClient(request.key);
			return request.version_id ? blob.withVersion(request.version_id) : blob;
		};
		return {
			head: async (request, signal) => {
				try {
					const properties = await blobFor(request).getProperties({ abortSignal: signal });
					return {
						total_bytes: requiredSize(properties.contentLength),
						content_type: properties.contentType,
						etag: properties.etag,
					};
				} catch (error) {
					throw mapAzureError(error);
				}
			},
			readRange: async (request, start, end, options) => {
				try {
					const response = await blobFor(request).download(start, end - start, {
						abortSignal: options.signal,
						conditions: request.version_id || !options.etag ? undefined : { ifMatch: options.etag },
					});
					return await readBoundedBody(response.readableStreamBody, end - start);
				} catch (error) {
					throw mapAzureError(error);
				}
			},
		};
	}

	private client(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
	): BlobServiceClient {
		return createAzureClient(source, context, this.options.resolveHost, this.fetchImpl);
	}

	private container(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		name: string,
	): ContainerClient {
		return this.client(source, context).getContainerClient(name);
	}

	private blob(
		source: AzureBlobObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	) {
		const blob = this.container(source, context, request.bucket).getBlobClient(request.key);
		return request.version_id ? blob.withVersion(request.version_id) : blob;
	}

	private metadata<T>(
		context: ObjectBrowseContext,
		run: (context: ObjectBrowseContext) => Promise<T>,
	): Promise<T> {
		return withOperationDeadline(context, this.limits.metadataTimeoutMs, run);
	}

	private observe<T>(
		operation: string,
		context: ObjectBrowseContext,
		run: () => Promise<T>,
	): Promise<T> {
		return this.observer.observe(operation, context, run);
	}
}

function blobEntry(item: BlobItem, prefix: string): ObjectEntry {
	return {
		kind: 'object',
		name: item.name.slice(prefix.length),
		key: item.name,
		size: requiredSize(item.properties.contentLength),
		last_modified: item.properties.lastModified?.toISOString(),
		etag: item.properties.etag,
		storage_class: item.properties.accessTier,
	};
}

async function azureRange(
	blob: ReturnType<ContainerClient['getBlobClient']>,
	range: string | undefined,
	signal?: AbortSignal,
): Promise<{ offset?: number; count?: number }> {
	if (!range) return {};
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!match || (!match[1] && !match[2])) throw invalidRange();
	if (!match[1]) {
		const suffix = Number(match[2]);
		const properties = await blob.getProperties({ abortSignal: signal });
		const size = requiredSize(properties.contentLength);
		if (!Number.isSafeInteger(suffix) || suffix < 1 || size === 0) throw invalidRange();
		return { offset: Math.max(0, size - suffix), count: Math.min(size, suffix) };
	}
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : undefined;
	if (
		!Number.isSafeInteger(start) ||
		start < 0 ||
		(end !== undefined && (!Number.isSafeInteger(end) || end < start))
	) {
		throw invalidRange();
	}
	return { offset: start, count: end === undefined ? undefined : end - start + 1 };
}

function totalSize(contentRange: string | undefined, contentLength: number): number {
	if (!contentRange) return contentLength;
	const match = /\/(\d+)$/.exec(contentRange);
	if (!match) {
		throw new ObjectBrowseError('unavailable', 'Azure Blob returned a malformed response.');
	}
	return requiredSize(Number(match[1]));
}

function requiredSize(value: number | undefined): number {
	if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
		throw new ObjectBrowseError('unavailable', 'Azure Blob returned a malformed response.');
	}
	return value;
}

function invalidCursor(): ObjectBrowseError {
	return new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
}

function nonAdvancingCursor(): ObjectBrowseError {
	return new ObjectBrowseError('invalid_cursor', 'The object-store cursor did not advance.');
}

function invalidRange(): ObjectBrowseError {
	return new ObjectBrowseError('range_not_satisfiable', 'The requested byte range is invalid.');
}

function isVersioningUnsupported(error: unknown): boolean {
	const code = (error as { code?: unknown; details?: { errorCode?: unknown } } | null)?.code;
	const detail = (error as { details?: { errorCode?: unknown } } | null)?.details?.errorCode;
	const value = typeof code === 'string' ? code : typeof detail === 'string' ? detail : '';
	return ['FeatureVersionMismatch', 'UnsupportedHeader', 'UnsupportedQueryParameter'].includes(
		value,
	);
}

function mapAzureError(error: unknown): ObjectBrowseError {
	if (error instanceof ObjectBrowseError) return error;
	const value = error as {
		statusCode?: number;
		code?: string;
		details?: { errorCode?: string };
		requestId?: string;
		name?: string;
	};
	const status = value?.statusCode;
	const code = value?.code ?? value?.details?.errorCode ?? '';
	if (value?.name === 'AbortError') {
		return new ObjectBrowseError('aborted', 'The request was canceled.');
	}
	if (status === 401 || status === 403 || code === 'AuthorizationPermissionMismatch') {
		return new ObjectBrowseError(
			'access_denied',
			'Access to Azure Blob was denied.',
			value.requestId,
		);
	}
	if (status === 404 || code === 'BlobNotFound' || code === 'ContainerNotFound') {
		return new ObjectBrowseError(
			'not_found',
			'The requested object was not found.',
			value.requestId,
		);
	}
	if (status === 412 || code === 'ConditionNotMet') {
		return new ObjectBrowseError(
			'precondition_failed',
			'The object changed before it could be read.',
			value.requestId,
		);
	}
	if (status === 416 || code === 'InvalidRange') {
		return new ObjectBrowseError(
			'range_not_satisfiable',
			'The requested byte range is not available.',
			value.requestId,
		);
	}
	if (isVersioningUnsupported(error) || code === 'UnsupportedQueryParameter') {
		return new ObjectBrowseError(
			'unsupported',
			'This Azure Blob account does not support the operation.',
			value.requestId,
		);
	}
	return new ObjectBrowseError('unavailable', 'The Azure Blob request failed.', value?.requestId);
}

export { DEFAULT_OBJECT_BROWSER_LIMITS as DEFAULT_AZURE_OBJECT_BROWSER_LIMITS } from '@marimo-hub/object-browser-commons';

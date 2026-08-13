import type {
	GcsObjectStoreSource,
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
	createGuardedFetch,
	DEFAULT_OBJECT_BROWSER_LIMITS,
	detectRasterImage,
	encodeCursor,
	guardObjectStream,
	matchesObjectSearchFilters,
	OBJECT_PREVIEW_FORMATS,
	ObjectBrowserObserver,
	previewObject,
	readBoundedBody,
	rasterContentType,
	withOperationDeadline,
} from '@marimo-hub/object-browser-commons';
import type {
	GuardedHostResolver,
	ObjectBrowserLimits,
	ObjectPreviewReader,
} from '@marimo-hub/object-browser-commons';
import { GcsAuth, parseServiceAccount } from './auth';

const API_ORIGIN = 'https://storage.googleapis.com';
const SEARCH_BATCH_SIZE = 1_000;

export interface GcsObjectBrowserOptions {
	mode: 'metadata' | 'full';
	metrics?: Metrics;
	limits?: Partial<ObjectBrowserLimits>;
	resolveHost: GuardedHostResolver;
	fetchImpl?: typeof fetch;
}

interface GcsObject {
	name?: string;
	generation?: string;
	metageneration?: string;
	size?: string;
	updated?: string;
	md5Hash?: string;
	crc32c?: string;
	etag?: string;
	storageClass?: string;
	contentType?: string;
	contentEncoding?: string;
	cacheControl?: string;
	metadata?: Record<string, unknown>;
}

interface GcsObjectPage {
	items?: unknown;
	prefixes?: unknown;
	nextPageToken?: unknown;
}

export class GcsObjectBrowser implements ObjectBrowser<'gcs'> {
	readonly provider = 'gcs' as const;
	private readonly mode: 'metadata' | 'full';
	private readonly limits: ObjectBrowserLimits;
	private readonly observer: ObjectBrowserObserver;
	private readonly fetchImpl: typeof fetch;
	private readonly authFetch: typeof fetch;

	constructor(private readonly options: GcsObjectBrowserOptions) {
		this.mode = options.mode;
		this.limits = { ...DEFAULT_OBJECT_BROWSER_LIMITS, ...options.limits };
		this.observer = new ObjectBrowserObserver(this.provider, options.mode, options.metrics);
		this.fetchImpl = options.fetchImpl ?? createGuardedFetch(options.resolveHost);
		this.authFetch = options.fetchImpl ?? fetch;
	}

	capability(source: GcsObjectStoreSource, context: ObjectBrowseContext): ObjectBrowseCapability {
		try {
			if (source.auth.method === 'service_account')
				parseServiceAccount(source.auth.credentials_json);
			if (source.auth.method === 'ambient' && !context.allow_server_ambient.gcs) {
				throw new ObjectBrowseError(
					'access_denied',
					'Ambient GCS access is not enabled for this integration.',
				);
			}
			return {
				...OBJECT_BROWSE_PROVIDER_METADATA.gcs,
				available: true,
				preview: this.mode === 'full',
				download: this.mode === 'full',
				search: 'bounded-key-name',
				versions: true,
				preview_formats: this.mode === 'full' ? [...OBJECT_PREVIEW_FORMATS] : [],
			};
		} catch (error) {
			const mapped = mapGcsError(error);
			return {
				...OBJECT_BROWSE_PROVIDER_METADATA.gcs,
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
		source: GcsObjectStoreSource,
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
				const auth = this.auth(source, scoped);
				const project = await auth.projectId();
				if (!project) {
					throw new ObjectBrowseError(
						'access_denied',
						'GCS bucket discovery requires a project ID.',
					);
				}
				const cursor = decodeCursor(request.cursor, ['token']);
				const params = new URLSearchParams({ project, maxResults: String(request.limit) });
				if (cursor.token) params.set('pageToken', cursor.token);
				const value = await this.json(source, scoped, `/storage/v1/b?${params}`, auth);
				const record = strictRecord(value);
				const items = optionalArray(record.items).map((item) => {
					const bucket = strictRecord(item);
					return {
						name: requiredString(bucket.name),
						created_at: optionalString(bucket.timeCreated),
						configured: false,
					};
				});
				const token = optionalString(record.nextPageToken);
				if (token && token === cursor.token) throw nonAdvancingCursor();
				return { items, next_cursor: token ? encodeCursor({ token }) : null };
			});
		});
	}

	listObjects(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>> {
		return this.observe('list_objects', context, async () => {
			assertBucket(source, request.bucket);
			return this.metadata(context, async (scoped) => {
				const auth = this.auth(source, scoped);
				const prefix = request.prefix ?? '';
				const cursor = decodeCursor(request.cursor, ['token']);
				const params = new URLSearchParams({
					delimiter: '/',
					maxResults: String(request.limit),
					prefix,
				});
				if (cursor.token) params.set('pageToken', cursor.token);
				const page = await this.objectPage(source, scoped, request.bucket, params, auth);
				if (page.next && page.next === cursor.token) throw nonAdvancingCursor();
				const prefixes = page.prefixes.map((key) => ({
					kind: 'prefix' as const,
					key,
					name: key.slice(prefix.length).replace(/\/$/, ''),
				}));
				const objects = page.items
					.filter((item) => !(item.size === '0' && page.prefixes.includes(item.name!)))
					.map((item) => objectEntry(item, prefix));
				return {
					items: [...prefixes, ...objects].sort((left, right) => left.key.localeCompare(right.key)),
					next_cursor: page.next ? encodeCursor({ token: page.next }) : null,
				};
			});
		});
	}

	searchObjects(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage> {
		return this.observe('search_objects', context, async () => {
			assertBucket(source, request.bucket);
			const result = await this.metadata(context, async (scoped) => {
				const auth = this.auth(source, scoped);
				const cursor = decodeCursor(request.cursor, ['token', 'start_after']);
				if (cursor.token && cursor.start_after) throw invalidCursor();
				const prefix = request.prefix ?? '';
				const query = request.query.toLocaleLowerCase();
				let token = cursor.token;
				let startAfter = cursor.start_after;
				let scanned = 0;
				let complete = false;
				let nextCursor: string | null = null;
				const items: ObjectEntry[] = [];
				while (scanned < this.limits.searchMaxKeys && items.length < request.limit) {
					const params = new URLSearchParams({
						maxResults: String(Math.min(SEARCH_BATCH_SIZE, this.limits.searchMaxKeys - scanned)),
						prefix,
					});
					if (token) params.set('pageToken', token);
					else if (startAfter) params.set('startOffset', `${startAfter}\0`);
					const requestedToken = token;
					const page = await this.objectPage(source, scoped, request.bucket, params, auth);
					for (let index = 0; index < page.items.length; index += 1) {
						const object = page.items[index];
						const entry = objectEntry(object, prefix);
						scanned += 1;
						if (
							entry.key.slice(prefix.length).toLocaleLowerCase().includes(query) &&
							matchesObjectSearchFilters(entry, request)
						) {
							items.push(entry);
						}
						if (scanned >= this.limits.searchMaxKeys || items.length >= request.limit) {
							nextCursor =
								index < page.items.length - 1
									? encodeCursor({ start_after: entry.key })
									: page.next
										? encodeCursor({ token: page.next })
										: null;
							complete = nextCursor === null;
							break;
						}
					}
					if (nextCursor || complete) break;
					if (!page.next) {
						complete = true;
						break;
					}
					if (page.next === requestedToken) throw nonAdvancingCursor();
					token = page.next;
					startAfter = undefined;
				}
				if (!complete && !nextCursor && token) nextCursor = encodeCursor({ token });
				return { items, scanned, complete, next_cursor: complete ? null : nextCursor };
			});
			this.observer.keysScanned(result.scanned);
			return result;
		});
	}

	headObject(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail> {
		return this.observe('head_object', context, async () => {
			assertObjectIdentity(source, request);
			return this.metadata(context, async (scoped) => {
				const object = await this.metadataObject(
					source,
					scoped,
					request,
					this.auth(source, scoped),
				);
				return detail(request, object);
			});
		});
	}

	listVersions(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>> {
		return this.observe('list_versions', context, async () => {
			assertObjectIdentity(source, request);
			return this.metadata(context, async (scoped) => {
				const auth = this.auth(source, scoped);
				let currentGeneration: string | undefined;
				try {
					currentGeneration = (await this.metadataObject(source, scoped, request, auth)).generation;
				} catch (error) {
					if (!(error instanceof ObjectBrowseError) || error.code !== 'not_found') throw error;
				}
				const cursor = decodeCursor(request.cursor, ['token']);
				const params = new URLSearchParams({
					prefix: request.key,
					versions: 'true',
					maxResults: String(request.limit),
				});
				if (cursor.token) params.set('pageToken', cursor.token);
				const page = await this.objectPage(source, scoped, request.bucket, params, auth);
				if (page.next && page.next === cursor.token) throw nonAdvancingCursor();
				const versions = page.items.filter((item) => item.name === request.key);
				return {
					items: versions.map((item) => ({
						kind: 'version',
						bucket: request.bucket,
						key: request.key,
						version_id: item.generation!,
						is_latest: item.generation === currentGeneration,
						last_modified: item.updated,
						size: safeNumber(item.size),
						etag: item.etag,
						storage_class: item.storageClass,
					})),
					next_cursor: page.next ? encodeCursor({ token: page.next }) : null,
				};
			});
		});
	}

	previewObject(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview> {
		return this.observe('preview_object', context, async () => {
			if (this.mode !== 'full') {
				throw new ObjectBrowseError('access_denied', 'Object previews are disabled.');
			}
			assertObjectIdentity(source, request);
			const reader = this.previewReader(source, context);
			const result = await previewObject(reader, this.limits, context, request);
			this.observer.previewRead(result, this.limits);
			return result;
		});
	}

	openObject(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody> {
		return this.observe('open_object', context, async () => {
			if (this.mode !== 'full') {
				throw new ObjectBrowseError('access_denied', 'Object downloads are disabled.');
			}
			assertObjectIdentity(source, request);
			const auth = this.auth(source, context);
			let verifiedType: string | undefined;
			let openRequest = request;
			if (request.inline) {
				const reader = this.previewReader(source, context, auth);
				const head = await reader.head(request, context.signal ?? new AbortController().signal);
				if (head.total_bytes === 0) {
					throw new ObjectBrowseError('unsupported', 'An empty object is not a raster image.');
				}
				if (head.total_bytes > this.limits.inlineImageMaxBytes) {
					throw new ObjectBrowseError('unsupported', 'The image exceeds the inline preview limit.');
				}
				const probe = await reader.readRange(request, 0, Math.min(16, head.total_bytes), {
					etag: head.etag,
					signal: context.signal ?? new AbortController().signal,
				});
				const format = detectRasterImage(probe);
				if (!format) {
					throw new ObjectBrowseError(
						'unsupported',
						'Only safe raster images can be shown inline.',
					);
				}
				verifiedType = rasterContentType(format);
				openRequest = { ...request, if_match: request.if_match ?? head.etag };
			}
			const response = await this.media(source, context, openRequest, auth);
			if (!response.body) throw new ObjectBrowseError('unavailable', 'The object body was empty.');
			if (request.range && response.status !== 206) {
				throw new ObjectBrowseError('unavailable', 'GCS returned a malformed range response.');
			}
			const length = requiredHeaderNumber(response.headers.get('content-length'));
			const total = totalSize(response.headers.get('content-range'), length);
			const guarded = guardObjectStream(response.body, context.signal, mapGcsError);
			const object: ObjectBody = {
				body: guarded.body,
				status: response.status === 206 ? 206 : 200,
				content_type:
					verifiedType ?? response.headers.get('content-type') ?? 'application/octet-stream',
				content_length: length,
				total_size: total,
				content_range: response.headers.get('content-range') ?? undefined,
				etag: response.headers.get('etag') ?? undefined,
				version_id: response.headers.get('x-goog-generation') ?? request.version_id,
				close() {
					guarded.close();
				},
			};
			return this.observer.observeBody(
				object,
				request.inline ? Math.min(object.total_size, 16) : 0,
			);
		});
	}

	private previewReader(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		auth = this.auth(source, context),
	): ObjectPreviewReader {
		return {
			head: async (request, signal) => {
				const object = await this.metadataObject(source, { ...context, signal }, request, auth);
				return {
					total_bytes: safeNumber(object.size) ?? 0,
					content_type: object.contentType,
					etag: object.etag,
				};
			},
			readRange: async (request, start, end, options) => {
				if (
					!Number.isSafeInteger(start) ||
					!Number.isSafeInteger(end) ||
					start < 0 ||
					end <= start
				) {
					throw new ObjectBrowseError(
						'range_not_satisfiable',
						'The requested byte range is invalid.',
					);
				}
				try {
					const response = await this.media(
						source,
						{ ...context, signal: options.signal },
						{
							...request,
							range: `bytes=${start}-${end - 1}`,
							if_match: request.version_id ? undefined : options.etag,
						},
						auth,
					);
					return await readBoundedBody(response.body, end - start);
				} catch (error) {
					throw mapGcsError(error);
				}
			},
		};
	}

	private async metadataObject(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
		auth?: GcsAuth,
	): Promise<GcsObject> {
		const generation = request.version_id
			? `?generation=${encodeURIComponent(request.version_id)}`
			: '';
		const value = await this.json(
			source,
			context,
			`/storage/v1/b/${encodeURIComponent(request.bucket)}/o/${encodeURIComponent(request.key)}${generation}`,
			auth,
		);
		return validateObject(value);
	}

	private async objectPage(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		bucket: string,
		params: URLSearchParams,
		auth?: GcsAuth,
	): Promise<{ items: GcsObject[]; prefixes: string[]; next?: string }> {
		const value = (await this.json(
			source,
			context,
			`/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`,
			auth,
		)) as GcsObjectPage;
		const record = strictRecord(value);
		return {
			items: optionalArray(record.items).map(validateObject),
			prefixes: optionalArray(record.prefixes).map(requiredString),
			next: optionalString(record.nextPageToken),
		};
	}

	private async json(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		path: string,
		auth = this.auth(source, context),
	): Promise<unknown> {
		const response = await this.request(context, `${API_ORIGIN}${path}`, {
			headers: await auth.headers(),
		});
		try {
			return await response.json();
		} catch {
			throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
		}
	}

	private async media(
		source: GcsObjectStoreSource,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
		auth = this.auth(source, context),
	): Promise<Response> {
		const params = new URLSearchParams({ alt: 'media' });
		if (request.version_id) params.set('generation', request.version_id);
		return this.request(
			context,
			`${API_ORIGIN}/storage/v1/b/${encodeURIComponent(request.bucket)}/o/${encodeURIComponent(request.key)}?${params}`,
			{
				headers: {
					...(await auth.headers()),
					...(request.range ? { Range: request.range } : {}),
					...(request.if_match ? { 'If-Match': request.if_match } : {}),
				},
			},
		);
	}

	private async request(
		context: ObjectBrowseContext,
		url: string,
		init: RequestInit,
	): Promise<Response> {
		try {
			if (this.options.fetchImpl) {
				await this.options.resolveHost(new URL(url).hostname, context.signal);
			}
			const response = await this.fetchImpl(url, { ...init, signal: context.signal });
			if (!response.ok) throw mapGcsResponse(response);
			return response;
		} catch (error) {
			throw mapGcsError(error);
		}
	}

	private metadata<T>(
		context: ObjectBrowseContext,
		run: (context: ObjectBrowseContext) => Promise<T>,
	): Promise<T> {
		return withOperationDeadline(context, this.limits.metadataTimeoutMs, run);
	}

	private auth(source: GcsObjectStoreSource, context: ObjectBrowseContext): GcsAuth {
		return new GcsAuth(source, context, this.authFetch, this.options.fetchImpl === undefined);
	}

	private observe<T>(
		operation: string,
		context: ObjectBrowseContext,
		run: () => Promise<T>,
	): Promise<T> {
		return this.observer.observe(operation, context, run);
	}
}

function validateObject(value: unknown): GcsObject {
	const record = strictRecord(value);
	const name = requiredString(record.name);
	const generation = requiredUnsignedInteger(record.generation);
	const size = requiredUnsignedInteger(record.size);
	if (safeNumber(size) === undefined) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	const object: GcsObject = {
		name,
		generation,
		metageneration: optionalString(record.metageneration),
		size,
		updated: optionalString(record.updated),
		md5Hash: optionalString(record.md5Hash),
		crc32c: optionalString(record.crc32c),
		etag: optionalString(record.etag),
		storageClass: optionalString(record.storageClass),
		contentType: optionalString(record.contentType),
		contentEncoding: optionalString(record.contentEncoding),
		cacheControl: optionalString(record.cacheControl),
	};
	if (record.metadata !== undefined) {
		const metadata = strictRecord(record.metadata);
		object.metadata = Object.fromEntries(
			Object.entries(metadata).map(([key, child]) => [key, requiredString(child)]),
		);
	}
	return object;
}

function objectEntry(object: GcsObject, prefix: string): ObjectEntry {
	const key = object.name!;
	return {
		kind: 'object',
		name: key.slice(prefix.length),
		key,
		size: safeNumber(object.size),
		last_modified: object.updated,
		etag: object.etag,
		storage_class: object.storageClass,
	};
}

function detail(request: ObjectIdentity, object: GcsObject): ObjectDetail {
	return {
		...request,
		version_id: object.generation ?? request.version_id,
		size: safeNumber(object.size) ?? 0,
		last_modified: object.updated,
		etag: object.etag,
		storage_class: object.storageClass,
		content_type: object.contentType,
		content_encoding: object.contentEncoding,
		cache_control: object.cacheControl,
		checksums: [
			...(object.crc32c ? [{ algorithm: 'crc32c', value: object.crc32c }] : []),
			...(object.md5Hash ? [{ algorithm: 'md5', value: object.md5Hash }] : []),
		],
		metadata: (object.metadata ?? {}) as Record<string, string>,
		tags_available: false,
	};
}

function strictRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	return value as Record<string, unknown>;
}

function optionalArray(value: unknown): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	return value;
}

function requiredString(value: unknown): string {
	if (typeof value !== 'string' || value === '') {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value);
}

function requiredUnsignedInteger(value: unknown): string {
	const result = requiredString(value);
	if (!/^\d+$/.test(result)) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	return result;
}

function safeNumber(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}

function requiredHeaderNumber(value: string | null): number {
	if (value === null || !/^\d+$/.test(value)) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	const number = Number(value);
	if (!Number.isSafeInteger(number)) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	return number;
}

function totalSize(contentRange: string | null, contentLength: number): number {
	if (!contentRange) return contentLength;
	const match = /\/(\d+)$/.exec(contentRange);
	if (!match) throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	const total = Number(match[1]);
	if (!Number.isSafeInteger(total)) {
		throw new ObjectBrowseError('unavailable', 'GCS returned a malformed response.');
	}
	return total;
}

function invalidCursor(): ObjectBrowseError {
	return new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
}

function nonAdvancingCursor(): ObjectBrowseError {
	return new ObjectBrowseError('invalid_cursor', 'The object-store cursor did not advance.');
}

function mapGcsResponse(response: Response): ObjectBrowseError {
	const requestId = response.headers.get('x-guploader-uploadid') ?? undefined;
	switch (response.status) {
		case 401:
		case 403:
			return new ObjectBrowseError('access_denied', 'Access to GCS was denied.', requestId);
		case 404:
			return new ObjectBrowseError('not_found', 'The requested object was not found.', requestId);
		case 412:
			return new ObjectBrowseError(
				'precondition_failed',
				'The object changed before it could be read.',
				requestId,
			);
		case 416:
			return new ObjectBrowseError(
				'range_not_satisfiable',
				'The requested byte range is not available.',
				requestId,
			);
		default:
			return new ObjectBrowseError('unavailable', 'The GCS request failed.', requestId);
	}
}

function mapGcsError(error: unknown): ObjectBrowseError {
	if (error instanceof ObjectBrowseError) return error;
	if ((error as { name?: unknown } | null)?.name === 'AbortError') {
		return new ObjectBrowseError('aborted', 'The request was canceled.');
	}
	return new ObjectBrowseError('unavailable', 'The GCS request failed.');
}

export { DEFAULT_OBJECT_BROWSER_LIMITS as DEFAULT_GCS_OBJECT_BROWSER_LIMITS } from '@marimo-hub/object-browser-commons';

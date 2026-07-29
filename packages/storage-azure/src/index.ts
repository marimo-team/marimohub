import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import type {
	BlobItem,
	ContainerClient,
	ContainerListBlobFlatSegmentResponse,
	ContainerListBlobHierarchySegmentResponse,
} from '@azure/storage-blob';
import type { TokenCredential } from '@azure/core-auth';
import { PreconditionFailedError } from '@marimo-hub/core';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports';

export type AzureStorageConfig =
	| { containerClient: ContainerClient }
	| { container: string; connectionString: string }
	| { container: string; accountUrl: string; credential?: TokenCredential };

type AzureError = {
	statusCode?: number;
};

function statusCode(err: unknown): number | undefined {
	return (err as AzureError)?.statusCode;
}

function isNotFound(err: unknown): boolean {
	return statusCode(err) === 404;
}

function isPreconditionFailed(err: unknown): boolean {
	return statusCode(err) === 412;
}

function conditionETag(etag: string): string {
	const trimmed = etag.trim();
	if (/^(W\/)?"[^"]*"$/.test(trimmed)) return trimmed;
	return `"${trimmed.replaceAll('"', '')}"`;
}

async function streamToBytes(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
	if (!stream) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
		const bytes =
			typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
		chunks.push(bytes);
		size += bytes.length;
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function toBucketObject(item: BlobItem): BucketObject {
	return {
		key: item.name,
		etag: item.properties.etag ?? '',
		size: item.properties.contentLength ?? 0,
		uploaded: item.properties.lastModified ?? new Date(),
	};
}

type ListPage = ContainerListBlobFlatSegmentResponse | ContainerListBlobHierarchySegmentResponse;

function pagePrefixes(page: ListPage): string[] {
	return 'blobPrefixes' in page.segment
		? (page.segment.blobPrefixes ?? []).map((prefix) => prefix.name)
		: [];
}

export class AzureStorage implements Bucket {
	private readonly client: ContainerClient;

	constructor(config: AzureStorageConfig) {
		const raw = config as Partial<{
			containerClient: ContainerClient;
			container: string;
			connectionString: string;
			accountUrl: string;
			credential: TokenCredential;
		}>;
		const hasClientMode = 'containerClient' in raw;
		const hasConnectionStringMode = 'connectionString' in raw;
		const hasAccountUrlMode = 'accountUrl' in raw;
		if (Number(hasClientMode) + Number(hasConnectionStringMode) + Number(hasAccountUrlMode) !== 1) {
			throw new Error(
				'AzureStorage requires exactly one of containerClient, connectionString, or accountUrl',
			);
		}

		if (hasClientMode) {
			if (!raw.containerClient || 'container' in raw || 'credential' in raw) {
				throw new Error('AzureStorage containerClient mode cannot include account configuration');
			}
			this.client = raw.containerClient;
			return;
		}
		if (!raw.container?.trim()) {
			throw new Error('AzureStorage requires a non-empty container');
		}
		if (hasConnectionStringMode) {
			if (!raw.connectionString?.trim() || 'credential' in raw) {
				throw new Error(
					'AzureStorage connectionString mode requires a non-empty connection string',
				);
			}
			this.client = BlobServiceClient.fromConnectionString(raw.connectionString).getContainerClient(
				raw.container,
			);
			return;
		}
		if (!raw.accountUrl?.trim()) {
			throw new Error('AzureStorage requires a non-empty accountUrl');
		}
		const credential = raw.credential ?? new DefaultAzureCredential();
		this.client = new BlobServiceClient(raw.accountUrl, credential).getContainerClient(
			raw.container,
		);
	}

	async get(key: string): Promise<BucketObjectBody | null> {
		try {
			const response = await this.client.getBlobClient(key).download();
			const bodyBytes = await streamToBytes(response.readableStreamBody);
			let bodyText: string | undefined;
			const decode = () => (bodyText ??= new TextDecoder().decode(bodyBytes));
			return {
				key,
				etag: response.etag ?? '',
				size: response.contentLength ?? bodyBytes.length,
				uploaded: response.lastModified ?? new Date(),
				text: async () => decode(),
				json: async <T = unknown>() => JSON.parse(decode()) as T,
				bytes: async () => bodyBytes,
			};
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async head(key: string): Promise<BucketObject | null> {
		try {
			const response = await this.client.getBlobClient(key).getProperties();
			return {
				key,
				etag: response.etag ?? '',
				size: response.contentLength ?? 0,
				uploaded: response.lastModified ?? new Date(),
			};
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: BucketPutOptions,
	): Promise<BucketObject> {
		const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
		const conditions =
			options?.onlyIfEtagMatches !== undefined
				? { ifMatch: conditionETag(options.onlyIfEtagMatches) }
				: options?.onlyIfNotExists
					? { ifNoneMatch: '*' }
					: undefined;
		try {
			const response = await this.client.getBlockBlobClient(key).uploadData(bytes, {
				conditions,
				blobHTTPHeaders: options?.httpMetadata?.contentType
					? { blobContentType: options.httpMetadata.contentType }
					: undefined,
				metadata: options?.customMetadata,
			});
			return {
				key,
				etag: response.etag ?? '',
				size: bytes.length,
				uploaded: response.lastModified ?? new Date(),
			};
		} catch (err) {
			if (isPreconditionFailed(err)) {
				throw new PreconditionFailedError(`ETag mismatch for key "${key}"`);
			}
			throw err;
		}
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		const failures: unknown[] = [];
		for (let offset = 0; offset < keys.length; offset += 32) {
			const batch = keys.slice(offset, offset + 32);
			const results = await Promise.allSettled(
				batch.map((item) =>
					this.client.getBlobClient(item).deleteIfExists({ deleteSnapshots: 'include' }),
				),
			);
			for (const result of results) {
				if (result.status === 'rejected' && !isNotFound(result.reason)) {
					failures.push(result.reason);
				}
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `Azure delete failed for ${failures.length} blob(s)`);
		}
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		const iterable = options?.delimiter
			? this.client.listBlobsByHierarchy(options.delimiter, { prefix: options.prefix })
			: this.client.listBlobsFlat({ prefix: options?.prefix });
		const pages = iterable.byPage({
			continuationToken: options?.cursor,
			maxPageSize: options?.limit,
		});

		for await (const page of pages) {
			const objects = page.segment.blobItems
				.filter((item) => !options?.startAfter || item.name > options.startAfter)
				.map(toBucketObject);
			const delimitedPrefixes = pagePrefixes(page).filter(
				(prefix) => !options?.startAfter || prefix > options.startAfter,
			);
			if (
				objects.length > 0 ||
				delimitedPrefixes.length > 0 ||
				!page.continuationToken ||
				!options?.startAfter
			) {
				return {
					objects,
					truncated: Boolean(page.continuationToken),
					cursor: page.continuationToken || undefined,
					delimitedPrefixes,
				};
			}
		}

		return { objects: [], truncated: false, delimitedPrefixes: [] };
	}

	async verifyConditionalWrites(): Promise<void> {
		const probeKey = `_system/.cas-probe-${randomUUID()}`;
		try {
			await this.put(probeKey, 'v1');
			let rejected = false;
			try {
				await this.put(probeKey, 'v2', { onlyIfEtagMatches: 'this-etag-is-wrong' });
			} catch (err) {
				if (!(err instanceof PreconditionFailedError)) throw err;
				rejected = true;
			}
			if (!rejected) {
				throw new Error(
					'Azure target does NOT enforce conditional writes (If-Match): a put with a wrong ETag was accepted. ' +
						'The catalog compare-and-swap protocol is unsafe on this store.',
				);
			}

			const seed = await this.put(probeKey, 'v3');
			const results = await Promise.allSettled(
				Array.from({ length: 8 }, (_, index) =>
					this.put(probeKey, `r${index}`, { onlyIfEtagMatches: seed.etag }),
				),
			);
			for (const result of results) {
				if (result.status === 'rejected' && !(result.reason instanceof PreconditionFailedError)) {
					throw result.reason;
				}
			}
			const winners = results.filter((result) => result.status === 'fulfilled').length;
			if (winners !== 1) {
				throw new Error(
					`Azure target does NOT apply conditional writes atomically: ${winners} concurrent If-Match puts ` +
						'from the same ETag were accepted (expected exactly 1). The catalog compare-and-swap protocol is unsafe on this store.',
				);
			}
		} finally {
			await this.delete(probeKey).catch(() => {});
		}
	}
}

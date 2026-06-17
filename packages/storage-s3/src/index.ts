/**
 * S3-compatible `Bucket` adapter (AWS S3, MinIO, Tigris, Ceph, R2-via-S3).
 *
 * The single hard requirement (docs/architecture.md §3.1) is strong
 * read-after-write consistency PLUS conditional writes. The catalog
 * compare-and-swap in `CatalogService.mutateSnapshot` passes
 * `onlyIfEtagMatches`; this adapter maps it to S3's `If-Match` precondition and
 * converts a 412 into `PreconditionFailedError` — the exact contract the R2 and
 * in-memory adapters honor. Verify support on a target store with
 * `verifyConditionalWrites()` (run at boot by apps/server).
 */
import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type PutObjectCommandInput,
	S3Client,
} from '@aws-sdk/client-s3';
import { PreconditionFailedError } from '@marimo-hub/core';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports';

export interface S3StorageConfig {
	/** Bucket name. */
	bucket: string;
	/** Endpoint URL for non-AWS stores (MinIO/Tigris/R2-via-S3). Omit for AWS. */
	endpoint?: string;
	/** Region; defaults to `auto` (works for most S3-compatibles). */
	region?: string;
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	};
	/** `true` for MinIO/Ceph and most non-AWS stores. */
	forcePathStyle?: boolean;
}

/** S3 returns ETags wrapped in double quotes; the `Bucket` port stores them bare. */
export function stripETag(etag: string | undefined): string {
	return etag ? etag.replace(/^"+|"+$/g, '') : '';
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function httpStatus(err: unknown): number | undefined {
	return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function isNotFound(err: unknown): boolean {
	const name = (err as { name?: string })?.name;
	return name === 'NoSuchKey' || name === 'NotFound' || httpStatus(err) === 404;
}

function isPreconditionFailed(err: unknown): boolean {
	const name = (err as { name?: string })?.name;
	return name === 'PreconditionFailed' || httpStatus(err) === 412;
}

function* chunk<T>(items: T[], size: number): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) {
		yield items.slice(i, i + size);
	}
}

export class S3Storage implements Bucket {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(config: S3StorageConfig) {
		this.bucket = config.bucket;
		this.client = new S3Client({
			region: config.region ?? 'auto',
			endpoint: config.endpoint || undefined,
			credentials: config.credentials,
			forcePathStyle: config.forcePathStyle ?? false,
		});
	}

	async get(key: string): Promise<BucketObjectBody | null> {
		try {
			const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
			// Read the stream once and cache; the port's text()/json() are idempotent.
			const bodyText = res.Body ? await res.Body.transformToString() : '';
			return {
				key,
				etag: stripETag(res.ETag),
				size: res.ContentLength ?? utf8ByteLength(bodyText),
				uploaded: res.LastModified ?? new Date(),
				text: async () => bodyText,
				json: async <T = unknown>() => JSON.parse(bodyText) as T,
			};
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async head(key: string): Promise<BucketObject | null> {
		try {
			const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
			return {
				key,
				etag: stripETag(res.ETag),
				size: res.ContentLength ?? 0,
				uploaded: res.LastModified ?? new Date(),
			};
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async put(key: string, value: string, options?: BucketPutOptions): Promise<BucketObject> {
		const input: PutObjectCommandInput = {
			Bucket: this.bucket,
			Key: key,
			Body: value,
			ContentType: options?.httpMetadata?.contentType,
			Metadata: options?.customMetadata,
		};
		if (options?.onlyIfEtagMatches !== undefined) {
			// Conditional write (compare-and-swap). S3 expects the quoted ETag.
			input.IfMatch = `"${options.onlyIfEtagMatches}"`;
		} else if (options?.onlyIfNotExists) {
			// Create-if-absent. S3 supports `If-None-Match: '*'` (rejects with 412
			// if the key already exists), which `isPreconditionFailed` maps below.
			input.IfNoneMatch = '*';
		}

		try {
			const res = await this.client.send(new PutObjectCommand(input));
			return {
				key,
				etag: stripETag(res.ETag),
				size: utf8ByteLength(value),
				uploaded: new Date(),
			};
		} catch (err) {
			if (isPreconditionFailed(err)) {
				throw new PreconditionFailedError(`ETag mismatch for key "${key}"`);
			}
			throw err;
		}
	}

	async delete(key: string | string[]): Promise<void> {
		if (Array.isArray(key)) {
			for (const batch of chunk(key, 1000)) {
				if (batch.length === 0) continue;
				await this.client.send(
					new DeleteObjectsCommand({
						Bucket: this.bucket,
						Delete: { Objects: batch.map((Key) => ({ Key })) },
					}),
				);
			}
			return;
		}
		await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		const res = await this.client.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: options?.prefix,
				Delimiter: options?.delimiter,
				MaxKeys: options?.limit,
				StartAfter: options?.startAfter,
				ContinuationToken: options?.cursor,
			}),
		);

		return {
			objects: (res.Contents ?? [])
				.filter((o): o is typeof o & { Key: string } => Boolean(o.Key))
				.map((o) => ({
					key: o.Key,
					etag: stripETag(o.ETag),
					size: o.Size ?? 0,
					uploaded: o.LastModified ?? new Date(),
				})),
			truncated: res.IsTruncated ?? false,
			cursor: res.IsTruncated ? res.NextContinuationToken : undefined,
			delimitedPrefixes: (res.CommonPrefixes ?? [])
				.map((p) => p.Prefix)
				.filter((p): p is string => Boolean(p)),
		};
	}

	/**
	 * Boot self-check: confirms the store honors conditional writes (`If-Match`).
	 *
	 * Two probes. (1) A single wrong-ETag put must be rejected — catches a store
	 * that ignores `If-Match` entirely. (2) A small CONTENTION probe: several
	 * conditional puts from the same base ETag fired concurrently must yield AT
	 * MOST one winner. A single-shot check cannot prove atomicity — a store that
	 * implements `If-Match` as a non-atomic check-then-set sails through (1) but
	 * lets multiple racers win here, which is exactly the lost-update bug that
	 * corrupts the catalog under real write contention. This is a fast sanity
	 * gate, NOT a substitute for the adapter conformance suite
	 * (`@marimo-hub/core/testing/contract`) run against the real store.
	 */
	async verifyConditionalWrites(): Promise<void> {
		const probeKey = '_system/.cas-probe';

		// (1) Single-shot: a wrong-ETag conditional put must be rejected.
		await this.put(probeKey, 'v1');
		let rejected = false;
		try {
			await this.put(probeKey, 'v2', { onlyIfEtagMatches: 'this-etag-is-wrong' });
		} catch (err) {
			if (!(err instanceof PreconditionFailedError)) {
				await this.delete(probeKey).catch(() => { });
				throw err;
			}
			rejected = true;
		}
		if (!rejected) {
			await this.delete(probeKey).catch(() => { });
			throw new Error(
				'S3 target does NOT enforce conditional writes (If-Match): a put with a wrong ETag was accepted. ' +
				'The catalog compare-and-swap protocol is unsafe on this store. Use AWS S3, R2, or a recent MinIO.',
			);
		}

		// (2) Contention probe: concurrent If-Match puts from one base ETag.
		const seed = await this.put(probeKey, 'v3');
		const N = 8;
		const results = await Promise.allSettled(
			Array.from({ length: N }, (_, i) =>
				this.put(probeKey, `r${i}`, { onlyIfEtagMatches: seed.etag }),
			),
		);
		await this.delete(probeKey).catch(() => { });

		// Surface a non-precondition failure (network/permissions) rather than
		// misreporting it as a consistency problem.
		for (const r of results) {
			if (r.status === 'rejected' && !(r.reason instanceof PreconditionFailedError)) throw r.reason;
		}
		const winners = results.filter((r) => r.status === 'fulfilled').length;
		if (winners > 1) {
			throw new Error(
				`S3 target does NOT apply conditional writes atomically: ${winners} concurrent If-Match puts ` +
				'from the same ETag were accepted (expected at most 1). The catalog compare-and-swap protocol ' +
				'is unsafe on this store — it permits lost updates under write contention. Use AWS S3, R2, or a recent MinIO.',
			);
		}
	}
}

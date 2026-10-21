import { PreconditionFailedError } from '@marimo-hub/core/errors';
import { assertValidBucketListLimit } from '@marimo-hub/core/ports/bucket';
import type {
	BucketMultipart,
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports/bucket';

function toObject(r2obj: R2Object): BucketObject {
	return {
		key: r2obj.key,
		etag: r2obj.etag,
		size: r2obj.size,
		uploaded: r2obj.uploaded,
	};
}

function toObjectBody(r2obj: R2ObjectBody): BucketObjectBody {
	return {
		...toObject(r2obj),
		text: () => r2obj.text(),
		json: <T>() => r2obj.json<T>(),
		bytes: async () => new Uint8Array(await r2obj.arrayBuffer()),
	};
}

export class R2BucketAdapter implements Bucket {
	constructor(private r2: R2Bucket) {}

	readonly multipart: BucketMultipart = {
		isolatedSessions: true,
		create: async (key, options) => {
			if (options?.onlyIfEtagMatches !== undefined || options?.onlyIfNotExists)
				throw new Error('Multipart conditional writes are not supported');
			const upload = await this.r2.createMultipartUpload(key, {
				httpMetadata: options?.httpMetadata,
				customMetadata: options?.customMetadata,
			});
			return { uploadId: upload.uploadId };
		},
		putPart: (key, uploadId, partNumber, bytes) =>
			this.r2.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, bytes),
		complete: async (key, uploadId, parts) =>
			toObject(await this.r2.resumeMultipartUpload(key, uploadId).complete(parts)),
		abort: async (key, uploadId) => {
			try {
				await this.r2.resumeMultipartUpload(key, uploadId).abort();
			} catch (error) {
				// Workers exposes the R2 NoSuchUpload code in the error message.
				if (!(error instanceof Error && error.message.endsWith('(10024)'))) throw error;
			}
		},
	};

	async get(key: string): Promise<BucketObjectBody | null> {
		const obj = await this.r2.get(key);
		return obj ? toObjectBody(obj) : null;
	}

	async head(key: string): Promise<BucketObject | null> {
		const obj = await this.r2.head(key);
		return obj ? toObject(obj) : null;
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: BucketPutOptions,
	): Promise<BucketObject> {
		const r2Options: R2PutOptions = {};

		if (options?.httpMetadata) {
			r2Options.httpMetadata = options.httpMetadata;
		}
		if (options?.customMetadata) {
			r2Options.customMetadata = options.customMetadata;
		}
		if (options?.onlyIfEtagMatches !== undefined) {
			// Presence, not truthiness: an empty-string etag is still a precondition
			// (drop it and a CAS would silently degrade to an unconditional write).
			// Matches the S3 adapter.
			r2Options.onlyIf = { etagMatches: options.onlyIfEtagMatches };
		} else if (options?.onlyIfNotExists) {
			// Create-if-absent (equivalent to `If-None-Match: *`). A failed
			// precondition makes `r2.put` resolve to `null`, which becomes
			// PreconditionFailedError below.
			r2Options.onlyIf = { etagDoesNotMatch: '*' };
		}

		const obj = await this.r2.put(key, value, r2Options);
		if (!obj) {
			throw new PreconditionFailedError(`ETag mismatch for key "${key}"`);
		}

		return toObject(obj);
	}

	async delete(key: string | string[]): Promise<void> {
		if (Array.isArray(key)) {
			// The Workers binding accepts at most 1000 keys per delete call.
			for (let offset = 0; offset < key.length; offset += 1000) {
				await this.r2.delete(key.slice(offset, offset + 1000));
			}
			return;
		}
		await this.r2.delete(key);
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		assertValidBucketListLimit(options?.limit);
		const result = await this.r2.list({
			prefix: options?.prefix,
			delimiter: options?.delimiter,
			cursor: options?.cursor,
			limit: options?.limit,
			startAfter: options?.startAfter,
		});

		return {
			objects: result.objects.map(toObject),
			truncated: result.truncated,
			cursor: result.truncated ? result.cursor : undefined,
			delimitedPrefixes: result.delimitedPrefixes,
		};
	}
}

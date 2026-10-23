export interface BucketObject {
	key: string;
	/**
	 * Non-empty tag that `get`, `head`, and `list` report identically for an unchanged
	 * object and that changes whenever the contents change (content-hash adapters keep
	 * it across identical rewrites). ETag-validated caches rely on it; an adapter that
	 * cannot supply one returns `''`, which disables caching.
	 */
	etag: string;
	size: number;
	uploaded: Date;
}

export interface BucketObjectBody extends BucketObject {
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	/** Raw bytes of the object — required to round-trip binary files. */
	bytes(): Promise<Uint8Array>;
}

export interface BucketListResult {
	objects: BucketObject[];
	/** Whether more objects or delimited prefixes remain after this page. */
	truncated: boolean;
	/** Resume token, present if and only if `truncated` is true. */
	cursor?: string;
	/** Rolled-up prefixes count toward the page's `limit`. */
	delimitedPrefixes: string[];
}

export interface BucketListOptions {
	prefix?: string;
	delimiter?: string;
	/** Opaque resume token from a truncated result. Takes precedence over `startAfter`. */
	cursor?: string;
	/** Positive integer maximum for combined object and delimited-prefix entries in one page. */
	limit?: number;
	/** Exclusive lower bound on object keys. */
	startAfter?: string;
}

export function assertValidBucketListLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new RangeError('Bucket list limit must be a positive integer');
	}
}

export interface BucketPutOptions {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
	/** Compare-and-swap: only write if the current ETag matches (If-Match). */
	onlyIfEtagMatches?: string;
	/**
	 * Create-if-absent: only write if the key does not exist (If-None-Match: *).
	 * On a losing race the adapter throws PreconditionFailedError.
	 *
	 * Mutually exclusive with `onlyIfEtagMatches`; adapters may treat both-set as
	 * an error.
	 */
	onlyIfNotExists?: boolean;
}

export interface BucketUploadPart {
	partNumber: number;
	etag: string;
}

export type BucketMultipartOptions = Pick<BucketPutOptions, 'httpMetadata' | 'customMetadata'> & {
	onlyIfEtagMatches?: never;
	onlyIfNotExists?: never;
};

export interface BucketMultipart {
	/** Parts survive unrelated writes to the destination and can resume across requests/processes. */
	isolatedSessions?: true;
	create(key: string, options?: BucketMultipartOptions): Promise<{ uploadId: string }>;
	putPart(
		key: string,
		uploadId: string,
		partNumber: number,
		bytes: Uint8Array,
	): Promise<BucketUploadPart>;
	complete(key: string, uploadId: string, parts: BucketUploadPart[]): Promise<BucketObject>;
	abort(key: string, uploadId: string): Promise<void>;
}

export interface Bucket {
	multipart?: BucketMultipart;
	/**
	 * Consumes chunks incrementally and publishes only after the entire body succeeds.
	 * `size` is the exact byte count; reject shorter or longer streams without publishing.
	 */
	putStream?(
		key: string,
		chunks: AsyncIterable<Uint8Array>,
		size: number,
		options?: BucketPutOptions,
	): Promise<BucketObject>;

	get(key: string): Promise<BucketObjectBody | null>;
	head(key: string): Promise<BucketObject | null>;
	put(key: string, value: string | Uint8Array, options?: BucketPutOptions): Promise<BucketObject>;
	delete(key: string | string[]): Promise<void>;
	list(options?: BucketListOptions): Promise<BucketListResult>;
}

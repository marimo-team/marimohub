export interface BucketObject {
	key: string;
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
	/** Maximum combined object and delimited-prefix entries returned in one page. */
	limit?: number;
	/** Exclusive lower bound on object keys. */
	startAfter?: string;
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

export interface Bucket {
	get(key: string): Promise<BucketObjectBody | null>;
	head(key: string): Promise<BucketObject | null>;
	put(key: string, value: string | Uint8Array, options?: BucketPutOptions): Promise<BucketObject>;
	delete(key: string | string[]): Promise<void>;
	list(options?: BucketListOptions): Promise<BucketListResult>;
}

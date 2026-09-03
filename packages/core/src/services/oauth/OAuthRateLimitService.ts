import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { ConflictError } from '../../errors';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import type { CasRetryOptions } from '../catalog/cas';

export const OAUTH_RATE_LIMITS = {
	register: { limit: 100, windowMs: 60 * 60_000 },
	authorize: { limit: 100, windowMs: 15 * 60_000 },
	token: { limit: 600, windowMs: 60_000 },
	revoke: { limit: 100, windowMs: 15 * 60_000 },
} as const;

export type OAuthRateLimitEndpoint = keyof typeof OAUTH_RATE_LIMITS;

const MAX_RATE_LIMIT = Math.max(...Object.values(OAUTH_RATE_LIMITS).map(({ limit }) => limit));
const OAuthRateLimitRecordSchema = z.strictObject({
	timestamps: z.array(z.number().int().nonnegative()).max(MAX_RATE_LIMIT),
});

export interface OAuthRateLimitServiceOptions {
	now?: () => number;
	retry?: CasRetryOptions;
}

export class OAuthRateLimitService {
	private readonly now: () => number;
	private readonly retry: CasRetryOptions | undefined;

	constructor(
		private readonly bucket: Bucket,
		options: OAuthRateLimitServiceOptions = {},
	) {
		this.now = options.now ?? (() => Date.now());
		this.retry = options.retry;
	}

	async consume(endpoint: OAuthRateLimitEndpoint): Promise<boolean> {
		const { limit, windowMs } = OAUTH_RATE_LIMITS[endpoint];
		const timestamp = this.now();
		const key = paths.oauthRateLimit(endpoint);
		try {
			return await withCasRetry(
				this.bucket,
				async (writer) => {
					const object = await this.bucket.get(key);
					const stored = object
						? await readStored(OAuthRateLimitRecordSchema, object, key)
						: { timestamps: [] };
					const timestamps = stored.timestamps.filter(
						(previous) => previous <= timestamp && timestamp - previous < windowMs,
					);
					if (timestamps.length >= limit) return false;
					timestamps.push(timestamp);
					await writer.put(
						key,
						JSON.stringify({ timestamps }),
						object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
					);
					return true;
				},
				this.retry,
			);
		} catch (error) {
			if (error instanceof ConflictError) return false;
			throw error;
		}
	}
}

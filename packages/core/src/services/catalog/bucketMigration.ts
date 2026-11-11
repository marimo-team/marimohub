import { Semaphore, settleAllOrThrow } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { Bucket } from '../../ports/bucket';
import { assertValidBucketListLimit } from '../../ports/bucket';
import type { BackgroundMigration } from './MigrationService';

/** New writes must already satisfy the migration, including keys behind the cursor. */
export function bucketMigration(options: {
	id: string;
	bucket: Bucket;
	prefix: string;
	migrate: (key: string, signal?: AbortSignal) => Promise<void>;
	batchSize?: number;
}): BackgroundMigration {
	const limit = options.batchSize ?? 100;
	assertValidBucketListLimit(limit);
	return {
		id: options.id,
		async runBatch({ cursor, signal }) {
			signal?.throwIfAborted();
			const page = await options.bucket.list({ prefix: options.prefix, cursor, limit });
			if (page.truncated && (!page.cursor || page.cursor === cursor))
				throw new Error('Migration listing did not advance its cursor');
			const semaphore = new Semaphore(BUCKET_SCAN_CONCURRENCY);
			// Drain in-flight writes before the runner releases its lease after a failure.
			await settleAllOrThrow(
				page.objects.map(({ key }) => semaphore.run(() => options.migrate(key, signal), signal)),
			);
			signal?.throwIfAborted();
			return page.truncated ? { done: false, cursor: page.cursor } : { done: true };
		},
	};
}

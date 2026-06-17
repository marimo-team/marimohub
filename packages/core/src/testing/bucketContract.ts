/**
 * Shared behavioral contract for any `Bucket` adapter.
 *
 * The storage layer's correctness hinges on conditional writes (compare-and-swap
 * on ETag) — `CatalogService.mutateSnapshot` relies on a mismatched conditional
 * `put` throwing `PreconditionFailedError`. Run this contract against every
 * adapter (MemoryBucket, S3Storage, R2BucketAdapter) to guarantee parity.
 *
 * Imports `vitest` — only invoke from a `*.test.ts`. Exposed at the
 * `@marimo-hub/core/testing/contract` subpath so it is never pulled into runtime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PreconditionFailedError } from '../errors';
import type { Bucket } from '../ports/bucket';

export function bucketContract(name: string, makeBucket: () => Bucket | Promise<Bucket>): void {
	describe(`Bucket contract: ${name}`, () => {
		let bucket: Bucket;

		beforeEach(async () => {
			bucket = await makeBucket();
		});

		it('put then get returns the stored value and a non-empty etag', async () => {
			const put = await bucket.put('k/a.json', JSON.stringify({ x: 1 }));
			expect(put.etag).toBeTruthy();

			const got = await bucket.get('k/a.json');
			expect(got).not.toBeNull();
			expect(await got!.json()).toEqual({ x: 1 });
			expect(got!.etag).toBe(put.etag);
		});

		it('get and head of a missing key return null', async () => {
			expect(await bucket.get('missing')).toBeNull();
			expect(await bucket.head('missing')).toBeNull();
		});

		it('head returns metadata without a body', async () => {
			await bucket.put('k/h.txt', 'hello');
			const head = await bucket.head('k/h.txt');
			expect(head).not.toBeNull();
			expect(head!.size).toBeGreaterThan(0);
		});

		it('delete removes an object', async () => {
			await bucket.put('k/d.txt', 'bye');
			await bucket.delete('k/d.txt');
			expect(await bucket.get('k/d.txt')).toBeNull();
		});

		it('list returns objects under a prefix', async () => {
			await bucket.put('p/1', 'a');
			await bucket.put('p/2', 'b');
			await bucket.put('q/3', 'c');

			const res = await bucket.list({ prefix: 'p/' });
			const keys = res.objects.map((o) => o.key).sort();
			expect(keys).toEqual(['p/1', 'p/2']);
		});

		it('conditional put succeeds when the etag matches', async () => {
			const first = await bucket.put('cas.json', '1');
			const second = await bucket.put('cas.json', '2', { onlyIfEtagMatches: first.etag });
			expect(second.etag).not.toBe(first.etag);
			expect(await (await bucket.get('cas.json'))!.text()).toBe('2');
		});

		it('conditional put throws PreconditionFailedError on etag mismatch', async () => {
			await bucket.put('cas2.json', '1');
			await expect(
				bucket.put('cas2.json', '2', { onlyIfEtagMatches: 'definitely-not-the-etag' }),
			).rejects.toBeInstanceOf(PreconditionFailedError);
		});

		it('create-if-absent put succeeds when the key is absent', async () => {
			const put = await bucket.put('cia.json', '1', { onlyIfNotExists: true });
			expect(put.etag).toBeTruthy();
			expect(await (await bucket.get('cia.json'))!.text()).toBe('1');
		});

		it('create-if-absent put throws PreconditionFailedError when the key exists and leaves the original intact', async () => {
			await bucket.put('cia2.json', '1', { onlyIfNotExists: true });
			await expect(bucket.put('cia2.json', '2', { onlyIfNotExists: true })).rejects.toBeInstanceOf(
				PreconditionFailedError,
			);
			// The losing write must not have clobbered the original value.
			expect(await (await bucket.get('cia2.json'))!.text()).toBe('1');
		});

		// --- Concurrency: the invariants the catalog CAS actually depends on, and
		// the ones a single-shot boot probe can't prove. These pass trivially on the
		// in-memory adapter (it serializes), so their real value is running this same
		// contract against a LIVE store, where a non-atomic check-then-set or an
		// eventually-consistent ETag surfaces as >1 winner / a lost update.

		it('CAS under contention: many writers from one base etag, exactly one wins', async () => {
			const seed = await bucket.put('race-cas.json', '0');
			const N = 20;
			const results = await Promise.allSettled(
				Array.from({ length: N }, (_, i) =>
					bucket.put('race-cas.json', String(i + 1), { onlyIfEtagMatches: seed.etag }),
				),
			);

			const fulfilled = results.filter((r) => r.status === 'fulfilled');
			const rejected = results.filter((r) => r.status === 'rejected');

			// Exactly one writer may commit; the rest must lose with a precondition
			// failure (not a silently-accepted write — that would be a lost update).
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(N - 1);
			for (const r of rejected) {
				expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PreconditionFailedError);
			}

			// The persisted object must be exactly the winner's write, not a torn or
			// stale value.
			const winner = (fulfilled[0] as PromiseFulfilledResult<{ etag: string }>).value;
			const stored = await bucket.get('race-cas.json');
			expect(stored!.etag).toBe(winner.etag);
		});

		it('create-if-absent under contention: only one creator wins', async () => {
			const N = 20;
			const results = await Promise.allSettled(
				Array.from({ length: N }, (_, i) =>
					bucket.put('race-cia.json', String(i + 1), { onlyIfNotExists: true }),
				),
			);

			const fulfilled = results.filter((r) => r.status === 'fulfilled');
			const rejected = results.filter((r) => r.status === 'rejected');

			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(N - 1);
			for (const r of rejected) {
				expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PreconditionFailedError);
			}

			const winner = (fulfilled[0] as PromiseFulfilledResult<{ etag: string }>).value;
			const stored = await bucket.get('race-cia.json');
			expect(stored!.etag).toBe(winner.etag);
		});
	});
}

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

		it('binary round-trip: put Uint8Array, bytes() returns identical bytes', async () => {
			// A non-UTF-8 byte sequence (0xff 0xfe ... 0x00) that text() would mangle.
			const data = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0x00, 0xab]);
			const put = await bucket.put('bin/blob', data);
			expect(put.etag).toBeTruthy();
			expect(put.size).toBe(data.length);

			const got = await bucket.get('bin/blob');
			expect(got).not.toBeNull();
			const bytes = await got!.bytes();
			expect([...bytes]).toEqual([...data]);
			expect(got!.size).toBe(data.length);
		});

		it('string puts still decode via text() and bytes()', async () => {
			await bucket.put('bin/text', 'héllo');
			const got = await bucket.get('bin/text');
			expect(await got!.text()).toBe('héllo');
			// bytes() yields the UTF-8 encoding of the same string.
			expect([...(await got!.bytes())]).toEqual([...new TextEncoder().encode('héllo')]);
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

		it('paginates with limit and cursor to completion without duplicates or gaps', async () => {
			const keys = Array.from({ length: 5 }, (_, i) => `pg/${i}`);
			for (const key of keys) await bucket.put(key, 'x');

			const seen: string[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const result = await bucket.list({ prefix: 'pg/', limit: 2, cursor });
				expect(result.objects.length).toBeLessThanOrEqual(2);
				expect(Boolean(result.cursor)).toBe(result.truncated);
				seen.push(...result.objects.map((object) => object.key));
				cursor = result.truncated ? result.cursor : undefined;
				expect(++pages).toBeLessThan(20);
			} while (cursor);

			expect([...seen].sort()).toEqual(keys);
			expect(new Set(seen).size).toBe(keys.length);
		});

		it('treats startAfter as an exclusive lower bound', async () => {
			await bucket.put('sa/a', '1');
			await bucket.put('sa/b', '2');
			await bucket.put('sa/c', '3');

			const result = await bucket.list({ prefix: 'sa/', startAfter: 'sa/b' });
			expect(result.objects.map((object) => object.key)).toEqual(['sa/c']);
		});

		it('paginates a delimited listing larger than the limit to completion', async () => {
			for (const key of ['dp/a/1', 'dp/a/2', 'dp/b/1', 'dp/c/1', 'dp/d/1', 'dp/top']) {
				await bucket.put(key, 'x');
			}

			const prefixes = new Set<string>();
			const objects = new Set<string>();
			let cursor: string | undefined;
			let pages = 0;
			do {
				const result = await bucket.list({ prefix: 'dp/', delimiter: '/', limit: 2, cursor });
				expect(result.objects.length + result.delimitedPrefixes.length).toBeLessThanOrEqual(2);
				expect(Boolean(result.cursor)).toBe(result.truncated);
				for (const prefix of result.delimitedPrefixes) prefixes.add(prefix);
				for (const object of result.objects) objects.add(object.key);
				cursor = result.truncated ? result.cursor : undefined;
				expect(++pages).toBeLessThan(20);
			} while (cursor);

			expect([...prefixes].sort()).toEqual(['dp/a/', 'dp/b/', 'dp/c/', 'dp/d/']);
			expect([...objects]).toEqual(['dp/top']);
		});

		it('omits the cursor from a non-truncated listing', async () => {
			await bucket.put('nt/1', 'x');
			const result = await bucket.list({ prefix: 'nt/' });
			expect(result.truncated).toBe(false);
			expect(result.cursor).toBeUndefined();
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

		// A conditional put against an ABSENT key must fail, never create. This is
		// the invariant TokenService.touch relies on to avoid resurrecting a token
		// deleted (revoked) between load and the last_used_at write — an adapter that
		// treated a missing object as "matches" would silently reintroduce that bug.
		it('conditional put throws PreconditionFailedError on an absent key (no create)', async () => {
			await expect(
				bucket.put('cas-absent.json', 'x', { onlyIfEtagMatches: 'any-etag' }),
			).rejects.toBeInstanceOf(PreconditionFailedError);
			expect(await bucket.get('cas-absent.json')).toBeNull();
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
				expect(r.reason).toBeInstanceOf(PreconditionFailedError);
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
				expect(r.reason).toBeInstanceOf(PreconditionFailedError);
			}

			const winner = (fulfilled[0] as PromiseFulfilledResult<{ etag: string }>).value;
			const stored = await bucket.get('race-cia.json');
			expect(stored!.etag).toBe(winner.etag);
		});
	});
}

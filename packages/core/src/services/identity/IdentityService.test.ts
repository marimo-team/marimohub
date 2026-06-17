import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryBucket, uid } from '../../testing';
import { paths } from '../../paths';
import { IdentityService } from './IdentityService';

describe('IdentityService', () => {
	let bucket: MemoryBucket;
	let identities: IdentityService;

	beforeEach(() => {
		bucket = new MemoryBucket();
		identities = new IdentityService(bucket);
	});

	describe('upsert', () => {
		it('writes a directory record for the user', async () => {
			await identities.upsert({ id: uid('sub-1'), email: 'ada@x.io', name: 'Ada Lovelace' });

			const stored = await identities.get(uid('sub-1'));
			expect(stored).toMatchObject({ id: uid('sub-1'), email: 'ada@x.io', name: 'Ada Lovelace' });
			expect(stored?.updated_at).toBeTruthy();
		});

		it('falls back to the email local-part when no name is supplied', async () => {
			await identities.upsert({ id: uid('sub-2'), email: 'grace@x.io' });
			expect((await identities.get(uid('sub-2')))?.name).toBe('grace');
		});

		it('skips re-writing when the identity is unchanged since last write', async () => {
			const put = vi.spyOn(bucket, 'put');
			const user = { id: uid('sub-3'), email: 'ada@x.io', name: 'Ada' };

			await identities.upsert(user);
			await identities.upsert(user);
			await identities.upsert(user);

			expect(put).toHaveBeenCalledTimes(1);
		});

		it('re-writes when the email or name changes', async () => {
			const put = vi.spyOn(bucket, 'put');

			await identities.upsert({ id: uid('sub-4'), email: 'ada@x.io', name: 'Ada' });
			await identities.upsert({ id: uid('sub-4'), email: 'ada@x.io', name: 'Ada L.' });
			await identities.upsert({ id: uid('sub-4'), email: 'ada2@x.io', name: 'Ada L.' });

			expect(put).toHaveBeenCalledTimes(3);
			expect(await identities.get(uid('sub-4'))).toMatchObject({
				email: 'ada2@x.io',
				name: 'Ada L.',
			});
		});
	});

	describe('get', () => {
		it('returns null for an unknown id', async () => {
			expect(await identities.get(uid('nope'))).toBeNull();
		});

		it('keys records by url-encoded id so awkward subs are addressable', async () => {
			await identities.upsert({ id: uid('auth0|abc/def'), email: 'x@x.io', name: 'X' });
			// Stored under an encoded key, but resolvable by the raw id.
			expect(await bucket.get(paths.identity(uid('auth0|abc/def')))).not.toBeNull();
			expect(await identities.get(uid('auth0|abc/def'))).toMatchObject({
				id: uid('auth0|abc/def'),
			});
		});
	});

	describe('getMany', () => {
		beforeEach(async () => {
			await identities.upsert({ id: uid('a'), email: 'a@x.io', name: 'Aye' });
			await identities.upsert({ id: uid('b'), email: 'b@x.io', name: 'Bee' });
		});

		it('resolves known ids, de-duplicates, and omits unknown ids', async () => {
			const result = await identities.getMany([uid('a'), uid('b'), uid('a'), uid('missing')]);
			expect(result.map((u) => u.id).sort()).toEqual([uid('a'), uid('b')]);
		});

		it('returns an empty list when nothing resolves', async () => {
			expect(await identities.getMany([uid('missing')])).toEqual([]);
		});
	});
});

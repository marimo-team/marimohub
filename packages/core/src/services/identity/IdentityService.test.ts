import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnavailableError } from '../../errors';
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

		it('persists a validated profile-picture URL when supplied', async () => {
			await identities.upsert({
				id: uid('sub-picture'),
				email: 'ada@x.io',
				pictureUrl: 'https://images.example.com/ada.png',
			});
			expect(await identities.get(uid('sub-picture'))).toMatchObject({
				picture_url: 'https://images.example.com/ada.png',
			});
		});

		it('skips re-writing when the identity is unchanged since last write', async () => {
			const put = vi.spyOn(bucket, 'put');
			const user = { id: uid('sub-3'), email: 'ada@x.io', name: 'Ada' };

			await identities.upsert(user);
			await identities.upsert(user);
			await identities.upsert(user);

			expect(put).toHaveBeenCalledTimes(1);
		});

		it('re-writes when the email, name, or profile picture changes', async () => {
			const put = vi.spyOn(bucket, 'put');

			await identities.upsert({ id: uid('sub-4'), email: 'ada@x.io', name: 'Ada' });
			await identities.upsert({ id: uid('sub-4'), email: 'ada@x.io', name: 'Ada L.' });
			await identities.upsert({ id: uid('sub-4'), email: 'ada2@x.io', name: 'Ada L.' });
			await identities.upsert({
				id: uid('sub-4'),
				email: 'ada2@x.io',
				name: 'Ada L.',
				pictureUrl: 'https://images.example.com/ada.png',
			});

			expect(put).toHaveBeenCalledTimes(4);
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

	describe('suspension', () => {
		it('loads only the requested identity and caches the active result', async () => {
			await identities.upsert({ id: uid('target'), email: 'target@x.io', name: 'Target' });
			await identities.upsert({ id: uid('other'), email: 'other@x.io', name: 'Other' });
			const checking = new IdentityService(bucket);
			const get = vi.spyOn(bucket, 'get');
			const list = vi.spyOn(bucket, 'list');

			expect(await checking.isSuspended(uid('target'))).toBe(false);
			expect(await checking.isSuspended(uid('target'))).toBe(false);

			expect(list).not.toHaveBeenCalled();
			expect(get).toHaveBeenCalledTimes(1);
			expect(get).toHaveBeenCalledWith(paths.identity(uid('target')));
		});

		it('coalesces concurrent cold checks for the same user', async () => {
			await identities.upsert({ id: uid('target'), email: 'target@x.io', name: 'Target' });
			const checking = new IdentityService(bucket);
			const get = vi.spyOn(bucket, 'get');

			await expect(
				Promise.all(Array.from({ length: 20 }, () => checking.isSuspended(uid('target')))),
			).resolves.toEqual(Array.from({ length: 20 }, () => false));
			expect(get).toHaveBeenCalledTimes(1);
		});

		it('fails closed on a cold read error, then retries successfully', async () => {
			await identities.upsert({ id: uid('target'), email: 'target@x.io', name: 'Target' });
			const checking = new IdentityService(bucket);
			const originalGet = bucket.get.bind(bucket);
			const get = vi
				.spyOn(bucket, 'get')
				.mockRejectedValueOnce(new Error('bucket unavailable'))
				.mockImplementation(originalGet);

			await expect(checking.isSuspended(uid('target'))).rejects.toBeInstanceOf(UnavailableError);
			await expect(checking.isSuspended(uid('target'))).resolves.toBe(false);
			expect(get).toHaveBeenCalledTimes(2);
		});

		it('fails closed when the stored identity cannot be parsed', async () => {
			await bucket.put(paths.identity(uid('target')), '{not valid json');

			await expect(new IdentityService(bucket).isSuspended(uid('target'))).rejects.toBeInstanceOf(
				UnavailableError,
			);
		});

		it('suspends and reactivates a known user', async () => {
			await identities.upsert({ id: uid('target'), email: 'target@x.io', name: 'Target' });

			const suspended = await identities.setSuspension(uid('target'), true);
			expect(suspended.suspended_at).toBeTruthy();
			expect(await identities.isSuspended(uid('target'))).toBe(true);

			const active = await identities.setSuspension(uid('target'), false);
			expect(active.suspended_at).toBeUndefined();
			expect(await identities.isSuspended(uid('target'))).toBe(false);
		});

		it('does not rewrite an identity when suspension state is unchanged', async () => {
			await identities.upsert({ id: uid('target'), email: 'target@x.io', name: 'Target' });
			await identities.setSuspension(uid('target'), true);
			const put = vi.spyOn(bucket, 'put');

			await identities.setSuspension(uid('target'), true);
			expect(put).not.toHaveBeenCalled();

			await identities.setSuspension(uid('target'), false);
			expect(put).toHaveBeenCalledTimes(1);
			await identities.setSuspension(uid('target'), false);
			expect(put).toHaveBeenCalledTimes(1);
		});

		it('returns false for users absent from the directory', async () => {
			expect(await identities.isSuspended(uid('missing'))).toBe(false);
		});

		it('rejects suspension changes for an unknown user', async () => {
			await expect(identities.setSuspension(uid('missing'), true)).rejects.toThrow(
				'User missing not found',
			);
		});

		it('preserves suspension when an upsert refreshes profile fields', async () => {
			await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
			const suspendedAt = (await identities.setSuspension(uid('target'), true)).suspended_at;

			await identities.upsert({ id: uid('target'), email: 'new@x.io', name: 'New Name' });

			expect(await identities.get(uid('target'))).toMatchObject({
				email: 'new@x.io',
				name: 'New Name',
				suspended_at: suspendedAt,
			});
		});

		it('does not resurrect a user when another service has a stale directory cache', async () => {
			await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
			const stale = new IdentityService(bucket);
			expect(await stale.isSuspended(uid('target'))).toBe(false);

			const suspendedAt = (await identities.setSuspension(uid('target'), true)).suspended_at;
			expect(await stale.isSuspended(uid('target'))).toBe(false);

			await stale.upsert({ id: uid('target'), email: 'new@x.io', name: 'New Name' });
			expect(await identities.get(uid('target'))).toMatchObject({
				email: 'new@x.io',
				suspended_at: suspendedAt,
			});
		});

		it('retries a profile upsert that races with suspension', async () => {
			await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
			const stale = new IdentityService(bucket);
			const originalGet = bucket.get.bind(bucket);
			let releaseRead!: () => void;
			let readCaptured!: () => void;
			const release = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			const captured = new Promise<void>((resolve) => {
				readCaptured = resolve;
			});
			let intercept = true;
			vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				const object = await originalGet(key);
				if (intercept && key === paths.identity(uid('target'))) {
					intercept = false;
					readCaptured();
					await release;
				}
				return object;
			});

			const upsert = stale.upsert({
				id: uid('target'),
				email: 'new@x.io',
				name: 'New Name',
			});
			await captured;
			const suspendedAt = (await identities.setSuspension(uid('target'), true)).suspended_at;
			releaseRead();
			await upsert;

			expect(await identities.get(uid('target'))).toMatchObject({
				email: 'new@x.io',
				name: 'New Name',
				suspended_at: suspendedAt,
			});
		});

		it('keeps a local suspension that races with a cache refresh', async () => {
			await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
			const refreshing = new IdentityService(bucket);
			const originalGet = bucket.get.bind(bucket);
			let releaseScan!: () => void;
			let scanCaptured!: () => void;
			const release = new Promise<void>((resolve) => {
				releaseScan = resolve;
			});
			const captured = new Promise<void>((resolve) => {
				scanCaptured = resolve;
			});
			let intercept = true;
			vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				const object = await originalGet(key);
				if (intercept && key === paths.identity(uid('target'))) {
					intercept = false;
					scanCaptured();
					await release;
				}
				return object;
			});

			const check = refreshing.isSuspended(uid('target'));
			await captured;
			await refreshing.setSuspension(uid('target'), true);
			releaseScan();

			expect(await check).toBe(true);
			expect(await refreshing.isSuspended(uid('target'))).toBe(true);
		});

		it('serves a stale active result while revalidating, then observes suspension', async () => {
			vi.useFakeTimers();
			try {
				await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
				const checking = new IdentityService(bucket);
				expect(await checking.isSuspended(uid('target'))).toBe(false);

				await identities.setSuspension(uid('target'), true);
				vi.advanceTimersByTime(IdentityService.ACTIVE_SUSPENSION_FRESH_MS + 1);
				expect(await checking.isSuspended(uid('target'))).toBe(false);
				await vi.waitFor(async () => {
					expect(await checking.isSuspended(uid('target'))).toBe(true);
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it('fails closed when an active result reaches its hard expiry', async () => {
			vi.useFakeTimers();
			try {
				await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
				const checking = new IdentityService(bucket);
				expect(await checking.isSuspended(uid('target'))).toBe(false);
				vi.advanceTimersByTime(IdentityService.ACTIVE_SUSPENSION_MAX_AGE_MS);
				vi.spyOn(bucket, 'get').mockRejectedValue(new Error('bucket unavailable'));

				await expect(checking.isSuspended(uid('target'))).rejects.toBeInstanceOf(UnavailableError);
			} finally {
				vi.useRealTimers();
			}
		});

		it('serves a stale active result when background refresh fails and logs the user', async () => {
			vi.useFakeTimers();
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
				const checking = new IdentityService(bucket);
				expect(await checking.isSuspended(uid('target'))).toBe(false);
				const get = vi.spyOn(bucket, 'get').mockRejectedValue(new Error('bucket unavailable'));

				vi.advanceTimersByTime(IdentityService.ACTIVE_SUSPENSION_FRESH_MS + 1);
				await expect(checking.isSuspended(uid('target'))).resolves.toBe(false);
				await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

				const event = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
				expect(event).toMatchObject({
					event: 'identity_suspension_refresh_failed',
					user_id: uid('target'),
					error: { name: 'UnavailableError' },
				});
				await expect(checking.isSuspended(uid('target'))).resolves.toBe(false);
				expect(get).toHaveBeenCalledTimes(1);
			} finally {
				log.mockRestore();
				vi.useRealTimers();
			}
		});

		it('keeps denying a cached suspension while reactivation revalidates', async () => {
			vi.useFakeTimers();
			try {
				await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
				await identities.setSuspension(uid('target'), true);
				const checking = new IdentityService(bucket);
				expect(await checking.isSuspended(uid('target'))).toBe(true);

				await identities.setSuspension(uid('target'), false);
				vi.advanceTimersByTime(IdentityService.SUSPENDED_FRESH_MS + 1);
				expect(await checking.isSuspended(uid('target'))).toBe(true);
				await vi.waitFor(async () => {
					expect(await checking.isSuspended(uid('target'))).toBe(false);
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it('keeps denying a cached suspension when background refresh fails', async () => {
			vi.useFakeTimers();
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await identities.upsert({ id: uid('target'), email: 'old@x.io', name: 'Old Name' });
				await identities.setSuspension(uid('target'), true);
				const checking = new IdentityService(bucket);
				expect(await checking.isSuspended(uid('target'))).toBe(true);
				vi.spyOn(bucket, 'get').mockRejectedValue(new Error('bucket unavailable'));

				vi.advanceTimersByTime(IdentityService.SUSPENDED_FRESH_MS + 1);
				await expect(checking.isSuspended(uid('target'))).resolves.toBe(true);
				await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
				await expect(checking.isSuspended(uid('target'))).resolves.toBe(true);
			} finally {
				log.mockRestore();
				vi.useRealTimers();
			}
		});
	});

	describe('list', () => {
		it('returns every directory record', async () => {
			await identities.upsert({ id: uid('a'), email: 'a@x.io', name: 'Aye' });
			await identities.upsert({ id: uid('b'), email: 'b@x.io', name: 'Bee' });

			const all = await identities.list();
			expect(all.map((u) => u.id).sort()).toEqual([uid('a'), uid('b')]);
		});

		it('returns an empty list for an empty directory', async () => {
			expect(await identities.list()).toEqual([]);
		});

		it('serves repeat calls within the TTL from the cached directory', async () => {
			const list = vi.spyOn(bucket, 'list');
			await identities.list();
			await identities.list();
			expect(list).toHaveBeenCalledTimes(1);
		});

		it('skips corrupt directory records instead of failing the scan', async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await identities.upsert({ id: uid('a'), email: 'a@x.io', name: 'Aye' });
				await bucket.put(`${paths.identitiesPrefix}corrupt.json`, '{"not": "an identity"}');

				expect((await identities.list()).map((u) => u.id)).toEqual([uid('a')]);
			} finally {
				log.mockRestore();
			}
		});

		it('propagates a cold-scan failure instead of serving an empty directory', async () => {
			vi.spyOn(bucket, 'list').mockRejectedValue(new Error('bucket unavailable'));
			await expect(identities.list()).rejects.toThrow('bucket unavailable');
		});

		it('recovers after a failed cold scan on the next call', async () => {
			await identities.upsert({ id: uid('a'), email: 'a@x.io', name: 'Aye' });
			const list = vi.spyOn(bucket, 'list').mockRejectedValueOnce(new Error('transient'));

			await expect(identities.list()).rejects.toThrow('transient');
			// The failed single-flight must not be cached as the directory.
			expect((await identities.list()).map((u) => u.id)).toEqual([uid('a')]);
			expect(list).toHaveBeenCalledTimes(2);
		});
	});

	describe('search', () => {
		beforeEach(async () => {
			await identities.upsert({ id: uid('usr_ada'), email: 'ada@x.io', name: 'Ada Lovelace' });
			await identities.upsert({ id: uid('usr_grace'), email: 'grace@x.io', name: 'Grace Hopper' });
			await identities.upsert({ id: uid('usr_alan'), email: 'alan@y.io', name: 'Alan Turing' });
		});

		it('matches case-insensitive substrings of email, name, and id', async () => {
			expect((await identities.search('ADA')).map((u) => u.id)).toEqual([uid('usr_ada')]);
			expect((await identities.search('hopper')).map((u) => u.id)).toEqual([uid('usr_grace')]);
			expect((await identities.search('usr_alan')).map((u) => u.id)).toEqual([uid('usr_alan')]);
		});

		it('sorts by name and respects the limit', async () => {
			const all = await identities.search('@');
			expect(all.map((u) => u.name)).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
			expect(await identities.search('@', 2)).toHaveLength(2);
		});

		it('returns nothing for a blank or non-matching query', async () => {
			expect(await identities.search('   ')).toEqual([]);
			expect(await identities.search('zzz-nope')).toEqual([]);
		});

		it('serves repeat searches within the TTL from the cached directory', async () => {
			vi.useFakeTimers();
			try {
				const list = vi.spyOn(bucket, 'list');
				await identities.search('ada');
				await identities.search('grace');
				expect(list).toHaveBeenCalledTimes(1);

				vi.advanceTimersByTime(31_000);
				await identities.search('ada');
				expect(list).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
			}
		});

		it('skips corrupt directory records instead of failing the search', async () => {
			await bucket.put(`${paths.identitiesPrefix}corrupt.json`, '{"not": "an identity"}');
			expect((await identities.search('ada')).map((u) => u.id)).toEqual([uid('usr_ada')]);
		});

		it('upsert splices into the warm cache — a fresh sign-in is searchable immediately', async () => {
			const list = vi.spyOn(bucket, 'list');
			await identities.search('ada'); // prime the cache

			await identities.upsert({ id: uid('usr_new'), email: 'newbie@x.io', name: 'Newbie' });

			expect((await identities.search('newbie')).map((u) => u.id)).toEqual([uid('usr_new')]);
			expect((await identities.getByEmail('newbie@x.io'))?.id).toBe(uid('usr_new'));
			// Served from the spliced cache, not a rescan.
			expect(list).toHaveBeenCalledTimes(1);
		});

		it('single-flights concurrent cold refreshes', async () => {
			const list = vi.spyOn(bucket, 'list');
			await Promise.all([identities.search('ada'), identities.search('grace')]);
			expect(list).toHaveBeenCalledTimes(1);
		});

		it('serves stale entries while a post-TTL refresh runs in the background', async () => {
			vi.useFakeTimers();
			try {
				await identities.search('ada'); // prime
				vi.advanceTimersByTime(31_000);

				// Make the refresh's list hang: the search must still answer from the
				// stale cache instead of blocking on the rescan.
				vi.spyOn(bucket, 'list').mockReturnValue(new Promise(() => {}));
				expect((await identities.search('ada')).map((u) => u.id)).toEqual([uid('usr_ada')]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('logs a failed shared stale-cache refresh once', async () => {
			vi.useFakeTimers();
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await identities.search('ada');
				vi.advanceTimersByTime(31_000);
				vi.spyOn(bucket, 'list').mockRejectedValue(new Error('directory unavailable'));

				await Promise.all(Array.from({ length: 20 }, () => identities.search('ada')));
				await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
				expect(log.mock.calls[0]?.[0]).toContain('identity_directory_refresh_failed');
			} finally {
				log.mockRestore();
				vi.useRealTimers();
			}
		});
	});

	describe('getByEmail', () => {
		it('resolves case-insensitively and misses cleanly', async () => {
			await identities.upsert({ id: uid('a'), email: 'Ada@X.io', name: 'Ada' });
			expect((await identities.getByEmail('ada@x.io'))?.id).toBe(uid('a'));
			expect(await identities.getByEmail('nobody@x.io')).toBeNull();
			expect(await identities.getByEmail('  ')).toBeNull();
		});

		it('prefers the most recently refreshed record when two ids share an email', async () => {
			await bucket.put(
				paths.identity(uid('old')),
				JSON.stringify({
					id: uid('old'),
					email: 'shared@x.io',
					name: 'Old',
					updated_at: '2020-01-01T00:00:00.000Z',
				}),
			);
			await bucket.put(
				paths.identity(uid('new')),
				JSON.stringify({
					id: uid('new'),
					email: 'shared@x.io',
					name: 'New',
					updated_at: '2026-01-01T00:00:00.000Z',
				}),
			);
			expect((await identities.getByEmail('shared@x.io'))?.id).toBe(uid('new'));
		});
	});
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { advanceTime, MemoryBucket, restoreClock, uid } from '../../testing';
import { NotFoundError, ResourceExhaustedError, UnavailableError } from '../../errors';
import { ProjectId, TokenId } from '../../ids';
import { paths } from '../../paths';
import type { TokenGrant } from '../../tokenGrants';
import { IdentityService } from '../identity/IdentityService';
import {
	bearerToken,
	hashPatSecret,
	hashScopedPatSecret,
	isPatRequest,
	isPersonalAccessToken,
	PAT_PREFIX,
	TokenService,
} from './TokenService';

const withAuth = (value?: string): Request =>
	new Request('https://hub.example/api/v1/me', {
		headers: value === undefined ? {} : { authorization: value },
	});

const OWNER = uid('sub-owner');
const PROJECT = ProjectId.parse('proj-0000000000000001');
const SCOPED_GRANT: TokenGrant = { actions: ['project.read'], projects: [PROJECT] };

describe('TokenService', () => {
	let bucket: MemoryBucket;
	let identities: IdentityService;
	let tokens: TokenService;

	beforeEach(async () => {
		bucket = new MemoryBucket();
		identities = new IdentityService(bucket);
		tokens = new TokenService(bucket, identities);
		await identities.upsert({ id: OWNER, email: 'owner@x.io', name: 'Owner' });
	});

	afterEach(() => {
		restoreClock();
	});

	describe('create', () => {
		it('returns a well-formed plaintext token exactly once', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);

			expect(token).toMatch(/^mhub_pat_[0-9A-Z]{26}_[0-9a-z]{32}$/);
			expect(token).toContain(record.id);
			expect(record).not.toHaveProperty('hash');
			expect(record.name).toBe('ci');
			expect(record.expires_at).toBeUndefined();
		});

		it('stores only the SHA-256 of the secret, never the plaintext', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			const secret = token.slice(token.lastIndexOf('_') + 1);

			const stored = (await (await bucket.get(paths.token(TokenId.parse(record.id))))!.json()) as {
				hash: string;
			};
			expect(stored.hash).toBe(await hashPatSecret(secret));
			expect(JSON.stringify(stored)).not.toContain(secret);
		});

		it('creates a domain-separated v2 record for an explicit grant', async () => {
			const { token, record } = await tokens.create({ name: 'scoped', grant: SCOPED_GRANT }, OWNER);
			const secret = token.slice(token.lastIndexOf('_') + 1);
			const stored = (await (await bucket.get(paths.token(TokenId.parse(record.id))))!.json()) as {
				credential_version: number;
				grant: unknown;
				hash: string;
			};

			expect(stored).toMatchObject({ credential_version: 2, grant: SCOPED_GRANT });
			expect(stored.hash).toBe(await hashScopedPatSecret(TokenId.parse(record.id), secret));
			expect(stored.hash).not.toBe(await hashPatSecret(secret));
			expect(record.grant).toEqual(SCOPED_GRANT);
		});

		it('stamps expires_at from expiresInDays', async () => {
			const { record } = await tokens.create({ name: 'short', expiresInDays: 7 }, OWNER);
			const expected = new Date(record.created_at).getTime() + 7 * 24 * 60 * 60 * 1000;
			expect(new Date(record.expires_at!).getTime()).toBe(expected);
		});

		it('mints a distinct id and secret each time', async () => {
			const a = await tokens.create({ name: 'a' }, OWNER);
			const b = await tokens.create({ name: 'b' }, OWNER);
			expect(a.record.id).not.toBe(b.record.id);
			expect(a.token).not.toBe(b.token);
		});

		it('enforces the per-user cap', async () => {
			for (let i = 0; i < TokenService.MAX_TOKENS_PER_USER; i++) {
				await tokens.create({ name: `t${i}` }, OWNER);
			}
			await expect(tokens.create({ name: 'one-too-many' }, OWNER)).rejects.toThrow(
				ResourceExhaustedError,
			);
			// The cap is per user, not global.
			await identities.upsert({ id: uid('sub-other'), email: 'other@x.io', name: 'Other' });
			await expect(tokens.create({ name: 'ok' }, uid('sub-other'))).resolves.toBeTruthy();
		});

		it('frees a slot when a token is revoked', async () => {
			const created = [];
			for (let i = 0; i < TokenService.MAX_TOKENS_PER_USER; i++) {
				created.push(await tokens.create({ name: `t${i}` }, OWNER));
			}
			await expect(tokens.create({ name: 'over' }, OWNER)).rejects.toThrow(ResourceExhaustedError);

			await tokens.revoke(OWNER, TokenId.parse(created[0].record.id));
			await expect(tokens.create({ name: 'now-fits' }, OWNER)).resolves.toBeTruthy();
		});

		it('does not count expired tokens toward the cap', async () => {
			// Fill the cap with short-lived tokens...
			for (let i = 0; i < TokenService.MAX_TOKENS_PER_USER; i++) {
				await tokens.create({ name: `t${i}`, expiresInDays: 1 }, OWNER);
			}
			await expect(tokens.create({ name: 'blocked' }, OWNER)).rejects.toThrow(
				ResourceExhaustedError,
			);

			// ...then let them all expire: minting a replacement must succeed even
			// though the 20 expired records still exist (and still list).
			advanceTime(2 * 24 * 60 * 60 * 1000);
			await expect(tokens.create({ name: 'fits-now' }, OWNER)).resolves.toBeTruthy();
			expect((await tokens.list(OWNER)).length).toBe(TokenService.MAX_TOKENS_PER_USER + 1);
		});
	});

	describe('list', () => {
		it("returns only the user's tokens, newest first, without hashes", async () => {
			const a = await tokens.create({ name: 'a' }, OWNER);
			const b = await tokens.create({ name: 'b' }, OWNER);
			await tokens.create({ name: 'theirs' }, uid('sub-other'));

			const listed = await tokens.list(OWNER);
			expect(listed.map((t) => t.name)).toEqual(['b', 'a']);
			expect(listed.map((t) => t.id)).toEqual([b.record.id, a.record.id]);
			for (const t of listed) expect(t).not.toHaveProperty('hash');
		});

		it('is empty for a user with no tokens', async () => {
			expect(await tokens.list(OWNER)).toEqual([]);
		});

		it('tolerates a schema-invalid record instead of failing the whole list', async () => {
			const good = await tokens.create({ name: 'good' }, OWNER);
			// A record that parses as JSON but not as a Token (e.g. schema drift).
			await bucket.put(paths.token(TokenId.parse('1'.repeat(26))), JSON.stringify({ id: 'nope' }));

			const listed = await tokens.list(OWNER);
			expect(listed.map((t) => t.name)).toEqual(['good']);
			expect(listed.map((t) => t.id)).toEqual([good.record.id]);
		});

		it('tolerates a non-JSON record instead of failing the whole list', async () => {
			await tokens.create({ name: 'good' }, OWNER);
			await bucket.put(paths.token(TokenId.parse('2'.repeat(26))), 'this is not json{{');

			const listed = await tokens.list(OWNER);
			expect(listed.map((t) => t.name)).toEqual(['good']);
		});
	});

	describe('verify', () => {
		it('resolves a valid token to the issuing principal with PAT provenance', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			expect(await tokens.verify(token)).toEqual({
				id: OWNER,
				email: 'owner@x.io',
				name: 'Owner',
				credential: { kind: 'personal-access-token', id: record.id },
			});
		});

		it('attaches a v2 grant to the credential', async () => {
			const { token, record } = await tokens.create({ name: 'scoped', grant: SCOPED_GRANT }, OWNER);
			expect((await tokens.verify(token))?.credential).toEqual({
				kind: 'personal-access-token',
				id: record.id,
				grant: SCOPED_GRANT,
			});
		});

		it('rejects a v2 record that contains a legacy hash', async () => {
			const { token, record } = await tokens.create({ name: 'scoped', grant: SCOPED_GRANT }, OWNER);
			const secret = token.slice(token.lastIndexOf('_') + 1);
			const key = paths.token(TokenId.parse(record.id));
			const stored = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
			await bucket.put(key, JSON.stringify({ ...stored, hash: await hashPatSecret(secret) }));

			expect(await new TokenService(bucket, identities).verify(token)).toBeNull();
		});

		it('rejects a v2 token copied to a different token id', async () => {
			const { token, record } = await tokens.create({ name: 'scoped', grant: SCOPED_GRANT }, OWNER);
			const secret = token.slice(token.lastIndexOf('_') + 1);
			const copiedId = TokenId.parse('0'.repeat(26));
			const stored = (await (await bucket.get(
				paths.token(TokenId.parse(record.id)),
			))!.json()) as Record<string, unknown>;
			await bucket.put(paths.token(copiedId), JSON.stringify({ ...stored, id: copiedId }));

			expect(
				await new TokenService(bucket, identities).verify(`${PAT_PREFIX}${copiedId}_${secret}`),
			).toBeNull();
		});

		it.each([
			{ credential_version: 2 },
			{ grant: SCOPED_GRANT },
			{ credential_version: 3, grant: SCOPED_GRANT },
		])('rejects an inconsistent stored record: %j', async (fields) => {
			const { token, record } = await tokens.create({ name: 'legacy' }, OWNER);
			const key = paths.token(TokenId.parse(record.id));
			const stored = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
			await bucket.put(key, JSON.stringify({ ...stored, ...fields }));

			expect(await new TokenService(bucket, identities).verify(token)).toBeNull();
		});

		it('carries the token expiry as bounded credential provenance', async () => {
			const { token, record } = await tokens.create({ name: 'short', expiresInDays: 7 }, OWNER);
			const principal = await tokens.verify(token);
			expect(principal?.credential).toEqual({
				kind: 'personal-access-token',
				id: record.id,
				expiresAt: record.expires_at,
			});
			// A PAT principal never carries session-only entitlements or their expiry.
			expect(principal).not.toHaveProperty('entitlements');
			expect(principal).not.toHaveProperty('entitlementsExpiresAt');
		});

		it('rejects a wrong secret for a real token id', async () => {
			const { record } = await tokens.create({ name: 'ci' }, OWNER);
			expect(await tokens.verify(`${PAT_PREFIX}${record.id}_${'x'.repeat(32)}`)).toBeNull();
		});

		it('rejects malformed and unknown tokens', async () => {
			expect(await tokens.verify('not-a-token')).toBeNull();
			expect(await tokens.verify(`${PAT_PREFIX}garbage`)).toBeNull();
			expect(await tokens.verify(`${PAT_PREFIX}${'0'.repeat(26)}_${'a'.repeat(32)}`)).toBeNull();
		});

		it('accepts a token whose expiry is still in the future', async () => {
			const { token } = await tokens.create({ name: 'short', expiresInDays: 2 }, OWNER);
			advanceTime(24 * 60 * 60 * 1000); // one day in — not yet past the 2-day expiry
			expect(await tokens.verify(token)).toBeTruthy();
		});

		it('rejects an expired token', async () => {
			const { token } = await tokens.create({ name: 'short', expiresInDays: 1 }, OWNER);
			expect(await tokens.verify(token)).toBeTruthy();

			advanceTime(2 * 24 * 60 * 60 * 1000);
			expect(await tokens.verify(token)).toBeNull();
		});

		it('rejects a suspended issuer and accepts the token again after reactivation', async () => {
			const { token } = await tokens.create({ name: 'ci' }, OWNER);
			expect(await tokens.verify(token)).toBeTruthy();

			await identities.setSuspension(OWNER, true);
			expect(await tokens.verify(token)).toBeNull();

			await identities.setSuspension(OWNER, false);
			expect(await tokens.verify(token)).toBeTruthy();
		});

		it('checks suspension on every verification, including token-cache hits', async () => {
			const { token } = await tokens.create({ name: 'ci' }, OWNER);
			const isSuspended = vi.spyOn(identities, 'isSuspended');

			await tokens.verify(token);
			await tokens.verify(token);

			expect(isSuspended).toHaveBeenCalledTimes(2);
			expect(isSuspended).toHaveBeenNthCalledWith(1, OWNER);
			expect(isSuspended).toHaveBeenNthCalledWith(2, OWNER);
		});

		it('propagates an unavailable suspension check without touching the token', async () => {
			const { token } = await tokens.create({ name: 'ci' }, OWNER);
			const put = vi.spyOn(bucket, 'put');
			vi.spyOn(identities, 'isSuspended').mockRejectedValue(
				new UnavailableError('Unable to verify account suspension status'),
			);

			await expect(tokens.verify(token)).rejects.toBeInstanceOf(UnavailableError);
			expect(put).not.toHaveBeenCalled();
		});

		it('returns null for a schema-corrupt stored record', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			// Overwrite with JSON that no longer matches the Token schema.
			await bucket.put(paths.token(TokenId.parse(record.id)), JSON.stringify({ id: record.id }));
			expect(await tokens.verify(token)).toBeNull();
		});

		it('returns null (does not throw) for a non-JSON stored record', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			await bucket.put(paths.token(TokenId.parse(record.id)), 'not json at all');
			await expect(tokens.verify(token)).resolves.toBeNull();
		});

		it('preserves unknown stored fields when it rewrites last_used_at', async () => {
			// Forward-compat: an older replica touching last_used_at must not strip a
			// field a newer replica added (TokenSchema is a looseObject).
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			const key = paths.token(TokenId.parse(record.id));
			const stored = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
			await bucket.put(
				key,
				JSON.stringify({
					...stored,
					future_field: 'keep-me',
					last_used_at: '2000-01-01T00:00:00.000Z',
				}),
			);

			expect(await tokens.verify(token)).toBeTruthy(); // triggers a touch rewrite

			const after = (await (await bucket.get(key))!.json()) as {
				future_field?: string;
				last_used_at?: string;
			};
			expect(after.future_field).toBe('keep-me'); // unknown key survived
			expect(after.last_used_at).not.toBe('2000-01-01T00:00:00.000Z'); // and it did rewrite
		});

		it('preserves a v2 grant and forward fields when it rewrites last_used_at', async () => {
			const { token, record } = await tokens.create({ name: 'scoped', grant: SCOPED_GRANT }, OWNER);
			const key = paths.token(TokenId.parse(record.id));
			const stored = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
			await bucket.put(
				key,
				JSON.stringify({
					...stored,
					future_field: { keep: true },
					last_used_at: '2000-01-01T00:00:00.000Z',
				}),
			);

			expect(await tokens.verify(token)).toBeTruthy();
			const after = (await (await bucket.get(key))!.json()) as Record<string, unknown>;
			expect(after).toMatchObject({
				credential_version: 2,
				grant: SCOPED_GRANT,
				future_field: { keep: true },
			});
			expect(after.last_used_at).not.toBe('2000-01-01T00:00:00.000Z');
		});

		it('rejects a revoked token immediately in the same process', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			expect(await tokens.verify(token)).toBeTruthy(); // warm the cache
			await tokens.revoke(OWNER, TokenId.parse(record.id));
			expect(await tokens.verify(token)).toBeNull();
		});

		it('does not resurrect a token revoked between load and last_used_at write', async () => {
			// A sporadically-used CI token whose last_used_at lags to a prior day, so
			// the next verify triggers a real `touch` write.
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			const key = paths.token(TokenId.parse(record.id));
			const stored = (await (await bucket.get(key))!.json()) as { last_used_at?: string };
			await bucket.put(
				key,
				JSON.stringify({ ...stored, last_used_at: '2000-01-01T00:00:00.000Z' }),
			);

			// Delete the object mid-load (the identity lookup runs after the record is
			// read, before `touch`) to model a concurrent revoke on another replica.
			// The conditional `touch` must NOT recreate the just-deleted object.
			vi.spyOn(identities, 'get').mockImplementation(async (id) => {
				await bucket.delete(key);
				return { id, email: 'owner@x.io', name: 'Owner', updated_at: '2026-07-24T00:00:00.000Z' };
			});
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});

			try {
				expect(await tokens.verify(token)).toBeTruthy(); // this call still passes...
				expect(await bucket.get(key)).toBeNull(); // ...but the object stays deleted.
				expect(log).not.toHaveBeenCalled();
			} finally {
				log.mockRestore();
			}
		});

		it('serves from the positive cache within the TTL, refreshes past it', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			expect(await tokens.verify(token)).toBeTruthy();

			// Another replica revokes: this process keeps honoring the token until
			// the cache entry ages out (the documented revocation lag)...
			await bucket.delete(paths.token(TokenId.parse(record.id)));
			expect(await tokens.verify(token)).toBeTruthy();

			// ...and rejects it once the TTL forces a re-read.
			advanceTime(TokenService.CACHE_TTL_MS + 1);
			expect(await tokens.verify(token)).toBeNull();
		});

		it('fails closed when the issuing user has no identity record', async () => {
			const ghost = uid('sub-ghost');
			const { token } = await tokens.create({ name: 'ci' }, ghost);
			expect(await tokens.verify(token)).toBeNull();
		});

		it('refreshes last_used_at at most once per day', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			const key = paths.token(TokenId.parse(record.id));

			await tokens.verify(token);
			const first = ((await (await bucket.get(key))!.json()) as { last_used_at?: string })
				.last_used_at;
			expect(first).toBeTruthy();

			const put = vi.spyOn(bucket, 'put');
			await tokens.verify(token);
			expect(put).not.toHaveBeenCalled(); // same UTC day → coalesced

			advanceTime(24 * 60 * 60 * 1000);
			await tokens.verify(token);
			const later = ((await (await bucket.get(key))!.json()) as { last_used_at?: string })
				.last_used_at;
			expect(later).not.toBe(first);
		});
	});

	describe('revoke', () => {
		it('deletes an own token so it no longer lists or verifies', async () => {
			const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
			await tokens.revoke(OWNER, TokenId.parse(record.id));
			expect(await tokens.list(OWNER)).toEqual([]);
			expect(await tokens.verify(token)).toBeNull();
		});

		it('404s for a nonexistent token', async () => {
			await expect(tokens.revoke(OWNER, TokenId.parse('0'.repeat(26)))).rejects.toThrow(
				NotFoundError,
			);
		});

		it("404s for another user's token (no ownership disclosure)", async () => {
			const { record } = await tokens.create({ name: 'ci' }, OWNER);
			await expect(tokens.revoke(uid('sub-other'), TokenId.parse(record.id))).rejects.toThrow(
				NotFoundError,
			);
			// Still present and usable by its owner.
			expect(await tokens.list(OWNER)).toHaveLength(1);
		});

		it('404s (not 500) on a schema-corrupt record', async () => {
			const id = TokenId.parse('2'.repeat(26));
			await bucket.put(paths.token(id), JSON.stringify({ id: 'nope' }));
			await expect(tokens.revoke(OWNER, id)).rejects.toThrow(NotFoundError);
		});

		it('404s (not 500) on a non-JSON record', async () => {
			const id = TokenId.parse('3'.repeat(26));
			await bucket.put(paths.token(id), 'definitely not json');
			await expect(tokens.revoke(OWNER, id)).rejects.toThrow(NotFoundError);
		});
	});

	describe('helpers', () => {
		it('isPersonalAccessToken keys on the scanner prefix', () => {
			expect(isPersonalAccessToken('mhub_pat_abc')).toBe(true);
			expect(isPersonalAccessToken('some-session-jwt')).toBe(false);
		});

		it('hashPatSecret is deterministic and secret-sensitive', async () => {
			expect(await hashPatSecret('s1')).toBe(await hashPatSecret('s1'));
			expect(await hashPatSecret('s1')).not.toBe(await hashPatSecret('s2'));
			expect(await hashPatSecret('s1')).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	// The bearer parser is security-critical: every consumer (authenticator +
	// route guard) must see the SAME value, so its casing/whitespace handling is
	// pinned here directly.
	describe('bearerToken', () => {
		it.each([
			['Bearer abc', 'abc'],
			['bearer abc', 'abc'],
			['BEARER abc', 'abc'],
			['BeArEr abc', 'abc'],
			['Bearer   abc', 'abc'], // extra internal whitespace is collapsed
			['Bearer abc ', 'abc'], // trailing whitespace trimmed
		])('parses %j → %j', (header, expected) => {
			expect(bearerToken(withAuth(header))).toBe(expected);
		});

		it('returns null for a missing header', () => {
			expect(bearerToken(withAuth())).toBeNull();
		});

		it.each([
			['Basic dXNlcjpwdw=='], // wrong scheme
			['Bearer'], // scheme only, no credential
			['Bearer '], // empty credential
			['Token abc'], // unrelated scheme
		])('returns null for %j', (header) => {
			expect(bearerToken(withAuth(header))).toBeNull();
		});
	});

	describe('isPatRequest', () => {
		it('is true for a PAT-shaped bearer, regardless of scheme case', () => {
			expect(isPatRequest(withAuth(`Bearer ${PAT_PREFIX}abc`))).toBe(true);
			expect(isPatRequest(withAuth(`BEARER ${PAT_PREFIX}abc`))).toBe(true);
		});

		it('is false for a non-PAT bearer, a non-bearer scheme, or no header', () => {
			expect(isPatRequest(withAuth('Bearer some-session-jwt'))).toBe(false);
			expect(isPatRequest(withAuth('Basic dXNlcjpwdw=='))).toBe(false);
			expect(isPatRequest(withAuth())).toBe(false);
		});
	});
});

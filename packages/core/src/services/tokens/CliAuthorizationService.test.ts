import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTime } from 'ulidx';
import { advanceTime, MemoryBucket, restoreClock, uid } from '../../testing';
import { CliAuthorizationId } from '../../ids';
import { toBase64Url } from '../../internal/base64url';
import { paths } from '../../paths';
import { IdentityService } from '../identity/IdentityService';
import { TokenService } from './TokenService';
import { CliAuthorizationService } from './CliAuthorizationService';

const OWNER = uid('cli-owner');
const VERIFIER = 'v'.repeat(64);

async function challenge(verifier = VERIFIER): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return toBase64Url(new Uint8Array(digest));
}

describe('CliAuthorizationService', () => {
	let bucket: MemoryBucket;
	let tokens: TokenService;
	let authorizations: CliAuthorizationService;

	beforeEach(async () => {
		bucket = new MemoryBucket();
		const identities = new IdentityService(bucket);
		await identities.upsert({ id: OWNER, email: 'owner@example.com', name: 'Owner' });
		tokens = new TokenService(bucket, identities);
		authorizations = new CliAuthorizationService(bucket, tokens);
	});

	afterEach(restoreClock);

	it('exchanges an approved PKCE code for a bounded PAT exactly once', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);

		const created = await authorizations.exchange(approved.code, VERIFIER);
		expect(created.token).toMatch(/^mhub_pat_/);
		expect(created.record).toMatchObject({ name: 'mohub CLI', user_id: OWNER });
		expect(new Date(created.record.expires_at!).getTime()).toBe(
			new Date(created.record.created_at).getTime() + 30 * 24 * 60 * 60 * 1000,
		);
		expect(await tokens.verify(created.token)).toMatchObject({ id: OWNER });
		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('stores only the authorization-code hash', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);
		const id = approved.code.split('_')[2];
		const object = await bucket.get(paths.cliAuthorization(id as never));
		const stored = await object!.text();

		expect(stored).not.toContain(approved.code);
		expect(stored).not.toContain(approved.code.slice(approved.code.lastIndexOf('_') + 1));
	});

	it('rejects the wrong PKCE verifier without consuming the code', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);

		await expect(authorizations.exchange(approved.code, 'wrong')).rejects.toThrow(
			/invalid or expired/,
		);
		await expect(authorizations.exchange(approved.code, VERIFIER)).resolves.toBeTruthy();
	});

	it('rejects and prunes expired authorizations', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);
		advanceTime(CliAuthorizationService.AUTHORIZATION_TTL_MS + 1);

		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'next', expiresInDays: 7 },
			OWNER,
		);
		expect((await bucket.list({ prefix: paths.cliAuthorizationsPrefix })).objects).toHaveLength(1);
	});

	it('allows only one winner when exchanges race', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);
		const results = await Promise.allSettled([
			authorizations.exchange(approved.code, VERIFIER),
			authorizations.exchange(approved.code, VERIFIER),
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
	});

	it('does not reopen a consumed code when best-effort cleanup fails', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);
		vi.spyOn(bucket, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(authorizations.exchange(approved.code, VERIFIER)).resolves.toBeTruthy();
		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		expect(await tokens.list(OWNER)).toHaveLength(1);
	});

	it('burns a claimed code when token minting fails', async () => {
		const approved = await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'mohub CLI', expiresInDays: 30 },
			OWNER,
		);
		const create = vi
			.spyOn(tokens, 'create')
			.mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			'storage unavailable',
		);
		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		expect(create).toHaveBeenCalledOnce();
	});

	it('bounds request-path pruning and does not read grant bodies', async () => {
		const timestamp = encodeTime(Date.now() - CliAuthorizationService.AUTHORIZATION_TTL_MS - 1, 10);
		for (let index = 0; index <= CliAuthorizationService.PRUNE_LIMIT; index++) {
			const oldId = CliAuthorizationId.parse(`${timestamp}${index.toString().padStart(16, '0')}`);
			await bucket.put(paths.cliAuthorization(oldId), 'body must not be read');
		}
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');

		await authorizations.approve(
			{ codeChallenge: await challenge(), tokenName: 'new', expiresInDays: 30 },
			OWNER,
		);

		expect(get).not.toHaveBeenCalled();
		expect(list).toHaveBeenCalledOnce();
		expect(list).toHaveBeenCalledWith({
			prefix: paths.cliAuthorizationsPrefix,
			limit: CliAuthorizationService.PRUNE_LIMIT,
		});
		expect((await bucket.list({ prefix: paths.cliAuthorizationsPrefix })).objects).toHaveLength(2);
	});
});

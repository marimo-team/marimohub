import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTime } from 'ulidx';
import { advanceTime, MemoryBucket, restoreClock, uid } from '../../testing';
import { PreconditionFailedError } from '../../errors';
import { CliAuthorizationId, createCliAuthorizationId, ProjectId } from '../../ids';
import { toBase64Url } from '../../internal/base64url';
import { paths } from '../../paths';
import { IdentityService } from '../identity/IdentityService';
import { TokenService } from './TokenService';
import { CliAuthorizationService } from './CliAuthorizationService';

const OWNER = uid('cli-owner');
const VERIFIER = 'v'.repeat(64);
const PROJECT = ProjectId.parse('proj-0000000000000001');
const FULL_GRANT = { actions: '*' as const, projects: '*' as const };

async function challenge(verifier = VERIFIER): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return toBase64Url(new Uint8Array(digest));
}

async function approve(
	authorizations: CliAuthorizationService,
	overrides: Partial<{ codeChallenge: string; tokenName: string; expiresInDays: number }> = {},
) {
	return authorizations.approve(
		{
			codeChallenge: await challenge(),
			tokenName: 'mohub CLI',
			expiresInDays: 30,
			...overrides,
		},
		OWNER,
	);
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
		const approved = await approve(authorizations);

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

	it('carries a narrowed scoped grant through loopback exchange', async () => {
		const approved = await authorizations.approveScoped(
			{
				codeChallenge: await challenge(),
				tokenName: 'scoped CLI',
				expiresInDays: 30,
				requestedGrant: FULL_GRANT,
				grant: { actions: ['project.read'], projects: [PROJECT] },
			},
			OWNER,
		);
		const created = await authorizations.exchange(approved.code, VERIFIER);
		expect(created.record.grant).toEqual({
			actions: ['project.read'],
			projects: [PROJECT],
		});
		expect((await tokens.verify(created.token))?.credential.grant).toEqual(created.record.grant);
	});

	it('rejects a loopback approval that widens the requested grant', async () => {
		await expect(
			authorizations.approveScoped(
				{
					codeChallenge: await challenge(),
					tokenName: 'wider',
					expiresInDays: 30,
					requestedGrant: { actions: ['project.read'], projects: [PROJECT] },
					grant: FULL_GRANT,
				},
				OWNER,
			),
		).rejects.toThrow(/cannot exceed/);
	});

	it('rejects a stored v2 authorization whose grant exceeds its request', async () => {
		const approved = await authorizations.approveScoped(
			{
				codeChallenge: await challenge(),
				tokenName: 'scoped CLI',
				expiresInDays: 30,
				requestedGrant: { actions: ['project.read'], projects: [PROJECT] },
				grant: { actions: ['project.read'], projects: [PROJECT] },
			},
			OWNER,
		);
		const id = CliAuthorizationId.parse(approved.code.split('_')[2]);
		const key = paths.cliAuthorization(id);
		const object = await bucket.get(key);
		const record = JSON.parse(await object!.text()) as Record<string, unknown>;
		await bucket.put(key, JSON.stringify({ ...record, grant: FULL_GRANT }));

		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('polls a device grant until a browser session approves it', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		expect(requested.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		await expect(authorizations.pollDevice(requested.code, VERIFIER)).resolves.toEqual({
			status: 'pending',
		});

		await authorizations.approveDevice(
			requested.userCode.toLowerCase().replace('-', ' '),
			{ tokenName: 'remote CLI', expiresInDays: 7 },
			OWNER,
		);
		const result = await authorizations.pollDevice(requested.code, VERIFIER);
		expect(result.status).toBe('approved');
		if (result.status !== 'approved') throw new Error('expected approved device grant');
		expect(result.credential.record).toMatchObject({
			name: 'remote CLI',
			user_id: OWNER,
		});
		expect(await tokens.verify(result.credential.token)).toMatchObject({ id: OWNER });
		await expect(authorizations.pollDevice(requested.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('previews and narrows a scoped device grant', async () => {
		const requested = await authorizations.requestDeviceScoped(await challenge(), FULL_GRANT);
		await expect(authorizations.previewDevice(requested.userCode)).resolves.toMatchObject({
			status: 'scoped',
			requestedGrant: FULL_GRANT,
		});
		await authorizations.approveDeviceScoped(
			requested.userCode,
			{
				tokenName: 'scoped device',
				expiresInDays: 7,
				grant: { actions: ['project.read'], projects: [PROJECT] },
			},
			OWNER,
		);
		const result = await authorizations.pollDevice(requested.code, VERIFIER);
		expect(result.status).toBe('approved');
		if (result.status !== 'approved') throw new Error('expected approved device grant');
		expect(result.credential.record.grant).toEqual({
			actions: ['project.read'],
			projects: [PROJECT],
		});
	});

	it('does not let legacy and scoped device approval methods cross', async () => {
		const legacy = await authorizations.requestDevice(await challenge());
		await expect(authorizations.previewDevice(legacy.userCode)).resolves.toMatchObject({
			status: 'legacy',
		});
		await expect(
			authorizations.approveDeviceScoped(
				legacy.userCode,
				{ tokenName: 'wrong method', expiresInDays: 7, grant: FULL_GRANT },
				OWNER,
			),
		).rejects.toThrow(/invalid or expired/);
		await expect(
			authorizations.approveDevice(
				legacy.userCode,
				{ tokenName: 'legacy', expiresInDays: 7 },
				OWNER,
			),
		).resolves.toBeTruthy();

		const scoped = await authorizations.requestDeviceScoped(await challenge(), FULL_GRANT);
		await expect(
			authorizations.approveDevice(
				scoped.userCode,
				{ tokenName: 'wrong method', expiresInDays: 7 },
				OWNER,
			),
		).rejects.toThrow(/invalid or expired/);
		await expect(
			authorizations.approveDeviceScoped(
				scoped.userCode,
				{ tokenName: 'scoped', expiresInDays: 7, grant: FULL_GRANT },
				OWNER,
			),
		).resolves.toBeTruthy();
	});

	it('rejects a scoped device approval that widens the requested grant', async () => {
		const requested = await authorizations.requestDeviceScoped(await challenge(), {
			actions: ['project.read'],
			projects: [PROJECT],
		});
		await expect(
			authorizations.approveDeviceScoped(
				requested.userCode,
				{ tokenName: 'wider', expiresInDays: 7, grant: FULL_GRANT },
				OWNER,
			),
		).rejects.toThrow(/cannot exceed/);
	});

	it('does not let a device code cross the loopback exchange endpoints', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		await expect(authorizations.exchange(requested.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		await authorizations.approveDevice(
			requested.userCode,
			{ tokenName: 'remote CLI', expiresInDays: 30 },
			OWNER,
		);
		await expect(authorizations.exchange(requested.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		await expect(authorizations.pollDevice(requested.code, VERIFIER)).resolves.toMatchObject({
			status: 'approved',
		});
	});

	it('requires both the high-entropy device secret and PKCE verifier', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		const separator = requested.code.lastIndexOf('_') + 1;
		const wrongCode = `${requested.code.slice(0, separator)}${'z'.repeat(32)}`;

		await expect(authorizations.pollDevice(wrongCode, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		await expect(authorizations.pollDevice(requested.code, 'wrong')).rejects.toThrow(
			/invalid or expired/,
		);
		await expect(authorizations.pollDevice(requested.code, VERIFIER)).resolves.toEqual({
			status: 'pending',
		});
	});

	it('allows only one browser account to approve a device code', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		const results = await Promise.allSettled([
			authorizations.approveDevice(
				requested.userCode,
				{ tokenName: 'first', expiresInDays: 30 },
				OWNER,
			),
			authorizations.approveDevice(
				requested.userCode,
				{ tokenName: 'second', expiresInDays: 30 },
				OWNER,
			),
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
	});

	it('retries user-code collisions and stops after the allocation limit', async () => {
		const originalPut = bucket.put.bind(bucket);
		let collisions = 0;
		const put = vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (key.startsWith(paths.cliDeviceUserCodesPrefix) && collisions < 2) {
				collisions += 1;
				return Promise.reject(new PreconditionFailedError('collision'));
			}
			return originalPut(key, value, options);
		});

		await expect(authorizations.requestDevice(await challenge())).resolves.toBeTruthy();
		expect(collisions).toBe(2);
		expect((await bucket.list({ prefix: paths.cliDeviceUserCodesPrefix })).objects).toHaveLength(1);
		put.mockImplementation((key, value, options) => {
			if (key.startsWith(paths.cliDeviceUserCodesPrefix)) {
				return Promise.reject(new PreconditionFailedError('collision'));
			}
			return originalPut(key, value, options);
		});

		await expect(authorizations.requestDevice(await challenge())).rejects.toThrow(
			/Could not allocate/,
		);
	});

	it('removes the user-code claim when device grant creation fails', async () => {
		const originalPut = bucket.put.bind(bucket);
		let failed = false;
		vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (key.startsWith(paths.cliAuthorizationsPrefix) && !failed) {
				failed = true;
				return Promise.reject(new Error('storage unavailable'));
			}
			return originalPut(key, value, options);
		});

		await expect(authorizations.requestDevice(await challenge())).rejects.toThrow(
			'storage unavailable',
		);
		expect((await bucket.list({ prefix: paths.cliDeviceUserCodesPrefix })).objects).toEqual([]);
	});

	it('rejects malformed and orphaned device user-code claims', async () => {
		const malformed = await authorizations.requestDevice(await challenge());
		const malformedKey = paths.cliDeviceUserCode(malformed.userCode.replace('-', ''));
		await bucket.put(malformedKey, '{not-json');
		await expect(
			authorizations.approveDevice(
				malformed.userCode,
				{ tokenName: 'remote CLI', expiresInDays: 30 },
				OWNER,
			),
		).rejects.toThrow(/invalid or expired/);

		const orphaned = await authorizations.requestDevice(await challenge());
		const orphanedKey = paths.cliDeviceUserCode(orphaned.userCode.replace('-', ''));
		await bucket.put(orphanedKey, JSON.stringify({ authorization_id: createCliAuthorizationId() }));
		await expect(
			authorizations.approveDevice(
				orphaned.userCode,
				{ tokenName: 'remote CLI', expiresInDays: 30 },
				OWNER,
			),
		).rejects.toThrow(/invalid or expired/);
	});

	it('does not consume a device grant when approval storage fails', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		const originalPut = bucket.put.bind(bucket);
		const id = CliAuthorizationId.parse(requested.code.split('_')[2]);
		const key = paths.cliAuthorization(id);
		let failed = false;
		const put = vi.spyOn(bucket, 'put').mockImplementation((putKey, value, options) => {
			if (putKey === key && options?.onlyIfEtagMatches && !failed) {
				failed = true;
				return Promise.reject(new Error('storage unavailable'));
			}
			return originalPut(putKey, value, options);
		});

		await expect(
			authorizations.approveDevice(
				requested.userCode,
				{ tokenName: 'remote CLI', expiresInDays: 30 },
				OWNER,
			),
		).rejects.toThrow('storage unavailable');
		put.mockRestore();
		await expect(
			authorizations.approveDevice(
				requested.userCode,
				{ tokenName: 'remote CLI', expiresInDays: 30 },
				OWNER,
			),
		).resolves.toBeTruthy();
	});

	it('removes the device user-code claim after exchange', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		const normalized = requested.userCode.replace('-', '');
		expect(await bucket.get(paths.cliDeviceUserCode(normalized))).not.toBeNull();
		await authorizations.approveDevice(
			requested.userCode,
			{ tokenName: 'remote CLI', expiresInDays: 30 },
			OWNER,
		);
		await authorizations.pollDevice(requested.code, VERIFIER);

		expect(await bucket.get(paths.cliDeviceUserCode(normalized))).toBeNull();
	});

	it('stores only the authorization-code hash', async () => {
		const approved = await approve(authorizations);
		const id = approved.code.split('_')[2];
		const object = await bucket.get(paths.cliAuthorization(id as never));
		const stored = await object!.text();

		expect(stored).not.toContain(approved.code);
		expect(stored).not.toContain(approved.code.slice(approved.code.lastIndexOf('_') + 1));
	});

	it('rejects the wrong PKCE verifier without consuming the code', async () => {
		const approved = await approve(authorizations);

		await expect(authorizations.exchange(approved.code, 'wrong')).rejects.toThrow(
			/invalid or expired/,
		);
		await expect(authorizations.exchange(approved.code, VERIFIER)).resolves.toBeTruthy();
	});

	it('rejects and prunes expired authorizations', async () => {
		const approved = await approve(authorizations);
		advanceTime(CliAuthorizationService.AUTHORIZATION_TTL_MS + 1);

		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		await approve(authorizations, { tokenName: 'next', expiresInDays: 7 });
		expect((await bucket.list({ prefix: paths.cliAuthorizationsPrefix })).objects).toHaveLength(1);
	});

	it('allows only one winner when exchanges race', async () => {
		const approved = await approve(authorizations);
		const results = await Promise.allSettled([
			authorizations.exchange(approved.code, VERIFIER),
			authorizations.exchange(approved.code, VERIFIER),
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
	});

	it('rejects the wrong authorization secret without consuming the code', async () => {
		const approved = await approve(authorizations);
		const separator = approved.code.lastIndexOf('_') + 1;
		const wrongCode = `${approved.code.slice(0, separator)}${'z'.repeat(32)}`;

		await expect(authorizations.exchange(wrongCode, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		await expect(authorizations.exchange(approved.code, VERIFIER)).resolves.toBeTruthy();
	});

	it('rejects a corrupt stored authorization', async () => {
		const approved = await approve(authorizations);
		const id = CliAuthorizationId.parse(approved.code.split('_')[2]);
		await bucket.put(paths.cliAuthorization(id), '{not-json');

		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('propagates storage failures without consuming the code', async () => {
		const approved = await approve(authorizations);
		vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			'storage unavailable',
		);
		await expect(authorizations.exchange(approved.code, VERIFIER)).resolves.toBeTruthy();
	});

	it('does not reopen a consumed code when best-effort cleanup fails', async () => {
		const approved = await approve(authorizations);
		vi.spyOn(bucket, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(authorizations.exchange(approved.code, VERIFIER)).resolves.toBeTruthy();
		await expect(authorizations.exchange(approved.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
		expect(await tokens.list(OWNER)).toHaveLength(1);
	});

	it('burns a claimed code when token minting fails', async () => {
		const approved = await approve(authorizations);
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

	it('burns a device grant and removes its claim when token minting fails', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		const claimKey = paths.cliDeviceUserCode(requested.userCode.replace('-', ''));
		const id = CliAuthorizationId.parse(requested.code.split('_')[2]);
		await authorizations.approveDevice(
			requested.userCode,
			{ tokenName: 'remote CLI', expiresInDays: 30 },
			OWNER,
		);
		vi.spyOn(tokens, 'create').mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(authorizations.pollDevice(requested.code, VERIFIER)).rejects.toThrow(
			'storage unavailable',
		);
		expect(await bucket.get(paths.cliAuthorization(id))).toBeNull();
		expect(await bucket.get(claimKey)).toBeNull();
		await expect(authorizations.pollDevice(requested.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('bounds request-path pruning and does not read grant bodies', async () => {
		const timestamp = encodeTime(Date.now() - CliAuthorizationService.AUTHORIZATION_TTL_MS - 1, 10);
		for (let index = 0; index <= CliAuthorizationService.PRUNE_LIMIT; index++) {
			const oldId = CliAuthorizationId.parse(`${timestamp}${index.toString().padStart(16, '0')}`);
			await bucket.put(paths.cliAuthorization(oldId), 'body must not be read');
		}
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');

		await approve(authorizations, { tokenName: 'new' });

		expect(get).not.toHaveBeenCalled();
		expect(list).toHaveBeenCalledOnce();
		expect(list).toHaveBeenCalledWith({
			prefix: paths.cliAuthorizationsPrefix,
			limit: CliAuthorizationService.PRUNE_LIMIT,
		});
		expect((await bucket.list({ prefix: paths.cliAuthorizationsPrefix })).objects).toHaveLength(2);
	});

	it('rejects invalid and expired device user codes', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		await expect(
			authorizations.approveDevice(
				'AAAA-AAAA',
				{ tokenName: 'remote CLI', expiresInDays: 30 },
				OWNER,
			),
		).rejects.toThrow(/invalid or expired/);

		advanceTime(CliAuthorizationService.AUTHORIZATION_TTL_MS + 1);
		await expect(
			authorizations.approveDevice(
				requested.userCode,
				{ tokenName: 'remote CLI', expiresInDays: 30 },
				OWNER,
			),
		).rejects.toThrow(/invalid or expired/);
		await expect(authorizations.pollDevice(requested.code, VERIFIER)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('stores only a hash of the device secret and prunes abandoned user-code claims', async () => {
		const requested = await authorizations.requestDevice(await challenge());
		const id = CliAuthorizationId.parse(requested.code.split('_')[2]);
		const secret = requested.code.slice(requested.code.lastIndexOf('_') + 1);
		const record = await bucket.get(paths.cliAuthorization(id));
		expect(await record!.text()).not.toContain(secret);

		const claimKey = paths.cliDeviceUserCode(requested.userCode.replace('-', ''));
		advanceTime(CliAuthorizationService.AUTHORIZATION_TTL_MS + 1);
		await authorizations.requestDevice(await challenge());
		expect(await bucket.get(claimKey)).toBeNull();
	});
});

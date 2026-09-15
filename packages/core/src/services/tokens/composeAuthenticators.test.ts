import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryBucket, uid } from '../../testing';
import { TokenId } from '../../ids';
import { paths } from '../../paths';
import type { AuthenticatedPrincipal, Authenticator } from '../../ports/auth';
import { IdentityService } from '../identity/IdentityService';
import { composeAuthenticators } from './composeAuthenticators';
import { hashPatSecret, PAT_PREFIX, TokenService } from './TokenService';
import {
	generateServiceAccountToken,
	ServiceAccountCredentials,
} from './ServiceAccountCredentials';

const OWNER = uid('sub-owner');
const SSO_USER: AuthenticatedPrincipal = {
	id: uid('sub-sso'),
	email: 'sso@x.io',
	credential: { kind: 'sso' },
};

function req(headers: Record<string, string> = {}): Request {
	return new Request('https://hub.example/api/v1/me', { headers });
}

const makeSsoMock = () =>
	vi.fn((_request: Request): Promise<AuthenticatedPrincipal | null> => Promise.resolve(SSO_USER));

describe('composeAuthenticators', () => {
	let bucket: MemoryBucket;
	let tokens: TokenService;
	let ssoAuthenticate: ReturnType<typeof makeSsoMock>;
	let sso: Authenticator;

	beforeEach(async () => {
		bucket = new MemoryBucket();
		const identities = new IdentityService(bucket);
		tokens = new TokenService(bucket, identities);
		await identities.upsert({ id: OWNER, email: 'owner@x.io', name: 'Owner' });
		ssoAuthenticate = makeSsoMock();
		sso = { authenticate: ssoAuthenticate };
	});

	it('resolves a valid PAT without consulting SSO', async () => {
		const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
		const auth = composeAuthenticators(tokens, sso);

		const user = await auth.authenticate(req({ authorization: `Bearer ${token}` }));
		expect(user?.id).toBe(OWNER);
		// PAT provenance survives composition — consumers key off it, never headers.
		expect(user?.credential).toEqual({ kind: 'personal-access-token', id: record.id });
		expect(ssoAuthenticate).not.toHaveBeenCalled();
	});

	it('an invalid PAT yields null — it never falls through to SSO', async () => {
		const auth = composeAuthenticators(tokens, sso);
		const bad = `${PAT_PREFIX}${'0'.repeat(26)}_${'a'.repeat(32)}`;

		expect(await auth.authenticate(req({ authorization: `Bearer ${bad}` }))).toBeNull();
		expect(
			await auth.authenticate(req({ authorization: `Bearer ${PAT_PREFIX}mangled` })),
		).toBeNull();
		expect(ssoAuthenticate).not.toHaveBeenCalled();
	});

	it('a revoked but well-formed PAT yields null, never SSO', async () => {
		const { token, record } = await tokens.create({ name: 'ci' }, OWNER);
		await bucket.delete(paths.token(TokenId.parse(record.id))); // revoked
		const auth = composeAuthenticators(tokens, sso);
		expect(await auth.authenticate(req({ authorization: `Bearer ${token}` }))).toBeNull();
		expect(ssoAuthenticate).not.toHaveBeenCalled();
	});

	it('delegates requests without bearer authentication to SSO', async () => {
		const auth = composeAuthenticators(tokens, sso);

		expect(await auth.authenticate(req())).toBe(SSO_USER);
		expect(await auth.authenticate(req({ authorization: 'Bearer some-other-token' }))).toBeNull();
		expect(await auth.authenticate(req({ authorization: 'Basic dXNlcjpwdw==' }))).toBe(SSO_USER);
		expect(
			await auth.authenticate(req({ authorization: 'Digest username="user", realm="hub"' })),
		).toBe(SSO_USER);
		expect(ssoAuthenticate).toHaveBeenCalledTimes(3);
	});

	it.each([false, true])(
		'rejects combined bearer credentials before authentication (external enabled: %s)',
		async (externalEnabled) => {
			const { token } = await tokens.create({ name: 'ci' }, OWNER);
			const verify = vi.spyOn(tokens, 'verify');
			const external = { authenticate: vi.fn(async () => SSO_USER) };
			const auth = composeAuthenticators(tokens, sso, {
				external: externalEnabled ? external : undefined,
			});
			for (const authorization of [
				'Basic dXNlcjpwdw==, Bearer invalid',
				'Basic dXNlcjpwdw==,bEaReR\tinvalid',
				'Basic dXNlcjpwdw==, Bearer',
				'Bearer invalid, Basic dXNlcjpwdw==',
				'Bearer invalid, Bearer another',
				`Basic dXNlcjpwdw==, Bearer ${token}`,
				`Bearer ${token}, Basic dXNlcjpwdw==`,
			]) {
				expect(
					await auth.authenticate(req({ authorization, cookie: 'mh_session=valid' })),
				).toBeNull();
			}
			expect(verify).not.toHaveBeenCalled();
			expect(external.authenticate).not.toHaveBeenCalled();
			expect(ssoAuthenticate).not.toHaveBeenCalled();
		},
	);

	it('rejects duplicate Authorization fields joined by Fetch', async () => {
		const headers = new Headers({ cookie: 'mh_session=valid' });
		headers.append('authorization', 'Basic dXNlcjpwdw==');
		headers.append('authorization', 'Bearer invalid');
		const external = { authenticate: vi.fn(async () => SSO_USER) };
		const auth = composeAuthenticators(tokens, sso, { external });
		expect(
			await auth.authenticate(new Request('https://hub.example/api/v1/me', { headers })),
		).toBeNull();
		expect(external.authenticate).not.toHaveBeenCalled();
		expect(ssoAuthenticate).not.toHaveBeenCalled();
	});

	// The scheme match must be case-insensitive — a stricter parse anywhere
	// downstream (the token-management guard) would then disagree and leak.
	it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])(
		'resolves the PAT under the %s scheme',
		async (scheme) => {
			const { token } = await tokens.create({ name: 'ci' }, OWNER);
			const auth = composeAuthenticators(tokens, sso);
			const user = await auth.authenticate(req({ authorization: `${scheme} ${token}` }));
			expect(user?.id).toBe(OWNER);
			expect(ssoAuthenticate).not.toHaveBeenCalled();
		},
	);

	it('surfaces logoutUrl only when the SSO adapter has one', () => {
		expect(composeAuthenticators(tokens, sso).logoutUrl).toBeUndefined();

		const withLogout = composeAuthenticators(tokens, {
			authenticate: async () => null,
			logoutUrl: () => 'https://idp.example/logout',
		});
		expect(withLogout.logoutUrl?.()).toBe('https://idp.example/logout');
	});

	it('authenticates a service account without consulting SSO', async () => {
		const token = `mhub_sa_deploy_key-1_${'a'.repeat(64)}`;
		const machine = new ServiceAccountCredentials([
			{
				id: 'deploy',
				credentials: [{ id: 'key-1', sha256: await hashPatSecret(token) }],
				actions: ['org-integration.manage'],
			},
		]);
		const auth = composeAuthenticators(tokens, sso, { serviceAccounts: machine });
		const principal = await auth.authenticate(req({ authorization: `bEaReR ${token}` }));
		expect(principal).toMatchObject({
			id: 'service-account:deploy',
			credential: { kind: 'service-account' },
		});
		for (const bad of [
			'mhub_sa_malformed',
			`mhub_sa_deploy_key-1_${'b'.repeat(64)}`,
			`mhub_sa_other_key-1_${'a'.repeat(64)}`,
		]) {
			expect(
				await auth.authenticate(req({ authorization: `Bearer ${bad}`, cookie: 'sso=valid' })),
			).toBeNull();
		}
		expect(ssoAuthenticate).not.toHaveBeenCalled();
	});

	it('rejects machine tokens when service accounts are disabled, even with SSO', async () => {
		const auth = composeAuthenticators(tokens, sso);
		expect(
			await auth.authenticate(
				req({ authorization: 'Bearer mhub_sa_disabled', cookie: 'sso=valid' }),
			),
		).toBeNull();
		expect(ssoAuthenticate).not.toHaveBeenCalled();
	});

	it('reserves the machine identity namespace against SSO and PAT impersonation', async () => {
		const id = uid('service-account:deploy');
		const identity = { id, email: 'deploy@service-accounts.invalid' };
		const auth = composeAuthenticators(tokens, {
			authenticate: async () => ({ ...identity, credential: { kind: 'sso' } }),
		});
		expect(await auth.authenticate(req())).toBeNull();
		await new IdentityService(bucket).upsert(identity);
		const { token } = await tokens.create({ name: 'impersonation' }, id);
		expect(await auth.authenticate(req({ authorization: `Bearer ${token}` }))).toBeNull();
	});
});

describe('external bearer composition', () => {
	it.each([false, true])(
		'never routes service account prefixes to OIDC (accounts enabled: %s)',
		async (enabled) => {
			const generated = await generateServiceAccountToken('deploy', 'key');
			const serviceAccounts = new ServiceAccountCredentials([
				{ id: 'deploy', actions: ['org-integration.manage'], credentials: [generated.credential] },
			]);
			const tokens = new TokenService(new MemoryBucket(), new IdentityService(new MemoryBucket()));
			const verify = vi.spyOn(tokens, 'verify');
			const sso = { authenticate: vi.fn(async () => SSO_USER) };
			const external = { authenticate: vi.fn(async () => SSO_USER) };
			const auth = composeAuthenticators(tokens, sso, {
				external,
				serviceAccounts: enabled ? serviceAccounts : undefined,
			});
			const valid = await auth.authenticate(
				req({ authorization: `Bearer ${generated.token}`, cookie: 'mh_session=valid' }),
			);
			expect(valid?.id ?? null).toBe(enabled ? 'service-account:deploy' : null);
			for (const token of [
				'mhub_sa_bad',
				`${generated.token}x`,
				generated.token.replace('_key_', '_missing_'),
			]) {
				expect(
					await auth.authenticate(
						req({ authorization: `Bearer ${token}`, cookie: 'mh_session=valid' }),
					),
				).toBeNull();
			}
			expect(verify).not.toHaveBeenCalled();
			expect(external.authenticate).not.toHaveBeenCalled();
			expect(sso.authenticate).not.toHaveBeenCalled();
		},
	);

	it('rejects external claims to the machine identity namespace', async () => {
		const bucket = new MemoryBucket();
		const tokens = new TokenService(bucket, new IdentityService(bucket));
		const external = {
			authenticate: async () => ({
				...SSO_USER,
				id: uid('service-account:deploy'),
				credential: { kind: 'external-access-token' as const },
			}),
		};
		const auth = composeAuthenticators(
			tokens,
			{ authenticate: async () => SSO_USER },
			{ external },
		);
		expect(
			await auth.authenticate(
				req({ authorization: 'Bearer external.jwt.token', cookie: 'mh_session=valid' }),
			),
		).toBeNull();
	});

	it.each(['Bearer', 'Bearer ', 'Bearer one two', 'Bearer unknown', 'Bearer a,b'])(
		'does not fall back to a cookie for %j when external tokens are disabled',
		async (authorization) => {
			const bucket = new MemoryBucket();
			const sso = { authenticate: vi.fn(async () => SSO_USER) };
			const auth = composeAuthenticators(
				new TokenService(bucket, new IdentityService(bucket)),
				sso,
			);
			expect(
				await auth.authenticate(req({ authorization, cookie: 'mh_session=valid' })),
			).toBeNull();
			expect(sso.authenticate).not.toHaveBeenCalled();
		},
	);

	it('routes external tokens without cookie fallback, including malformed bearer headers', async () => {
		const tokens = { verify: vi.fn(async () => null) } as unknown as TokenService;
		const sso = { authenticate: vi.fn(async () => SSO_USER) };
		const external = { authenticate: vi.fn(async () => null) };
		const auth = composeAuthenticators(tokens, sso, { external });
		for (const authorization of ['Bearer external.jwt.token', 'Bearer', 'bearer ', 'BEARER\tbad']) {
			expect(
				await auth.authenticate(req({ authorization, cookie: 'mh_session=valid' })),
			).toBeNull();
		}
		expect(external.authenticate).toHaveBeenCalledTimes(2);
		expect(sso.authenticate).not.toHaveBeenCalled();
		expect(await auth.authenticate(req({ cookie: 'mh_session=valid' }))).toBe(SSO_USER);
		expect(await auth.authenticate(req({ authorization: 'Bearer mhub_pat_invalid' }))).toBeNull();
		expect(tokens.verify).toHaveBeenCalledWith('mhub_pat_invalid');
		expect(external.authenticate).toHaveBeenCalledTimes(2);
	});
});

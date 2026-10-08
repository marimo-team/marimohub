import { describe, expect, it } from 'vitest';
import { admitOidcIdentity, createAdmissionPolicy } from './admission';
import type { OidcAdmissionConfig } from './admission';

const identity = { sub: 'user', email: 'user@example.com', email_verified: true };
const policy = createAdmissionPolicy({ allowedEmailDomains: [' @EXAMPLE.COM ', ''] });
const groupConfig = {
	groups: {
		claim: '/groups',
		allowed: ['staff'],
		superAdmin: ['admin'],
		defaultRoles: { editor: ['staff'] },
	},
};

describe('shared OIDC identity admission', () => {
	it('normalizes domain configuration without broadening domain matches', () => {
		expect(admitOidcIdentity({ ...identity, email: 'user@EXAMPLE.COM' }, policy)).toMatchObject({
			user: { email: 'user@EXAMPLE.COM' },
		});
		for (const email of ['user@sub.example.com', 'user@notexample.com', 'user@example.com.evil']) {
			expect(admitOidcIdentity({ ...identity, email }, policy)).toEqual({
				error: 'domain_not_allowed',
			});
		}
	});

	it.each(['', 'a'.repeat(513), 'user\n', 123, null])('rejects an invalid subject: %j', (sub) => {
		expect(admitOidcIdentity({ ...identity, sub }, policy)).toEqual({ error: 'auth_failed' });
	});

	it('accepts a subject at the size limit', () => {
		expect(admitOidcIdentity({ ...identity, sub: 'a'.repeat(512) }, policy)).toHaveProperty('user');
	});

	it.each([undefined, 'other'])('rejects UserInfo whose subject is %j', (sub) => {
		expect(admitOidcIdentity(identity, policy, { ...identity, sub })).toEqual({
			error: 'auth_failed',
		});
	});

	it('uses UserInfo email without falling back when that email is invalid or disallowed', () => {
		for (const email of ['', null, 'not-an-email']) {
			expect(admitOidcIdentity(identity, policy, { ...identity, email })).toEqual({
				error: 'auth_failed',
			});
		}
		expect(admitOidcIdentity(identity, policy, { ...identity, email: 'user@foreign.com' })).toEqual(
			{ error: 'domain_not_allowed' },
		);
		expect(admitOidcIdentity(identity, policy, { sub: identity.sub })).toMatchObject({
			user: { email: identity.email },
		});
	});

	describe.each(['required', 'trusted-issuer'] as const)(
		'%s email verification',
		(emailVerification) => {
			const admissionPolicy = createAdmissionPolicy({ emailVerification });

			it.each([
				[true, 'true'],
				['true', true],
				['true', 'true'],
				[undefined, 'true'],
			])('accepts ID-token %j and UserInfo %j verification', (tokenVerified, userInfoVerified) => {
				expect(
					admitOidcIdentity({ ...identity, email_verified: tokenVerified }, admissionPolicy, {
						...identity,
						email: 'other@example.com',
						email_verified: userInfoVerified,
					}),
				).toMatchObject({ user: { email: 'other@example.com' } });
			});

			it('accepts string verification without UserInfo', () => {
				expect(
					admitOidcIdentity({ ...identity, email_verified: 'true' }, admissionPolicy),
				).toMatchObject({ user: { email: identity.email } });
			});

			it.each([undefined, true, 'true'])(
				'uses the verified ID-token email when UserInfo omits email (verification: %j)',
				(email_verified) => {
					expect(
						admitOidcIdentity({ ...identity, email_verified: 'true' }, admissionPolicy, {
							sub: identity.sub,
							email_verified,
						}),
					).toMatchObject({ user: { email: identity.email } });
				},
			);

			it.each([
				['without UserInfo', undefined, undefined],
				['absent from both sources', undefined, { ...identity, email_verified: undefined }],
				['absent from UserInfo email source', 'true', { ...identity, email_verified: undefined }],
				[
					'absent from ID-token email source',
					undefined,
					{ sub: identity.sub, email_verified: 'true' },
				],
			] as const)('handles missing verification %s', (_label, email_verified, userInfo) => {
				const result = admitOidcIdentity(
					{ ...identity, email_verified },
					admissionPolicy,
					userInfo,
				);
				if (emailVerification === 'required') {
					expect(result).toEqual({ error: 'email_not_verified' });
				} else {
					expect(result).toMatchObject({ user: { email: identity.email } });
				}
			});

			it.each([
				false,
				'false',
				null,
				0,
				1,
				'',
				'TRUE',
				'True',
				' true',
				'true ',
				'true\n',
				{},
				[],
				['true'],
			])('rejects a contradictory verification claim %j', (email_verified) => {
				const verifiedIdentity = { ...identity, email_verified: 'true' };
				const invalidIdentity = { ...identity, email_verified };
				const missingVerification = { ...identity, email_verified: undefined };
				for (const [source, token, userInfo] of [
					['ID token only', invalidIdentity, undefined],
					['ID token with verified UserInfo', invalidIdentity, verifiedIdentity],
					['ID token with missing UserInfo verification', invalidIdentity, missingVerification],
					['UserInfo with verified ID token', verifiedIdentity, invalidIdentity],
					['UserInfo with missing ID-token verification', missingVerification, invalidIdentity],
					['UserInfo without email', verifiedIdentity, { sub: identity.sub, email_verified }],
				] as const) {
					expect(admitOidcIdentity(token, admissionPolicy, userInfo), source).toEqual({
						error: 'email_not_verified',
					});
				}
			});
		},
	);

	it('prefers UserInfo groups and falls back only when the claim is absent', () => {
		const groups = createAdmissionPolicy(groupConfig);
		const token = { ...identity, groups: ['staff', 'admin'] };
		expect(admitOidcIdentity(token, groups, { ...identity, groups: ['staff'] })).toMatchObject({
			user: { entitlements: ['default-role:editor'] },
		});
		expect(admitOidcIdentity(token, groups, { ...identity, groups: [] })).toEqual({
			error: 'group_not_allowed',
		});
		expect(admitOidcIdentity(token, groups, { ...identity, groups: null })).toEqual({
			error: 'invalid_groups',
		});
		expect(admitOidcIdentity(token, groups, identity)).toMatchObject({
			user: { entitlements: ['super-admin', 'default-role:editor'] },
		});
	});

	it.each([
		null,
		'staff',
		['staff', 1],
		[''],
		['x'.repeat(257)],
		['bad\n'],
		Array(201).fill('staff'),
	])('rejects malformed groups: %j', (groups) => {
		expect(admitOidcIdentity({ ...identity, groups }, createAdmissionPolicy(groupConfig))).toEqual({
			error: 'invalid_groups',
		});
	});

	it('enforces a custom group count limit and deduplicates mapped entitlements', () => {
		const limited = createAdmissionPolicy({ groups: { ...groupConfig.groups, maxGroups: 2 } });
		expect(admitOidcIdentity({ ...identity, groups: ['staff', 'staff'] }, limited)).toMatchObject({
			user: { entitlements: ['default-role:editor'] },
		});
		expect(
			admitOidcIdentity({ ...identity, groups: ['staff', 'staff', 'staff'] }, limited),
		).toEqual({ error: 'invalid_groups' });
	});

	it('applies group admission to array-nested claims from access tokens or UserInfo', () => {
		const nestedPolicy = createAdmissionPolicy({
			groups: { ...groupConfig.groups, claim: '/identities/0/groups' },
		});
		const nestedIdentity = { ...identity, identities: [{ groups: ['staff'] }] };
		for (const result of [
			admitOidcIdentity(nestedIdentity, nestedPolicy),
			admitOidcIdentity(identity, nestedPolicy, nestedIdentity),
		]) {
			expect(result).toMatchObject({ user: { entitlements: ['default-role:editor'] } });
		}
		expect(admitOidcIdentity({ ...identity, identities: [] }, nestedPolicy)).toEqual({
			error: 'group_not_allowed',
		});
		expect(
			admitOidcIdentity({ ...identity, identities: [{ groups: 'staff' }] }, nestedPolicy),
		).toEqual({ error: 'invalid_groups' });
	});

	it('resolves escaped JSON pointers without accepting inherited memberships', () => {
		const groups = createAdmissionPolicy({
			groups: { claim: '/org~1groups/~0names', allowed: ['staff'] },
		});
		expect(
			admitOidcIdentity({ ...identity, 'org/groups': { '~names': ['staff'] } }, groups),
		).toHaveProperty('user');
		const inherited = Object.assign(Object.create({ groups: ['staff'] }), identity) as Record<
			string,
			unknown
		>;
		expect(admitOidcIdentity(inherited, createAdmissionPolicy(groupConfig))).toEqual({
			error: 'group_not_allowed',
		});
	});

	it('omits unsafe profile values and preserves safe fallback values', () => {
		expect(
			admitOidcIdentity(
				{ ...identity, name: 'Token Name', picture: 'https://example.com/profile' },
				policy,
				{ ...identity, name: 'bad\nname', picture: 'https://user:pass@example.com/profile' },
			),
		).toMatchObject({
			user: { name: 'Token Name', pictureUrl: 'https://example.com/profile' },
		});
		expect(
			admitOidcIdentity(
				{ ...identity, name: 'x'.repeat(201), picture: 'javascript:alert(1)' },
				policy,
			),
		).toEqual({ user: { id: 'user', email: identity.email } });
	});

	it.each([
		{ emailVerification: 'optional' },
		{ groups: { claim: '/groups' } },
		{ groups: { claim: 'groups', allowed: ['staff'] } },
		{ groups: { claim: '/bad~2escape', allowed: ['staff'] } },
		{ groups: { claim: '/groups', allowed: [] } },
		{ groups: { claim: '/groups', allowed: [''] } },
		{ groups: { claim: '/groups', allowed: ['staff'], maxGroups: 0 } },
		{ groups: { claim: '/groups', allowed: ['staff'], maxGroups: 201 } },
		{ groups: { claim: '/groups', allowed: ['staff'], maxGroups: 1.5 } },
	])('fails closed for invalid admission configuration: %j', (config) => {
		expect(() => createAdmissionPolicy(config as OidcAdmissionConfig)).toThrow();
	});
});

describe('retained membership groups', () => {
	it.each([
		[{ exact: ['staff'] }, ['staff']],
		[{ prefixes: ['team-'] }, ['team-a', 'team-b']],
		[{ exact: ['staff'], prefixes: ['team-'] }, ['staff', 'team-a', 'team-b']],
	] as const)('selects exact ids and prefixes: %j', (membership, expected) => {
		const admission = createAdmissionPolicy({
			groups: {
				...groupConfig.groups,
				membership: {
					exact: 'exact' in membership ? [...membership.exact] : undefined,
					prefixes: 'prefixes' in membership ? [...membership.prefixes] : undefined,
				},
			},
		});
		expect(
			admitOidcIdentity(
				{ ...identity, groups: ['staff', 'admin', 'team-b', 'team-a', 'team-a', 'TEAM-c'] },
				admission,
			),
		).toMatchObject({
			user: { groups: expected, entitlements: ['super-admin', 'default-role:editor'] },
		});
		expect(admitOidcIdentity({ ...identity, groups: ['team-a'] }, admission)).toEqual({
			error: 'group_not_allowed',
		});
	});
	it('distinguishes an absent membership policy from a missing claim', () => {
		expect(admitOidcIdentity(identity, policy)).toEqual({
			user: { id: identity.sub, email: identity.email },
		});
		const admission = createAdmissionPolicy({
			groups: { claim: '/groups', membership: { prefixes: ['team-'] } },
		});
		expect(admitOidcIdentity(identity, admission)).toMatchObject({
			user: { groups: [], entitlements: [] },
		});
	});
	it('drops only unretainable selected ids and keeps counts off the user', () => {
		const admission = createAdmissionPolicy({
			groups: { claim: '/groups', membership: { prefixes: ['team-'] } },
		});
		expect(
			admitOidcIdentity(
				{
					...identity,
					groups: ['team-ok', 'team-bad,comma', `team-${'x'.repeat(129)}`, 'other,bad'],
				},
				admission,
			),
		).toEqual({
			user: { id: identity.sub, email: identity.email, groups: ['team-ok'], entitlements: [] },
			groupStats: { unretainable: 2 },
		});
	});
	it('denies overflow without truncating', () => {
		const admission = createAdmissionPolicy({
			groups: { claim: '/groups', membership: { prefixes: ['team-'] } },
		});
		const groups = Array.from({ length: 33 }, (_, i) => `team-${i}`);
		expect(admitOidcIdentity({ ...identity, groups }, admission)).toEqual({
			error: 'too_many_groups',
			retained: 33,
		});
	});
	it.each([
		{ exact: [] },
		{ prefixes: [''] },
		{},
		{ exact: ['a,b'] },
		{ prefixes: Array(21).fill('team-') },
		{ exact: Array(201).fill('team-a') },
	])('rejects invalid membership configuration: %j', (membership) => {
		expect(() => createAdmissionPolicy({ groups: { claim: '/groups', membership } })).toThrow();
	});
});

describe('membership admission failure boundaries', () => {
	const membershipPolicy = createAdmissionPolicy({
		groups: { claim: '/groups', membership: { prefixes: ['team-'] } },
	});

	it.each([
		{ userInfoGroups: [], expected: { user: { groups: [] } } },
		{ userInfoGroups: ['team-info'], expected: { user: { groups: ['team-info'] } } },
		{ userInfoGroups: null, expected: { error: 'invalid_groups' } },
		{ userInfoGroups: 'team-info', expected: { error: 'invalid_groups' } },
		{ userInfoGroups: undefined, expected: { user: { groups: ['team-token'] } } },
	])(
		'does not fall back from a present UserInfo group claim: $userInfoGroups',
		({ userInfoGroups, expected }) => {
			expect(
				admitOidcIdentity({ ...identity, groups: ['team-token'] }, membershipPolicy, {
					...identity,
					groups: userInfoGroups,
				}),
			).toMatchObject(expected);
		},
	);

	it('bounds only unique selected groups, but still enforces the raw claim count', () => {
		const selected = Array.from({ length: 32 }, (_, i) => `team-${i}`);
		const groups = [...selected, ...Array(168).fill('unselected')];
		expect(admitOidcIdentity({ ...identity, groups }, membershipPolicy)).toMatchObject({
			user: { groups: [...selected].sort() },
		});
		expect(
			admitOidcIdentity({ ...identity, groups: Array(200).fill('team-a') }, membershipPolicy),
		).toMatchObject({ user: { groups: ['team-a'] } });
		expect(
			admitOidcIdentity({ ...identity, groups: [...groups, 'unselected'] }, membershipPolicy),
		).toEqual({ error: 'invalid_groups' });
	});

	it('denies byte overflow below the group-count cap and succeeds after the filter is narrowed', () => {
		const groups = Array.from({ length: 11 }, (_, i) => `team-${i}-${'x'.repeat(120)}`);
		expect(admitOidcIdentity({ ...identity, groups }, membershipPolicy)).toEqual({
			error: 'too_many_groups',
			retained: 11,
		});
		const narrow = createAdmissionPolicy({
			groups: { claim: '/groups', membership: { exact: [groups[0]] } },
		});
		expect(admitOidcIdentity({ ...identity, groups }, narrow)).toMatchObject({
			user: { groups: [groups[0]] },
		});
	});

	it('keeps entitlement mapping independent from membership retention', () => {
		const unretainable = 'team-admin,legacy';
		const admission = createAdmissionPolicy({
			groups: {
				claim: '/groups',
				allowed: [unretainable],
				superAdmin: [unretainable],
				membership: { prefixes: ['team-'] },
			},
		});
		expect(admitOidcIdentity({ ...identity, groups: [unretainable] }, admission)).toMatchObject({
			user: { groups: [], entitlements: ['super-admin'] },
			groupStats: { unretainable: 1 },
		});
	});
});

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

	it.each([false, null, 'true', 1])(
		'rejects a contradictory verification claim %j even with trusted-issuer',
		(email_verified) => {
			const trusted = createAdmissionPolicy({ emailVerification: 'trusted-issuer' });
			expect(admitOidcIdentity({ ...identity, email_verified }, trusted, identity)).toEqual({
				error: 'email_not_verified',
			});
			expect(admitOidcIdentity(identity, trusted, { ...identity, email_verified })).toEqual({
				error: 'email_not_verified',
			});
			expect(admitOidcIdentity(identity, trusted, { sub: identity.sub, email_verified })).toEqual({
				error: 'email_not_verified',
			});
		},
	);

	it('requires verification from the selected email source', () => {
		expect(
			admitOidcIdentity(identity, policy, { sub: identity.sub, email: 'other@example.com' }),
		).toEqual({ error: 'email_not_verified' });
		const trusted = createAdmissionPolicy({ emailVerification: 'trusted-issuer' });
		expect(admitOidcIdentity({ ...identity, email_verified: undefined }, trusted)).toHaveProperty(
			'user',
		);
	});

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

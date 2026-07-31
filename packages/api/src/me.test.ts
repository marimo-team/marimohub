import { describe, it, expect } from 'vitest';
import type { Authenticator } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { createTestApi, expectError, expectOk } from './testing';

describe('GET /api/v1/me', () => {
	it('returns the authenticated user with a null logout_url by default', async () => {
		const { request } = createTestApi();
		const res = await request('GET', '/me');
		expect(await expectOk(res)).toEqual({
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			logout_url: null,
			is_super_admin: false,
		});
	});

	it('flags a configured super admin', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		expect((await expectOk(await request('GET', '/me'))).is_super_admin).toBe(true);
	});

	it('surfaces the authenticator logout URL when one is provided', async () => {
		const authenticator: Authenticator = {
			authenticate: async () => ({ id: ACTOR, email: `${ACTOR}@example.com` }),
			logoutUrl: () => 'https://idp.example/logout',
		};
		const { request } = createTestApi({ deps: { authenticator } });
		const res = await request('GET', '/me');
		expect((await expectOk(res)).logout_url).toBe('https://idp.example/logout');
	});

	it('requires authentication', async () => {
		const authenticator: Authenticator = { authenticate: async () => null };
		const { request } = createTestApi({ deps: { authenticator } });
		await expectError(await request('GET', '/me'), 401);
	});
});

import { describe, it, expect } from 'vitest';
import { MemoryBucket, uid } from '@marimo-hub/core/testing';
import type { Authenticator } from '@marimo-hub/core';
import { createApi } from './createApi';
import { expectError, expectOk, makeTestDeps } from './testing';

const authed: Authenticator = {
	authenticate: async () => ({ id: uid('u'), email: 'u@example.com' }),
};

/** A minimal stub of the WIF issuer — capabilities only checks for its presence. */
const stubWif = {
	mint: async () => 'jwt',
	jwks: async () => ({ keys: [] }),
} as unknown as NonNullable<Parameters<typeof makeTestDeps>[1]>['wif'];

describe('GET /api/v1/capabilities', () => {
	it('reports federation available when WIF is configured', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: authed, wif: stubWif });
		const res = await createApi(deps).request('/api/v1/capabilities');
		expect(await expectOk(res)).toMatchObject({ federation: { available: true } });
	});

	it('reports federation unavailable when WIF is not configured', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		const res = await createApi(deps).request('/api/v1/capabilities');
		expect(await expectOk(res)).toMatchObject({ federation: { available: false } });
	});

	it('reports the configured viewer mode, defaulting to static', async () => {
		const defaulted = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(
			await expectOk(await createApi(defaulted).request('/api/v1/capabilities')),
		).toMatchObject({ viewer_mode: 'static' });

		const configured = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { viewerMode: 'ephemeral-sandbox' },
		});
		expect(
			await expectOk(await createApi(configured).request('/api/v1/capabilities')),
		).toMatchObject({ viewer_mode: 'ephemeral-sandbox' });
	});

	it('reports deployment limits', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { maxConcurrentSessionsPerUser: 3 },
		});
		const data = await expectOk<{ limits: Record<string, number | null> }>(
			await createApi(deps).request('/api/v1/capabilities'),
		);
		expect(data.limits).toEqual({
			max_concurrent_sessions_per_user: 3,
			max_request_bytes: 10 * 1024 * 1024,
			max_versions_per_notebook: 50,
			default_page_size: 100,
			max_page_size: 500,
		});
	});

	it('reports an unlimited session cap as null', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		const data = await expectOk<{ limits: { max_concurrent_sessions_per_user: number | null } }>(
			await createApi(deps).request('/api/v1/capabilities'),
		);
		expect(data.limits.max_concurrent_sessions_per_user).toBeNull();
	});

	it('requires authentication (not a public endpoint)', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { wif: stubWif });
		const res = await createApi(deps).request('/api/v1/capabilities');
		await expectError(res, 401, 'UNAUTHORIZED');
	});
});

import { describe, it, expect } from 'vitest';
import { MemoryBucket, uid } from '@marimo-hub/core/testing';
import type { Authenticator } from '@marimo-hub/core';
import { createApi } from './createApi';
import { expectError, expectOk, makeTestDeps } from './testing';

const authed: Authenticator = {
	authenticate: async () => ({
		id: uid('u'),
		email: 'u@example.com',
		credential: { kind: 'development' },
	}),
};

describe('GET /api/v1/version', () => {
	// The rest of the build/runtime identity (image, replica, backends, …) is
	// super-admin material on GET /api/v1/admin/config, not served here.
	it('returns only the version string when configured', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			version: {
				version: 'a1b2c3d',
				image: 'ghcr.io/marimo-team/marimohub:a1b2c3d',
				sandboxImage: 'ghcr.io/marimo-team/marimo-sandbox:latest',
				startedAt: '2026-06-24T12:05:00Z',
				replica: 'marimohub-abc123',
				node: 'v24.3.0',
				backends: { storage: 's3', compute: 'coreweave', auth: 'oidc' },
			},
		});
		const res = await createApi(deps).request('/api/v1/version');
		expect(await expectOk(res)).toEqual({ version: 'a1b2c3d' });
	});

	it('falls back to dev when no version is wired', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		const res = await createApi(deps).request('/api/v1/version');
		expect(await expectOk(res)).toEqual({ version: 'dev' });
	});

	it('requires authentication (not a public endpoint)', async () => {
		// Default deny-all authenticator → the auth guard rejects.
		const deps = makeTestDeps(new MemoryBucket(), {
			version: { version: 'a1b2c3d' },
		});
		const res = await createApi(deps).request('/api/v1/version');
		await expectError(res, 401, 'UNAUTHORIZED');
	});
});

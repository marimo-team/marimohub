import { describe, it, expect, beforeEach } from 'vitest';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR } from '@marimo-hub/core/testing';
import { createApi } from '../createApi';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	makeTestDeps,
} from '../testing';

describe('User routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		// Each authenticated request upserts the caller's identity into the
		// directory (auth middleware), so ACTOR is resolvable after the first call.
		request = createTestApi({ bucket, userId: ACTOR }).request;
		await request('GET', '/me');
	});

	it('GET /users resolves a known id to { id, email, name }', async () => {
		const data = await expectOk<Record<string, { id: string; email: string; name: string }>>(
			await request('GET', `/users?ids=${ACTOR}`),
		);
		expect(data[ACTOR]).toEqual({
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			name: ACTOR, // email local-part fallback (stub auth supplies no name)
		});
	});

	it('GET /users omits ids with no recorded identity', async () => {
		const data = await expectOk<Record<string, unknown>>(
			await request('GET', `/users?ids=${ACTOR},sub-unknown`),
		);
		expect(Object.keys(data)).toEqual([ACTOR]);
		expect(data['sub-unknown']).toBeUndefined();
	});

	it('GET /users with no ids returns an empty map', async () => {
		expect(await expectOk(await request('GET', '/users'))).toEqual({});
	});

	it('GET /users is rejected for unauthenticated callers (401)', async () => {
		// A fresh app with the default deny-all authenticator.
		const app = createApi(makeTestDeps(bucket));
		await expectError(await app.request(`/api/v1/users?ids=${ACTOR}`), 401, 'UNAUTHORIZED');
	});
});

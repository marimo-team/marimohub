import { afterEach, expect, it, vi } from 'vitest';
import { MigrationService, paths } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '@marimo-hub/core/testing';
import { createTestApi } from '../testing';

afterEach(() => vi.restoreAllMocks());
function fixture(superAdmin = true) {
	const bucket = new MemoryBucket();
	const register = vi.fn(async () => {});
	const api = createTestApi({
		bucket,
		deps: { policy: { superAdmins: superAdmin ? [ACTOR] : [] }, requestMigrationTick: register },
	});
	return { ...api, bucket, register };
}
it('authorizes before inspecting or requesting work', async () => {
	const { request, deps, register } = fixture(false);
	const inspect = vi.spyOn(deps.services.migrations, 'inspect');
	for (const method of ['GET', 'POST'] as const) {
		expect(
			(
				await request(
					method,
					method === 'GET' ? '/admin/migrations' : '/admin/migrations/run',
					method === 'POST' ? {} : undefined,
				)
			).status,
		).toBe(403);
	}
	expect(inspect).not.toHaveBeenCalled();
	expect(register).not.toHaveBeenCalled();
});
it('registers an attempt without executing a batch and rejects arbitrary inputs', async () => {
	const { request, deps, register } = fixture();
	const tick = vi.spyOn(deps.services.migrations, 'tick');
	expect((await request('POST', '/admin/migrations/run', { id: 'unknown' })).status).toBe(422);
	expect(register).not.toHaveBeenCalled();
	expect((await request('POST', '/admin/migrations/run', {})).status).toBe(202);
	expect(register).toHaveBeenCalledOnce();
	expect(tick).not.toHaveBeenCalled();
});
it('reports missing host capability and failed registration safely', async () => {
	const { request, register } = fixture();
	register.mockRejectedValue(new Error('secret'));
	const failed = await request('POST', '/admin/migrations/run', {});
	expect(failed.status).toBe(503);
	expect(await failed.text()).not.toContain('secret');
	const missing = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
	const response = await missing.request('GET', '/admin/migrations');
	const payload = (await response.json()) as { data: { actions_available: boolean } };
	expect(payload.data.actions_available).toBe(false);
	expect((await missing.request('POST', '/admin/migrations/run', {})).status).toBe(503);
});
it('returns completion without registration and blocks invalid checkpoints', async () => {
	const { request, deps, bucket, register } = fixture();
	deps.services.migrations = new MigrationService(bucket, [
		{ id: 'test-v1', runBatch: async () => ({ done: true }) },
	]);
	await bucket.put(paths.migration('test-v1'), '{}');
	expect((await request('POST', '/admin/migrations/run', {})).status).toBe(409);
	await bucket.put(
		paths.migration('test-v1'),
		JSON.stringify({ version: 1, status: 'complete', completed_at: new Date().toISOString() }),
	);
	expect((await request('POST', '/admin/migrations/run', {})).status).toBe(200);
	expect(register).not.toHaveBeenCalled();
});

it.each(['GET', 'POST'] as const)(
	'rejects anonymous and PAT callers before inspection (%s)',
	async (method) => {
		for (const anonymous of [true, false]) {
			const api = createTestApi({
				deps: {
					policy: { superAdmins: [ACTOR] },
					authenticator: {
						authenticate: async () =>
							anonymous
								? null
								: {
										id: ACTOR,
										email: 'admin@example.com',
										credential: { kind: 'personal-access-token', id: 'tok-admin' },
									},
					},
				},
			});
			const inspect = vi.spyOn(api.deps.services.migrations, 'inspect');
			const response = await api.request(
				method,
				method === 'GET' ? '/admin/migrations' : '/admin/migrations/run',
				method === 'POST' ? {} : undefined,
			);
			expect(response.status).toBe(anonymous ? 401 : 403);
			expect(inspect).not.toHaveBeenCalled();
		}
	},
);

it('rejects service-account credentials before inspection', async () => {
	const api = createTestApi({
		subject: { credential: { kind: 'service-account' } },
		deps: { policy: { superAdmins: [ACTOR] } },
	});
	const inspect = vi.spyOn(api.deps.services.migrations, 'inspect');
	for (const method of ['GET', 'POST']) {
		expect(
			(
				await api.request(
					method,
					method === 'GET' ? '/admin/migrations' : '/admin/migrations/run',
					method === 'POST' ? {} : undefined,
				)
			).status,
		).toBe(403);
	}
	expect(inspect).not.toHaveBeenCalled();
});

it('does not initialize or scan the catalog while inspecting an empty installation', async () => {
	const { request, bucket, deps } = fixture();
	const initialize = vi.spyOn(deps.services.catalog, 'initialize');
	const list = vi.spyOn(bucket, 'list');
	const tick = vi.spyOn(deps.services.migrations, 'tick');
	expect((await request('GET', '/admin/migrations')).status).toBe(200);
	expect(initialize).not.toHaveBeenCalled();
	expect(list).not.toHaveBeenCalled();
	expect(tick).not.toHaveBeenCalled();
	expect(await bucket.get(paths.catalog)).toBeNull();
});

it.each([false, true])(
	'keeps independent work available beside an unreadable or corrupt checkpoint (corrupt: %s)',
	async (corrupt) => {
		const { request, bucket, deps, register } = fixture();
		deps.services.migrations = new MigrationService(bucket, [
			{ id: 'broken-v1', runBatch: async () => ({ done: true }) },
			{ id: 'independent-v1', after: [], runBatch: async () => ({ done: true }) },
		]);
		const key = paths.migration('broken-v1');
		if (corrupt) await bucket.put(key, '{secret-invalid-json');
		else {
			const get = bucket.get.bind(bucket);
			vi.spyOn(bucket, 'get').mockImplementation((path) =>
				path === key ? Promise.reject(new Error('secret-provider-response')) : get(path),
			);
		}
		const snapshot = await request('GET', '/admin/migrations');
		expect(snapshot.status).toBe(200);
		const payload = await snapshot.text();
		expect(payload).not.toContain('secret');
		expect((await request('POST', '/admin/migrations/run', {})).status).toBe(202);
		expect(register).toHaveBeenCalledOnce();
	},
);

it('refuses registration when unreadable prerequisites leave no known eligible work', async () => {
	const { request, bucket, deps, register } = fixture();
	deps.services.migrations = new MigrationService(bucket, [
		{ id: 'first-v1', runBatch: async () => ({ done: true }) },
		{ id: 'dependent-v1', runBatch: async () => ({ done: true }) },
	]);
	const get = bucket.get.bind(bucket);
	vi.spyOn(bucket, 'get').mockImplementation((path) =>
		path === paths.migration('first-v1') ? Promise.reject(new Error('secret')) : get(path),
	);
	const response = await request('POST', '/admin/migrations/run', {});
	expect(response.status).toBe(503);
	expect(await response.text()).not.toContain('secret');
	expect(register).not.toHaveBeenCalled();
});

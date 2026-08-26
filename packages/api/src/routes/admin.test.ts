import { describe, it, expect, beforeEach, vi } from 'vitest';
import { composeAuthenticators, execResult, paths } from '@marimo-hub/core';
import type { SandboxInstance, SandboxProvider } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, makeFakeSandbox, uid } from '@marimo-hub/core/testing';
import type { ConfigSummary } from '../context';
import { createApi, generateOpenApiDocument } from '../createApi';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	makeTestDeps,
} from '../testing';

interface AdminUser {
	id: string;
	email: string;
	name: string;
	updated_at: string;
	suspended_at: string | null;
	is_super_admin: boolean;
}

describe('Admin routes', () => {
	let bucket: MemoryBucket;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
	});

	function superAdminApi(deps: Record<string, unknown> = {}) {
		return createTestApi({
			bucket,
			userId: ACTOR,
			deps: { policy: { superAdmins: [ACTOR] }, ...deps },
		});
	}

	it('rejects unauthenticated requests with 401', async () => {
		const app = createApi(makeTestDeps(bucket));
		for (const path of ['/api/v1/admin/users', '/api/v1/admin/config']) {
			await expectError(await app.request(path), 401, 'UNAUTHORIZED');
		}
		await expectError(
			await app.request('/api/v1/admin/debug/sandbox-startup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			}),
			401,
			'UNAUTHORIZED',
		);
	});

	it('rejects non-super-admins with 403', async () => {
		const { request } = createTestApi({ bucket, userId: ACTOR });
		await expectError(await request('GET', '/admin/users'), 403, 'FORBIDDEN');
		await expectError(await request('GET', '/admin/config'), 403, 'FORBIDDEN');
		await expectError(
			await request('PUT', `/admin/users/${uid('target')}/suspension`),
			403,
			'FORBIDDEN',
		);
		await expectError(await request('POST', '/admin/debug/sandbox-startup', {}), 403, 'FORBIDDEN');
	});

	it('rejects a super admin PAT with 403 — admin endpoints are session-only', async () => {
		const session = superAdminApi();
		const composed = createApi({
			...session.deps,
			authenticator: composeAuthenticators(session.deps.services.tokens, {
				authenticate: async () => null,
			}),
		});
		await session.request('GET', '/me');
		const { token } = await expectOk<{ token: string }>(
			await session.request('POST', '/me/tokens', { name: 'ci' }),
			201,
		);
		for (const path of [
			'/api/v1/admin/users',
			'/api/v1/admin/config',
			`/api/v1/admin/users/${uid('target')}/suspension`,
			'/api/v1/admin/debug/sandbox-startup',
		]) {
			const debug = path.endsWith('/sandbox-startup');
			const res = await composed.request(path, {
				method: debug ? 'POST' : path.includes('/suspension') ? 'PUT' : 'GET',
				headers: {
					authorization: `Bearer ${token}`,
					...(debug ? { 'content-type': 'application/json' } : {}),
				},
				...(debug ? { body: '{}' } : {}),
			});
			await expectError(res, 403, 'FORBIDDEN');
		}
	});

	it('grants access to a super admin configured by email, not just by id', async () => {
		const { request } = createTestApi({
			bucket,
			userId: ACTOR,
			// createTestApi authenticates the caller as `${ACTOR}@example.com`.
			deps: { policy: { superAdmins: [`${ACTOR}@example.com`] } },
		});
		await expectOk(await request('GET', '/admin/users'));
		await expectOk(await request('GET', '/admin/config'));
	});

	it('advertises only cookieAuth (not bearerAuth) for the admin routes', () => {
		const doc = generateOpenApiDocument() as {
			paths: Record<string, Record<string, { security?: unknown }>>;
		};
		expect(doc.paths['/api/v1/admin/users'].get.security).toEqual([{ cookieAuth: [] }]);
		expect(doc.paths['/api/v1/admin/config'].get.security).toEqual([{ cookieAuth: [] }]);
		expect(doc.paths['/api/v1/admin/debug/sandbox-startup'].post.security).toEqual([
			{ cookieAuth: [] },
		]);
		expect(doc.paths['/api/v1/admin/users/{id}/suspension'].put.security).toEqual([
			{ cookieAuth: [] },
		]);
		expect(doc.paths['/api/v1/admin/users/{id}/suspension'].delete.security).toEqual([
			{ cookieAuth: [] },
		]);
	});

	describe('GET /admin/users', () => {
		it('lists the directory name-sorted with computed super-admin flags', async () => {
			const { request, deps } = createTestApi({
				bucket,
				userId: ACTOR,
				// One super admin matched by email, one by id, plus the caller.
				deps: { policy: { superAdmins: [ACTOR, 'ada@x.io', uid('usr_alan')] } },
			});
			await deps.services.identities.upsert({
				id: uid('usr_ada'),
				email: 'Ada@X.io',
				name: 'Ada Lovelace',
			});
			await deps.services.identities.upsert({
				id: uid('usr_grace'),
				email: 'grace@x.io',
				name: 'Grace Hopper',
			});
			await deps.services.identities.upsert({
				id: uid('usr_alan'),
				email: 'alan@y.io',
				name: 'Alan Turing',
			});

			const { items, next_cursor } = await expectOk<{
				items: AdminUser[];
				next_cursor: string | null;
			}>(await request('GET', '/admin/users'));
			expect(next_cursor).toBeNull();
			const seeded = items.filter((u) => u.id !== ACTOR);
			expect(seeded.map((u) => u.name)).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
			expect(seeded.map((u) => u.is_super_admin)).toEqual([true, true, false]);
			expect(seeded[0]).toMatchObject({
				id: uid('usr_ada'),
				email: 'Ada@X.io',
				updated_at: expect.any(String),
			});
		});

		it('includes the caller (upserted by the auth middleware)', async () => {
			const { request } = superAdminApi();
			const { items } = await expectOk<{ items: AdminUser[] }>(
				await request('GET', '/admin/users'),
			);
			expect(items.map((u) => u.id)).toContain(ACTOR);
			expect(items.find((u) => u.id === ACTOR)?.is_super_admin).toBe(true);
		});

		it('skips a corrupt directory record instead of failing the whole list', async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const { request, deps } = superAdminApi();
				await deps.services.identities.upsert({
					id: uid('usr_ada'),
					email: 'ada@x.io',
					name: 'Ada Lovelace',
				});
				await bucket.put(`${paths.identitiesPrefix}corrupt.json`, '{"not": "an identity"}');

				const { items } = await expectOk<{ items: AdminUser[] }>(
					await request('GET', '/admin/users'),
				);
				expect(items.map((u) => u.id)).toContain(uid('usr_ada'));
			} finally {
				log.mockRestore();
			}
		});

		it('maps a directory-scan failure to a 500 envelope', async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const { request, deps } = superAdminApi();
				vi.spyOn(deps.services.identities, 'list').mockRejectedValue(
					new Error('bucket unavailable'),
				);
				const error = await expectError(
					await request('GET', '/admin/users'),
					500,
					'INTERNAL_ERROR',
				);
				expect(error.message).not.toContain('bucket unavailable');
			} finally {
				log.mockRestore();
			}
		});
	});

	describe('user suspension', () => {
		const target = uid('usr_target');

		async function seedTarget(deps: ReturnType<typeof superAdminApi>['deps']) {
			await deps.services.identities.upsert({
				id: target,
				email: 'target@x.io',
				name: 'Target User',
			});
		}

		it('suspends and reactivates a user and appends audit events', async () => {
			const { request, deps } = superAdminApi();
			await seedTarget(deps);

			const suspended = await expectOk<AdminUser>(
				await request('PUT', `/admin/users/${target}/suspension`),
			);
			expect(suspended.suspended_at).toEqual(expect.any(String));
			expect(await deps.services.identities.isSuspended(target)).toBe(true);

			const active = await expectOk<AdminUser>(
				await request('DELETE', `/admin/users/${target}/suspension`),
			);
			expect(active.suspended_at).toBeNull();
			expect(await deps.services.identities.isSuspended(target)).toBe(false);

			const today = new Date().toISOString().slice(0, 10);
			const events = await deps.services.events.getEvents(today);
			expect(events.map((event) => ({ event: event.event, target: event.target_user_id }))).toEqual(
				expect.arrayContaining([
					{ event: 'user.suspended', target },
					{ event: 'user.unsuspended', target },
				]),
			);
		});

		it('rejects self-suspension', async () => {
			const { request, deps } = superAdminApi();
			await request('GET', '/me');

			const error = await expectError(
				await request('PUT', `/admin/users/${ACTOR}/suspension`),
				403,
				'FORBIDDEN',
			);
			expect(error.message).toContain('own account');
			expect(await deps.services.identities.isSuspended(ACTOR)).toBe(false);
		});

		it('returns 404 for a user absent from the directory', async () => {
			const { request } = superAdminApi();
			await expectError(
				await request('PUT', `/admin/users/${uid('missing')}/suspension`),
				404,
				'NOT_FOUND',
			);
		});
	});

	describe('POST /admin/debug/sandbox-startup', () => {
		const sandboxConfig = {
			bucket: { name: 'test', endpoint: '' },
			hostname: 'localhost',
			workdir: '/workspace',
			persistWorkspace: 'source' as const,
			images: ['registry.example/sandbox:default', 'registry.example/sandbox:py313'],
			computeProfile: 'small',
			resources: { cpu: 1, memoryBytes: 2_147_483_648 },
			computeProfiles: [
				{ name: 'small', resources: { cpu: 1, memoryBytes: 2_147_483_648 } },
				{ name: 'gpu', resources: { cpu: 8, memoryBytes: 34_359_738_368, gpu: 'A100' } },
			],
		};

		function computeFor(instance: SandboxInstance) {
			const create = vi.fn(() => instance);
			const compute: SandboxProvider = { create, proxy: async () => null };
			return { compute, create };
		}

		it('uses the selected image and profile, runs two echoes, reports timings, and destroys', async () => {
			const { instance, calls } = makeFakeSandbox();
			instance.exec = vi
				.fn()
				.mockResolvedValueOnce(execResult(true, 'Hello\n', ''))
				.mockResolvedValueOnce(execResult(true, 'Hello\n', ''));
			instance.drainTimings = vi
				.fn()
				.mockReturnValueOnce({ find: 4, create: 12, boot: 34 })
				.mockReturnValue({});
			instance.drainCounters = vi.fn(() => ({ execs: 2 }));
			const { compute, create } = computeFor(instance);
			const { request, deps } = superAdminApi({ compute, sandbox: sandboxConfig });

			const report = await expectOk<any>(
				await request('POST', '/admin/debug/sandbox-startup', {
					image: 'registry.example/sandbox:py313',
					compute_profile: 'gpu',
				}),
			);

			expect(create).toHaveBeenCalledWith(expect.stringMatching(/^sb-/), {
				reuse: false,
				image: 'registry.example/sandbox:py313',
				resources: { cpu: 8, memoryBytes: 34_359_738_368, gpu: 'A100' },
			});
			expect(instance.exec).toHaveBeenNthCalledWith(1, 'echo "Hello"', { timeout: 120_000 });
			expect(instance.exec).toHaveBeenNthCalledWith(2, 'echo "Hello"', { timeout: 30_000 });
			expect(calls.destroy).toBe(1);
			expect(report).toMatchObject({
				ok: true,
				image: 'registry.example/sandbox:py313',
				compute_profile: 'gpu',
				compute_resources: { cpu: 8, memory_bytes: 34_359_738_368, gpu: 'A100' },
				readiness: { status: 'ok', command: 'echo "Hello"', stdout: 'Hello\n', stderr: '' },
				exec: { status: 'ok', command: 'echo "Hello"', stdout: 'Hello\n', stderr: '' },
				cleanup: { status: 'ok' },
				startup_timings_ms: { find: 4, create: 12, boot: 34 },
				counters: { execs: 2 },
			});
			expect(report.handle.duration_ms).toEqual(expect.any(Number));
			expect(report.total_ms).toEqual(expect.any(Number));
			expect(await deps.services.sessions.countActiveForUser(ACTOR)).toBe(0);
		});

		it('uses deployment defaults when both selections are omitted', async () => {
			const { instance } = makeFakeSandbox();
			const { compute, create } = computeFor(instance);
			const { request } = superAdminApi({ compute, sandbox: sandboxConfig });

			const report = await expectOk<any>(await request('POST', '/admin/debug/sandbox-startup', {}));
			expect(create).toHaveBeenCalledWith(expect.any(String), {
				reuse: false,
				image: 'registry.example/sandbox:default',
				resources: { cpu: 1, memoryBytes: 2_147_483_648 },
			});
			expect(report).toMatchObject({
				image: 'registry.example/sandbox:default',
				compute_profile: 'small',
			});
		});

		it('rejects unknown configured selections before creating a sandbox', async () => {
			const { instance } = makeFakeSandbox();
			const { compute, create } = computeFor(instance);
			const { request } = superAdminApi({ compute, sandbox: sandboxConfig });

			await expectError(
				await request('POST', '/admin/debug/sandbox-startup', { image: 'unknown' }),
				400,
				'BAD_REQUEST',
			);
			await expectError(
				await request('POST', '/admin/debug/sandbox-startup', { compute_profile: 'huge' }),
				400,
				'BAD_REQUEST',
			);
			expect(create).not.toHaveBeenCalled();
		});

		it('returns a partial report and skips the second echo when readiness fails', async () => {
			const { instance } = makeFakeSandbox();
			instance.exec = vi.fn(async () => execResult(false, '', 'shell unavailable', 'SPAWN_FAILED'));
			instance.destroy = vi.fn(async () => {
				throw Object.assign(new Error('destroy failed'), { code: 'BACKEND_UNAVAILABLE' });
			});
			const { compute } = computeFor(instance);
			const { request } = superAdminApi({ compute, sandbox: sandboxConfig });

			const report = await expectOk<any>(await request('POST', '/admin/debug/sandbox-startup', {}));
			expect(instance.exec).toHaveBeenCalledTimes(1);
			expect(instance.destroy).toHaveBeenCalledTimes(1);
			expect(report).toMatchObject({
				ok: false,
				readiness: {
					status: 'failed',
					stderr: 'shell unavailable',
					failure_code: 'SPAWN_FAILED',
				},
				exec: { status: 'skipped', duration_ms: null },
				cleanup: {
					status: 'failed',
					error: { error_name: 'Error', error_code: 'BACKEND_UNAVAILABLE' },
				},
			});
		});

		it('reports a thrown steady-state exec error and still cleans up', async () => {
			const { instance, calls } = makeFakeSandbox();
			instance.exec = vi
				.fn()
				.mockResolvedValueOnce(execResult(true, 'Hello\n', ''))
				.mockRejectedValueOnce(Object.assign(new Error('exec failed'), { code: 'TRANSPORT' }));
			const { compute } = computeFor(instance);
			const { request } = superAdminApi({ compute, sandbox: sandboxConfig });

			const report = await expectOk<any>(await request('POST', '/admin/debug/sandbox-startup', {}));
			expect(calls.destroy).toBe(1);
			expect(report).toMatchObject({
				ok: false,
				readiness: { status: 'ok' },
				exec: {
					status: 'failed',
					error: { error_name: 'Error', error_code: 'TRANSPORT' },
				},
				cleanup: { status: 'ok' },
			});
		});

		it('reports handle creation failures without attempting cleanup', async () => {
			const create = vi.fn(() => {
				throw Object.assign(new Error('create failed'), { code: 'NO_CAPACITY' });
			});
			const compute: SandboxProvider = { create, proxy: async () => null };
			const { request } = superAdminApi({ compute, sandbox: sandboxConfig });

			const report = await expectOk<any>(await request('POST', '/admin/debug/sandbox-startup', {}));
			expect(report).toMatchObject({
				ok: false,
				handle: {
					status: 'failed',
					error: { error_name: 'Error', error_code: 'NO_CAPACITY' },
				},
				readiness: { status: 'skipped' },
				exec: { status: 'skipped' },
				cleanup: { status: 'skipped' },
			});
			expect(await (await bucket.get(paths.sandboxDiagnosticLease(ACTOR)))!.json()).toEqual({
				sandbox_id: null,
				expires_at: null,
			});
		});

		it('uses a shared lease to reject overlap across replicas and releases it afterward', async () => {
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { instance } = makeFakeSandbox();
			instance.exec = vi
				.fn()
				.mockImplementationOnce(async () => {
					await blocked;
					return execResult(true, 'Hello\n', '');
				})
				.mockResolvedValue(execResult(true, 'Hello\n', ''));
			const { compute, create } = computeFor(instance);
			const longStartupConfig = { ...sandboxConfig, startupTimeoutMs: 20 * 60_000 };
			const firstReplica = superAdminApi({ compute, sandbox: longStartupConfig });
			const secondReplica = superAdminApi({ compute, sandbox: longStartupConfig });

			const first = firstReplica.request('POST', '/admin/debug/sandbox-startup', {});
			await vi.waitFor(() => expect(instance.exec).toHaveBeenCalledTimes(1));
			const held = await (await bucket.get(paths.sandboxDiagnosticLease(ACTOR)))!.json<{
				sandbox_id: string;
				expires_at: string;
			}>();
			expect(create).toHaveBeenCalledTimes(1);
			expect(held.sandbox_id).toMatch(/^sb-/);
			expect(Date.parse(held.expires_at) - Date.now()).toBeGreaterThan(20 * 60_000);
			await expectError(
				await secondReplica.request('POST', '/admin/debug/sandbox-startup', {}),
				429,
				'RESOURCE_EXHAUSTED',
			);
			release?.();
			await expectOk(await first);
			expect(await (await bucket.get(paths.sandboxDiagnosticLease(ACTOR)))!.json()).toEqual({
				sandbox_id: null,
				expires_at: null,
			});
			await expectOk(await secondReplica.request('POST', '/admin/debug/sandbox-startup', {}));
		});
	});

	describe('GET /admin/config', () => {
		const configSummary: ConfigSummary = {
			groups: [
				{
					name: 'Auth',
					backend: 'oidc',
					settings: [
						{
							key: 'MARIMOHUB_AUTH_OIDC_ISSUER',
							name: 'OIDC issuer',
							value: 'https://accounts.example.com',
							secret: false,
							set: true,
						},
						{
							key: 'MARIMOHUB_AUTH_OIDC_CLIENT_SECRET',
							name: 'OIDC client secret',
							value: null,
							secret: true,
							set: true,
						},
					],
				},
				{ name: 'Server / API', backend: null, settings: [] },
			],
		};

		it('serves the grouped summary with deployment and policy bits, secrets stay null', async () => {
			const { request } = superAdminApi({
				configSummary,
				policy: { superAdmins: [ACTOR, 'ops@example.com'], defaultRole: 'editor' },
				version: {
					version: 'a1b2c3d',
					image: 'ghcr.io/marimo-team/marimohub:a1b2c3d',
					startedAt: '2026-06-24T12:05:00Z',
					replica: 'marimohub-abc123',
					node: 'v24.3.0',
					backends: { storage: 's3', compute: 'coreweave', auth: 'oidc' },
				},
			});
			const data = await expectOk<any>(await request('GET', '/admin/config'));
			expect(data).toEqual({
				deployment: {
					version: 'a1b2c3d',
					image: 'ghcr.io/marimo-team/marimohub:a1b2c3d',
					sandbox_image: null,
					started_at: '2026-06-24T12:05:00Z',
					replica: 'marimohub-abc123',
					node: 'v24.3.0',
					backends: { storage: 's3', compute: 'coreweave', auth: 'oidc' },
				},
				groups: configSummary.groups,
				policy: { default_role: 'editor', super_admins: [ACTOR, 'ops@example.com'] },
			});
		});

		it('nulls the value of a secret setting even if a summary carried one', async () => {
			const leaky: ConfigSummary = {
				groups: [
					{
						name: 'Auth',
						backend: 'oidc',
						settings: [{ key: 'X', name: 'X', value: 'oops-a-secret', secret: true, set: true }],
					},
				],
			};
			const { request } = superAdminApi({ configSummary: leaky });
			const data = await expectOk<any>(await request('GET', '/admin/config'));
			expect(data.groups[0].settings[0].value).toBeNull();
			expect(JSON.stringify(data)).not.toContain('oops-a-secret');
		});

		it('serves an empty summary when the wiring provides none', async () => {
			const { request } = superAdminApi();
			const data = await expectOk<any>(await request('GET', '/admin/config'));
			expect(data).toEqual({
				deployment: null,
				groups: [],
				policy: { default_role: null, super_admins: [ACTOR] },
			});
		});
	});
});

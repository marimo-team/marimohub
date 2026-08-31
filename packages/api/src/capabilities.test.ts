import { describe, it, expect, vi } from 'vitest';
import { MemoryBucket, uid } from '@marimo-hub/core/testing';
import type { Authenticator } from '@marimo-hub/core';
import { createApi } from './createApi';
import { expectError, expectOk, makeTestDeps, stubSourceControl } from './testing';

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

	it('reports the configured viewer mode and its evaluated admission row, defaulting to static', async () => {
		const defaulted = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(
			await expectOk(await createApi(defaulted).request('/api/v1/capabilities')),
		).toMatchObject({ viewer_mode: 'static', viewer_session_modes: [] });

		const configured = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { viewerMode: 'ephemeral-sandbox' },
		});
		expect(
			await expectOk(await createApi(configured).request('/api/v1/capabilities')),
		).toMatchObject({
			viewer_mode: 'ephemeral-sandbox',
			viewer_session_modes: ['app', 'edit'],
		});

		const apps = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { viewerMode: 'applications' },
		});
		expect(await expectOk(await createApi(apps).request('/api/v1/capabilities'))).toMatchObject({
			viewer_mode: 'applications',
			viewer_session_modes: ['app'],
		});
	});

	it('reports the configured default role, null when members-only', async () => {
		const membersOnly = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(
			await expectOk(await createApi(membersOnly).request('/api/v1/capabilities')),
		).toMatchObject({ default_role: null });

		const open = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { defaultRole: 'editor' },
		});
		expect(await expectOk(await createApi(open).request('/api/v1/capabilities'))).toMatchObject({
			default_role: 'editor',
		});
	});

	it('reports configured source-control publisher and reader providers', async () => {
		const none = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(await expectOk(await createApi(none).request('/api/v1/capabilities'))).toMatchObject({
			source_control: {
				change_request_providers: [],
				sync_providers: [],
				pull_source_providers: [],
			},
		});

		const configured = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			sourceControl: stubSourceControl({
				publisher: { provider: 'github', openChangeRequest: vi.fn() },
				reader: {
					provider: 'github',
					supportsRepository: () => true,
					getBranchHead: vi.fn(),
					fetchWorkspace: vi.fn(),
					fetchGitDirectory: vi.fn(),
				},
			}),
		});
		expect(
			await expectOk(await createApi(configured).request('/api/v1/capabilities')),
		).toMatchObject({
			source_control: {
				change_request_providers: ['github'],
				sync_providers: ['github'],
				pull_source_providers: ['github'],
			},
		});
	});

	it('reports the role derived from the current OIDC session', async () => {
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: uid('group-user'),
				email: 'group-user@example.com',
				entitlements: ['default-role:editor'],
			}),
		};
		const deps = makeTestDeps(new MemoryBucket(), { authenticator });

		expect(await expectOk(await createApi(deps).request('/api/v1/capabilities'))).toMatchObject({
			default_role: 'editor',
		});
	});

	it('reports a group-derived manager without treating them as a super admin', async () => {
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: uid('group-manager'),
				email: 'group-manager@example.com',
				entitlements: ['default-role:manager'],
			}),
		};
		const deps = makeTestDeps(new MemoryBucket(), { authenticator });
		const app = createApi(deps);

		expect(await expectOk(await app.request('/api/v1/capabilities'))).toMatchObject({
			default_role: 'manager',
		});
		expect(await expectOk(await app.request('/api/v1/me'))).toMatchObject({
			is_super_admin: false,
		});
	});

	it('reports the editor sandbox sharing, defaulting to shared', async () => {
		const defaulted = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(
			await expectOk(await createApi(defaulted).request('/api/v1/capabilities')),
		).toMatchObject({ editor_sandbox_sharing: 'shared' });
		const exclusive = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { editorSandboxSharing: 'exclusive' },
		});
		expect(
			await expectOk(await createApi(exclusive).request('/api/v1/capabilities')),
		).toMatchObject({ editor_sandbox_sharing: 'exclusive' });
	});

	it('advertises the brokered SSH transport and persistence policy', async () => {
		const disabled = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(await expectOk(await createApi(disabled).request('/api/v1/capabilities'))).toMatchObject(
			{
				remote_development: {
					ssh: { available: false, transport: null, persistence: null },
				},
			},
		);
		const enabled = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		enabled.sandbox.remoteDevelopment = { mode: 'ssh', images: ['image'], port: 2222 };
		enabled.sandbox.persistWorkspace = 'workspace';
		expect(await expectOk(await createApi(enabled).request('/api/v1/capabilities'))).toMatchObject({
			remote_development: {
				ssh: { available: true, transport: 'websocket', persistence: 'workspace' },
			},
		});
	});

	it('reports deployment limits', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			authenticator: authed,
			policy: { maxConcurrentSessionsPerUser: 3, maxAppsPerProject: 5 },
		});
		const data = await expectOk<{ limits: Record<string, number | null> }>(
			await createApi(deps).request('/api/v1/capabilities'),
		);
		expect(data.limits).toEqual({
			max_concurrent_sessions_per_user: 3,
			max_apps_per_project: 5,
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

	it('reports the configured sandbox images, empty when none', async () => {
		const none = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(await expectOk(await createApi(none).request('/api/v1/capabilities'))).toMatchObject({
			sandbox_images: [],
		});

		const configured = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		configured.sandbox.images = ['img-a', 'img-b'];
		expect(
			await expectOk(await createApi(configured).request('/api/v1/capabilities')),
		).toMatchObject({ sandbox_images: ['img-a', 'img-b'] });
	});

	it('reports compute profiles and the editor override policy', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		deps.sandbox.computeProfiles = [
			{ name: 'small', resources: { cpu: 1, memoryBytes: 2 * 1024 ** 3 } },
			{ name: 'large', resources: { cpu: 8, gpu: 'A100:2' } },
		];
		deps.sandbox.computeProfileOverride = 'editors';

		expect(await expectOk(await createApi(deps).request('/api/v1/capabilities'))).toMatchObject({
			compute_profiles: [
				{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
				{ name: 'large', cpu: 8, gpu: 'A100:2' },
			],
			compute_profile_override: 'editors',
		});
	});

	it('defaults compute profile capabilities to no profiles and no overrides', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { authenticator: authed });
		expect(await expectOk(await createApi(deps).request('/api/v1/capabilities'))).toMatchObject({
			compute_profiles: [],
			compute_profile_override: 'none',
		});
	});

	it('requires authentication (not a public endpoint)', async () => {
		const deps = makeTestDeps(new MemoryBucket(), { wif: stubWif });
		const res = await createApi(deps).request('/api/v1/capabilities');
		await expectError(res, 401, 'UNAUTHORIZED');
	});
});

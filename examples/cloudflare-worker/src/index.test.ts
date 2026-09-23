import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

vi.mock('@marimo-hub/compute-cloudflare', () => ({
	CloudflareSandboxProvider: class CloudflareSandboxProvider {
		constructor(
			readonly binding: unknown,
			readonly options: unknown,
		) {}
		async proxy() {
			return null;
		}
	},
	ContainerProxy: class ContainerProxy {},
	Sandbox: class Sandbox {},
}));

vi.mock('@marimo-hub/storage-r2', () => ({
	R2BucketAdapter: function R2BucketAdapter(binding: unknown) {
		return binding;
	},
}));

import { MaintenanceLock } from '@marimo-hub/core';
import { ASSIGNABLE_ROLES } from '@marimo-hub/core/constants';
import type { AssignableRole } from '@marimo-hub/core/constants';
import { JobScheduler } from '@marimo-hub/core/jobs';
import { MemoryBucket } from '@marimo-hub/core/testing';
import worker, { buildDeps } from './index';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Cloudflare Worker configuration', () => {
	it('supports disabling automatic thumbnails while keeping uploads available', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			AUTH_MODE: 'dev',
			NOTEBOOKS_BUCKET: {},
			SANDBOX: {},
			MARIMOHUB_AUTOMATIC_THUMBNAILS: 'false',
		} as unknown as Env);
		expect(deps.sandbox.automaticThumbnails).toBe(false);
		expect(deps.services.notebooks.thumbnails).toBeDefined();
	});

	it('hides configured profiles while warning that Cloudflare ignores them', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const deps = buildDeps(new Request('https://hub.example.com'), {
			AUTH_MODE: 'dev',
			USER_ID: 'user-test',
			USER_EMAIL: 'test@example.com',
			NOTEBOOKS_BUCKET: {},
			SANDBOX: {},
			MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1;mem=2Gi,large:cpu=4;mem=8Gi',
		} as unknown as Env);

		expect(deps.sandbox.computeProfile).toBeUndefined();
		expect(deps.sandbox.computeProfiles).toEqual([]);
		expect(deps.sandbox.computeProfileOverride).toBe('none');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('profiles are ignored'));
	});

	const baseEnv = {
		AUTH_MODE: 'dev',
		USER_ID: 'user-test',
		USER_EMAIL: 'test@example.com',
		NOTEBOOKS_BUCKET: {},
		SANDBOX: {},
	};

	it('wires public deployment branding', async () => {
		const response = await worker.fetch(
			new Request('https://hub.example.com/api/v1/theme'),
			{
				...baseEnv,
				MARIMOHUB_THEME_NAME: 'Research Hub',
				MARIMOHUB_THEME_PRIMARY_COLOR: '#2563eb',
			} as Env,
			{ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			data: { name: 'Research Hub', primary_color: '#2563eb' },
		});
	});

	it('serves installation branding through the shared backend', async () => {
		const env = {
			...baseEnv,
			MARIMOHUB_THEME_NAME: 'Research Hub',
			MARIMOHUB_THEME_PRIMARY_COLOR: '#2563eb',
			MARIMOHUB_THEME_PWA_ICON_192: '/brand/192.png',
			MARIMOHUB_THEME_APPLE_TOUCH_ICON: '/brand/apple.png',
		} as Env;
		const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} };
		const response = await worker.fetch(
			new Request('https://hub.example.com/manifest.webmanifest'),
			env,
			ctx,
		);
		expect(response.headers.get('content-type')).toBe('application/manifest+json');
		expect(await response.json()).toMatchObject({
			name: 'Research Hub',
			theme_color: '#2563eb',
			icons: [{ src: '/brand/192.png' }, { src: '/icons/icon-512.png' }],
		});
		const icon = await worker.fetch(
			new Request('https://hub.example.com/apple-touch-icon.png'),
			env,
			ctx,
		);
		expect(icon.status).toBe(302);
		expect(icon.headers.get('location')).toBe('/brand/apple.png');
	});

	it.each([
		{ MARIMOHUB_THEME_PRIMARY_COLOR: 'rgb(1,2,3)' },
		{ MARIMOHUB_THEME_LOGO_DARK: 'javascript:alert(1)' },
	])('rejects invalid theme configuration at the Worker request boundary: %j', async (theme) => {
		const response = await worker.fetch(
			new Request('https://hub.example.com/api/v1/theme'),
			{ ...baseEnv, ...theme } as Env,
			{ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} },
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			success: false,
			error: {
				code: 'CONFIG_ERROR',
				message: expect.stringContaining(Object.keys(theme)[0]),
			},
		});
	});

	it.each([
		[undefined, 'off'],
		['', 'off'],
		[' \t\n', 'off'],
		['off', 'off'],
		[' OFF ', 'off'],
		['on', 'on'],
		[' ON ', 'on'],
	])('parses sandbox authentication %j as %s', (raw, expected) => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			...baseEnv,
			MARIMOHUB_SANDBOX_AUTH: raw,
		} as unknown as Env);
		expect(deps.sandbox.auth).toBe(expected);
	});

	it.each(['true', 'false', 'none', 'partitioned'])(
		'rejects invalid sandbox authentication %s at the request boundary',
		async (raw) => {
			const response = await worker.fetch(
				new Request('https://hub.example.com/api/v1/capabilities'),
				{ ...baseEnv, MARIMOHUB_SANDBOX_AUTH: raw } as unknown as Env,
				{ waitUntil: vi.fn() } as unknown as ExecutionContext,
			);
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({
				success: false,
				error: {
					code: 'CONFIG_ERROR',
					message: `Invalid MARIMOHUB_SANDBOX_AUTH: ${raw} (expected on, off)`,
				},
			});
		},
	);

	it('parses MARIMOHUB_SUPER_ADMINS into a trimmed list, dropping empties', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			...baseEnv,
			MARIMOHUB_SUPER_ADMINS: 'admin@example.com, user-1 ,',
		} as unknown as Env);
		expect(deps.policy.superAdmins).toEqual(['admin@example.com', 'user-1']);
	});

	it('leaves superAdmins undefined when MARIMOHUB_SUPER_ADMINS is unset', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), baseEnv as unknown as Env);
		expect(deps.policy.superAdmins).toBeUndefined();
	});

	it('adapts request background tasks to the Workers execution context', () => {
		const waitUntil = vi.fn();
		const deps = buildDeps(new Request('https://hub.example.com'), baseEnv as unknown as Env, {
			waitUntil,
		});
		const task = Promise.resolve();

		deps.backgroundTasks?.defer(task);

		expect(waitUntil).toHaveBeenCalledWith(task);
	});

	it('defaults and canonicalizes editor sandbox sharing', () => {
		expect(
			buildDeps(new Request('https://hub.example.com'), baseEnv as unknown as Env).policy
				.editorSandboxSharing,
		).toBe('shared');
		expect(
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				MARIMOHUB_EDITOR_SANDBOX_SHARING: ' EXCLUSIVE ',
			} as unknown as Env).policy.editorSandboxSharing,
		).toBe('exclusive');
	});

	it('keeps notebook jobs off unless MARIMOHUB_JOBS=on, and rejects other values', () => {
		const at = (env: Record<string, unknown>) =>
			buildDeps(new Request('https://hub.example.com'), env as unknown as Env).jobs;
		expect(at(baseEnv)).toBeUndefined();
		expect(at({ ...baseEnv, MARIMOHUB_JOBS: 'off' })).toBeUndefined();
		expect(at({ ...baseEnv, MARIMOHUB_JOBS: ' ON ' })).toBeDefined();
		expect(() => at({ ...baseEnv, MARIMOHUB_JOBS: 'yes' })).toThrow(
			'Unknown MARIMOHUB_JOBS: yes (supported: on, off).',
		);
	});

	it('rejects an invalid editor sandbox sharing value', () => {
		expect(() =>
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				MARIMOHUB_EDITOR_SANDBOX_SHARING: 'per-user',
			} as unknown as Env),
		).toThrow('Invalid MARIMOHUB_EDITOR_SANDBOX_SHARING: per-user (expected shared, exclusive)');
	});

	it('keeps default-role environment types aligned with assignable roles', () => {
		expectTypeOf<Env['DEFAULT_ROLE']>().toEqualTypeOf<AssignableRole | 'none' | undefined>();
	});

	it.each([...ASSIGNABLE_ROLES, 'none'] as const)('accepts typed default role %s', (role) => {
		const env: Env = {
			AUTH_MODE: 'dev',
			USER_ID: 'user-test',
			USER_EMAIL: 'test@example.com',
			NOTEBOOKS_BUCKET: new MemoryBucket() as never,
			SANDBOX: {} as never,
			DEFAULT_ROLE: role,
		};
		expect(buildDeps(new Request('https://hub.example.com'), env).policy.defaultRole).toBe(
			role === 'none' ? undefined : role,
		);
	});

	it.each(['admin', 'owner', 'app', 'app_user', 'unknown'])(
		'rejects unsupported default role %s',
		(role) => {
			expect(() =>
				buildDeps(new Request('https://hub.example.com'), {
					...baseEnv,
					DEFAULT_ROLE: role,
				} as unknown as Env),
			).toThrow(`Invalid DEFAULT_ROLE: ${role} (expected ${ASSIGNABLE_ROLES.join(', ')}, none)`);
		},
	);
});

describe('Cloudflare Worker scheduled handler', () => {
	const controller: ScheduledController = {
		scheduledTime: 0,
		cron: '*/5 * * * *',
		noRetry() {},
	};
	const executionContext = (waitUntil = vi.fn()): ExecutionContext => ({
		waitUntil,
		passThroughOnException() {},
		props: undefined,
	});
	const scheduledEnv = (): Env => ({
		AUTH_MODE: 'dev',
		USER_ID: 'user-test',
		USER_EMAIL: 'test@example.com',
		NOTEBOOKS_BUCKET: new MemoryBucket() as never,
		SANDBOX: {} as never,
		MARIMOHUB_JOBS: 'on',
	});

	it('runs the job scheduler when the maintenance lease is unavailable', async () => {
		vi.spyOn(MaintenanceLock.prototype, 'acquire')
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		vi.spyOn(MaintenanceLock.prototype, 'release').mockResolvedValue(undefined);
		const tick = vi.spyOn(JobScheduler.prototype, 'tick').mockResolvedValue({
			fired: 0,
			repaired: 0,
			skipped: 0,
			dispatched: 0,
			timedOut: 0,
			markersPruned: 0,
			errors: 0,
		});
		vi.spyOn(JobScheduler.prototype, 'prune').mockResolvedValue({
			runsPruned: 0,
			markersPruned: 0,
		});
		vi.spyOn(JobScheduler.prototype, 'drain').mockResolvedValue(undefined);

		await worker.scheduled(controller, scheduledEnv(), executionContext());

		expect(tick).toHaveBeenCalledOnce();
	});

	it('registers the execution drain before pruning', async () => {
		vi.spyOn(MaintenanceLock.prototype, 'acquire')
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		vi.spyOn(MaintenanceLock.prototype, 'release').mockResolvedValue(undefined);
		vi.spyOn(JobScheduler.prototype, 'tick').mockResolvedValue({
			fired: 0,
			repaired: 0,
			skipped: 0,
			dispatched: 1,
			timedOut: 0,
			markersPruned: 0,
			errors: 0,
		});
		const drainPromise = Promise.resolve();
		vi.spyOn(JobScheduler.prototype, 'drain').mockReturnValue(drainPromise);
		vi.spyOn(JobScheduler.prototype, 'prune').mockRejectedValue(new Error('prune failed'));
		const waitUntil = vi.fn();

		await expect(
			worker.scheduled(controller, scheduledEnv(), executionContext(waitUntil)),
		).rejects.toThrow('prune failed');

		expect(waitUntil).toHaveBeenCalledWith(drainPromise);
	});
});

describe('Cloudflare Worker sandbox-host isolation guard', () => {
	const baseEnv = {
		AUTH_MODE: 'dev',
		USER_ID: 'user-test',
		USER_EMAIL: 'test@example.com',
		NOTEBOOKS_BUCKET: {},
		SANDBOX: {},
	};

	it.each(['sandboxes.example.net', 'sandboxes.example.com'])(
		'allows sandbox hostname %s',
		(hostname) => {
			expect(() =>
				buildDeps(new Request('https://hub.example.com/'), {
					...baseEnv,
					SANDBOX_HOSTNAME: hostname,
				} as unknown as Env),
			).not.toThrow();
		},
	);

	it('rejects a sandbox hostname that differs from the app host only in case', () => {
		expect(() =>
			buildDeps(new Request('https://hub.example.com/'), {
				...baseEnv,
				SANDBOX_HOSTNAME: 'Hub.Example.Com',
			} as unknown as Env),
		).toThrow(/shares an origin/);
	});

	it('rejects a sandbox hostname that differs from the app host only by whitespace', () => {
		expect(() =>
			buildDeps(new Request('https://hub.example.com/'), {
				...baseEnv,
				SANDBOX_HOSTNAME: ' hub.example.com ',
			} as unknown as Env),
		).toThrow(/shares an origin/);
	});
});

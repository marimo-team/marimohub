import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@marimo-hub/compute-cloudflare', () => ({
	CloudflareSandboxProvider: class CloudflareSandboxProvider {
		constructor(
			readonly binding: unknown,
			readonly options: unknown,
		) {}
	},
	ContainerProxy: class ContainerProxy {},
	Sandbox: class Sandbox {},
}));

vi.mock('@marimo-hub/storage-r2', () => ({
	R2BucketAdapter: function R2BucketAdapter(binding: unknown) {
		return binding;
	},
}));

import { JobScheduler, MaintenanceLock } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import worker, { buildDeps } from './index';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Cloudflare Worker configuration', () => {
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

	it('accepts assignable default roles and rejects reserved admin', () => {
		expect(
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				DEFAULT_ROLE: 'manager',
			} as unknown as Env).policy.defaultRole,
		).toBe('manager');
		expect(() =>
			buildDeps(new Request('https://hub.example.com'), {
				...baseEnv,
				DEFAULT_ROLE: 'admin',
			} as unknown as Env),
		).toThrow('Invalid DEFAULT_ROLE: admin (expected manager, editor, viewer, none)');
	});
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

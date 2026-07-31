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

import { buildDeps } from './index';

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

	it('parses SUPER_ADMINS into a trimmed list, dropping empties', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), {
			...baseEnv,
			SUPER_ADMINS: 'admin@example.com, user-1 ,',
		} as unknown as Env);
		expect(deps.policy.superAdmins).toEqual(['admin@example.com', 'user-1']);
	});

	it('leaves superAdmins undefined when SUPER_ADMINS is unset', () => {
		const deps = buildDeps(new Request('https://hub.example.com'), baseEnv as unknown as Env);
		expect(deps.policy.superAdmins).toBeUndefined();
	});
});

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
	it('persists the configured default profile name while warning that resources are ignored', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const deps = buildDeps(new Request('https://hub.example.com'), {
			AUTH_MODE: 'dev',
			USER_ID: 'user-test',
			USER_EMAIL: 'test@example.com',
			NOTEBOOKS_BUCKET: {},
			SANDBOX: {},
			MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1;mem=2Gi,large:cpu=4;mem=8Gi',
		} as unknown as Env);

		expect(deps.sandbox.computeProfile).toBe('small');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('profiles are ignored'));
	});
});

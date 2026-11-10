import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Transform entrypoint dependencies before the per-test timeout starts.
import '@marimo-hub/config';
import '@marimo-hub/core';

const adapter = (name: string) =>
	fileURLToPath(new URL(`../../../packages/config/src/testdata/adapters/${name}`, import.meta.url));

beforeEach(() => {
	vi.resetModules();
	vi.stubEnv('MARIMOHUB_STORAGE_BACKEND', 'library');
	vi.stubEnv('MARIMOHUB_COMPUTE_BACKEND', 'local');
	vi.stubEnv('MARIMOHUB_AUTH_BACKEND', 'dev');
	vi.stubEnv('MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND', undefined);
	vi.stubEnv('MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND', undefined);
	vi.stubEnv('MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER', undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('session index backfill command', () => {
	it.each(['valid-storage.mjs', 'async-storage.mjs'])(
		'loads the %s library before constructing storage',
		async (name) => {
			vi.stubEnv('MARIMOHUB_STORAGE_LIBRARY', adapter(name));
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			await import('./session-index-rebuild');
			expect(log).toHaveBeenCalledWith('Session index rebuilt.');
		},
	);

	it.each([
		{ name: undefined, error: /MARIMOHUB_STORAGE_LIBRARY/ },
		{ name: 'throwing-factory.mjs', error: /failed to initialize/ },
		{ name: 'missing-method.mjs', error: /missing required Bucket method/ },
	])('rejects invalid library $name without reporting success', async ({ name, error }) => {
		vi.stubEnv('MARIMOHUB_STORAGE_LIBRARY', name ? adapter(name) : undefined);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await expect(import('./session-index-rebuild')).rejects.toThrow(error);
		expect(log).not.toHaveBeenCalled();
	});
});

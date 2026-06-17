import { describe, it, expect } from 'vitest';
import { createFromEnv } from './index';

/**
 * Composition-root selector tests. `createFromEnv` accepts an env object, so we
 * pass fake envs without touching `process.env`. The focus here is the
 * fail-closed behavior of the auth-backend selector (an unset backend must refuse
 * to boot rather than silently enabling the dev bypass).
 */
describe('createFromEnv auth backend selection', () => {
	// Storage `memory` + compute `none` keep these tests free of S3/Modal config.
	// `memory` is non-durable, so it must be explicitly allowed.
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
	};

	it('throws when MARIMOHUB_AUTH_BACKEND is unset (fail closed)', () => {
		expect(() => createFromEnv({ ...baseEnv })).toThrow(/MARIMOHUB_AUTH_BACKEND/);
	});

	it('throws when MARIMOHUB_AUTH_BACKEND is empty (fail closed)', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_AUTH_BACKEND: '' })).toThrow(
			/MARIMOHUB_AUTH_BACKEND/,
		);
	});

	it('accepts an explicit dev backend and authenticates a fixed user', async () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_AUTH_DEV_USER_ID: 'alice',
			MARIMOHUB_AUTH_DEV_EMAIL: 'alice@example.com',
		});
		const user = await deps.authenticator.authenticate(new Request('http://x'));
		expect(user).toEqual({ id: 'alice', email: 'alice@example.com' });
	});

	it('throws on an unknown backend', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_AUTH_BACKEND: 'bogus' })).toThrow(
			/Unknown MARIMOHUB_AUTH_BACKEND/,
		);
	});
});

describe('createFromEnv storage selection', () => {
	it('throws when a required storage var is missing', () => {
		// s3 backend without MARIMOHUB_STORAGE_S3_BUCKET must fail closed.
		expect(() =>
			createFromEnv({
				MARIMOHUB_STORAGE_BACKEND: 's3',
				MARIMOHUB_COMPUTE_BACKEND: 'none',
				MARIMOHUB_AUTH_BACKEND: 'dev',
			}),
		).toThrow(/Missing required env var/);
	});

	it('refuses the non-durable memory backend unless explicitly allowed (fail closed)', () => {
		expect(() =>
			createFromEnv({
				MARIMOHUB_STORAGE_BACKEND: 'memory',
				MARIMOHUB_COMPUTE_BACKEND: 'none',
				MARIMOHUB_AUTH_BACKEND: 'dev',
			}),
		).toThrow(/MARIMOHUB_ALLOW_EPHEMERAL_STORAGE/);
	});

	it('accepts the memory backend when explicitly allowed', () => {
		const deps = createFromEnv({
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			MARIMOHUB_COMPUTE_BACKEND: 'none',
			MARIMOHUB_AUTH_BACKEND: 'dev',
		});
		expect(deps.bucket).toBeDefined();
	});
});

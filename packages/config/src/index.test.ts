import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { BadRequestError, createProjectId, createSessionId } from '@marimo-hub/core';
import type { ProxyExposure, SandboxProvider } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createFromEnv, createFromEnvAsync } from './index';

const validStorageFixture = fileURLToPath(
	new URL('./testdata/adapters/valid-storage.mjs', import.meta.url),
);

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
			MARIMOHUB_AUTH_DEV_NAME: 'Alice Example',
		});
		const user = await deps.authenticator.authenticate(new Request('http://x'));
		expect(user).toEqual({ id: 'alice', email: 'alice@example.com', name: 'Alice Example' });
	});

	it('parses compute profiles during boot and rejects typos', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_PROFILES: 'small:cpus=1',
			}),
		).toThrow(/unknown key.*"small"/);
	});

	it('wires the first compute profile into sandbox configuration', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_COMPUTE_BACKEND: 'docker',
			MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=0.5;mem=512Mi,large:cpu=4;mem=8Gi',
		});
		expect(deps.sandbox.resources).toEqual({
			cpu: 0.5,
			memoryBytes: 512 * 1024 ** 2,
		});
		expect(deps.sandbox.computeProfile).toBe('small');
		expect(deps.sandbox.computeProfiles).toEqual([
			{ name: 'small', resources: { cpu: 0.5, memoryBytes: 512 * 1024 ** 2 } },
			{ name: 'large', resources: { cpu: 4, memoryBytes: 8 * 1024 ** 3 } },
		]);
		expect(deps.sandbox.computeProfileOverride).toBe('none');
	});

	it('wires GPU profiles through for Modal', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_COMPUTE_BACKEND: 'modal',
			MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/acme/marimo:latest',
			MARIMOHUB_COMPUTE_MODAL_TOKEN_ID: 'token-id',
			MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET: 'token-secret',
			MARIMOHUB_COMPUTE_PROFILES: 'gpu:cpu=8;mem=32Gi;gpu=A100:2',
		});
		expect(deps.sandbox.resources).toEqual({
			cpu: 8,
			memoryBytes: 32 * 1024 ** 3,
			gpu: 'A100:2',
		});
		expect(deps.sandbox.computeProfiles).toEqual([
			{
				name: 'gpu',
				resources: { cpu: 8, memoryBytes: 32 * 1024 ** 3, gpu: 'A100:2' },
			},
		]);
	});

	it('wires a preview service in full mode regardless of the compute backend', () => {
		const env = {
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
			MARIMOHUB_DATA_PREVIEW_IMAGE: 'preview-image',
		};
		// Sandbox previews stay unavailable on backends without image overrides,
		// but the always-on DuckDB-Wasm executor still serves compatible previews.
		const local = createFromEnv({ ...env, MARIMOHUB_COMPUTE_BACKEND: 'local' }).dataBrowser;
		expect(local).toMatchObject({ preview: true });
		expect(local?.checkPreview).toBeTypeOf('function');

		const preview = createFromEnv({
			...env,
			MARIMOHUB_COMPUTE_BACKEND: 'docker',
		}).dataBrowser;
		expect(preview?.checkPreview).toBeTypeOf('function');
		expect(preview?.close).toBeTypeOf('function');
	});

	it('registers DuckDB-Wasm previews by default in full mode', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
		});
		expect(deps.dataBrowser).toMatchObject({ preview: true });
		expect(deps.dataBrowser?.checkPreview).toBeTypeOf('function');
		expect(deps.dataBrowser?.close).toBeTypeOf('function');
	});

	it('validates the integrations feature gate before its probe policy', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_DATA_BROWSER: 'full',
				MARIMOHUB_INTEGRATIONS: 'off',
				MARIMOHUB_INTEGRATIONS_PROBE: 'bogus',
			}),
		).toThrow(/MARIMOHUB_DATA_BROWSER requires integrations to be enabled/);
	});

	it('wires Run SQL whenever full data-browser mode is enabled', async () => {
		const env = {
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
		};
		expect(createFromEnv({ ...env, MARIMOHUB_DATA_BROWSER: 'full' }).dataBrowser?.query).toBe(true);
		expect(
			createFromEnv({
				...env,
				MARIMOHUB_DATA_BROWSER: 'metadata',
			}).dataBrowser?.query,
		).toBe(false);

		const deps = createFromEnv({
			...env,
			MARIMOHUB_DATA_BROWSER: 'full',
			MARIMOHUB_DATA_QUERY_MEMORY_LIMIT_MB: '96',
			MARIMOHUB_DATA_QUERY_MAX_ROWS: '321',
		});
		expect(deps.dataBrowser?.query).toBe(true);
		expect(deps.dataBrowser?.close).toBeTypeOf('function');
		const stores = deps.integrations as unknown as {
			store: { dataQuery: { options: { maxRows: number; executorFactories: unknown } } };
		};
		expect(stores.store.dataQuery.options).toMatchObject({
			maxRows: 321,
			executorFactories: expect.objectContaining({ 'duckdb-wasm': expect.any(Object) }),
		});
		const pid = createProjectId();
		const integration = await deps.integrations!.create(
			pid,
			{ kind: 'custom_env', name: 'query-source', config: { vars: { SOURCE: 'test' } } },
			ACTOR,
		);
		await expect(
			deps.integrations!.runDataQuery(
				pid,
				integration.id,
				{ userId: ACTOR, email: 'actor@example.com' },
				createSessionId(),
				'select 1 as value',
			),
		).rejects.toThrow(/does not support SQL queries/);
		await deps.dataBrowser?.close?.();
	});

	it('reports DuckDB OAuth2 and S3 object queries ready with no rollout gates', () => {
		const env = {
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
		};
		const s3Config = {
			endpoint_url: 'https://objects.example.test',
			path_style: true,
			auth: { method: 'anonymous' },
			broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
		};
		const oauthConfig = {
			uri: 'https://catalog.example.test',
			auth: {
				method: 'oauth2_client_credentials',
				token_endpoint: 'https://identity.example.test/token',
				client_id: 'client',
				client_secret: 'secret',
				scope: 'catalog',
			},
			storage: {
				scheme: 's3',
				endpoint: 'https://objects.example.test',
				anonymous: true,
				broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
			},
			access_delegation: 'none',
		};

		const wired = createFromEnv(env).integrations!;
		expect(wired.queryReadiness({ kind: 's3', config: s3Config }).every(({ ready }) => ready)).toBe(
			true,
		);
		expect(
			wired
				.queryReadiness({ kind: 'iceberg_rest', config: oauthConfig })
				.every(({ ready }) => ready),
		).toBe(true);
	});

	it('always enables remote DuckDB database queries', () => {
		const env = {
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
		};
		const config = {
			url: 'https://data.example.test/snapshots/analytics.duckdb',
			auth: { method: 'none' },
		};

		expect(
			createFromEnv(env)
				.integrations!.queryReadiness({ kind: 'duckdb_http', config })
				.every(({ ready }) => ready),
		).toBe(true);
	});

	it('wires DuckDB-Wasm pool and idle lifecycle settings', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
			MARIMOHUB_DATA_PREVIEW_MAX_CONCURRENT: '3',
			MARIMOHUB_DATA_PREVIEW_EMBEDDED_MEMORY_LIMIT_MB: '96',
			MARIMOHUB_DATA_PREVIEW_EMBEDDED_IDLE_TIMEOUT_SECONDS: '17',
		});
		const stores = deps.integrations as unknown as {
			store: {
				dataPreview: {
					options: {
						duckdbWasm: {
							options: { maxPoolSize: number; memoryLimitMb: number; idleTimeoutMs: number };
						};
					};
				};
			};
		};

		expect(stores.store.dataPreview.options.duckdbWasm.options).toMatchObject({
			maxPoolSize: 3,
			memoryLimitMb: 96,
			idleTimeoutMs: 17_000,
		});
	});

	it('honors legacy DuckDB-Wasm settings with deprecation warnings', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const deps = createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_DATA_BROWSER: 'full',
				MARIMOHUB_DUCKDB_WASM_MEMORY_LIMIT_MB: '72',
				MARIMOHUB_DUCKDB_WASM_IDLE_TIMEOUT_SECONDS: '19',
				MARIMOHUB_DUCKDB_WASM_RUNTIME: 'inline',
			});
			const stores = deps.integrations as unknown as {
				store: {
					dataPreview: {
						options: {
							duckdbWasm: { options: { memoryLimitMb: number; idleTimeoutMs: number } };
						};
					};
				};
			};

			expect(stores.store.dataPreview.options.duckdbWasm.options).toMatchObject({
				memoryLimitMb: 72,
				idleTimeoutMs: 19_000,
			});
			const warnings = warn.mock.calls.map(([message]) => String(message)).join('\n');
			expect(warnings).toMatch(/MARIMOHUB_DUCKDB_WASM_MEMORY_LIMIT_MB/);
			expect(warnings).toMatch(/MARIMOHUB_DUCKDB_WASM_IDLE_TIMEOUT_SECONDS/);
			expect(warnings).toMatch(/MARIMOHUB_DUCKDB_WASM_RUNTIME/);
		} finally {
			warn.mockRestore();
		}
	});

	it('prefers renamed DuckDB-Wasm settings over legacy values', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
			MARIMOHUB_DATA_PREVIEW_EMBEDDED_MEMORY_LIMIT_MB: '96',
			MARIMOHUB_DUCKDB_WASM_MEMORY_LIMIT_MB: '72',
		});
		const stores = deps.integrations as unknown as {
			store: { dataPreview: { options: { duckdbWasm: { options: { memoryLimitMb: number } } } } };
		};

		expect(stores.store.dataPreview.options.duckdbWasm.options.memoryLimitMb).toBe(96);
	});

	it('rejects the non-preemptible inline embedded preview runtime', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_DATA_BROWSER: 'full',
				MARIMOHUB_DATA_PREVIEW_EMBEDDED_RUNTIME: 'inline',
			}),
		).toThrow(/MARIMOHUB_DATA_PREVIEW_EMBEDDED_RUNTIME/);
	});

	it('accepts zero and rejects invalid embedded preview idle timeouts', () => {
		const env = {
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
		};
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_DATA_PREVIEW_EMBEDDED_IDLE_TIMEOUT_SECONDS: '0' }),
		).not.toThrow();
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_DATA_PREVIEW_EMBEDDED_IDLE_TIMEOUT_SECONDS: '-1' }),
		).toThrow(/MARIMOHUB_DATA_PREVIEW_EMBEDDED_IDLE_TIMEOUT_SECONDS/);
	});

	it('rejects invalid sandbox-preview limits during composition', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_BACKEND: 'docker',
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_DATA_BROWSER: 'full',
				MARIMOHUB_DATA_PREVIEW_IMAGE: 'preview-image',
				MARIMOHUB_DATA_PREVIEW_MAX_CONCURRENT: '0',
			}),
		).toThrow(/MARIMOHUB_DATA_PREVIEW_MAX_CONCURRENT/);
	});

	it('rejects unsafe query limits and timer-overflowing timeouts', () => {
		const env = {
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_DATA_BROWSER: 'full',
		};
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_DATA_QUERY_MAX_ROWS: '9007199254740992' }),
		).toThrow(/MARIMOHUB_DATA_QUERY_MAX_ROWS/);
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_DATA_QUERY_TIMEOUT_SECONDS: '2147484' }),
		).toThrow(/MARIMOHUB_DATA_QUERY_TIMEOUT_SECONDS/);
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_DATA_QUERY_TIMEOUT_SECONDS: '2147483' }),
		).not.toThrow();
	});

	it('enables editor profile overrides explicitly', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_COMPUTE_BACKEND: 'docker',
			MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1,large:cpu=4',
			MARIMOHUB_COMPUTE_PROFILE_OVERRIDE: 'editors',
		});
		expect(deps.sandbox.computeProfileOverride).toBe('editors');
	});

	it('parses the sandbox startup timeout into ms, defaulting to unset (core default)', () => {
		const devEnv = { ...baseEnv, MARIMOHUB_AUTH_BACKEND: 'dev' };
		expect(createFromEnv({ ...devEnv }).sandbox.startupTimeoutMs).toBeUndefined();
		expect(
			createFromEnv({ ...devEnv, MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS: '300' }).sandbox
				.startupTimeoutMs,
		).toBe(300_000);
		expect(() =>
			createFromEnv({ ...devEnv, MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS: '0' }),
		).toThrow(/MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS/);
		expect(() =>
			createFromEnv({ ...devEnv, MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS: 'soon' }),
		).toThrow(/MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS/);
	});

	it('rejects an invalid compute profile override policy', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_PROFILE_OVERRIDE: 'everyone',
			}),
		).toThrow(/MARIMOHUB_COMPUTE_PROFILE_OVERRIDE/);
	});

	it('warns once at startup when the selected backend ignores configured resources', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1',
			});
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=2',
			});
			const profileWarnings = warn.mock.calls.filter((call) =>
				String(call[0]).includes('MARIMOHUB_COMPUTE_PROFILES'),
			);
			expect(profileWarnings).toHaveLength(1);
			expect(String(profileWarnings[0][0])).toContain('ignored');
		} finally {
			warn.mockRestore();
		}
	});

	it('warns when an unsupported backend ignores the editor override policy', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_BACKEND: 'local',
				MARIMOHUB_COMPUTE_PROFILE_OVERRIDE: 'editors',
			});
			expect(
				warn.mock.calls.some((call) =>
					String(call[0]).includes('MARIMOHUB_COMPUTE_PROFILE_OVERRIDE'),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('warns when a profile-aware backend ignores GPU values', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const deps = createFromEnv({
				...baseEnv,
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_COMPUTE_BACKEND: 'docker',
				MARIMOHUB_COMPUTE_PROFILES: 'gpu:cpu=8;gpu=A100',
			});
			expect(warn.mock.calls.some((call) => String(call[0]).includes('profile GPUs'))).toBe(true);
			expect(deps.sandbox.resources).toEqual({ cpu: 8 });
			expect(deps.sandbox.computeProfiles).toEqual([{ name: 'gpu', resources: { cpu: 8 } }]);
		} finally {
			warn.mockRestore();
		}
	});

	it('hides configured profiles when the selected backend does not support them', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_COMPUTE_PROFILES: 'small:cpu=1,large:cpu=4',
			MARIMOHUB_COMPUTE_PROFILE_OVERRIDE: 'editors',
		});

		expect(deps.sandbox.resources).toEqual({});
		expect(deps.sandbox.computeProfile).toBeUndefined();
		expect(deps.sandbox.computeProfiles).toEqual([]);
		expect(deps.sandbox.computeProfileOverride).toBe('none');
	});

	it('throws on an unknown backend', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_AUTH_BACKEND: 'bogus' })).toThrow(
			/Invalid MARIMOHUB_AUTH_BACKEND: bogus/,
		);
	});

	it('wraps the SSO adapter with personal-access-token support', async () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_AUTH_DEV_USER_ID: 'alice',
			MARIMOHUB_AUTH_DEV_EMAIL: 'alice@example.com',
		});
		// A PAT resolves through the TokenService — issue one against the same
		// bucket the deps were wired over.
		const alice = (await deps.authenticator.authenticate(new Request('http://x')))!;
		await deps.services.identities.upsert(alice);
		const { token } = await deps.services.tokens.create({ name: 'ci' }, alice.id);

		const viaPat = await deps.authenticator.authenticate(
			new Request('http://x', { headers: { authorization: `Bearer ${token}` } }),
		);
		expect(viaPat?.id).toBe('alice');

		// An invalid PAT is rejected outright — never a fall-through to the SSO
		// adapter (which here would happily authenticate anyone).
		const viaBadPat = await deps.authenticator.authenticate(
			new Request('http://x', { headers: { authorization: 'Bearer mhub_pat_bogus' } }),
		);
		expect(viaBadPat).toBeNull();
	});
});

describe('createFromEnv external adapter libraries', () => {
	const env = {
		MARIMOHUB_STORAGE_BACKEND: 'library',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('requires preloaded adapters in the synchronous API', () => {
		expect(() => createFromEnv(env)).toThrow(/use createFromEnvAsync/);
		expect(() =>
			createFromEnv({
				MARIMOHUB_STORAGE_BACKEND: 'memory',
				MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
				MARIMOHUB_COMPUTE_BACKEND: 'library',
				MARIMOHUB_AUTH_BACKEND: 'dev',
			}),
		).toThrow(/use createFromEnvAsync/);
	});

	it('wires a preloaded adapter and reports its backend', () => {
		const bucket = new MemoryBucket();
		const deps = createFromEnv(env, undefined, { libraries: { bucket } });
		expect(deps.bucket).toBe(bucket);
		expect(deps.version?.backends?.storage).toBe('library');
	});

	it('wires a preloaded compute provider', () => {
		const compute = {
			create() {
				throw new Error('not used');
			},
			async proxy() {
				return null;
			},
		} satisfies SandboxProvider;
		const deps = createFromEnv(
			{
				MARIMOHUB_STORAGE_BACKEND: 'memory',
				MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
				MARIMOHUB_COMPUTE_BACKEND: 'library',
				MARIMOHUB_AUTH_BACKEND: 'dev',
			},
			undefined,
			{ libraries: { compute } },
		);
		expect(deps.compute).toBe(compute);
		expect(deps.version?.backends?.compute).toBe('library');
	});

	it('loads and wires an adapter end to end through the async API', async () => {
		const deps = await createFromEnvAsync({
			...env,
			MARIMOHUB_STORAGE_LIBRARY: validStorageFixture,
		});
		expect(deps.version?.backends?.storage).toBe('library');
		await expect(deps.bucket.list()).resolves.toMatchObject({ objects: [], truncated: false });
	});
});

describe('createFromEnv oidc email-domain allowlist', () => {
	// A full oidc env, minus the allowlist (added per-test). The session secret is
	// ≥32 bytes so createOidcAuth's HS256 check passes; discovery stays lazy.
	const oidcEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'oidc',
		MARIMOHUB_AUTH_OIDC_ISSUER: 'https://accounts.example.com',
		MARIMOHUB_AUTH_OIDC_CLIENT_ID: 'client',
		MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'secret',
		MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
	};

	it('fails closed when the allowlist is unset', () => {
		expect(() => createFromEnv({ ...oidcEnv })).toThrow(/MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS/);
	});

	it('fails closed when the allowlist is empty/whitespace', () => {
		expect(() =>
			createFromEnv({ ...oidcEnv, MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: ' , ' }),
		).toThrow(/MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS/);
	});

	it('accepts a domain list', () => {
		const deps = createFromEnv({
			...oidcEnv,
			MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'marimo.io,example.com',
		});
		expect(deps.authenticator).toBeDefined();
	});

	it('accepts an explicit "*" allow-all opt-out', () => {
		const deps = createFromEnv({ ...oidcEnv, MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: '*' });
		expect(deps.authenticator).toBeDefined();
	});
});

describe('createFromEnv sandbox-host isolation guard', () => {
	// OIDC env (its redirect URI host = the app's public host) + a distinct compute
	// backend. The guard compares MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME against it.
	const env = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'oidc',
		MARIMOHUB_AUTH_OIDC_ISSUER: 'https://accounts.example.com',
		MARIMOHUB_AUTH_OIDC_CLIENT_ID: 'client',
		MARIMOHUB_AUTH_OIDC_CLIENT_SECRET: 'secret',
		MARIMOHUB_AUTH_OIDC_REDIRECT_URI: 'https://hub.example.com/api/auth/callback',
		MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
		MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS: 'example.com',
	};

	it('throws when the sandbox host equals the app host', () => {
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com' }),
		).toThrow(/shares an origin\/parent domain/);
	});

	it('throws when the sandbox host is a subdomain of the app host', () => {
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'kernels.hub.example.com' }),
		).toThrow(/shares an origin\/parent domain/);
	});

	it('allows a sandbox host on a separate domain', () => {
		const deps = createFromEnv({
			...env,
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'sandboxes.example.net',
		});
		expect(deps.sandbox.hostname).toBe('sandboxes.example.net');
	});

	it('is a no-op when no sandbox host is configured', () => {
		const deps = createFromEnv({ ...env });
		expect(deps.sandbox.hostname).toBe('');
	});

	it('is skipped in proxy exposure mode (proxy is intentionally same-origin)', () => {
		// A sandbox host that would normally trip the guard is allowed in proxy mode,
		// where there is no separate public kernel domain to isolate.
		const deps = createFromEnv({
			...env,
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'hub.example.com',
			MARIMOHUB_SANDBOX_EXPOSURE: 'proxy',
			MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED: 'true',
		});
		expect(deps.sandbox.exposure?.mode).toBe('proxy');
	});
});

describe('createFromEnv sandbox exposure mode', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('defaults to subdomain mode when unset', () => {
		const deps = createFromEnv({ ...baseEnv });
		expect(deps.sandbox.exposure?.mode).toBe('subdomain');
	});

	it('throws on an invalid exposure mode', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_SANDBOX_EXPOSURE: 'bogus' })).toThrow(
			/Invalid MARIMOHUB_SANDBOX_EXPOSURE/,
		);
	});

	it('fails closed in proxy mode without the untrusted acknowledgement', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_SANDBOX_EXPOSURE: 'proxy',
				MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
			}),
		).toThrow(/MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED/);
	});

	it('requires a signing secret in proxy mode', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_SANDBOX_EXPOSURE: 'proxy',
				MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED: 'true',
			}),
		).toThrow(/MARIMOHUB_AUTH_SESSION_SECRET/);
	});

	it('enables proxy mode with the ack + secret, exposing the signing secret', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_SANDBOX_EXPOSURE: 'proxy',
			MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED: 'true',
			MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
			MARIMOHUB_APP_BASE_URL: 'https://hub.example.com',
		});
		expect(deps.sandbox.exposure?.mode).toBe('proxy');
		expect((deps.sandbox.exposure as ProxyExposure).signingSecret).toBe('x'.repeat(48));
		expect(deps.sandbox.appBaseUrl).toBe('https://hub.example.com');
	});

	it('passes proxy exposure to the kubernetes compute adapter', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_COMPUTE_BACKEND: 'kubernetes',
			MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME: 'sandboxes.example.net',
			MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS: 'nginx',
			MARIMOHUB_SANDBOX_EXPOSURE: 'proxy',
			MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED: 'true',
			MARIMOHUB_AUTH_SESSION_SECRET: 'x'.repeat(48),
		});
		const config = (deps.compute as unknown as { config: { exposureMode?: string } }).config;

		expect(config.exposureMode).toBe('proxy');
	});
});

describe('createFromEnv default role', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('defaults to "editor" when MARIMOHUB_DEFAULT_ROLE is unset', () => {
		expect(createFromEnv({ ...baseEnv }).policy.defaultRole).toBe('editor');
	});

	it('accepts explicit viewer/editor/manager (case-insensitive)', () => {
		expect(createFromEnv({ ...baseEnv, MARIMOHUB_DEFAULT_ROLE: 'viewer' }).policy.defaultRole).toBe(
			'viewer',
		);
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_DEFAULT_ROLE: 'MANAGER' }).policy.defaultRole,
		).toBe('manager');
		expect(createFromEnv({ ...baseEnv, MARIMOHUB_DEFAULT_ROLE: 'Editor' }).policy.defaultRole).toBe(
			'editor',
		);
	});

	it('treats "none" as members-only (no implicit role)', () => {
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_DEFAULT_ROLE: 'none' }).policy.defaultRole,
		).toBeUndefined();
	});

	it('throws on an invalid role', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_DEFAULT_ROLE: 'admin' })).toThrow(
			/Invalid MARIMOHUB_DEFAULT_ROLE/,
		);
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_DEFAULT_ROLE: 'superadmin' })).toThrow(
			/Invalid MARIMOHUB_DEFAULT_ROLE/,
		);
	});

	it('defaults viewerMode to "static" when MARIMOHUB_VIEWER_MODE is unset', () => {
		expect(createFromEnv({ ...baseEnv }).policy.viewerMode).toBe('static');
	});

	it('accepts explicit static/applications/ephemeral-sandbox (case-insensitive)', () => {
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_VIEWER_MODE: 'ephemeral-sandbox' }).policy.viewerMode,
		).toBe('ephemeral-sandbox');
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_VIEWER_MODE: 'applications' }).policy.viewerMode,
		).toBe('applications');
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_VIEWER_MODE: 'Applications' }).policy.viewerMode,
		).toBe('applications');
		expect(createFromEnv({ ...baseEnv, MARIMOHUB_VIEWER_MODE: 'Static' }).policy.viewerMode).toBe(
			'static',
		);
	});

	it('throws on an invalid viewer mode, naming the accepted values', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_VIEWER_MODE: 'readonly' })).toThrow(
			/Invalid MARIMOHUB_VIEWER_MODE.*static, applications, ephemeral-sandbox/,
		);
	});

	it('defaults editor sandbox sharing to shared and accepts exclusive', () => {
		expect(createFromEnv({ ...baseEnv }).policy.editorSandboxSharing).toBe('shared');
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_EDITOR_SANDBOX_SHARING: 'EXCLUSIVE' }).policy
				.editorSandboxSharing,
		).toBe('exclusive');
	});

	it('rejects an invalid editor sandbox sharing', () => {
		expect(() =>
			createFromEnv({ ...baseEnv, MARIMOHUB_EDITOR_SANDBOX_SHARING: 'per-user' }),
		).toThrow(/Invalid MARIMOHUB_EDITOR_SANDBOX_SHARING.*shared, exclusive/);
	});

	it('rejects the CoreWeave vars that Sandbox v1 removed', () => {
		// Set on any backend for the user-home var (its successor is runner-based)…
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_PROFILE: 'marimohub-user-home',
			}),
		).toThrow(/USER_HOME_PROFILE is no longer supported/);
		// …and on the coreweave backend for the profile / network-mode vars.
		for (const variable of [
			'MARIMOHUB_COMPUTE_COREWEAVE_PROFILE',
			'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MODE',
			'MARIMOHUB_COMPUTE_COREWEAVE_EGRESS_MODE',
		]) {
			expect(() =>
				createFromEnv({
					...baseEnv,
					MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
					MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
					[variable]: 'some-value',
				}),
			).toThrow(new RegExp(`${variable} is no longer supported`));
		}
	});

	it('requires exclusive CoreWeave editors when a user-home runner is configured', () => {
		const coreweave = {
			...baseEnv,
			MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
			MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
			MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_RUNNER_IDS: 'runner-user-home',
		};
		expect(() => createFromEnv(coreweave)).toThrow(
			/requires MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive/,
		);
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_RUNNER_IDS: 'runner-user-home',
				MARIMOHUB_EDITOR_SANDBOX_SHARING: 'exclusive',
			}),
		).toThrow(/requires the coreweave backend/);
	});

	it('requires normal and user-home CoreWeave runners to be disjoint', () => {
		expect(() =>
			createFromEnv({
				...baseEnv,
				MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
				MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
				MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_IDS: 'runner-a, runner-shared',
				MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_RUNNER_IDS: 'runner-shared, runner-user-home',
				MARIMOHUB_EDITOR_SANDBOX_SHARING: 'exclusive',
			}),
		).toThrow(/must not overlap.*runner-shared/);
	});

	it('resolves exclusive CoreWeave user homes from canonical email', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_COMPUTE_BACKEND: ' CoreWeave ',
			MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
			MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_RUNNER_IDS: 'runner-user-home',
			MARIMOHUB_EDITOR_SANDBOX_SHARING: 'exclusive',
		});
		expect(
			deps.sandbox.userHome?.resolve({ id: 'user-1' as never, email: ' Ada@Example.COM ' }),
		).toEqual({ key: 'ada@example.com', path: '/mnt/ada@example.com' });
	});

	it('rejects an email that cannot be a CoreWeave subpath', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
			MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
			MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_RUNNER_IDS: 'runner-user-home',
			MARIMOHUB_EDITOR_SANDBOX_SHARING: 'exclusive',
		});
		const resolve = () =>
			deps.sandbox.userHome?.resolve({ id: 'user-1' as never, email: '../escape@example.com' });
		expect(resolve).toThrow(BadRequestError);
		expect(resolve).toThrow(/contact an administrator.*identity-provider email claim/);
	});

	it('defaults persistWorkspace to "source" when MARIMOHUB_PERSIST_WORKSPACE is unset', () => {
		expect(createFromEnv({ ...baseEnv }).sandbox.persistWorkspace).toBe('source');
	});

	it('accepts explicit source/workspace (case-insensitive)', () => {
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_PERSIST_WORKSPACE: 'workspace' }).sandbox
				.persistWorkspace,
		).toBe('workspace');
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_PERSIST_WORKSPACE: 'SOURCE' }).sandbox.persistWorkspace,
		).toBe('source');
	});

	it('throws on an invalid persistWorkspace value', () => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_PERSIST_WORKSPACE: 'always' })).toThrow(
			/Invalid MARIMOHUB_PERSIST_WORKSPACE/,
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

describe('createFromEnv workload identity federation', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};
	// The issuer imports the key lazily, so a syntactically-marked PEM is enough
	// to exercise the wiring without generating a real RSA key.
	const wifEnv = {
		MARIMOHUB_WIF_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
		MARIMOHUB_WIF_KID: 'kid-1',
		MARIMOHUB_WIF_ISSUER_URL: 'https://hub.example.com',
		MARIMOHUB_WIF_AUDIENCE: 'coreweave-object-storage',
		MARIMOHUB_WIF_BROKER: 'coreweave',
		MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL:
			'https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/test-org',
		MARIMOHUB_WIF_STORAGE_ENDPOINT: 'https://cwobject.com',
		MARIMOHUB_WIF_STORAGE_REGION: 'us-east-1',
	};

	it('is disabled (no WIF) when no WIF vars are set', () => {
		const deps = createFromEnv({ ...baseEnv });
		expect(deps.wif).toBeUndefined();
	});

	it('wires the issuer + target when fully configured', () => {
		const deps = createFromEnv({ ...baseEnv, ...wifEnv });
		expect(deps.wif).toBeDefined();
		expect(deps.wif!.issuerUrl).toBe('https://hub.example.com');
		const target = deps.wif!.target;
		expect(target).toBeDefined();
		expect(target.audience).toBe('coreweave-object-storage');
		expect(target.broker).toBeDefined();
		expect(target.storage).toEqual({ endpoint: 'https://cwobject.com', region: 'us-east-1' });
	});

	it('strips a trailing slash from the issuer URL (canonical jwks_uri)', () => {
		const deps = createFromEnv({
			...baseEnv,
			...wifEnv,
			MARIMOHUB_WIF_ISSUER_URL: 'https://hub.example.com/',
		});
		expect(deps.wif!.issuerUrl).toBe('https://hub.example.com');
	});

	it('throws on an unknown broker', () => {
		expect(() => createFromEnv({ ...baseEnv, ...wifEnv, MARIMOHUB_WIF_BROKER: 'bogus' })).toThrow(
			/Unknown MARIMOHUB_WIF_BROKER/,
		);
	});

	it('requires the broker to be set explicitly (no default)', () => {
		const { MARIMOHUB_WIF_BROKER: _omit, ...noBroker } = wifEnv;
		expect(() => createFromEnv({ ...baseEnv, ...noBroker })).toThrow(
			/partially configured.*MARIMOHUB_WIF_BROKER/,
		);
	});

	it('throws when WIF is partially configured', () => {
		const { MARIMOHUB_WIF_AUDIENCE: _omit, ...partial } = wifEnv;
		expect(() => createFromEnv({ ...baseEnv, ...partial })).toThrow(
			/partially configured.*MARIMOHUB_WIF_AUDIENCE/,
		);
	});

	it('rejects a signing key that is not a PKCS8 PEM', () => {
		expect(() =>
			createFromEnv({ ...baseEnv, ...wifEnv, MARIMOHUB_WIF_SIGNING_KEY: 'not-a-pem' }),
		).toThrow(/PKCS8 PEM/);
	});

	it('accepts a base64-encoded PEM (single-line, for env-file secret stores)', () => {
		const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
		const b64 = btoa(pem);
		const deps = createFromEnv({ ...baseEnv, ...wifEnv, MARIMOHUB_WIF_SIGNING_KEY: b64 });
		// Wired without throwing — the issuer received the decoded PEM.
		expect(deps.wif).toBeDefined();
	});

	it('does not fall back to the storage S3 endpoint/region (explicit only)', () => {
		const {
			MARIMOHUB_WIF_STORAGE_ENDPOINT: _e,
			MARIMOHUB_WIF_STORAGE_REGION: _r,
			...noWifStorage
		} = wifEnv;
		const deps = createFromEnv({
			...baseEnv,
			...noWifStorage,
			MARIMOHUB_STORAGE_S3_ENDPOINT: 'https://storage.cwobject.com',
			MARIMOHUB_STORAGE_S3_REGION: 'us-west-2',
		});
		// Unset WIF storage vars stay unset — no magic inheritance from the storage config.
		expect(deps.wif!.target.storage).toEqual({ endpoint: undefined, region: undefined });
	});
});

describe('createFromEnv session lifetime', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('applies the documented defaults', () => {
		const deps = createFromEnv({ ...baseEnv });
		expect(deps.sandbox.sessionLifetime).toEqual({
			maxLifetimeMs: 14400 * 1000,
			idleTimeoutMs: 1800 * 1000,
			snapshotIntervalMs: 120 * 1000,
			extensionMs: 1800 * 1000,
			connectionAware: true,
			sweepIntervalMs: 60 * 1000,
		});
	});

	it('honors explicit overrides, including disabling snapshots and connection-awareness', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS: '7200',
			MARIMOHUB_SESSION_SNAPSHOT_INTERVAL_SECONDS: '0',
			MARIMOHUB_SESSION_CONNECTION_AWARE: 'false',
		});
		expect(deps.sandbox.sessionLifetime).toMatchObject({
			maxLifetimeMs: 7200 * 1000,
			snapshotIntervalMs: 0,
			connectionAware: false,
		});
	});

	it('rejects a non-positive lifetime', () => {
		expect(() =>
			createFromEnv({ ...baseEnv, MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS: '0' }),
		).toThrow(/MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS/);
	});

	it.each([
		'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS',
		'MARIMOHUB_SESSION_LIFETIME_EXTENSION_SECONDS',
		'MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS',
	])('rejects a zero %s (only the snapshot interval may be 0)', (key) => {
		expect(() => createFromEnv({ ...baseEnv, [key]: '0' })).toThrow(new RegExp(key));
	});

	it.each([
		'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS',
		'MARIMOHUB_SESSION_LIFETIME_EXTENSION_SECONDS',
		'MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS',
	])('rejects a negative %s', (key) => {
		expect(() => createFromEnv({ ...baseEnv, [key]: '-1' })).toThrow(new RegExp(key));
	});
});

describe('createFromEnv concurrent-session cap', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('defaults to 10 when unset', () => {
		expect(createFromEnv({ ...baseEnv }).policy.maxConcurrentSessionsPerUser).toBe(10);
	});

	it('treats 0 as unlimited (undefined)', () => {
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_MAX_SESSIONS_PER_USER: '0' }).policy
				.maxConcurrentSessionsPerUser,
		).toBeUndefined();
	});

	it.each(['-1', '2.5', 'abc'])('rejects the invalid cap %o', (raw) => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_MAX_SESSIONS_PER_USER: raw })).toThrow(
			/MARIMOHUB_MAX_SESSIONS_PER_USER/,
		);
	});

	it('defaults the per-project app cap to 5', () => {
		expect(createFromEnv({ ...baseEnv }).policy.maxAppsPerProject).toBe(5);
	});

	it('treats an app cap of 0 as unlimited (undefined)', () => {
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_MAX_APPS_PER_PROJECT: '0' }).policy.maxAppsPerProject,
		).toBeUndefined();
	});

	it.each(['-1', '2.5', 'abc'])('rejects the invalid app cap %o', (raw) => {
		expect(() => createFromEnv({ ...baseEnv, MARIMOHUB_MAX_APPS_PER_PROJECT: raw })).toThrow(
			/MARIMOHUB_MAX_APPS_PER_PROJECT/,
		);
	});

	it('treats an empty value as unset (defaults), never as 0/unlimited', () => {
		// `Number('') === 0`, so `MARIMOHUB_MAX_APPS_PER_PROJECT=` in an env file
		// would otherwise silently disable the cap instead of applying the default.
		const cfg = createFromEnv({
			...baseEnv,
			MARIMOHUB_MAX_SESSIONS_PER_USER: '',
			MARIMOHUB_MAX_APPS_PER_PROJECT: ' ',
		});
		expect(cfg.policy.maxConcurrentSessionsPerUser).toBe(10);
		expect(cfg.policy.maxAppsPerProject).toBe(5);
	});
});

describe('createFromEnv allowed origins', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('parses MARIMOHUB_ALLOWED_ORIGINS into a trimmed list', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
		});
		expect(deps.policy.allowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
	});

	it('leaves allowed origins undefined when unset', () => {
		expect(createFromEnv({ ...baseEnv }).policy.allowedOrigins).toBeUndefined();
	});
});

describe('createFromEnv super admins', () => {
	const baseEnv = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('parses MARIMOHUB_SUPER_ADMINS into a trimmed list of ids/emails', () => {
		const deps = createFromEnv({
			...baseEnv,
			MARIMOHUB_SUPER_ADMINS: 'admin@example.com, user_01HXY00000000000000000000 ,',
		});
		expect(deps.policy.superAdmins).toEqual([
			'admin@example.com',
			'user_01HXY00000000000000000000',
		]);
	});

	it('leaves super admins undefined when unset or empty', () => {
		expect(createFromEnv({ ...baseEnv }).policy.superAdmins).toBeUndefined();
		expect(
			createFromEnv({ ...baseEnv, MARIMOHUB_SUPER_ADMINS: ' , ' }).policy.superAdmins,
		).toBeUndefined();
	});
});

describe('createFromEnv data-browser lockdown', () => {
	const env = {
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'none',
		MARIMOHUB_AUTH_BACKEND: 'dev',
	};

	it('defaults to metadata with previews and Run SQL locked off', () => {
		const deps = createFromEnv({ ...env });
		expect(deps.dataBrowser).toMatchObject({ preview: false, query: false });
		expect(deps.dataBrowser?.checkPreview).toBeUndefined();
	});

	it('boots without a data browser when the probe or integrations are off by default', () => {
		expect(
			createFromEnv({ ...env, MARIMOHUB_INTEGRATIONS_PROBE: 'off' }).dataBrowser,
		).toBeUndefined();
		expect(
			createFromEnv({
				...env,
				MARIMOHUB_INTEGRATIONS: 'off',
				MARIMOHUB_INTEGRATIONS_PROBE: 'off',
			}).dataBrowser,
		).toBeUndefined();
	});

	it('refuses explicit full mode without a probe', () => {
		expect(() =>
			createFromEnv({
				...env,
				MARIMOHUB_INTEGRATIONS_PROBE: 'off',
				MARIMOHUB_DATA_BROWSER: 'full',
			}),
		).toThrow(/probe/);
	});

	it('trims and lowercases the mode consistently across every wiring site', () => {
		const deps = createFromEnv({ ...env, MARIMOHUB_DATA_BROWSER: ' FULL ' });
		expect(deps.dataBrowser).toMatchObject({ preview: true, query: true });
		expect(deps.dataBrowser?.checkPreview).toBeTypeOf('function');
	});

	it('registers PostgreSQL query execution only with its rollout flag', () => {
		const deps = createFromEnv({ ...env, MARIMOHUB_DATA_BROWSER: 'full' });
		const enabled = createFromEnv({
			...env,
			MARIMOHUB_DATA_BROWSER: 'full',
			MARIMOHUB_POSTGRES_DATA_ACCESS: 'on',
		});
		const stores = deps.integrations as unknown as {
			store: { dataQuery: { options: { executorFactories: Record<string, unknown> } } };
		};
		const enabledStores = enabled.integrations as unknown as typeof stores;
		expect(Object.keys(stores.store.dataQuery.options.executorFactories)).toEqual(['duckdb-wasm']);
		expect(Object.keys(enabledStores.store.dataQuery.options.executorFactories).sort()).toEqual([
			'duckdb-wasm',
			'postgres',
		]);
	});
});

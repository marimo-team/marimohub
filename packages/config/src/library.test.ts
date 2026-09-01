import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '@marimo-hub/core';
import type { ExternalStorageAdapter, SandboxId } from '@marimo-hub/core';
import { isConfigError } from './errors';
import { loadAdapterLibraries, resolveAdapterSpecifier } from './library';

const fixtures = fileURLToPath(new URL('./testdata/adapters/', import.meta.url));
const fixture = (name: string) => path.join(fixtures, name);
const exampleStorage = fileURLToPath(
	new URL('../../../examples/external-adapter/storage.mjs', import.meta.url),
);
const storageEnv = (specifier: string) => ({
	MARIMOHUB_STORAGE_BACKEND: 'library',
	MARIMOHUB_STORAGE_LIBRARY: specifier,
});
const computeEnv = (specifier: string) => ({
	MARIMOHUB_COMPUTE_BACKEND: 'library',
	MARIMOHUB_COMPUTE_LIBRARY: specifier,
});

async function expectConfigError(
	promise: Promise<unknown>,
	variable: string,
	message: RegExp,
): Promise<void> {
	try {
		await promise;
		expect.fail('expected a ConfigError');
	} catch (error) {
		expect(isConfigError(error)).toBe(true);
		if (!isConfigError(error)) return;
		expect(error.opts.variable).toBe(variable);
		expect(error.message).toMatch(message);
		if (variable.endsWith('_LIBRARY')) {
			expect(error.opts.docs).toBe('development_docs/ports.md#external-adapter-libraries');
			expect(error.format()).toContain(`var:    ${variable}`);
		}
	}
}

describe('external adapter library loading', () => {
	it('is a no-op unless a library backend is selected', async () => {
		await expect(loadAdapterLibraries({})).resolves.toEqual({});
	});

	it('requires the selected library specifier', async () => {
		await expectConfigError(
			loadAdapterLibraries({ MARIMOHUB_STORAGE_BACKEND: 'library' }),
			'MARIMOHUB_STORAGE_LIBRARY',
			/Missing required env var/,
		);
		await expectConfigError(
			loadAdapterLibraries({ MARIMOHUB_COMPUTE_BACKEND: 'library' }),
			'MARIMOHUB_COMPUTE_LIBRARY',
			/Missing required env var/,
		);
	});

	it('loads file paths and passes the full env to storage factories', async () => {
		const env = {
			...storageEnv(fixture('valid-storage.mjs')),
			MARIMOHUB_STORAGE_LIBRARY_TOKEN: 'fixture-token',
		};
		const loaded = await loadAdapterLibraries(env);
		expect(loaded.bucket).toBeDefined();
		expect(
			(loaded.bucket as unknown as { factoryContext: { env: typeof env } }).factoryContext.env,
		).toBe(env);
		await loaded.bucket?.put('existing', 'first');
		await expect(
			loaded.bucket?.put('existing', 'second', { onlyIfNotExists: true }),
		).rejects.toBeInstanceOf(PreconditionFailedError);
		const unicode = await loaded.bucket?.put('unicode', 'héllo');
		expect(unicode?.size).toBe(6);
		const body = await loaded.bucket?.get('unicode');
		expect(await body?.text()).toBe('héllo');
		expect(await body?.bytes()).toEqual(new TextEncoder().encode('héllo'));
		await loaded.bucket?.put('json', '{"value":"héllo"}');
		expect(await (await loaded.bucket?.get('json'))?.json()).toEqual({ value: 'héllo' });
	});

	it('loads file URLs, async factories, and nested CommonJS defaults', async () => {
		await expect(
			loadAdapterLibraries(storageEnv(pathToFileURL(fixture('valid-storage.mjs')).href)),
		).resolves.toHaveProperty('bucket');
		await expect(
			loadAdapterLibraries(storageEnv(fixture('async-storage.mjs'))),
		).resolves.toHaveProperty('bucket');
		await expect(
			loadAdapterLibraries(storageEnv(fixture('valid-storage.cjs'))),
		).resolves.toHaveProperty('bucket');
	});

	it('example storage probes atomic contention without touching a shared key', async () => {
		const loaded = await loadAdapterLibraries(storageEnv(exampleStorage));
		const bucket = loaded.bucket as ExternalStorageAdapter;
		const oldProbeKey = '_system/.external-adapter-cas-probe';
		await bucket.put(oldProbeKey, 'preserve');
		await Promise.all([bucket.verifyConditionalWrites(), bucket.verifyConditionalWrites()]);
		expect(await (await bucket.get(oldProbeKey))?.text()).toBe('preserve');

		let nextWinner = 1;
		const nonAtomic = {
			async put(key: string, _value: string, options?: { onlyIfNotExists?: boolean }) {
				return {
					key,
					etag: options?.onlyIfNotExists ? 'seed' : `winner-${nextWinner++}`,
					size: 0,
					uploaded: new Date(0),
				};
			},
			async delete() {},
		} as unknown as ExternalStorageAdapter;
		await expect(bucket.verifyConditionalWrites.call(nonAtomic)).rejects.toThrow(
			/does NOT enforce conditional writes atomically: 8 concurrent writes succeeded/,
		);
	});

	it('passes session lifecycle hints to compute factories', async () => {
		const loaded = await loadAdapterLibraries({
			...computeEnv(fixture('valid-compute.mjs')),
			MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS: '7200',
			MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS: '600',
		});
		const context = (
			loaded.compute as unknown as {
				factoryContext: { compute: Record<string, number> };
			}
		).factoryContext;
		expect(context.compute).toEqual({
			sessionMaxLifetimeSeconds: 7200,
			sessionIdleTimeoutMs: 600_000,
		});
		expect(() => loaded.compute?.create('sb-aaaaaaaaaaaaaaaa' as SandboxId)).not.toThrow();
	});

	it.each([
		['no-manifest.mjs', /does not default-export.*manifest/],
		['malformed-manifest.mjs', /does not default-export.*manifest/],
		['throwing-manifest.mjs', /manifest.*could not be validated: manifest getter failed/],
		['bad-api-version.mjs', /apiVersion 2; this server supports 1/],
		['missing-method.mjs', /missing required Bucket method\(s\): put, list/],
		['throwing-factory.mjs', /failed to initialize: fixture initialization failed/],
		['throwing-shape.mjs', /could not be validated: shape getter failed/],
	] as const)('maps %s failures to storage ConfigErrors', async (name, message) => {
		await expectConfigError(
			loadAdapterLibraries(storageEnv(fixture(name))),
			'MARIMOHUB_STORAGE_LIBRARY',
			message,
		);
	});

	it.each([
		['missing-probe', /verifyConditionalWrites must be a function/],
		['invalid-probe', /verifyConditionalWrites must be a function/],
		['missing-scope', /casScope must be "global" or "process"/],
		['invalid-scope', /casScope must be "global" or "process"/],
	] as const)('rejects an external storage adapter with %s', async (invalidSafety, message) => {
		await expectConfigError(
			loadAdapterLibraries({
				...storageEnv(fixture('invalid-storage-safety.mjs')),
				MARIMOHUB_STORAGE_LIBRARY_INVALID_SAFETY: invalidSafety,
			}),
			'MARIMOHUB_STORAGE_LIBRARY',
			message,
		);
	});

	it('reports imports and wrong adapter kinds clearly', async () => {
		await expectConfigError(
			loadAdapterLibraries(storageEnv('@missing/marimohub-adapter-fixture')),
			'MARIMOHUB_STORAGE_LIBRARY',
			/Could not load storage adapter library/,
		);
		await expectConfigError(
			loadAdapterLibraries(computeEnv(fixture('wrong-kind.mjs'))),
			'MARIMOHUB_COMPUTE_LIBRARY',
			/declares kind "storage".*compute adapter/,
		);
		await expectConfigError(
			loadAdapterLibraries(storageEnv(fixture('valid-compute.mjs'))),
			'MARIMOHUB_STORAGE_LIBRARY',
			/declares kind "compute".*storage adapter/,
		);
	});

	it.each([
		['missing-provider-method.mjs', /missing required SandboxProvider method\(s\): proxy/],
		[
			'invalid-provider-optional.mjs',
			/non-callable optional SandboxProvider method\(s\): listActive/,
		],
		[
			'invalid-provider-dispose.mjs',
			/non-callable optional SandboxProvider method\(s\): Symbol.asyncDispose/,
		],
		['throwing-compute-factory.mjs', /failed to initialize: compute initialization rejected/],
	] as const)('maps %s failures to compute ConfigErrors', async (name, message) => {
		await expectConfigError(
			loadAdapterLibraries(computeEnv(fixture(name))),
			'MARIMOHUB_COMPUTE_LIBRARY',
			message,
		);
	});

	it.each([
		['invalid-instance.mjs', /missing required SandboxInstance method\(s\): execStream, readFile$/],
		[
			'async-instance.mjs',
			/missing required SandboxInstance method\(s\): exec, execStream, readFile, listFiles, writeFiles, gitCheckout, setEnvVars, mountBucket, unmountBucket, startProcess, exposePort, destroy$/,
		],
	] as const)(
		'validates the first sandbox from %s without creating one at boot',
		async (name, message) => {
			const loaded = await loadAdapterLibraries(computeEnv(fixture(name)));
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(() => loaded.compute?.create('sb-aaaaaaaaaaaaaaaa' as SandboxId)).toThrow(message);
			}
		},
	);

	it.each(['ready', 'launchProcess', 'drainTimings', 'drainCounters'] as const)(
		'rejects a non-callable sandbox %s capability',
		async (capability) => {
			const loaded = await loadAdapterLibraries({
				...computeEnv(fixture('valid-compute.mjs')),
				MARIMOHUB_COMPUTE_LIBRARY_INVALID_CAPABILITY: capability,
			});
			expect(() => loaded.compute?.create('sb-aaaaaaaaaaaaaaaa' as SandboxId)).toThrow(
				new RegExp(`non-callable optional method\\(s\\): ${capability}`),
			);
		},
	);

	it('rejects a non-boolean supportsBucketMount capability', async () => {
		const loaded = await loadAdapterLibraries({
			...computeEnv(fixture('valid-compute.mjs')),
			MARIMOHUB_COMPUTE_LIBRARY_INVALID_CAPABILITY: 'supportsBucketMount',
		});
		expect(() => loaded.compute?.create('sb-aaaaaaaaaaaaaaaa' as SandboxId)).toThrow(
			/non-boolean supportsBucketMount/,
		);
	});

	it.each([
		['MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS', '0'],
		['MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS', 'not-an-integer'],
	] as const)(
		'rejects invalid compute lifecycle hint %s before initialization',
		async (variable, value) => {
			await expectConfigError(
				loadAdapterLibraries({
					...computeEnv(fixture('valid-compute.mjs')),
					[variable]: value,
				}),
				variable,
				new RegExp(`Invalid ${variable}`),
			);
		},
	);
});

describe('resolveAdapterSpecifier', () => {
	it('resolves relative and absolute paths to file URLs', () => {
		const relative = './packages/config/src/testdata/adapters/valid-storage.mjs';
		const parentRelative = '../external-adapter.mjs';
		expect(resolveAdapterSpecifier(relative)).toBe(pathToFileURL(path.resolve(relative)).href);
		expect(resolveAdapterSpecifier(parentRelative)).toBe(
			pathToFileURL(path.resolve(parentRelative)).href,
		);
		expect(resolveAdapterSpecifier(fixture('valid-storage.mjs'))).toBe(
			pathToFileURL(fixture('valid-storage.mjs')).href,
		);
	});

	it('keeps file URLs and bare package specifiers unchanged', () => {
		const url = pathToFileURL(fixture('valid-storage.mjs')).href;
		expect(resolveAdapterSpecifier(url)).toBe(url);
		expect(resolveAdapterSpecifier('@myorg/custom-storage')).toBe('@myorg/custom-storage');
	});
});

describe('OIDC login-policy library loading', () => {
	const policyFixtures = fileURLToPath(new URL('./testdata/oidc-login-policies/', import.meta.url));
	const policyFixture = (name: string) => path.join(policyFixtures, name);
	const policyEnv = (specifier: string) => ({
		MARIMOHUB_AUTH_BACKEND: 'oidc',
		MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
		MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: specifier,
	});
	const policyInput = (claims: Record<string, unknown>) => ({
		identity: { id: 'user-1' as never, email: 'user@example.com' },
		idTokenClaims: claims,
		signal: new AbortController().signal,
	});

	it('is a no-op unless the library backend and the oidc auth backend are selected', async () => {
		await expect(
			loadAdapterLibraries({
				MARIMOHUB_AUTH_BACKEND: 'oidc',
			}),
		).resolves.toEqual({});
		// A stale selector under another auth backend must not run module code;
		// makeAuth rejects the combination separately.
		await expect(
			loadAdapterLibraries({
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY: policyFixture('throwing-factory.mjs'),
			}),
		).resolves.toEqual({});
	});

	it('requires the library specifier', async () => {
		await expectConfigError(
			loadAdapterLibraries({
				MARIMOHUB_AUTH_BACKEND: 'oidc',
				MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND: 'library',
			}),
			'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY',
			/Missing required env var/,
		);
	});

	it('loads a policy from a path and passes the full env to the factory', async () => {
		const env = {
			...policyEnv(policyFixture('valid.mjs')),
			MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TENANT: 'fixture-tenant',
		};
		const loaded = await loadAdapterLibraries(env);
		const policy = loaded.oidcLoginPolicy;
		expect(policy).toBeDefined();
		expect((policy as unknown as { factoryContext: { env: typeof env } }).factoryContext.env).toBe(
			env,
		);
		expect(policy?.evaluate(policyInput({ groups: ['hub-users'] }))).toEqual({
			decision: 'allow',
			entitlements: ['default-role:editor'],
		});
		expect(policy?.evaluate(policyInput({}))).toEqual({
			decision: 'deny',
			reason: 'fixture_policy',
		});
	});

	it('loads file URLs and asynchronous factories', async () => {
		await expect(
			loadAdapterLibraries(policyEnv(pathToFileURL(policyFixture('valid.mjs')).href)),
		).resolves.toHaveProperty('oidcLoginPolicy');
		const loaded = await loadAdapterLibraries(policyEnv(policyFixture('async-factory.mjs')));
		await expect(loaded.oidcLoginPolicy?.evaluate(policyInput({}))).resolves.toEqual({
			decision: 'allow',
		});
	});

	it('loads the example module and evaluates its compound AND rule', async () => {
		const examplePolicy = fileURLToPath(
			new URL('../../../examples/external-adapter/oidc-login-policy.mjs', import.meta.url),
		);
		const loaded = await loadAdapterLibraries(policyEnv(examplePolicy));
		const satisfied = {
			department: 'orgcode1',
			access_level: 'elevated',
			elements: ['element-a', 'element-b'],
		};
		expect(loaded.oidcLoginPolicy?.evaluate(policyInput({ user_attributes: satisfied }))).toEqual({
			decision: 'allow',
			entitlements: ['default-role:editor'],
		});
		for (const missing of [
			{ ...satisfied, department: 'other' },
			{ ...satisfied, access_level: 'baseline' },
			{ ...satisfied, elements: ['element-a'] },
			{},
		]) {
			expect(loaded.oidcLoginPolicy?.evaluate(policyInput({ user_attributes: missing }))).toEqual({
				decision: 'deny',
				reason: 'example_access_policy',
			});
		}
	});

	it('loads a login policy alongside library storage and compute', async () => {
		const loaded = await loadAdapterLibraries({
			...policyEnv(policyFixture('valid.mjs')),
			MARIMOHUB_STORAGE_BACKEND: 'library',
			MARIMOHUB_STORAGE_LIBRARY: fixture('valid-storage.mjs'),
			MARIMOHUB_COMPUTE_BACKEND: 'library',
			MARIMOHUB_COMPUTE_LIBRARY: fixture('valid-compute.mjs'),
		});
		expect(loaded.bucket).toBeDefined();
		expect(loaded.compute).toBeDefined();
		expect(loaded.oidcLoginPolicy).toBeDefined();
	});

	it('reports missing packages clearly', async () => {
		await expectConfigError(
			loadAdapterLibraries(policyEnv('@missing/marimohub-login-policy-fixture')),
			'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY',
			/Could not load oidc-login-policy adapter library/,
		);
	});

	it.each([
		['no-manifest.mjs', /does not default-export.*manifest/],
		['wrong-kind.mjs', /declares kind "storage".*oidc-login-policy adapter/],
		['bad-api-version.mjs', /apiVersion 2; this server supports 1/],
		['missing-evaluate.mjs', /missing a callable evaluate method/],
		['non-callable-evaluate.mjs', /missing a callable evaluate method/],
		['throwing-factory.mjs', /failed to initialize: fixture initialization failed/],
		['rejected-factory.mjs', /failed to initialize: login-policy initialization rejected/],
		['throwing-shape.mjs', /could not be validated: shape getter failed/],
	] as const)('maps %s failures to ConfigErrors', async (name, message) => {
		await expectConfigError(
			loadAdapterLibraries(policyEnv(policyFixture(name))),
			'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY',
			message,
		);
	});

	it('rejects a storage manifest configured as a login policy', async () => {
		await expectConfigError(
			loadAdapterLibraries(policyEnv(fixture('valid-storage.mjs'))),
			'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY',
			/declares kind "storage".*oidc-login-policy adapter/,
		);
	});
});

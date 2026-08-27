import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core';
import { isConfigError } from './errors';
import { loadAdapterLibraries, resolveAdapterSpecifier } from './library';

const fixtures = fileURLToPath(new URL('./testdata/adapters/', import.meta.url));
const fixture = (name: string) => path.join(fixtures, name);
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
		['invalid-instance.mjs', /missing required SandboxInstance method\(s\): execStream, readFile/],
		['async-instance.mjs', /missing required SandboxInstance method\(s\): exec, execStream/],
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

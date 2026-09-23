import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Millis } from '@marimo-hub/core';
import { parseComputeProfiles } from './computeProfiles';
import { parseWarmPoolConfig } from './warmPool';
import { makeCompute } from './compute';
import { makeFakeSandbox } from '@marimo-hub/core/testing';
import type { SandboxProvider } from '@marimo-hub/core';

const options = {
	backend: 'kubernetes',
	compute: makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'kubernetes' }),
	images: ['default-image', 'other-image'],
	profiles: parseComputeProfiles('small:cpu=1;mem=2Gi,large:cpu=4;mem=8Gi'),
	sessionMaxLifetimeMs: Millis.hours(4),
};
const enabled = { MARIMOHUB_COMPUTE_WARM_POOL_ENABLED: 'true' };

function coreWeaveOptions(maxLifetimeSeconds?: number) {
	return {
		...options,
		backend: 'coreweave',
		compute: makeCompute(
			{
				MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
				MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'test-key',
				...(maxLifetimeSeconds === undefined
					? {}
					: {
							MARIMOHUB_COMPUTE_COREWEAVE_MAX_LIFETIME_SECONDS: String(maxLifetimeSeconds),
						}),
			},
			{ sessionMaxLifetimeSeconds: Millis.toSeconds(options.sessionMaxLifetimeMs) },
		),
	};
}

describe('warm pool configuration', () => {
	it('accepts an external provider through capabilities without a backend allowlist', () => {
		const sandbox = makeFakeSandbox().instance;
		const compute: SandboxProvider = {
			create: () => sandbox,
			connectExisting: () => sandbox,
			proxy: async () => null,
			warmPool: { maxLifetimeMs: null, configuration: { deployment: 'external', revision: 1 } },
		};
		const parsed = parseWarmPoolConfig(enabled, { ...options, backend: 'library', compute })!;
		expect(parsed.backend).toBe('library');
		expect(parsed.config.enabled).toBe(true);
		expect(parsed.config.providerLifetimeMs).toBeUndefined();
		const changed = parseWarmPoolConfig(enabled, {
			...options,
			backend: 'library',
			compute: {
				...compute,
				warmPool: { maxLifetimeMs: null, configuration: { deployment: 'external', revision: 2 } },
			},
		})!;
		expect(changed.config.profiles[0].key).not.toBe(parsed.config.profiles[0].key);
	});

	it('requires strict reconnect even if a provider advertises pooling', () => {
		expect(() =>
			parseWarmPoolConfig(enabled, {
				...options,
				compute: { ...options.compute, connectExisting: undefined },
			}),
		).toThrow('does not support warm pools');
	});

	it.each([0, -1, Number.NaN, Infinity])(
		'rejects invalid provider lifetime %s on any backend',
		(maxLifetimeMs) => {
			const sandbox = makeFakeSandbox().instance;
			const compute: SandboxProvider = {
				create: () => sandbox,
				connectExisting: () => sandbox,
				proxy: async () => null,
				warmPool: { maxLifetimeMs },
			};
			expect(() =>
				parseWarmPoolConfig(enabled, { ...options, backend: 'library', compute }),
			).toThrow('provider lifetime longer');
		},
	);
	it('is disabled by default with size one and the first profile', () => {
		const parsed = parseWarmPoolConfig({}, options)!;
		expect(parsed.config.enabled).toBe(false);
		expect(parsed.config.size).toBe(1);
		expect(parsed.config.profiles.map((profile) => profile.name)).toEqual(['small']);
		expect(parsed.config.profiles[0].image).toBe('default-image');
	});

	it('selects all profiles with the requested size', () => {
		const parsed = parseWarmPoolConfig(
			{
				...enabled,
				MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: 'all',
				MARIMOHUB_COMPUTE_WARM_POOL_SIZE: '3',
			},
			options,
		)!;
		expect(parsed.config.enabled).toBe(true);
		expect(parsed.config.size).toBe(3);
		expect(parsed.config.profiles.map((profile) => profile.name)).toEqual(['small', 'large']);
		expect(parsed.config.profiles[0].key).not.toBe(parsed.config.profiles[1].key);
	});

	it('uses one adapter-default pool with no profiles or images', () => {
		const parsed = parseWarmPoolConfig(enabled, {
			...options,
			profiles: parseComputeProfiles(undefined),
			images: [],
		})!;
		expect(parsed.config.profiles).toEqual([
			{ key: expect.any(String), name: undefined, image: undefined, resources: {} },
		]);
	});

	it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('rejects invalid size %s', (size) => {
		expect(() =>
			parseWarmPoolConfig({ ...enabled, MARIMOHUB_COMPUTE_WARM_POOL_SIZE: size }, options),
		).toThrow('MARIMOHUB_COMPUTE_WARM_POOL_SIZE');
	});

	it.each([undefined, 'false'])('ignores unused pool settings when enabled is %s', (value) => {
		const env = {
			MARIMOHUB_COMPUTE_WARM_POOL_ENABLED: value,
			MARIMOHUB_COMPUTE_WARM_POOL_SIZE: 'not-a-number',
			MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: 'unknown',
		};
		const parsed = parseWarmPoolConfig(env, options)!;
		expect(parsed.config.enabled).toBe(false);
		expect(parsed.config.size).toBe(1);
		expect(parsed.config.profiles.map((profile) => profile.name)).toEqual(['small']);
		expect(
			parseWarmPoolConfig(env, {
				...options,
				compute: { ...options.compute, warmPool: undefined },
			}),
		).toBeUndefined();
	});

	it('rejects unknown profile selection and providers without warm-pool support', () => {
		expect(() =>
			parseWarmPoolConfig({ ...enabled, MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: 'small' }, options),
		).toThrow('MARIMOHUB_COMPUTE_WARM_POOL_PROFILES');
		const unsupported = { ...options, compute: { ...options.compute, warmPool: undefined } };
		expect(() => parseWarmPoolConfig(enabled, unsupported)).toThrow('does not support warm pools');
		expect(parseWarmPoolConfig({}, unsupported)).toBeUndefined();
	});

	it('uses the lifetime already resolved by compute wiring', () => {
		const cw = coreWeaveOptions();
		const parsed = parseWarmPoolConfig(enabled, cw)!;
		expect(parsed.config.providerLifetimeMs).toBe(Millis.hours(8));
		expect(parsed.config.minimumRemainingMs).toBeGreaterThan(Millis.hours(4));
		expect(() => parseWarmPoolConfig(enabled, coreWeaveOptions(14400))).toThrow(
			'provider lifetime longer',
		);
		expect(() => parseWarmPoolConfig(enabled, { ...cw, startupTimeoutMs: Millis.of(0) })).toThrow(
			'finite startup timeout',
		);
	});

	it('keeps fingerprints stable across replicas and size changes, and changes them with creation configuration', () => {
		const cw = coreWeaveOptions();
		const key = (env: Record<string, string>) =>
			parseWarmPoolConfig(env, cw)!.config.profiles[0].key;
		expect(key({ PORT: '3000', ...enabled })).toBe(
			key({ PORT: '3001', ...enabled, MARIMOHUB_COMPUTE_WARM_POOL_SIZE: '2' }),
		);
		expect(key(enabled)).not.toBe(
			key({ ...enabled, MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID: 'changed' }),
		);
		expect(key(enabled)).not.toBe(key({ ...enabled, MARIMOHUB_SURFACES: 'vscode' }));
		expect(key(enabled)).not.toBe(key({ ...enabled, MARIMOHUB_SURFACE_VSCODE_PORT: '8444' }));
	});

	it('rejects the exact lifetime boundary and accepts one second more', () => {
		const { config } = parseWarmPoolConfig(enabled, coreWeaveOptions())!;
		const seconds = (config.minimumRemainingMs + config.creationTimeoutMs) / 1000;
		expect(() => parseWarmPoolConfig(enabled, coreWeaveOptions(seconds))).toThrow(
			'provider lifetime longer',
		);
		expect(parseWarmPoolConfig(enabled, coreWeaveOptions(seconds + 1))!.config.enabled).toBe(true);
	});

	it('allows disabling a pool whose lifetime no longer permits warm creation', () => {
		const parsed = parseWarmPoolConfig(
			{},
			{
				...coreWeaveOptions(14400),
				startupTimeoutMs: Millis.of(0),
			},
		)!;
		expect(parsed.backend).toBe('coreweave');
		expect(parsed.config.enabled).toBe(false);
	});

	it('changes the fingerprint when the effective default image changes', () => {
		const original = parseWarmPoolConfig(enabled, options)!.config.profiles[0].key;
		const changed = parseWarmPoolConfig(enabled, { ...options, images: ['new-default'] })!;
		expect(changed.config.profiles[0].key).not.toBe(original);
	});

	it('changes the fingerprint when a pod template is edited at the same path', () => {
		const dir = mkdtempSync(join(tmpdir(), 'warm-pool-template-'));
		try {
			const path = join(dir, 'pod.yaml');
			const env = {
				...enabled,
				MARIMOHUB_COMPUTE_BACKEND: 'kubernetes',
				MARIMOHUB_COMPUTE_KUBERNETES_POD_TEMPLATE_FILE: path,
			};
			const key = () =>
				parseWarmPoolConfig(env, { ...options, compute: makeCompute(env) })!.config.profiles[0].key;
			writeFileSync(path, 'spec: {nodeSelector: {pool: first}}');
			const original = key();
			writeFileSync(path, 'spec: {nodeSelector: {pool: second}}');
			expect(key()).not.toBe(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps existing profile fingerprints stable when selecting all profiles', () => {
		const first = parseWarmPoolConfig(enabled, options)!.config.profiles[0];
		const all = parseWarmPoolConfig(
			{ ...enabled, MARIMOHUB_COMPUTE_WARM_POOL_PROFILES: 'all' },
			options,
		)!;
		expect(all.config.profiles[0]).toEqual(first);
	});
});

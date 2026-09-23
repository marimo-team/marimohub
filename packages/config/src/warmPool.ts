import { createHash } from 'node:crypto';
import { WARM_POOL_MAX_IDLE_MS } from '@marimo-hub/core';
import type { Millis, SandboxProvider, WarmPoolConfig } from '@marimo-hub/core';
import type { ComputeProfilesConfig } from './computeProfiles';
import type { Env } from './env';
import { parseBool, parseEnum, parseIntEnv } from './env';
import { ConfigError } from './errors';

export function parseWarmPoolConfig(
	env: Env,
	options: {
		backend: string;
		compute: SandboxProvider;
		images: readonly string[];
		profiles: ComputeProfilesConfig;
		sessionMaxLifetimeMs: Millis;
		startupTimeoutMs?: Millis;
	},
): { backend: string; config: WarmPoolConfig } | undefined {
	const enabled = parseBool(env, 'MARIMOHUB_COMPUTE_WARM_POOL_ENABLED');
	const size = parseIntEnv(env, 'MARIMOHUB_COMPUTE_WARM_POOL_SIZE') ?? 1;
	if (!Number.isSafeInteger(size) || size < 1) {
		throw new ConfigError('MARIMOHUB_COMPUTE_WARM_POOL_SIZE must be a positive safe integer', {
			variable: 'MARIMOHUB_COMPUTE_WARM_POOL_SIZE',
		});
	}
	const selection = parseEnum(env, 'MARIMOHUB_COMPUTE_WARM_POOL_PROFILES', {
		allowed: ['default', 'all'] as const,
		fallback: 'default',
	});
	const support = options.compute.warmPool;
	if (!support || !options.compute.connectExisting) {
		if (enabled)
			throw new ConfigError(`The ${options.backend} compute backend does not support warm pools`, {
				variable: 'MARIMOHUB_COMPUTE_WARM_POOL_ENABLED',
			});
		return;
	}
	const creationTimeoutMs = 5 * 60_000;
	const minimumRemainingMs =
		options.sessionMaxLifetimeMs + (options.startupTimeoutMs ?? 120_000) + 10 * 60_000;
	const providerLifetimeMs = support.maxLifetimeMs ?? undefined;
	if (
		enabled &&
		support.maxLifetimeMs !== null &&
		(options.startupTimeoutMs === 0 ||
			!Number.isFinite(providerLifetimeMs) ||
			support.maxLifetimeMs <= minimumRemainingMs + creationTimeoutMs)
	) {
		throw new ConfigError(
			'Warm pools require a finite startup timeout and a provider lifetime longer than the session lifetime plus startup, ten minutes for teardown, and five minutes for warm creation.',
			{ variable: 'MARIMOHUB_COMPUTE_WARM_POOL_ENABLED' },
		);
	}
	const configuration = JSON.stringify({
		version: 1,
		backend: options.backend,
		image: options.images[0],
		env: Object.fromEntries(
			Object.entries(env)
				.filter(
					([key]) =>
						(key.startsWith('MARIMOHUB_COMPUTE_') &&
							!key.startsWith('MARIMOHUB_COMPUTE_WARM_POOL_')) ||
						key.startsWith('MARIMOHUB_SANDBOX_') ||
						key.startsWith('MARIMOHUB_SURFACE_') ||
						key === 'MARIMOHUB_SURFACES',
				)
				.sort(([a], [b]) => a.localeCompare(b)),
		),
		provider: support.configuration,
		providerLifetimeMs,
		minimumRemainingMs,
		maxIdleMs: WARM_POOL_MAX_IDLE_MS,
	});
	const configured =
		options.profiles.profiles.length > 0
			? options.profiles.profiles
			: [{ name: undefined, resources: {} }];
	const selected = selection === 'all' ? configured : configured.slice(0, 1);
	return {
		backend: options.backend,
		config: {
			enabled,
			size,
			creationTimeoutMs,
			minimumRemainingMs,
			providerLifetimeMs,
			profiles: selected.map((profile) => ({
				...profile,
				image: options.images[0],
				key: createHash('sha256')
					.update(configuration)
					.update(JSON.stringify(profile))
					.digest('hex'),
			})),
		},
	};
}

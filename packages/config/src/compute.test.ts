import { describe, it, expect } from 'vitest';
import { Millis, Seconds } from '@marimo-hub/core';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { LocalCompute } from '@marimo-hub/compute-local';
import { DockerCompute } from '@marimo-hub/compute-container/docker';
import { PodmanCompute } from '@marimo-hub/compute-container/podman';
import { CoreWeaveCompute } from '@marimo-hub/compute-coreweave';
import { KubernetesCompute } from '@marimo-hub/compute-kubernetes';
import {
	makeCompute,
	resolveLifetimeBackstop,
	resolveSandboxImages,
	usesSandboxNativeObjectStorage,
} from './compute';
import { ConfigError } from './errors';

function getConfigError(run: () => unknown): ConfigError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return error as ConfigError;
	}
	throw new Error('Expected configuration to fail');
}

/** Peek at a provider's private constructor config (test-only). */
const configOf = (provider: unknown) =>
	(
		provider as {
			config: {
				image?: string;
				template?: string;
				host?: string;
				bindHost?: string;
				network?: string;
				idleFallbackMs?: number;
			};
		}
	).config;

/**
 * Backend-selector tests for `makeCompute`. It takes an env object, so each case
 * is hermetic — no `process.env`, no live SDK. Adapter constructors that touch a
 * vendor SDK (CoreWeave/E2B/Kubernetes) are exercised only on the throw-before-
 * construct paths; the lazy ones (Modal/Docker/Local) are constructed directly.
 */

const modalEnv = {
	MARIMOHUB_COMPUTE_BACKEND: 'modal',
	MARIMOHUB_COMPUTE_MODAL_TOKEN_ID: 'tid',
	MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET: 'tsecret',
	MARIMOHUB_COMPUTE_IMAGE: 'img',
};

describe('makeCompute backend selection', () => {
	it('requires an explicit backend (no default)', () => {
		expect(() => makeCompute({})).toThrow(/MARIMOHUB_COMPUTE_BACKEND/);
	});

	it('selects modal', () => {
		expect(makeCompute(modalEnv)).toBeInstanceOf(ModalCompute);
	});

	it('folds a mixed-case modal backend selector', () => {
		expect(makeCompute({ ...modalEnv, MARIMOHUB_COMPUTE_BACKEND: 'Modal' })).toBeInstanceOf(
			ModalCompute,
		);
	});

	it('sets the Modal idle fallback to 1.5x the graceful session timeout', () => {
		expect(
			configOf(makeCompute(modalEnv, { sessionIdleTimeoutMs: Millis.minutes(30) })).idleFallbackMs,
		).toBe(Millis.minutes(45));
	});

	it('selects docker', () => {
		expect(makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'docker' })).toBeInstanceOf(DockerCompute);
	});

	it('selects podman', () => {
		expect(makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'podman' })).toBeInstanceOf(PodmanCompute);
	});

	it('forwards Podman-specific connection and network settings', () => {
		expect(
			configOf(
				makeCompute({
					MARIMOHUB_COMPUTE_BACKEND: 'podman',
					MARIMOHUB_COMPUTE_PODMAN_HOST: 'kernels.example.test',
					MARIMOHUB_COMPUTE_PODMAN_BIND_HOST: '0.0.0.0',
					MARIMOHUB_COMPUTE_PODMAN_NETWORK: 'marimohub',
				}),
			),
		).toMatchObject({
			host: 'kernels.example.test',
			bindHost: '0.0.0.0',
			network: 'marimohub',
		});
	});

	it('selects local', () => {
		expect(makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'local' })).toBeInstanceOf(LocalCompute);
	});

	it('selects wandb (the CoreWeave adapter behind the W&B gateway)', () => {
		expect(
			makeCompute({
				MARIMOHUB_COMPUTE_BACKEND: 'wandb',
				MARIMOHUB_COMPUTE_WANDB_API_KEY: 'wb-key',
				MARIMOHUB_COMPUTE_IMAGE: 'img',
			}),
		).toBeInstanceOf(CoreWeaveCompute);
	});

	it.each(['none', 'noop'])('returns a no-op provider for %s', (backend) => {
		const provider = makeCompute({ MARIMOHUB_COMPUTE_BACKEND: backend });
		expect(() => provider.create('sb-x' as never)).toThrow(/No compute backend configured/);
	});

	it('no-op provider proxy resolves to null', async () => {
		const provider = makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'none' });
		expect(await provider.proxy(new Request('http://x/'))).toBeNull();
	});
});

describe('makeCompute fail-fast', () => {
	it('throws for the cloudflare backend (needs a Workers binding)', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'cloudflare' })).toThrow(ConfigError);
	});

	it('preserves the missing-backend error for an empty selector', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: '' })).toThrow(
			/Missing required env var: MARIMOHUB_COMPUTE_BACKEND/,
		);
	});

	it('rejects an unknown backend with the shared enum error', () => {
		const error = getConfigError(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'firecracker' }));

		expect(error.message).toMatch(/Invalid MARIMOHUB_COMPUTE_BACKEND: firecracker/);
		for (const alias of ['noop', 'cloudflare']) {
			expect(error.message).toContain(alias);
			expect(error.opts.remediation).toContain(alias);
		}
	});

	it('requires the modal token id', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'modal' })).toThrow(
			/MARIMOHUB_COMPUTE_MODAL_TOKEN_ID/,
		);
	});

	it('requires the modal token secret', () => {
		expect(() =>
			makeCompute({
				MARIMOHUB_COMPUTE_BACKEND: 'modal',
				MARIMOHUB_COMPUTE_MODAL_TOKEN_ID: 'tid',
				MARIMOHUB_COMPUTE_IMAGE: 'img',
			}),
		).toThrow(/MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET/);
	});

	it('requires a modal image', () => {
		expect(() =>
			makeCompute({
				MARIMOHUB_COMPUTE_BACKEND: 'modal',
				MARIMOHUB_COMPUTE_MODAL_TOKEN_ID: 'tid',
				MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET: 'tsecret',
			}),
		).toThrow(/MARIMOHUB_COMPUTE_IMAGE/);
	});

	it('selects kubernetes', () => {
		expect(makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'kubernetes' })).toBeInstanceOf(
			KubernetesCompute,
		);
	});

	it('rejects an invalid kubernetes image pull policy', () => {
		expect(() =>
			makeCompute({
				MARIMOHUB_COMPUTE_BACKEND: 'kubernetes',
				MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY: 'ifnotpresent',
			}),
		).toThrow(/MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY/);
	});

	it('requires the e2b api key before constructing the adapter', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'e2b' })).toThrow(
			/MARIMOHUB_COMPUTE_E2B_API_KEY/,
		);
	});

	it('requires the coreweave api key before constructing the adapter', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'coreweave' })).toThrow(
			/MARIMOHUB_COMPUTE_COREWEAVE_API_KEY/,
		);
	});

	it('requires the wandb api key before constructing the adapter', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'wandb' })).toThrow(
			/MARIMOHUB_COMPUTE_WANDB_API_KEY/,
		);
	});

	it('rejects an unknown coreweave object-storage permission', () => {
		expect(() =>
			makeCompute({
				MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
				MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
				MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS: 'org-data',
				MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION: 'write-only',
			}),
		).toThrow(/OBJECT_STORAGE_PERMISSION/);
	});
});

describe('usesSandboxNativeObjectStorage', () => {
	it('is true only for the coreweave backend with a non-empty bucket list', () => {
		const buckets = { MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS: 'org-data' };
		expect(
			usesSandboxNativeObjectStorage({ MARIMOHUB_COMPUTE_BACKEND: 'coreweave', ...buckets }),
		).toBe(true);
		expect(usesSandboxNativeObjectStorage({ MARIMOHUB_COMPUTE_BACKEND: 'coreweave' })).toBe(false);
		expect(usesSandboxNativeObjectStorage({ MARIMOHUB_COMPUTE_BACKEND: 'modal', ...buckets })).toBe(
			false,
		);
		expect(usesSandboxNativeObjectStorage(buckets)).toBe(false);
	});

	it('stays false for wandb (CAIOS vending is unconfirmed through the W&B gateway)', () => {
		expect(
			usesSandboxNativeObjectStorage({
				MARIMOHUB_COMPUTE_BACKEND: 'wandb',
				MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS: 'org-data',
			}),
		).toBe(false);
	});
});

describe('sandbox image list', () => {
	it('resolveSandboxImages parses MARIMOHUB_COMPUTE_IMAGE as a comma-separated list', () => {
		expect(
			resolveSandboxImages({
				MARIMOHUB_COMPUTE_BACKEND: 'modal',
				MARIMOHUB_COMPUTE_IMAGE: 'img-a, img-b,img-c',
			}),
		).toEqual(['img-a', 'img-b', 'img-c']);
		expect(resolveSandboxImages({})).toEqual([]);
	});

	it.each(['local', 'none', 'noop'])('resolveSandboxImages is empty for %s', (backend) => {
		expect(
			resolveSandboxImages({ MARIMOHUB_COMPUTE_BACKEND: backend, MARIMOHUB_COMPUTE_IMAGE: 'img' }),
		).toEqual([]);
	});

	it('resolveSandboxImages prefers the e2b template list over the image list', () => {
		expect(
			resolveSandboxImages({
				MARIMOHUB_COMPUTE_BACKEND: 'e2b',
				MARIMOHUB_COMPUTE_E2B_TEMPLATE: 'tpl-a,tpl-b',
				MARIMOHUB_COMPUTE_IMAGE: 'img-a,img-b',
			}),
		).toEqual(['tpl-a', 'tpl-b']);
		expect(
			resolveSandboxImages({
				MARIMOHUB_COMPUTE_BACKEND: 'e2b',
				MARIMOHUB_COMPUTE_IMAGE: 'img-a,img-b',
			}),
		).toEqual(['img-a', 'img-b']);
	});

	it('constructs providers with the first image as their default', () => {
		expect(
			configOf(makeCompute({ ...modalEnv, MARIMOHUB_COMPUTE_IMAGE: 'img-a,img-b' })).image,
		).toBe('img-a');
		expect(
			configOf(
				makeCompute({
					MARIMOHUB_COMPUTE_BACKEND: 'docker',
					MARIMOHUB_COMPUTE_IMAGE: 'img-a,img-b',
				}),
			).image,
		).toBe('img-a');
		expect(
			configOf(
				makeCompute({
					MARIMOHUB_COMPUTE_BACKEND: 'podman',
					MARIMOHUB_COMPUTE_IMAGE: 'img-a,img-b',
				}),
			).image,
		).toBe('img-a');
	});

	it('e2b template default is the first template id', () => {
		const compute = makeCompute({
			MARIMOHUB_COMPUTE_BACKEND: 'e2b',
			MARIMOHUB_COMPUTE_E2B_API_KEY: 'key',
			MARIMOHUB_COMPUTE_E2B_TEMPLATE: 'tpl-a,tpl-b',
		});
		expect(configOf(compute).template).toBe('tpl-a');
	});

	it('modal rejects an image value that parses to an empty list', () => {
		expect(() => makeCompute({ ...modalEnv, MARIMOHUB_COMPUTE_IMAGE: ' , ' })).toThrow(
			/at least one image/,
		);
	});
});

describe('provider lifetime backstop', () => {
	const KEY = 'MARIMOHUB_COMPUTE_COREWEAVE_MAX_LIFETIME_SECONDS';

	it('defaults to 2× the session TTL when unset', () => {
		expect(resolveLifetimeBackstop({}, KEY, Seconds.of(14400))).toBe(28800);
	});

	it('is undefined when unset and no session TTL is provided', () => {
		expect(resolveLifetimeBackstop({}, KEY)).toBeUndefined();
	});

	it('honors an explicit value >= the session TTL', () => {
		expect(resolveLifetimeBackstop({ [KEY]: '14400' }, KEY, Seconds.of(14400))).toBe(14400);
		expect(resolveLifetimeBackstop({ [KEY]: '86400' }, KEY, Seconds.of(14400))).toBe(86400);
	});

	it('rejects an explicit value below the session TTL (would SIGKILL before the graceful save)', () => {
		expect(() => resolveLifetimeBackstop({ [KEY]: '3600' }, KEY, Seconds.of(14400))).toThrow(
			ConfigError,
		);
		expect(() => resolveLifetimeBackstop({ [KEY]: '3600' }, KEY, Seconds.of(14400))).toThrow(
			/must be >= the session TTL/,
		);
	});

	it('fails fast through makeCompute for a coreweave cap below the session TTL', () => {
		expect(() =>
			makeCompute(
				{
					MARIMOHUB_COMPUTE_BACKEND: 'coreweave',
					MARIMOHUB_COMPUTE_COREWEAVE_API_KEY: 'key',
					MARIMOHUB_COMPUTE_COREWEAVE_MAX_LIFETIME_SECONDS: '3600',
				},
				{ sessionMaxLifetimeSeconds: Seconds.of(14400) },
			),
		).toThrow(/must be >= the session TTL/);
	});

	it('fails fast through makeCompute for a wandb cap below the session TTL', () => {
		expect(() =>
			makeCompute(
				{
					MARIMOHUB_COMPUTE_BACKEND: 'wandb',
					MARIMOHUB_COMPUTE_WANDB_API_KEY: 'wb-key',
					MARIMOHUB_COMPUTE_WANDB_MAX_LIFETIME_SECONDS: '3600',
				},
				{ sessionMaxLifetimeSeconds: Seconds.of(14400) },
			),
		).toThrow(/must be >= the session TTL/);
	});
});

describe('makeCompute local port range', () => {
	it('accepts a valid "start-end" range', () => {
		expect(
			makeCompute({
				MARIMOHUB_COMPUTE_BACKEND: 'local',
				MARIMOHUB_COMPUTE_LOCAL_PORTS: '2718-2723',
			}),
		).toBeInstanceOf(LocalCompute);
	});

	it.each(['2718', '2718_2723', 'abc-def', '2718-'])(
		'throws ConfigError on the malformed range %o',
		(ports) => {
			expect(() =>
				makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'local', MARIMOHUB_COMPUTE_LOCAL_PORTS: ports }),
			).toThrow(/Invalid MARIMOHUB_COMPUTE_LOCAL_PORTS/);
		},
	);

	it.each(['3000-2999', '0-1', '1-65536', `${'9'.repeat(400)}-${'9'.repeat(400)}`])(
		'throws ConfigError on the invalid range %o',
		(ports) => {
			expect(() =>
				makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'local', MARIMOHUB_COMPUTE_LOCAL_PORTS: ports }),
			).toThrow(/Invalid MARIMOHUB_COMPUTE_LOCAL_PORTS/);
		},
	);
});

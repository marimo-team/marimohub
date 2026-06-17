import { describe, it, expect } from 'vitest';
import { Seconds } from '@marimo-hub/core';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { LocalCompute } from '@marimo-hub/compute-local';
import { DockerCompute } from '@marimo-hub/compute-docker';
import { makeCompute, resolveLifetimeBackstop, resolveSandboxImages } from './compute';
import { ConfigError } from './errors';

/** Peek at a provider's private constructor config (test-only). */
const configOf = (provider: unknown) =>
	(provider as { config: { image?: string; template?: string } }).config;

/**
 * Backend-selector tests for `makeCompute`. It takes an env object, so each case
 * is hermetic — no `process.env`, no live SDK. Adapter constructors that touch a
 * vendor SDK (CoreWeave/E2B/Kubernetes) are exercised only on the throw-before-
 * construct paths; the lazy ones (Modal/Docker/Local) are constructed directly.
 */

const modalEnv = {
	MARIMOHUB_COMPUTE_MODAL_TOKEN_ID: 'tid',
	MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET: 'tsecret',
	MARIMOHUB_COMPUTE_IMAGE: 'img',
};

describe('makeCompute backend selection', () => {
	it('defaults to the modal backend', () => {
		expect(makeCompute(modalEnv)).toBeInstanceOf(ModalCompute);
	});

	it('selects modal explicitly', () => {
		expect(makeCompute({ ...modalEnv, MARIMOHUB_COMPUTE_BACKEND: 'modal' })).toBeInstanceOf(
			ModalCompute,
		);
	});

	it('selects docker', () => {
		expect(makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'docker' })).toBeInstanceOf(DockerCompute);
	});

	it('selects local', () => {
		expect(makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'local' })).toBeInstanceOf(LocalCompute);
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

	it('throws on an unknown backend', () => {
		expect(() => makeCompute({ MARIMOHUB_COMPUTE_BACKEND: 'bogus' })).toThrow(
			/Unknown MARIMOHUB_COMPUTE_BACKEND/,
		);
	});

	it('requires the modal token id on the default path', () => {
		expect(() => makeCompute({})).toThrow(/MARIMOHUB_COMPUTE_MODAL_TOKEN_ID/);
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
});

describe('sandbox image list', () => {
	it('resolveSandboxImages parses MARIMOHUB_COMPUTE_IMAGE as a comma-separated list', () => {
		expect(resolveSandboxImages({ MARIMOHUB_COMPUTE_IMAGE: 'img-a, img-b,img-c' })).toEqual([
			'img-a',
			'img-b',
			'img-c',
		]);
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
});

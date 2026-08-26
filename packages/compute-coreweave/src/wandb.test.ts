import type { GetSandboxResult, SandboxTransport } from '@coreweave/cwsandbox';
import { describe, it, expect, vi } from 'vitest';
import { NOT_A_DIRECTORY_EXIT_CODE, NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import { Seconds } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core';
import {
	computeContract,
	isContractNonDirectoryFindCommand,
} from '@marimo-hub/core/testing/compute-contract';
import { expectExecResult } from '@marimo-hub/core/testing';
import { CoreWeaveCompute } from './index';
import {
	buildWandbMetadata,
	createWandbCompute,
	serviceAddressResolver,
	withServiceAddressCache,
} from './wandb';
import type { WandbConfig } from './wandb';
import { makeWorld, procResult } from './testWorld';

const SANDBOX_ID = 'sb-abc' as SandboxId;

const baseConfig: WandbConfig = { apiKey: 'wb-key', image: 'my-image' };

describe('buildWandbMetadata', () => {
	it('sends the W&B API key and the constant telemetry headers', () => {
		expect(buildWandbMetadata({ apiKey: 'wb-key' })).toEqual({
			'x-wandb-api-key': 'wb-key',
			'x-cwsandbox-client-version': '0.0.0',
			'x-wandb-sdk-version': '0.0.0',
			'x-sandbox-integration': 'js-sdk',
		});
	});

	it('includes entity and project headers only when set', () => {
		const metadata = buildWandbMetadata({ apiKey: 'k', entity: 'my-team', project: 'sandbox' });
		expect(metadata['x-entity-id']).toBe('my-team');
		expect(metadata['x-project-name']).toBe('sandbox');
	});

	it('never emits an authorization header (the W&B key is the sole credential)', () => {
		const metadata = buildWandbMetadata({ apiKey: 'k', entity: 'e', project: 'p' });
		expect(Object.keys(metadata).some((k) => k.toLowerCase() === 'authorization')).toBe(false);
	});

	it('rejects a missing or whitespace-only API key up front', () => {
		expect(() => buildWandbMetadata({ apiKey: '  ' })).toThrow(/missing or blank/);
	});

	it('trims values and drops whitespace-only entity/project', () => {
		const metadata = buildWandbMetadata({
			apiKey: 'wb-key\n',
			entity: ' my-team ',
			project: '  ',
		});
		expect(metadata['x-wandb-api-key']).toBe('wb-key');
		expect(metadata['x-entity-id']).toBe('my-team');
		expect(metadata).not.toHaveProperty('x-project-name');
	});
});

describe('serviceAddressResolver', () => {
	it('builds a plain-HTTP URL from the sandbox serviceAddress', async () => {
		const resolve = serviceAddressResolver(async () => ({ serviceAddress: '166.19.118.62' }));
		expect(await resolve('cw-1', 2718)).toBe('http://166.19.118.62:2718');
	});

	it('brackets IPv6 addresses', async () => {
		const resolve = serviceAddressResolver(async () => ({ serviceAddress: '2001:db8::1' }));
		expect(await resolve('cw-1', 2718)).toBe('http://[2001:db8::1]:2718');
	});

	it('throws when no serviceAddress is assigned', async () => {
		const resolve = serviceAddressResolver(async () => ({}));
		await expect(resolve('cw-1', 2718)).rejects.toThrow(/no serviceAddress/);
	});
});

describe('withServiceAddressCache', () => {
	function transport(
		get: SandboxTransport['get'] = vi.fn(
			async ({ sandboxId }: { sandboxId: string }): Promise<GetSandboxResult> => ({
				sandboxId,
				status: 'running',
				serviceAddress: '166.19.118.62',
			}),
		),
	) {
		return {
			start: async () => ({ sandboxId: 'cw-1', status: 'creating' as const }),
			get,
			list: async () => ({ sandboxes: [] }),
			delete: async () => {},
			exec: async () => {
				throw new Error('unused');
			},
			startCommand: async () => {
				throw new Error('unused');
			},
			streamLogs: async () => {
				throw new Error('unused');
			},
			stop: async () => {},
			writeFile: async () => {},
			readFile: async () => ({ content: new Uint8Array() }),
		} satisfies SandboxTransport;
	}

	it('reuses the latest boot Get result for URL resolution', async () => {
		const raw = transport();
		const cache = withServiceAddressCache(raw);
		await cache.transport.get({ sandboxId: 'cw-1' });
		const fallback = vi.fn();
		expect(await cache.get('cw-1', fallback)).toMatchObject({
			serviceAddress: '166.19.118.62',
		});
		expect(vi.mocked(raw.get)).toHaveBeenCalledTimes(1);
		expect(fallback).not.toHaveBeenCalled();
		await cache.transport.delete({ sandboxId: 'cw-1' });
		const afterDelete = vi.fn(async () => ({
			sandboxId: 'cw-1',
			status: 'running' as const,
			serviceAddress: '10.0.0.3',
		}));
		await cache.get('cw-1', afterDelete);
		expect(afterDelete).toHaveBeenCalledOnce();
		await cache.get('cw-1', afterDelete);
		expect(afterDelete).toHaveBeenCalledOnce();
	});

	it('falls back when the poll response has no address', async () => {
		const raw = transport(
			vi.fn(async ({ sandboxId }: { sandboxId: string }) => ({
				sandboxId,
				status: 'running' as const,
			})),
		);
		const cache = withServiceAddressCache(raw);
		await cache.transport.get({ sandboxId: 'cw-1' });
		const fallback = vi.fn(async () => ({
			sandboxId: 'cw-1',
			status: 'running' as const,
			serviceAddress: '10.0.0.2',
		}));
		expect(await cache.get('cw-1', fallback)).toMatchObject({ serviceAddress: '10.0.0.2' });
		expect(fallback).toHaveBeenCalledOnce();
	});
});

describe('createWandbCompute', () => {
	it('returns a CoreWeaveCompute (same adapter, W&B-authenticated client)', () => {
		expect(createWandbCompute(baseConfig)).toBeInstanceOf(CoreWeaveCompute);
	});

	it('falls back to the default gateway on a set-but-empty baseUrl', () => {
		expect(createWandbCompute({ ...baseConfig, baseUrl: '' })).toBeInstanceOf(CoreWeaveCompute);
	});

	it('an injected client takes over (test seam), and the adapter works through it', async () => {
		const world = makeWorld();
		const compute = createWandbCompute(baseConfig, world.client);
		const result = await compute.create(SANDBOX_ID).exec('echo hi');
		expectExecResult(result, { success: true, stdout: '', stderr: '' });
		expect(world.created).toHaveLength(1);
		expect(world.created[0].containerImage).toBe('my-image');
	});

	it('passes the restricted config subset through to the CoreWeave adapter', async () => {
		const world = makeWorld();
		const compute = createWandbCompute(
			{
				...baseConfig,
				ownerTag: 'my-hub',
				maxLifetimeSeconds: Seconds.of(3600),
			},
			world.client,
		);
		await compute.create(SANDBOX_ID).exec('true');
		const opts = world.created[0];
		expect(opts.tags).toContain('my-hub');
		expect(opts.maxLifetimeSeconds).toBe(3600);
		// Gateway-unsupported knobs are not configurable: adapter defaults apply.
		expect(opts.profileNames).toBeUndefined();
		expect(opts.objectStorageAccess).toBeUndefined();
		expect(opts.network).toMatchObject({ ingressMode: 'public', egressMode: 'internet' });
	});
});

computeContract(
	'WandbCompute',
	() =>
		createWandbCompute(
			baseConfig,
			makeWorld({
				runImpl: async (command) => {
					if (command.at(-1) === 'false') {
						return procResult({ exitCode: 1, failed: true, ok: false, stderr: 'failed' });
					}
					if (isContractNonDirectoryFindCommand(command.at(-1))) {
						return procResult({
							exitCode: NOT_A_DIRECTORY_EXIT_CODE,
							failed: true,
							ok: false,
							stderr: NOT_A_DIRECTORY_MARKER,
						});
					}
					return procResult();
				},
			}).client,
		),
	{ mountFallsBack: true, semantics: { failingCommand: 'false' } },
);

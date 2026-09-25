import { describe, it, expect } from 'vitest';
import { NOT_A_DIRECTORY_EXIT_CODE, NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import { Seconds } from '@marimo-hub/core/duration';
import type { SandboxId } from '@marimo-hub/core/ids';
import {
	computeContract,
	isContractNonDirectoryFindCommand,
} from '@marimo-hub/core/testing/compute-contract';
import { expectExecResult } from '@marimo-hub/core/testing/result-assertions';
import { CoreWeaveCompute } from './index';
import { createWandbCompute, serviceUrlResolver } from './wandb';
import type { WandbConfig } from './wandb';
import { contractLaunchProcess, fakeProcess, makeWorld, procResult } from './testWorld';

const SANDBOX_ID = 'sb-abc' as SandboxId;

const baseConfig: WandbConfig = { apiKey: 'wb-key', image: 'my-image' };

describe('serviceUrlResolver', () => {
	const URLS = [
		{ name: 'other', port: 8080, url: 'https://8080.cw-1.example.com' },
		{ name: 'kernel', port: 2718, url: 'https://2718.cw-1.example.com' },
	];
	const handle = (serviceUrls?: typeof URLS) => ({ sandboxId: 'cw-1', serviceUrls });

	it('answers from the handle metadata without a Get round-trip', async () => {
		let gets = 0;
		const resolve = serviceUrlResolver(async () => {
			gets++;
			return {};
		});
		expect(await resolve(handle(URLS) as never, 2718)).toBe('https://2718.cw-1.example.com');
		expect(gets).toBe(0);
	});

	it('falls back to a Get when the handle has no URL for the port', async () => {
		const resolve = serviceUrlResolver(async () => ({ serviceUrls: URLS }));
		expect(await resolve(handle() as never, 2718)).toBe('https://2718.cw-1.example.com');
	});

	it('throws when no service URL is assigned for the port', async () => {
		const resolve = serviceUrlResolver(async () => ({}));
		await expect(resolve(handle() as never, 2718)).rejects.toThrow(/no service URL for port 2718/);
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

	it('uses the assigned HTTPS URL with an injected client', async () => {
		const world = makeWorld();
		const compute = createWandbCompute({ ...baseConfig, kernelPort: 8080 }, world.client);
		await expect(
			compute.create(SANDBOX_ID).exposePort(8080, { hostname: 'unused.example.com' }),
		).resolves.toEqual({ url: 'https://cw-1-8080.sandbox.test' });
	});

	it('rejects a legacy HTTP endpoint after a hub restart', async () => {
		const world = makeWorld();
		const legacy = new CoreWeaveCompute({ image: baseConfig.image }, world.client);
		await legacy.create(SANDBOX_ID).ready!();
		const compute = createWandbCompute(baseConfig, world.client);
		await expect(
			compute.create(SANDBOX_ID).exposePort(2718, { hostname: 'unused.example.com' }),
		).rejects.toThrow(/expected HTTPS/);
		expect(world.created).toHaveLength(1);
		expect(world.deleted).toEqual([]);
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
		expect(opts.objectStorageAccess).toBeUndefined();
		expect(opts.services).toEqual([
			{
				name: 'kernel',
				port: 2718,
				protocol: 'tcp',
				visibility: 'public',
				endpoint: { kind: 'https', auth: 'open', requestTimeoutSeconds: 900 },
			},
		]);
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
				startImpl: async (command) => contractLaunchProcess(command) ?? fakeProcess(),
			}).client,
		),
	{ mountFallsBack: true, semantics: { failingCommand: 'false', launch: {} } },
);

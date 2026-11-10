import { describe, expect, it, vi } from 'vitest';
import { CoreWeaveCompute } from './index';
import { createSandboxId } from '@marimo-hub/core/ids';
import { makeWorld } from './testWorld';

describe('CoreWeave preconnection', () => {
	it('uses only validated provider references and preserves Gateway-only behavior', async () => {
		const world = makeWorld();
		const preconnect = vi.fn(async () => true);
		const client = { ...world.client, preconnect };
		const provider = new CoreWeaveCompute({ dataPlaneMode: 'auto' }, client);
		const id = createSandboxId();
		const options = {
			reconnectReference: JSON.stringify({
				kind: 'coreweave-v1',
				hubId: id,
				sandboxId: 'provider-id',
			}),
			timeoutMs: 5000,
			signal: new AbortController().signal,
		};
		expect(await provider.preconnect!(id, options)).toBe(true);
		expect(preconnect).toHaveBeenCalledWith('provider-id', options);
		expect(await provider.preconnect!(createSandboxId(), options)).toBe(false);
		expect(await provider.preconnect!(id, { ...options, reconnectReference: 'invalid' })).toBe(
			false,
		);
		expect(preconnect).toHaveBeenCalledTimes(1);
		expect(world.fromIdCalls).toEqual([]);
		expect(world.listCalls).toEqual([]);
		expect(world.created).toEqual([]);
		expect(new CoreWeaveCompute({ dataPlaneMode: 'gateway' }, client).preconnect).toBeUndefined();
	});
});

import { describe, expect, it, vi } from 'vitest';
import { CoreWeaveCompute } from './index';
import { createSandboxId } from '@marimo-hub/core/ids';
import { makeWorld } from './testWorld';
import type * as SdkNode from '@coreweave/cwsandbox/node';

vi.mock('@coreweave/cwsandbox/node', async (importOriginal) => ({
	...(await importOriginal<typeof SdkNode>()),
	createSandboxClient: () => makeWorld().client,
}));

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

	it('degrades to one warning when the SDK client lacks the patched method', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const provider = new CoreWeaveCompute({ apiKey: 'key', dataPlaneMode: 'auto' });
		const id = createSandboxId();
		const options = {
			reconnectReference: JSON.stringify({ kind: 'coreweave-v1', hubId: id, sandboxId: 'p' }),
			timeoutMs: 5000,
			signal: new AbortController().signal,
		};
		expect(await provider.preconnect!(id, options)).toBe(false);
		expect(await provider.preconnect!(id, options)).toBe(false);
		const events = warn.mock.calls
			.flat()
			.filter((line) => String(line).includes('coreweave_preconnect_unsupported'));
		expect(events).toHaveLength(1);
	});
});

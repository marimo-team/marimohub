import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeSDK from '@coreweave/cwsandbox/node';
import type { SandboxId } from '@marimo-hub/core/ids';
import { CoreWeaveCompute } from './index';
import type { CoreWeaveConfig } from './index';
import { makeWorld } from './testWorld';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('@coreweave/cwsandbox/node', async (importOriginal) => ({
	...(await importOriginal<typeof NodeSDK>()),
	createSandboxClient: createClient,
}));

describe('CoreWeave SDK client configuration', () => {
	beforeEach(() => {
		createClient.mockReset().mockReturnValue(makeWorld().client);
	});

	it.each<CoreWeaveConfig['dataPlaneMode']>([undefined, 'direct', 'auto', 'gateway'])(
		'passes data connection mode %j to the SDK',
		(dataPlaneMode) => {
			const compute = new CoreWeaveCompute({ apiKey: 'key', dataPlaneMode });
			compute.create('sb-one' as SandboxId);
			compute.create('sb-two' as SandboxId);

			expect(createClient).toHaveBeenCalledExactlyOnceWith({
				apiKey: 'key',
				baseUrl: 'https://api.cwsandbox.com',
				dataPlaneMode: dataPlaneMode ?? 'direct',
			});
		},
	);
});

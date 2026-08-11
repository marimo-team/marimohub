import { expectTypeOf, it } from 'vitest';
import type { ComputeContractSemantics } from './computeContract';
import { computeContract } from './computeContract';
import { makeFakeCompute } from './fakes';

// Validate the shared contract against the known-good in-memory fake provider.
computeContract('makeFakeCompute', () => makeFakeCompute());

it('requires envProbe when preexistingEnv is configured', () => {
	type PreexistingEnvWithoutProbe = {
		preexistingEnv: {
			name: string;
			value: string;
			setup: () => Promise<() => void>;
		};
	};

	expectTypeOf<PreexistingEnvWithoutProbe>().not.toExtend<ComputeContractSemantics>();
});

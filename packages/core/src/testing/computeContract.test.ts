import { computeContract } from './computeContract';
import { makeFakeCompute } from './fakes';

// Validate the shared contract against the known-good in-memory fake provider.
computeContract('makeFakeCompute', () => makeFakeCompute());

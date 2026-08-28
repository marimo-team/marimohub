import { describe, expect, it } from 'vitest';
import { noopCompute } from '../testing/fakes';
import { asSandboxPortConnector } from './sandbox';

describe('asSandboxPortConnector', () => {
	it('returns undefined when a provider does not advertise the capability', () => {
		expect(asSandboxPortConnector(noopCompute)).toBeUndefined();
	});

	it('requires both the feature flag and connect method', () => {
		expect(
			asSandboxPortConnector({
				...noopCompute,
				brokeredPortConnectionsEnabled: true,
			} as never),
		).toBeUndefined();
		expect(
			asSandboxPortConnector({
				...noopCompute,
				brokeredPortConnectionsEnabled: false,
				connectPort: async () => {
					throw new Error('not used');
				},
			} as never),
		).toBeUndefined();
	});
});

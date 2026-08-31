import { describe, expect, it } from 'vitest';
import { noopCompute } from '../testing/fakes';
import { asSandboxPortConnector } from './sandbox';

describe('asSandboxPortConnector', () => {
	it('returns undefined when a provider does not advertise the capability', () => {
		expect(asSandboxPortConnector(noopCompute)).toBeUndefined();
	});

	it('requires both the capability and connect method', () => {
		expect(
			asSandboxPortConnector({
				...noopCompute,
				capabilities: { multiPort: false, brokeredTcp: true },
			} as never),
		).toBeUndefined();
		expect(
			asSandboxPortConnector({
				...noopCompute,
				capabilities: { multiPort: false, brokeredTcp: false },
				connectPort: async () => {
					throw new Error('not used');
				},
			} as never),
		).toBeUndefined();
		const connector = {
			...noopCompute,
			capabilities: { multiPort: false, brokeredTcp: true },
			connectPort: async () => {
				throw new Error('not used');
			},
		};
		expect(asSandboxPortConnector(connector)).toBe(connector);
	});
});

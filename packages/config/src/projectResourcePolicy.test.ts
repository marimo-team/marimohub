import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectResourceRules } from './projectResourcePolicy';

afterEach(() => vi.restoreAllMocks());
describe('resource policy configuration', () => {
	it.each([undefined, '', '  '])('warns and preserves legacy access when unset (%s)', (value) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(projectResourceRules({ POLICY: value }, 'POLICY')).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('available across projects'));
	});
	it('accepts deny-all without a warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(projectResourceRules({ POLICY: '[]' }, 'POLICY')).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
	});
	it.each(['{"sensitive":', '{}', 'null', '[{"resource":"secret","projects":[]}]'])(
		'rejects malformed policies without echoing them',
		(value) => {
			expect(() => projectResourceRules({ POLICY: value }, 'POLICY')).toThrow(
				'POLICY must be a JSON array',
			);
			expect(() => projectResourceRules({ POLICY: value }, 'POLICY')).not.toThrow(value);
		},
	);
});

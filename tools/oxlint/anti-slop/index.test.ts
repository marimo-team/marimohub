import { describe, expect, it, vi } from 'vitest';
import antiSlopPlugin from './index';

const RULE_NAMES = [
	'no-chained-type-assertions',
	'no-conditional-empty-object-spread',
	'no-known-value-widening',
	'no-object-parameters',
	'no-runtime-typeof',
	'no-shape-in-symbol-names',
	'no-unknown-parameters',
	'no-unknown-type-aliases',
	'no-unsafe-dictionary-type',
	'no-widen-then-assert',
] as const;

describe('anti-slop plugin', () => {
	it('registers every rule under its stable public name', () => {
		expect(Object.keys(antiSlopPlugin.rules).sort()).toEqual([...RULE_NAMES].sort());
	});

	it.each(RULE_NAMES)('%s has diagnostics and creates at least one AST visitor', (name) => {
		const rule = antiSlopPlugin.rules[name];
		expect(rule.meta?.docs?.description).toEqual(expect.any(String));
		expect(Object.keys(rule.meta?.messages ?? {})).not.toHaveLength(0);
		const create = rule.createOnce ?? rule.create;
		expect(create).toBeTypeOf('function');
		const visitors = create!({
			report: vi.fn(),
			sourceCode: {
				getScope: vi.fn(),
				getText: vi.fn(() => ''),
				scopeManager: { scopes: [] },
			},
		} as never);
		expect(Object.keys(visitors ?? {})).not.toHaveLength(0);
	});
});

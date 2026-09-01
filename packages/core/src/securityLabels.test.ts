import { describe, expect, it } from 'vitest';
import {
	isMonotonicRestrictionIncrease,
	MAX_SECURITY_COMPARTMENTS,
	normalizeSecurityLabels,
	ResourceSecurityLabelsSchema,
} from './securityLabels';

const LABELS = { classification: 'SECRET', compartments: ['element-a', 'element-b'] };

describe('ResourceSecurityLabelsSchema', () => {
	it('accepts bounded labels, including an empty compartment set', () => {
		expect(ResourceSecurityLabelsSchema.safeParse(LABELS).success).toBe(true);
		expect(
			ResourceSecurityLabelsSchema.safeParse({ classification: 'CUI', compartments: [] }).success,
		).toBe(true);
		expect(
			ResourceSecurityLabelsSchema.safeParse({
				classification: 'S',
				compartments: Array.from({ length: MAX_SECURITY_COMPARTMENTS }, (_, i) => `c${i}`),
			}).success,
		).toBe(true);
	});

	it.each([
		['whitespace in classification', { classification: 'TOP SECRET', compartments: [] }],
		['empty classification', { classification: '', compartments: [] }],
		['oversized classification', { classification: `S${'x'.repeat(64)}`, compartments: [] }],
		['empty-string compartment', { classification: 'SECRET', compartments: [''] }],
		['non-string compartment', { classification: 'SECRET', compartments: [1] }],
		[
			'too many compartments',
			{
				classification: 'SECRET',
				compartments: Array.from({ length: MAX_SECURITY_COMPARTMENTS + 1 }, (_, i) => `c${i}`),
			},
		],
		['unknown field', { ...LABELS, note: 'raw attribute smuggling' }],
		['missing compartments', { classification: 'SECRET' }],
	])('rejects %s', (_name, value) => {
		expect(ResourceSecurityLabelsSchema.safeParse(value).success).toBe(false);
	});
});

describe('normalizeSecurityLabels', () => {
	it('deduplicates and sorts compartments', () => {
		expect(
			normalizeSecurityLabels({
				classification: 'SECRET',
				compartments: ['element-b', 'element-a', 'element-b'],
			}),
		).toEqual({ classification: 'SECRET', compartments: ['element-a', 'element-b'] });
	});
});

describe('isMonotonicRestrictionIncrease', () => {
	it('accepts only same-classification compartment supersets', () => {
		expect(isMonotonicRestrictionIncrease(LABELS, LABELS)).toBe(true);
		expect(
			isMonotonicRestrictionIncrease(LABELS, {
				classification: 'SECRET',
				compartments: ['element-a', 'element-b', 'element-c'],
			}),
		).toBe(true);
		expect(
			isMonotonicRestrictionIncrease(
				{ classification: 'SECRET', compartments: [] },
				{ classification: 'SECRET', compartments: ['element-a'] },
			),
		).toBe(true);
	});

	it('treats any classification change or dropped compartment as a potential decrease', () => {
		// Core has no lattice, so even a seemingly-higher classification is NOT
		// provably an increase — the lowering permission must gate it.
		expect(
			isMonotonicRestrictionIncrease(LABELS, {
				classification: 'TOP_SECRET',
				compartments: LABELS.compartments,
			}),
		).toBe(false);
		expect(
			isMonotonicRestrictionIncrease(LABELS, {
				classification: 'SECRET',
				compartments: ['element-a'],
			}),
		).toBe(false);
		expect(
			isMonotonicRestrictionIncrease(LABELS, { classification: 'SECRET', compartments: [] }),
		).toBe(false);
	});
});

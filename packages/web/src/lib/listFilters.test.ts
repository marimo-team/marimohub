import { describe, expect, it } from 'vitest';
import { hasListFilters, readListFilters, updateListFilterParams } from './listFilters';

const STATUSES = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

describe('list filter URL state', () => {
	it('reads namespace filters only for projects and preserves their exact value', () => {
		for (const prefix of ['research/vision', '', 'Research ', 'dep1/']) {
			const params = updateListFilterParams(new URLSearchParams('view=grid'), {
				tag_prefix: prefix,
			});
			expect(readListFilters(params, STATUSES).tag_prefix).toBeUndefined();
			const filters = readListFilters(params, STATUSES, { tagPrefix: true });
			expect(filters.tag_prefix).toBe(prefix);
			expect(hasListFilters(filters)).toBe(true);
			expect(params.get('view')).toBe('grid');
			expect(updateListFilterParams(params, {}).has('tag_prefix')).toBe(false);
		}
	});

	it('trims values and ignores invalid statuses', () => {
		const filters = readListFilters(
			new URLSearchParams('q=%20revenue%20&tag=%20finance%20&status=unknown'),
			STATUSES,
		);

		expect(filters).toEqual({ q: 'revenue', tag: 'finance', status: undefined });
		expect(hasListFilters(filters)).toBe(true);
	});

	it('replaces only filter parameters', () => {
		const params = updateListFilterParams(new URLSearchParams('q=old&view=grid'), {
			status: 'deleted',
		});

		expect(Object.fromEntries(params)).toEqual({ view: 'grid', status: 'deleted' });
	});
});

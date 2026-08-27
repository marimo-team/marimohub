import { describe, expect, it } from 'vitest';
import { hasListFilters, readListFilters, updateListFilterParams } from './listFilters';

const STATUSES = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

describe('list filter URL state', () => {
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

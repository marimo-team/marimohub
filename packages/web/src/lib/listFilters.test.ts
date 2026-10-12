import { describe, expect, it } from 'vitest';
import { hasListFilters, readListFilters, updateListFilterParams } from './listFilters';

const STATUSES = [
	{ value: 'active', label: 'Active' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

describe('list filter URL state', () => {
	it.each(['research/vision', 'a'.repeat(256)])(
		'reads valid namespace filters only for projects: %s',
		(prefix) => {
			const params = new URLSearchParams({ tag_namespace: prefix, view: 'grid' });
			expect(readListFilters(params, STATUSES).tag_namespace).toBeUndefined();
			const filters = readListFilters(params, STATUSES, { tagNamespace: true });
			expect(filters.tag_namespace).toBe(prefix);
			expect(hasListFilters(filters)).toBe(true);
		},
	);

	it('trims copied namespace URLs', () => {
		const params = new URLSearchParams({ tag_namespace: ' research/vision ' });
		expect(readListFilters(params, STATUSES, { tagNamespace: true }).tag_namespace).toBe(
			'research/vision',
		);
	});

	it.each(['', ' ', 'Research', 'dep1/', 'a//b', '-team', 'a/_team', 'a'.repeat(257)])(
		'ignores invalid namespace filter %j',
		(prefix) => {
			const filters = readListFilters(new URLSearchParams({ tag_namespace: prefix }), STATUSES, {
				tagNamespace: true,
			});
			expect(filters.tag_namespace).toBeUndefined();
			expect(hasListFilters(filters)).toBe(false);
		},
	);

	it('updates and clears namespace filters when opted in', () => {
		const current = new URLSearchParams('tag_namespace=old&view=grid');
		const params = updateListFilterParams(
			current,
			{ tag_namespace: 'research/vision' },
			{ tagNamespace: true },
		);
		expect(Object.fromEntries(params)).toEqual({ tag_namespace: 'research/vision', view: 'grid' });
		expect(updateListFilterParams(params, {}, { tagNamespace: true }).has('tag_namespace')).toBe(
			false,
		);
		expect(current.get('tag_namespace')).toBe('old');
	});

	it.each([{}, { tag_namespace: 'replacement' }])(
		'preserves namespace parameters for callers that have not opted in',
		(values) => {
			const current = new URLSearchParams('tag_namespace=research&q=old&view=grid');
			const params = updateListFilterParams(current, { ...values, q: 'new' });
			expect(Object.fromEntries(params)).toEqual({
				tag_namespace: 'research',
				q: 'new',
				view: 'grid',
			});
			expect(Object.fromEntries(updateListFilterParams(params, {}))).toEqual({
				tag_namespace: 'research',
				view: 'grid',
			});
		},
	);

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

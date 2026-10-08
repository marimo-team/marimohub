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
			const params = new URLSearchParams({ tag_prefix: prefix, view: 'grid' });
			expect(readListFilters(params, STATUSES).tag_prefix).toBeUndefined();
			const filters = readListFilters(params, STATUSES, { tagPrefix: true });
			expect(filters.tag_prefix).toBe(prefix);
			expect(hasListFilters(filters)).toBe(true);
		},
	);

	it('trims copied namespace URLs', () => {
		const params = new URLSearchParams({ tag_prefix: ' research/vision ' });
		expect(readListFilters(params, STATUSES, { tagPrefix: true }).tag_prefix).toBe(
			'research/vision',
		);
	});

	it.each(['', ' ', 'Research', 'dep1/', 'a//b', '-team', 'a/_team', 'a'.repeat(257)])(
		'ignores invalid namespace filter %j',
		(prefix) => {
			const filters = readListFilters(new URLSearchParams({ tag_prefix: prefix }), STATUSES, {
				tagPrefix: true,
			});
			expect(filters.tag_prefix).toBeUndefined();
			expect(hasListFilters(filters)).toBe(false);
		},
	);

	it('updates and clears namespace filters when opted in', () => {
		const current = new URLSearchParams('tag_prefix=old&view=grid');
		const params = updateListFilterParams(
			current,
			{ tag_prefix: 'research/vision' },
			{ tagPrefix: true },
		);
		expect(Object.fromEntries(params)).toEqual({ tag_prefix: 'research/vision', view: 'grid' });
		expect(updateListFilterParams(params, {}, { tagPrefix: true }).has('tag_prefix')).toBe(false);
		expect(current.get('tag_prefix')).toBe('old');
	});

	it.each([{}, { tag_prefix: 'replacement' }])(
		'preserves namespace parameters for callers that have not opted in',
		(values) => {
			const current = new URLSearchParams('tag_prefix=research&q=old&view=grid');
			const params = updateListFilterParams(current, { ...values, q: 'new' });
			expect(Object.fromEntries(params)).toEqual({
				tag_prefix: 'research',
				q: 'new',
				view: 'grid',
			});
			expect(Object.fromEntries(updateListFilterParams(params, {}))).toEqual({
				tag_prefix: 'research',
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

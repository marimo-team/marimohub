import { describe, it, expect } from 'vitest';
import { BadRequestError } from '@marimo-hub/core';
import { paginate, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination';
import type { SortKeys } from './pagination';

interface Row {
	id: string;
	at: string;
}

const keys: SortKeys<Row> = { key: (r) => r.at, tiebreak: (r) => r.id };

const rows: Row[] = [
	{ id: 'a', at: '2025-01-01T00:00:00Z' },
	{ id: 'b', at: '2025-03-01T00:00:00Z' },
	{ id: 'c', at: '2025-02-01T00:00:00Z' },
	// Same timestamp as 'b' — the id tiebreak must order them deterministically.
	{ id: 'z', at: '2025-03-01T00:00:00Z' },
];

describe('paginate ordering', () => {
	it('sorts descending by key, then by tiebreak', () => {
		const page = paginate(rows, {}, keys);
		expect(page.items.map((r) => r.id)).toEqual(['z', 'b', 'c', 'a']);
		expect(page.next_cursor).toBeNull();
	});

	it('does not mutate the input array', () => {
		const input = [...rows];
		paginate(input, {}, keys);
		expect(input).toEqual(rows);
	});
});

describe('paginate limit', () => {
	it('returns a next_cursor when more items remain', () => {
		const page = paginate(rows, { limit: 2 }, keys);
		expect(page.items.map((r) => r.id)).toEqual(['z', 'b']);
		expect(page.next_cursor).not.toBeNull();
	});

	it('clamps an over-large limit to MAX_PAGE_SIZE', () => {
		const many = Array.from({ length: MAX_PAGE_SIZE + 50 }, (_, i) => ({
			id: String(i).padStart(4, '0'),
			at: `2025-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
		}));
		const page = paginate(many, { limit: MAX_PAGE_SIZE + 50 }, keys);
		expect(page.items).toHaveLength(MAX_PAGE_SIZE);
		expect(page.next_cursor).not.toBeNull();
	});

	it('defaults the page size when limit is omitted', () => {
		const many = Array.from({ length: DEFAULT_PAGE_SIZE + 10 }, (_, i) => ({
			id: String(i).padStart(4, '0'),
			at: '2025-01-01T00:00:00Z',
		}));
		expect(paginate(many, {}, keys).items).toHaveLength(DEFAULT_PAGE_SIZE);
	});
});

describe('paginate cursor', () => {
	it('round-trips: the second page continues strictly after the first', () => {
		const first = paginate(rows, { limit: 2 }, keys);
		const second = paginate(rows, { limit: 2, cursor: first.next_cursor! }, keys);
		expect(second.items.map((r) => r.id)).toEqual(['c', 'a']);
		expect(second.next_cursor).toBeNull();
	});

	it('keeps the page boundary stable when an unrelated row is deleted', () => {
		const first = paginate(rows, { limit: 2 }, keys);
		// Drop a row that already appeared on page 1; page 2 must be unaffected.
		const without = rows.filter((r) => r.id !== 'z');
		const second = paginate(without, { limit: 2, cursor: first.next_cursor! }, keys);
		expect(second.items.map((r) => r.id)).toEqual(['c', 'a']);
	});

	it('treats an empty cursor as the first page', () => {
		expect(paginate(rows, { cursor: '' }, keys).items.map((r) => r.id)).toEqual([
			'z',
			'b',
			'c',
			'a',
		]);
	});

	it.each(['!!!not-base64!!!', btoa('{"not":"an-array"}'), btoa(JSON.stringify(['only-one']))])(
		'throws BadRequestError on the malformed cursor %o',
		(cursor) => {
			expect(() => paginate(rows, { cursor }, keys)).toThrow(BadRequestError);
		},
	);
});

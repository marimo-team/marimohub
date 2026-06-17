import { describe, it, expect } from 'vitest';
import { filterBySearch, matchesQuery } from './search';

describe('matchesQuery', () => {
	it('is case-insensitive', () => {
		expect(matchesQuery('Hello World', 'hello')).toBe(true);
		expect(matchesQuery('hello world', 'WORLD')).toBe(true);
	});

	it('trims the query before matching', () => {
		expect(matchesQuery('analysis', '  analy  ')).toBe(true);
	});

	it('returns false when there is no substring match', () => {
		expect(matchesQuery('analysis', 'zzz')).toBe(false);
	});
});

describe('filterBySearch', () => {
	const items = [
		{ name: 'Sales', description: 'quarterly revenue' },
		{ name: 'Marketing', description: 'campaign analysis' },
		{ name: 'Ops', description: 'logistics' },
	];
	const getText = (i: (typeof items)[number]) => `${i.name} ${i.description}`;

	it('returns the same array reference for an empty/whitespace query', () => {
		expect(filterBySearch(items, '', getText)).toBe(items);
		expect(filterBySearch(items, '   ', getText)).toBe(items);
	});

	it('matches against the projected text (name OR description)', () => {
		expect(filterBySearch(items, 'sales', getText).map((i) => i.name)).toEqual(['Sales']);
		expect(filterBySearch(items, 'analysis', getText).map((i) => i.name)).toEqual(['Marketing']);
	});

	it('returns every matching item', () => {
		const result = filterBySearch(items, 'e', getText); // Sales, Marketing, revenue...
		expect(result.length).toBeGreaterThan(1);
	});

	it('returns an empty list when nothing matches', () => {
		expect(filterBySearch(items, 'nonexistent', getText)).toEqual([]);
	});
});

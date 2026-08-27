import { describe, expect, it } from 'vitest';
import { createListFilter } from './listFilters';

interface Entry {
	status: string;
	tags?: string[];
	name: string;
	description: string;
}

const entries: Entry[] = [
	{ status: 'active', tags: ['finance'], name: 'Revenue', description: 'Monthly totals' },
	{ status: 'archived', tags: ['finance'], name: 'Capacity', description: 'Annual forecast' },
	{ status: 'deleted', tags: ['finance'], name: 'Retired', description: 'Annual forecast' },
];

describe('createListFilter', () => {
	it('ANDs status, exact tag, and case-insensitive text filters', () => {
		const matches = createListFilter<Entry>(
			{ status: 'archived', tag: 'finance', q: 'FORECAST' },
			(entry) => [entry.name, entry.description],
		);

		expect(entries.filter(matches)).toEqual([entries[1]]);
	});

	it('excludes deleted entries by default and leaves missing tags for legacy resolution', () => {
		const legacy = { ...entries[0], tags: undefined };
		const strict = createListFilter<Entry>({ tag: 'finance' }, (entry) => [entry.name]);
		const allowLegacy = createListFilter<Entry>({ tag: 'finance' }, (entry) => [entry.name], {
			allowUnknownTags: true,
		});

		expect([...entries, legacy].filter(strict)).toEqual([entries[0], entries[1]]);
		expect([...entries, legacy].filter(allowLegacy)).toEqual([entries[0], entries[1], legacy]);
	});
});

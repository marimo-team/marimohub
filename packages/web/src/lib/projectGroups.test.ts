import { describe, expect, it } from 'vitest';
import { groupProjectsByTagPath } from './projectGroups';

describe('project namespace groups', () => {
	it('keeps free-form tags ungrouped', () => {
		const projects = [{ tags: [] }, { tags: ['Team A', 'Research/X'] }];
		expect(groupProjectsByTagPath(projects)).toEqual({
			groups: [],
			direct: [],
			ungrouped: projects,
		});
	});
	it('sorts groups, deduplicates membership, and preserves project order', () => {
		const first = { tags: ['dep2/a', 'dep1', 'dep1/b', 'dep1/b'] };
		const second = { tags: ['dep1/c'] };
		expect(groupProjectsByTagPath([first, second]).groups).toEqual([
			{ prefix: 'dep1', label: 'dep1', projects: [first, second] },
			{ prefix: 'dep2', label: 'dep2', projects: [first] },
		]);
	});
	it('separates direct matches, permits direct and child membership, and excludes dep10', () => {
		const direct = { tags: ['dep1'] };
		const both = { tags: ['dep1', 'dep1/team/repo'] };
		expect(
			groupProjectsByTagPath([direct, both, { tags: ['dep10', 'dep1/Team'] }], 'dep1'),
		).toEqual({
			direct: [direct, both],
			ungrouped: [],
			groups: [{ prefix: 'dep1/team', label: 'team', projects: [both] }],
		});
	});
});

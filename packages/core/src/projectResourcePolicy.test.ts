import { describe, expect, it } from 'vitest';
import { ProjectId } from './ids';
import { allowsProjectResource, parseProjectResourceRules } from './projectResourcePolicy';

const project = ProjectId.parse('proj-0000000000000000');
describe('project resource policies', () => {
	it('requires both the resource and project to match', () => {
		const rules = parseProjectResourceRules([{ resource: 'secret', projects: [project] }]);
		expect(allowsProjectResource(rules, 'secret', project)).toBe(true);
		expect(allowsProjectResource(rules, 'other', project)).toBe(false);
		expect(allowsProjectResource(rules, 'secret')).toBe(false);
		expect(allowsProjectResource(rules, 'secret', ProjectId.parse('proj-1111111111111111'))).toBe(
			false,
		);
	});
	it('supports explicit shared access and an empty deny-all policy', () => {
		expect(
			allowsProjectResource(
				parseProjectResourceRules([{ resource: '*', projects: '*' }]),
				'anything',
			),
		).toBe(true);
		expect(allowsProjectResource([], 'anything', project)).toBe(false);
	});
	it.each([
		{},
		null,
		[{ resource: '', projects: '*' }],
		[{ resource: 'x', projects: [] }],
		[{ resource: 'x', projects: ['bad'] }],
		[{ resource: 'x', projects: '*', typo: true }],
	])('rejects malformed rules %j', (rules) => {
		expect(() => parseProjectResourceRules(rules)).toThrow();
	});
});

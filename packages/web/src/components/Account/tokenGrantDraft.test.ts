import { describe, expect, it } from 'vitest';
import { tokenGrantFromDraft } from './tokenGrantDraft';

const projects = ['proj-0000000000000001'];

describe('tokenGrantFromDraft', () => {
	it('rejects deployment actions in selected-project grants before submission', () => {
		expect(tokenGrantFromDraft({ actions: ['project.read', 'admin.access'], projects })).toBeNull();
	});

	it('allows deployment actions for all-project grants', () => {
		const grant = { actions: ['admin.access'] as const, projects: '*' as const };
		expect(tokenGrantFromDraft({ ...grant, actions: [...grant.actions] })).toEqual(grant);
	});

	it('preserves wildcard actions for selected projects', () => {
		const grant = { actions: '*' as const, projects };
		expect(tokenGrantFromDraft(grant)).toEqual(grant);
	});

	it('rejects an empty project selection even with wildcard actions', () => {
		expect(tokenGrantFromDraft({ actions: '*', projects: [] })).toBeNull();
	});
});

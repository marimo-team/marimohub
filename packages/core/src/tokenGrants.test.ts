import { describe, expect, it } from 'vitest';
import { ProjectId } from './ids';
import {
	expandTokenGrantPreset,
	TokenGrantSchema,
	tokenGrantAllowsAction,
	tokenGrantAllowsProject,
	tokenGrantIsSubset,
} from './tokenGrants';
import type { TokenGrant } from './tokenGrants';

const PROJECT_A = ProjectId.parse('proj-0000000000000001');
const PROJECT_B = ProjectId.parse('proj-0000000000000002');

describe('TokenGrant', () => {
	it('expands presets to immutable action arrays', () => {
		expect(expandTokenGrantPreset('read')).toEqual(['project.read', 'integration.read']);
		expect(expandTokenGrantPreset('run')).toContain('session.start');
		expect(expandTokenGrantPreset('edit')).toContain('notebook.write');
		expect(expandTokenGrantPreset('full')).toBe('*');
	});

	it('rejects duplicate actions and projects', () => {
		expect(
			TokenGrantSchema.safeParse({
				actions: ['project.read', 'project.read'],
				projects: '*',
			}).success,
		).toBe(false);
		expect(
			TokenGrantSchema.safeParse({ actions: '*', projects: [PROJECT_A, PROJECT_A] }).success,
		).toBe(false);
	});

	it('applies action and project boundaries independently', () => {
		const grant: TokenGrant = { actions: ['project.read'], projects: [PROJECT_A] };
		expect(tokenGrantAllowsAction(grant, 'project.read')).toBe(true);
		expect(tokenGrantAllowsAction(grant, 'project.update')).toBe(false);
		expect(tokenGrantAllowsProject(grant, PROJECT_A)).toBe(true);
		expect(tokenGrantAllowsProject(grant, PROJECT_B)).toBe(false);
	});

	it('denies deployment actions for selected-project grants', () => {
		const grant = { actions: '*' as const, projects: [PROJECT_A] };
		expect(tokenGrantAllowsAction(grant, 'project.create')).toBe(false);
		expect(tokenGrantAllowsAction(grant, 'project.read')).toBe(true);
	});

	it('checks whether an approval narrows a requested grant', () => {
		const requested = { actions: '*' as const, projects: '*' as const };
		expect(
			tokenGrantIsSubset({ actions: ['project.read'], projects: [PROJECT_A] }, requested),
		).toBe(true);
		expect(
			tokenGrantIsSubset(
				{ actions: '*', projects: '*' },
				{ actions: ['project.read'], projects: [PROJECT_A] },
			),
		).toBe(false);
	});
});

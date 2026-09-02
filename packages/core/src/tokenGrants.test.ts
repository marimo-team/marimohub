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

	it.each([
		['an unknown action', { actions: ['project.fly'], projects: '*' }],
		['an empty project list', { actions: '*', projects: [] }],
		['an invalid project id', { actions: '*', projects: ['project-one'] }],
		['an unexpected field', { actions: '*', projects: '*', future: true }],
		['a missing action boundary', { projects: '*' }],
	])('rejects %s', (_label, value) => {
		expect(TokenGrantSchema.safeParse(value).success).toBe(false);
	});

	it('accepts 100 selected projects and rejects 101', () => {
		const projects = Array.from({ length: 101 }, (_, index) =>
			ProjectId.parse(`proj-${String(index).padStart(16, '0')}`),
		);
		expect(
			TokenGrantSchema.safeParse({ actions: '*', projects: projects.slice(0, 100) }).success,
		).toBe(true);
		expect(TokenGrantSchema.safeParse({ actions: '*', projects }).success).toBe(false);
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
		expect(
			tokenGrantAllowsAction(
				{ actions: ['project.create'], projects: [PROJECT_A] },
				'project.create',
			),
		).toBe(false);
	});

	it('treats an absent legacy grant as unrestricted', () => {
		expect(tokenGrantAllowsAction(undefined, 'project.delete')).toBe(true);
		expect(tokenGrantAllowsProject(undefined, PROJECT_B)).toBe(true);
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

	it('rejects action and project widening independently', () => {
		const requested: TokenGrant = {
			actions: ['project.read'],
			projects: [PROJECT_A],
		};
		expect(
			tokenGrantIsSubset(
				{ actions: ['project.read', 'project.update'], projects: [PROJECT_A] },
				requested,
			),
		).toBe(false);
		expect(
			tokenGrantIsSubset(
				{ actions: ['project.read'], projects: [PROJECT_A, PROJECT_B] },
				requested,
			),
		).toBe(false);
		expect(tokenGrantIsSubset({ actions: '*', projects: [PROJECT_A] }, requested)).toBe(false);
		expect(tokenGrantIsSubset({ actions: ['project.read'], projects: '*' }, requested)).toBe(false);
	});
});

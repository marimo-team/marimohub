import { describe, it, expect } from 'vitest';
import { canAct, effectiveRole, requireRole } from './authz';
import { ForbiddenError } from './errors';
import { makeProject } from './testing';

const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const VIEWER = 'user_viewer';
const STRANGER = 'user_stranger';

const project = makeProject({
	owner: OWNER,
	members: [
		{ user_id: OWNER, role: 'admin' },
		{ user_id: EDITOR, role: 'editor' },
		{ user_id: VIEWER, role: 'viewer' },
	],
});

describe('authz', () => {
	describe('effectiveRole', () => {
		it('treats the owner as admin even if not listed as a member', () => {
			const p = makeProject({ owner: OWNER, members: [] });
			expect(effectiveRole(p, OWNER)).toBe('admin');
		});

		it('returns the member role', () => {
			expect(effectiveRole(project, EDITOR)).toBe('editor');
			expect(effectiveRole(project, VIEWER)).toBe('viewer');
		});

		it('returns null for a non-member', () => {
			expect(effectiveRole(project, STRANGER)).toBeNull();
		});
	});

	describe('canAct', () => {
		it('honors the role hierarchy admin > editor > viewer', () => {
			expect(canAct(project, EDITOR, 'viewer')).toBe(true);
			expect(canAct(project, EDITOR, 'editor')).toBe(true);
			expect(canAct(project, EDITOR, 'admin')).toBe(false);

			expect(canAct(project, VIEWER, 'viewer')).toBe(true);
			expect(canAct(project, VIEWER, 'editor')).toBe(false);

			expect(canAct(project, OWNER, 'admin')).toBe(true);
		});

		it('denies non-members at every level', () => {
			expect(canAct(project, STRANGER, 'viewer')).toBe(false);
			expect(canAct(project, STRANGER, 'admin')).toBe(false);
		});
	});

	describe('requireRole', () => {
		it('passes when the role is sufficient', () => {
			expect(() => requireRole(project, EDITOR, 'editor')).not.toThrow();
		});

		it('throws ForbiddenError when the role is insufficient', () => {
			expect(() => requireRole(project, VIEWER, 'editor')).toThrow(ForbiddenError);
			expect(() => requireRole(project, STRANGER, 'viewer')).toThrow(ForbiddenError);
		});
	});
});

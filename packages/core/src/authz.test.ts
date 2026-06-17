import { describe, it, expect } from 'vitest';
import { canAct, canSeeProjectEntry, effectiveRole, requireRole } from './authz';
import { ForbiddenError } from './errors';
import { UserId } from './ids';
import { makeProject } from './testing';

const OWNER = UserId.parse('user_owner');
const EDITOR = UserId.parse('user_editor');
const VIEWER = UserId.parse('user_viewer');
const STRANGER = UserId.parse('user_stranger');

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

		it('falls back to the default role for a non-member', () => {
			expect(effectiveRole(project, STRANGER, 'editor')).toBe('editor');
			expect(effectiveRole(project, STRANGER, 'viewer')).toBe('viewer');
		});

		it('does not let the default role override an explicit membership', () => {
			expect(effectiveRole(project, VIEWER, 'admin')).toBe('viewer');
			expect(effectiveRole(project, OWNER, 'viewer')).toBe('admin');
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

		it('lets a default editor role act on notebooks but not the project', () => {
			expect(canAct(project, STRANGER, 'editor', 'editor')).toBe(true);
			expect(canAct(project, STRANGER, 'admin', 'editor')).toBe(false);
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

		it('honors a default role for non-members', () => {
			expect(() => requireRole(project, STRANGER, 'editor', 'editor')).not.toThrow();
			expect(() => requireRole(project, STRANGER, 'admin', 'editor')).toThrow(ForbiddenError);
		});
	});

	describe('canSeeProjectEntry', () => {
		const entry = { owner: OWNER, member_ids: [OWNER, EDITOR, VIEWER] };

		it('makes every project visible when a default role is set', () => {
			expect(canSeeProjectEntry(entry, STRANGER, 'viewer')).toBe(true);
			expect(canSeeProjectEntry(entry, STRANGER, 'editor')).toBe(true);
		});

		it('restricts visibility to owner and members under none (null default)', () => {
			expect(canSeeProjectEntry(entry, OWNER, null)).toBe(true);
			expect(canSeeProjectEntry(entry, EDITOR, null)).toBe(true);
			expect(canSeeProjectEntry(entry, STRANGER, null)).toBe(false);
		});

		it('sees the owner even when member_ids is absent', () => {
			expect(canSeeProjectEntry({ owner: OWNER }, OWNER, null)).toBe(true);
		});

		it('is indeterminate for a non-owner when member_ids is absent (fallback)', () => {
			expect(canSeeProjectEntry({ owner: OWNER }, STRANGER, null)).toBeNull();
		});
	});
});

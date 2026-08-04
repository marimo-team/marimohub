import { describe, it, expect } from 'vitest';
import { canAct, canSeeProjectEntry, effectiveRole, isSuperAdmin, requireRole } from './authz';
import type { AuthSubject } from './authz';
import { ForbiddenError } from './errors';
import { UserId } from './ids';
import { makeProject } from './testing';

function subject(id: string, email = `${id}@example.com`): AuthSubject {
	return { id: UserId.parse(id), email };
}

const OWNER = subject('user_owner');
const EDITOR = subject('user_editor');
const VIEWER = subject('user_viewer');
const STRANGER = subject('user_stranger');
const INVITEE = subject('user_invitee', 'invitee@example.com');

const project = makeProject({
	owner: OWNER.id,
	members: [
		{ user_id: OWNER.id, role: 'admin' },
		{ user_id: EDITOR.id, role: 'editor' },
		{ user_id: VIEWER.id, role: 'viewer' },
		{ email: 'invitee@example.com', role: 'editor' },
	],
});

describe('authz', () => {
	describe('effectiveRole', () => {
		it('treats the owner as admin even if not listed as a member', () => {
			const p = makeProject({ owner: OWNER.id, members: [] });
			expect(effectiveRole(p, OWNER)).toBe('admin');
		});

		it('returns the member role', () => {
			expect(effectiveRole(project, EDITOR)).toBe('editor');
			expect(effectiveRole(project, VIEWER)).toBe('viewer');
		});

		it('matches an email member by the subject email', () => {
			expect(effectiveRole(project, INVITEE)).toBe('editor');
		});

		it('matches email members case-insensitively on the subject email', () => {
			const shouty = { ...INVITEE, email: 'Invitee@Example.COM' };
			expect(effectiveRole(project, shouty)).toBe('editor');
		});

		it('does not match an email member by id or a different email', () => {
			expect(effectiveRole(project, subject('user_invitee', 'other@example.com'))).toBeNull();
		});

		it('takes the highest-ranked role when both an id and an email row match', () => {
			const p = makeProject({
				owner: OWNER.id,
				members: [
					{ user_id: EDITOR.id, role: 'viewer' },
					{ email: EDITOR.email, role: 'admin' },
				],
			});
			expect(effectiveRole(p, EDITOR)).toBe('admin');
		});

		it('returns null for a non-member', () => {
			expect(effectiveRole(project, STRANGER)).toBeNull();
		});

		it('falls back to the default role for a non-member', () => {
			expect(effectiveRole(project, STRANGER, { defaultRole: 'editor' })).toBe('editor');
			expect(effectiveRole(project, STRANGER, { defaultRole: 'viewer' })).toBe('viewer');
		});

		it('maps a group-derived entitlement to the highest per-user default role', () => {
			const entitled = {
				...STRANGER,
				entitlements: ['default-role:viewer', 'default-role:editor'] as const,
			};
			expect(effectiveRole(project, entitled)).toBe('editor');
			expect(effectiveRole(project, entitled, { defaultRole: 'viewer' })).toBe('editor');
		});

		it('keeps a higher deployment default when group entitlements are lower', () => {
			const entitled = {
				...STRANGER,
				entitlements: ['default-role:editor', 'default-role:viewer'] as const,
			};
			expect(effectiveRole(project, entitled, { defaultRole: 'admin' })).toBe('admin');
		});

		it('does not let a default-role entitlement override explicit membership', () => {
			const entitledViewer = {
				...VIEWER,
				entitlements: ['default-role:admin'] as const,
			};
			expect(effectiveRole(project, entitledViewer)).toBe('viewer');
		});

		it('does not let the default role override an explicit membership', () => {
			expect(effectiveRole(project, VIEWER, { defaultRole: 'admin' })).toBe('viewer');
			expect(effectiveRole(project, OWNER, { defaultRole: 'viewer' })).toBe('admin');
		});

		it('grants a super admin admin on a project they have no relation to', () => {
			expect(effectiveRole(project, STRANGER, { superAdmins: [STRANGER.id] })).toBe('admin');
			expect(effectiveRole(project, STRANGER, { superAdmins: [STRANGER.email] })).toBe('admin');
		});

		it('super admin outranks an explicit lower membership', () => {
			expect(effectiveRole(project, VIEWER, { superAdmins: [VIEWER.id] })).toBe('admin');
			expect(effectiveRole(project, { ...VIEWER, entitlements: ['super-admin'] })).toBe('admin');
		});
	});

	describe('isSuperAdmin', () => {
		it('is off with no list', () => {
			expect(isSuperAdmin(STRANGER)).toBe(false);
			expect(isSuperAdmin(STRANGER, [])).toBe(false);
		});

		it('matches ids exactly, never case-variant', () => {
			expect(isSuperAdmin(STRANGER, [STRANGER.id])).toBe(true);
			expect(isSuperAdmin(STRANGER, [STRANGER.id.toUpperCase()])).toBe(false);
			expect(isSuperAdmin(STRANGER, ['user_strange'])).toBe(false);
		});

		it('matches emails case-insensitively in both directions', () => {
			expect(isSuperAdmin(STRANGER, ['USER_STRANGER@example.com'])).toBe(true);
			const shouty = { ...STRANGER, email: 'User_Stranger@Example.COM' };
			expect(isSuperAdmin(shouty, ['user_stranger@example.com'])).toBe(true);
		});

		it('any matching entry in the list suffices', () => {
			expect(isSuperAdmin(STRANGER, ['someone@else.com', STRANGER.id])).toBe(true);
			expect(isSuperAdmin(STRANGER, ['someone@else.com', 'other_id'])).toBe(false);
		});

		it('an email entry never matches an id (namespace collision)', () => {
			// UserId is an opaque IdP sub — it can be any string, including one that
			// looks like the configured email while the real email is someone else's.
			const impostor = subject('admin@example.com', 'attacker@example.net');
			expect(isSuperAdmin(impostor, ['admin@example.com'])).toBe(false);
		});

		it('an id entry never matches an email', () => {
			// An @-free entry is an id; a subject whose EMAIL local-part echoes it
			// gains nothing.
			const bystander = subject('other_id', 'user_god@example.com');
			expect(isSuperAdmin(bystander, ['user_god'])).toBe(false);
		});

		it('accepts only the normalized super-admin entitlement', () => {
			expect(isSuperAdmin({ ...STRANGER, entitlements: ['super-admin'] })).toBe(true);
			expect(
				isSuperAdmin({
					...STRANGER,
					entitlements: ['default-role:admin'],
				}),
			).toBe(false);
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
			expect(canAct(project, STRANGER, 'editor', { defaultRole: 'editor' })).toBe(true);
			expect(canAct(project, STRANGER, 'admin', { defaultRole: 'editor' })).toBe(false);
		});

		it('lets a super admin act at every level', () => {
			expect(canAct(project, STRANGER, 'admin', { superAdmins: [STRANGER.id] })).toBe(true);
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
			expect(() =>
				requireRole(project, STRANGER, 'editor', { defaultRole: 'editor' }),
			).not.toThrow();
			expect(() => requireRole(project, STRANGER, 'admin', { defaultRole: 'editor' })).toThrow(
				ForbiddenError,
			);
		});
	});

	describe('canSeeProjectEntry', () => {
		const entry = {
			owner: OWNER.id,
			member_ids: [OWNER.id, EDITOR.id, VIEWER.id],
			member_emails: ['invitee@example.com'],
		};

		it('makes every project visible when a default role is set', () => {
			expect(canSeeProjectEntry(entry, STRANGER, { defaultRole: 'viewer' })).toBe(true);
			expect(canSeeProjectEntry(entry, STRANGER, { defaultRole: 'editor' })).toBe(true);
		});

		it('makes every project visible for a group-derived default role', () => {
			expect(
				canSeeProjectEntry(entry, {
					...STRANGER,
					entitlements: ['default-role:viewer'],
				}),
			).toBe(true);
		});

		it('restricts visibility to owner and members under none (null default)', () => {
			expect(canSeeProjectEntry(entry, OWNER)).toBe(true);
			expect(canSeeProjectEntry(entry, EDITOR)).toBe(true);
			expect(canSeeProjectEntry(entry, STRANGER)).toBe(false);
		});

		it('sees an email member via member_emails, case-insensitively', () => {
			expect(canSeeProjectEntry(entry, INVITEE)).toBe(true);
			expect(canSeeProjectEntry(entry, { ...INVITEE, email: 'INVITEE@example.com' })).toBe(true);
		});

		it('normalizes stored member_emails, so a whitespace-padded entry still lists', () => {
			// ProjectMemberSchema lowercases but does not trim; direct access
			// (memberRefMatchesSubject) trims both sides, so listing must too or an
			// invitee could reach the project yet be missing from their list.
			const padded = {
				owner: OWNER.id,
				member_ids: [OWNER.id],
				member_emails: [' invitee@example.com '],
			};
			expect(canSeeProjectEntry(padded, INVITEE)).toBe(true);
		});

		it('fails closed for an email member when member_emails is absent', () => {
			const stripped = { owner: OWNER.id, member_ids: [OWNER.id] };
			expect(canSeeProjectEntry(stripped, INVITEE)).toBe(false);
		});

		it('sees the owner even when member_ids is absent', () => {
			expect(canSeeProjectEntry({ owner: OWNER.id }, OWNER)).toBe(true);
		});

		it('is indeterminate for a non-owner when member_ids is absent (fallback)', () => {
			expect(canSeeProjectEntry({ owner: OWNER.id }, STRANGER)).toBeNull();
		});

		it('a super admin sees everything, even indeterminate legacy entries', () => {
			const policy = { superAdmins: [STRANGER.id] };
			expect(canSeeProjectEntry(entry, STRANGER, policy)).toBe(true);
			expect(canSeeProjectEntry({ owner: OWNER.id }, STRANGER, policy)).toBe(true);
		});

		it('does not grant visibility on an id/email namespace collision', () => {
			// Email entry, caller whose ID equals it but whose email is their own:
			// visibility stays members-only (here: indeterminate → fallback needed).
			const impostor = subject('admin@example.com', 'attacker@evil.example');
			expect(
				canSeeProjectEntry({ owner: OWNER.id }, impostor, { superAdmins: ['admin@example.com'] }),
			).toBeNull();
			expect(canSeeProjectEntry(entry, impostor, { superAdmins: ['admin@example.com'] })).toBe(
				false,
			);
		});
	});
});

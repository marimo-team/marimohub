/**
 * Characterization tests: every decision here mirrors a rule the API enforced
 * before the service existed (effectiveRole tiers, lifecycle-precedes-role,
 * visibility masking, viewer-mode session admission, deployment standing).
 * A failure means live access control changed.
 */
import { describe, expect, it } from 'vitest';
import type { AuthSubject } from '../../authz';
import { ProjectId, UserId } from '../../ids';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import { makeProject } from '../../testing';
import type { TokenGrant } from '../../tokenGrants';
import { AuthorizationService } from './AuthorizationService';
import type { AuthorizationResource, SessionAdmissionRecord } from './AuthorizationService';
import { ACTION_RULES, AUTHORIZATION_ACTIONS, PROJECT_ACTIONS } from './actions';

function subject(id: string, email = `${id}@example.com`): AuthSubject {
	return { id: UserId.parse(id), email };
}

const OWNER = subject('user_owner');
const MANAGER = subject('user_manager');
const EDITOR = subject('user_editor');
const VIEWER = subject('user_viewer');
const STRANGER = subject('user_stranger');

function pat(who: AuthSubject, grant: TokenGrant): AuthenticatedPrincipal {
	return { ...who, credential: { kind: 'personal-access-token', grant } };
}

const project = makeProject({
	owner: OWNER.id,
	members: [
		{ user_id: MANAGER.id, role: 'manager' },
		{ user_id: EDITOR.id, role: 'editor' },
		{ user_id: VIEWER.id, role: 'viewer' },
	],
});
const deletedProject = makeProject({ owner: OWNER.id, members: [], status: 'deleted' });

const service = (policy = {}) => new AuthorizationService(policy);
const onProject = (p = project): AuthorizationResource => ({ kind: 'project', project: p });
const onSession = (session: SessionAdmissionRecord, p = project): AuthorizationResource => ({
	kind: 'session',
	project: p,
	session,
});

describe('AuthorizationService: project actions', () => {
	it('grants each project action at exactly its rule tier', async () => {
		const bySubject: [AuthSubject, string][] = [
			[OWNER, 'admin'],
			[MANAGER, 'manager'],
			[EDITOR, 'editor'],
			[VIEWER, 'viewer'],
		];
		for (const action of PROJECT_ACTIONS) {
			const rule = ACTION_RULES[action];
			if (rule.scope !== 'project') continue;
			for (const [who, role] of bySubject) {
				const decision = await service().authorize(who, action, onProject());
				if (rule.requiresSuperAdmin) {
					// Standing-gated: no project role — the owner included — suffices.
					expect(decision, `${action} for ${role}`).toEqual({
						allowed: false,
						category: 'standing',
						role,
					});
					continue;
				}
				const rank = { viewer: 1, editor: 2, manager: 3, admin: 4 } as const;
				const expected = rank[role as keyof typeof rank] >= rank[rule.min];
				expect(decision.allowed, `${action} for ${role}`).toBe(expected);
				expect(decision.role).toBe(role);
			}
		}
	});

	it('masks read denials as visibility and write denials as role', async () => {
		const read = await service().authorize(STRANGER, 'project.read', onProject());
		expect(read).toEqual({ allowed: false, category: 'visibility', role: null });
		const write = await service().authorize(VIEWER, 'notebook.write', onProject());
		expect(write).toEqual({ allowed: false, category: 'role', role: 'viewer' });
		// integration.read follows an existence-revealing guard historically: 403.
		const integration = await service().authorize(STRANGER, 'integration.read', onProject());
		expect(integration).toEqual({ allowed: false, category: 'role', role: null });
	});

	it('denies every action on a deleted project, super admins included', async () => {
		const superAdmin = service({ superAdmins: [OWNER.id] });
		for (const action of PROJECT_ACTIONS) {
			const decision = await superAdmin.authorize(OWNER, action, onProject(deletedProject));
			expect(decision).toEqual({ allowed: false, category: 'lifecycle', role: null });
		}
	});

	it('applies the deployment default role only when there is no membership', async () => {
		const defaultEditor = service({ defaultRole: 'editor' });
		await expect(
			defaultEditor.authorize(STRANGER, 'notebook.write', onProject()),
		).resolves.toMatchObject({ allowed: true, role: 'editor' });
		// An explicit viewer membership is never upgraded by the default.
		await expect(defaultEditor.authorize(VIEWER, 'notebook.write', onProject())).resolves.toEqual({
			allowed: false,
			category: 'role',
			role: 'viewer',
		});
	});

	it('grants super admins admin everywhere', async () => {
		const superAdmin = service({ superAdmins: [STRANGER.id] });
		await expect(superAdmin.authorize(STRANGER, 'project.delete', onProject())).resolves.toEqual({
			allowed: true,
			role: 'admin',
		});
	});

	it('honors the super-admin session entitlement', async () => {
		const entitled: AuthSubject = { ...STRANGER, entitlements: ['super-admin'] };
		await expect(service().authorize(entitled, 'project.update', onProject())).resolves.toEqual({
			allowed: true,
			role: 'admin',
		});
	});
});

describe('AuthorizationService: deployment actions', () => {
	it('gates admin surfaces on super-admin standing', async () => {
		for (const action of ['admin.access', 'org-integration.manage', 'audit.global.read'] as const) {
			await expect(service().authorize(VIEWER, action, { kind: 'deployment' })).resolves.toEqual({
				allowed: false,
				category: 'standing',
				role: null,
			});
			await expect(
				service({ superAdmins: [VIEWER.id] }).authorize(VIEWER, action, { kind: 'deployment' }),
			).resolves.toEqual({ allowed: true, role: null });
		}
	});

	it('gates project creation only under a restricted deployment', async () => {
		const open = service();
		await expect(
			open.authorize(STRANGER, 'project.create', { kind: 'deployment' }),
		).resolves.toEqual({ allowed: true, role: null });
		const restricted = service({ projectCreationRestricted: true });
		await expect(
			restricted.authorize(STRANGER, 'project.create', { kind: 'deployment' }),
		).resolves.toEqual({ allowed: false, category: 'standing', role: null });
		const creator: AuthSubject = { ...STRANGER, entitlements: ['project-creator'] };
		await expect(
			restricted.authorize(creator, 'project.create', { kind: 'deployment' }),
		).resolves.toEqual({ allowed: true, role: null });
	});
});

describe('AuthorizationService: credential grants', () => {
	it('intersects explicit actions with the current project role', async () => {
		const readOnly = pat(OWNER, { actions: ['project.read'], projects: '*' });
		await expect(service().authorize(readOnly, 'project.read', onProject())).resolves.toMatchObject(
			{
				allowed: true,
			},
		);
		await expect(service().authorize(readOnly, 'project.update', onProject())).resolves.toEqual({
			allowed: false,
			category: 'credential-action',
			role: 'admin',
		});

		const wildcardViewer = pat(VIEWER, { actions: '*', projects: '*' });
		await expect(
			service().authorize(wildcardViewer, 'project.update', onProject()),
		).resolves.toEqual({ allowed: false, category: 'role', role: 'viewer' });
	});

	it('masks projects outside a selected-project grant', async () => {
		const anotherProject = ProjectId.parse('proj-0000000000000002');
		const selected = pat(OWNER, { actions: '*', projects: [anotherProject] });
		await expect(service().authorize(selected, 'project.read', onProject())).resolves.toEqual({
			allowed: false,
			category: 'credential-resource',
			role: 'admin',
		});
		await expect(service().authorize(selected, 'project.update', onProject())).resolves.toEqual({
			allowed: false,
			category: 'credential-resource',
			role: 'admin',
		});
		const excludedStranger = pat(STRANGER, {
			actions: '*',
			projects: [anotherProject],
		});
		await expect(
			service().authorize(excludedStranger, 'project.update', onProject()),
		).resolves.toEqual({
			allowed: false,
			category: 'credential-resource',
			role: null,
		});
	});

	it('denies deployment actions when a grant selects projects', async () => {
		const selected = pat(OWNER, { actions: '*', projects: [project.id] });
		await expect(
			service().authorize(selected, 'project.create', { kind: 'deployment' }),
		).resolves.toEqual({ allowed: false, category: 'credential-resource', role: null });
		await expect(
			service().authorize(selected, 'admin.access', { kind: 'deployment' }),
		).resolves.toEqual({ allowed: false, category: 'credential-resource', role: null });
	});

	it('preserves lifecycle and visibility masking before credential denials', async () => {
		const excluded = pat(OWNER, { actions: [], projects: [project.id] });
		await expect(
			service().authorize(excluded, 'project.read', onProject(deletedProject)),
		).resolves.toEqual({ allowed: false, category: 'lifecycle', role: null });

		const hidden = pat(STRANGER, { actions: [], projects: [project.id] });
		await expect(service().authorize(hidden, 'project.read', onProject())).resolves.toEqual({
			allowed: false,
			category: 'visibility',
			role: null,
		});
	});

	it('applies credential grants in batch decisions', async () => {
		const another = makeProject({ id: ProjectId.parse('proj-0000000000000002'), owner: OWNER.id });
		const selected = pat(OWNER, { actions: ['project.read'], projects: [project.id] });
		const decisions = await service().authorizeMany(selected, 'project.read', [
			onProject(),
			onProject(another),
		]);
		expect(decisions[0]).toMatchObject({ allowed: true });
		expect(decisions[1]).toMatchObject({
			allowed: false,
			category: 'credential-resource',
		});
	});

	it('includes the credential stage in analyzer output', async () => {
		const readOnly = pat(OWNER, { actions: ['project.read'], projects: '*' });
		const analysis = await service().analyze(readOnly, 'project.update', onProject());
		expect(analysis.presentation).toBe('forbidden');
		expect(analysis.trace).toContainEqual(
			expect.objectContaining({ stage: 'credential', status: 'failed' }),
		);
	});
});

describe('AuthorizationService: session actions', () => {
	const edit = (user: AuthSubject, sharing?: 'shared' | 'exclusive') => ({
		mode: 'edit' as const,
		user_id: user.id,
		...(sharing ? { editor_sandbox_sharing: sharing } : {}),
	});
	const app = { mode: 'app' as const, user_id: OWNER.id };

	it('admits editors to shared editors and apps, and blocks role-less callers', async () => {
		await expect(
			service().authorize(EDITOR, 'session.attach', onSession(edit(MANAGER))),
		).resolves.toMatchObject({ allowed: true });
		await expect(service().authorize(STRANGER, 'session.attach', onSession(app))).resolves.toEqual({
			allowed: false,
			category: 'session',
			role: null,
		});
	});

	it('keeps exclusive editors owner-only, with manager force-stop but no attach', async () => {
		const session = edit(EDITOR, 'exclusive');
		await expect(
			service().authorize(MANAGER, 'session.attach', { kind: 'session', project, session }),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
		await expect(
			service().authorize(MANAGER, 'session.stop', { kind: 'session', project, session }),
		).resolves.toMatchObject({ allowed: true });
		await expect(
			service().authorize(EDITOR, 'session.attach', { kind: 'session', project, session }),
		).resolves.toMatchObject({ allowed: true });
	});

	it('admits viewers to shared apps exactly per viewer mode', async () => {
		const resource: AuthorizationResource = onSession(app);
		await expect(service().authorize(VIEWER, 'session.attach', resource)).resolves.toMatchObject({
			allowed: false,
			category: 'session',
		});
		await expect(
			service({ viewerMode: 'applications' }).authorize(VIEWER, 'session.attach', resource),
		).resolves.toMatchObject({ allowed: true, role: 'viewer' });
	});

	it('routes proxy admission through the attach rule', async () => {
		const resource: AuthorizationResource = onSession(app);
		const direct = await service({ viewerMode: 'applications' }).authorize(
			VIEWER,
			'session.attach',
			resource,
		);
		const proxied = await service({ viewerMode: 'applications' }).authorize(
			VIEWER,
			'session.proxy',
			resource,
		);
		expect(proxied).toEqual(direct);
	});

	it('restricts surfaces to editors on edit sessions', async () => {
		await expect(
			service({ viewerMode: 'ephemeral-sandbox' }).authorize(
				VIEWER,
				'session.surface',
				onSession(app),
			),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
		await expect(
			service().authorize(EDITOR, 'session.surface', onSession(edit(EDITOR))),
		).resolves.toMatchObject({ allowed: true });
	});

	it('gates session starts on role and viewer mode', async () => {
		const start = (mode: 'edit' | 'app'): AuthorizationResource => ({
			kind: 'session-start',
			project,
			mode,
		});
		await expect(
			service().authorize(EDITOR, 'session.start', start('edit')),
		).resolves.toMatchObject({ allowed: true });
		await expect(service().authorize(VIEWER, 'session.start', start('app'))).resolves.toMatchObject(
			{ allowed: false, category: 'session' },
		);
		await expect(
			service({ viewerMode: 'applications' }).authorize(VIEWER, 'session.start', start('app')),
		).resolves.toMatchObject({ allowed: true });
		await expect(
			service({ viewerMode: 'ephemeral-sandbox' }).authorize(
				VIEWER,
				'session.start',
				start('edit'),
			),
		).resolves.toMatchObject({ allowed: true });
	});

	it('denies session actions on a deleted project before any session rule', async () => {
		await expect(
			service().authorize(OWNER, 'session.attach', onSession(app, deletedProject)),
		).resolves.toEqual({ allowed: false, category: 'lifecycle', role: null });
	});
});

describe('AuthorizationService: list visibility', () => {
	const entry = {
		owner: OWNER.id,
		member_ids: [VIEWER.id],
		member_emails: ['invitee@example.com'],
	};

	it('fast path admits super admins and default-role subjects', () => {
		expect(service().listsAllProjects(STRANGER)).toBe(false);
		expect(service({ defaultRole: 'viewer' }).listsAllProjects(STRANGER)).toBe(true);
		expect(service({ superAdmins: [STRANGER.id] }).listsAllProjects(STRANGER)).toBe(true);
	});

	it('decides per-entry visibility from the denormalized snapshot', () => {
		expect(service().projectEntryVisibility(OWNER, entry)).toBe(true);
		expect(service().projectEntryVisibility(VIEWER, entry)).toBe(true);
		expect(service().projectEntryVisibility(subject('user_x', 'invitee@example.com'), entry)).toBe(
			true,
		);
		expect(service().projectEntryVisibility(STRANGER, entry)).toBe(false);
	});

	it('reports indeterminate entries as null, never visible', () => {
		expect(service().projectEntryVisibility(STRANGER, { owner: OWNER.id })).toBeNull();
	});
});

describe('AuthorizationService: contract', () => {
	it('uses the enforcement decision as the analysis verdict', async () => {
		for (const [who, action, resource] of [
			[OWNER, 'project.read', onProject()],
			[STRANGER, 'project.read', onProject()],
			[VIEWER, 'notebook.write', onProject()],
			[OWNER, 'session.start', { kind: 'session-start', project, mode: 'edit' }],
		] as const) {
			const authz = service();
			const decision = await authz.authorize(who, action, resource);
			const analysis = await authz.analyze(who, action, resource);
			expect(analysis.decision).toEqual(decision);
			expect(analysis.trace.at(-1)).toMatchObject({ stage: 'final' });
		}
	});

	it('reports the role source and transport presentation', async () => {
		const analysis = await service().analyze(STRANGER, 'project.read', onProject());
		expect(analysis.presentation).toBe('not-found');
		expect(analysis.trace).toContainEqual(
			expect.objectContaining({ stage: 'role', code: 'effective_role_none' }),
		);
	});

	it('rejects a resource whose kind does not match the action scope', async () => {
		await expect(
			service().authorize(OWNER, 'project.read', { kind: 'deployment' }),
		).rejects.toThrow(/requires a project resource/);
	});

	it('authorizeMany mirrors authorize element-wise', async () => {
		const resources: AuthorizationResource[] = [onProject(), onProject(deletedProject)];
		const many = await service().authorizeMany(OWNER, 'project.read', resources);
		expect(many).toEqual([
			await service().authorize(OWNER, 'project.read', resources[0]),
			await service().authorize(OWNER, 'project.read', resources[1]),
		]);
	});

	it('covers every action with a scope rule', () => {
		for (const action of AUTHORIZATION_ACTIONS) {
			expect(ACTION_RULES[action]).toBeDefined();
		}
		const projectRules = PROJECT_ACTIONS.map((action) => ACTION_RULES[action]);
		for (const rule of projectRules) expect(rule.scope).toBe('project');
	});
});

describe('AuthorizationService: identity-matching edge cases', () => {
	it('matches an email invite row case- and whitespace-insensitively', async () => {
		const invited = makeProject({
			owner: OWNER.id,
			members: [{ email: '  Invitee@Example.COM ', role: 'editor' }],
		});
		const bySameEmail = subject('user_other_id', 'invitee@example.com');
		await expect(
			service().authorize(bySameEmail, 'notebook.write', onProject(invited)),
		).resolves.toEqual({ allowed: true, role: 'editor' });
		// A different email with an id that HAPPENS to equal the invite email must
		// not match — invite rows bind to the asserted login email only.
		const idCollision = subject('invitee@example.com', 'attacker@example.com');
		await expect(
			service().authorize(idCollision, 'notebook.write', onProject(invited)),
		).resolves.toEqual({ allowed: false, category: 'role', role: null });
	});

	it('keeps the highest role when id and email rows both match the caller', async () => {
		const doubled = makeProject({
			owner: OWNER.id,
			members: [
				{ user_id: VIEWER.id, role: 'viewer' },
				{ email: VIEWER.email, role: 'manager' },
			],
		});
		await expect(
			service().authorize(VIEWER, 'project.update', onProject(doubled)),
		).resolves.toEqual({ allowed: true, role: 'manager' });
	});

	it('applies the super-admin namespace rule: @ entries match email only, others id only', async () => {
		const byEmail = service({ superAdmins: ['Stranger@Example.com'] });
		await expect(
			byEmail.authorize(
				subject('user_stranger', 'stranger@example.com'),
				'project.delete',
				onProject(),
			),
		).resolves.toMatchObject({ allowed: true, role: 'admin' });
		// An id equal to that email string must not be elevated by the email entry.
		await expect(
			byEmail.authorize(
				subject('Stranger@Example.com', 'other@example.com'),
				'project.delete',
				onProject(),
			),
		).resolves.toMatchObject({ allowed: false });
		// And a plain id entry never matches by email.
		const byId = service({ superAdmins: ['user_stranger'] });
		await expect(
			byId.authorize(subject('user_x', 'user_stranger'), 'project.delete', onProject()),
		).resolves.toMatchObject({ allowed: false });
	});

	it('decides with no policy at all (undefined) as members-only', async () => {
		const bare = new AuthorizationService(undefined);
		await expect(bare.authorize(VIEWER, 'project.read', onProject())).resolves.toEqual({
			allowed: true,
			role: 'viewer',
		});
		await expect(bare.authorize(STRANGER, 'project.read', onProject())).resolves.toEqual({
			allowed: false,
			category: 'visibility',
			role: null,
		});
		await expect(
			bare.authorize(STRANGER, 'project.create', { kind: 'deployment' }),
		).resolves.toEqual({ allowed: true, role: null });
	});
});

describe('AuthorizationService: session edge cases', () => {
	it('treats a stored session without a mode as an edit session', async () => {
		// Legacy records omit `mode`; exclusive sharing must still bind to it.
		const session = { user_id: EDITOR.id, editor_sandbox_sharing: 'exclusive' as const };
		await expect(
			service().authorize(MANAGER, 'session.attach', { kind: 'session', project, session }),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
		await expect(
			service().authorize(EDITOR, 'session.attach', { kind: 'session', project, session }),
		).resolves.toMatchObject({ allowed: true });
	});

	it('falls back to the deployment sharing policy when the session omits it', async () => {
		const session = { mode: 'edit' as const, user_id: EDITOR.id };
		await expect(
			service({ editorSandboxSharing: 'exclusive' }).authorize(MANAGER, 'session.attach', {
				kind: 'session',
				project,
				session,
			}),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
		await expect(
			service().authorize(MANAGER, 'session.attach', { kind: 'session', project, session }),
		).resolves.toMatchObject({ allowed: true });
	});

	it("cuts a viewer's own ephemeral kernel on a viewer-mode downgrade, but not their stop", async () => {
		const throwaway = { mode: 'edit' as const, ephemeral: true, user_id: VIEWER.id };
		const downgraded = service({ viewerMode: 'static' });
		await expect(
			downgraded.authorize(VIEWER, 'session.attach', onSession(throwaway)),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
		await expect(
			downgraded.authorize(VIEWER, 'session.stop', onSession(throwaway)),
		).resolves.toMatchObject({ allowed: true });
		// Another viewer never reaches someone else's throwaway.
		const otherViewer = subject('user_viewer_2');
		const withOther = makeProject({
			owner: OWNER.id,
			members: [
				{ user_id: VIEWER.id, role: 'viewer' },
				{ user_id: otherViewer.id, role: 'viewer' },
			],
		});
		await expect(
			service({ viewerMode: 'ephemeral-sandbox' }).authorize(
				otherViewer,
				'session.attach',
				onSession(throwaway, withOther),
			),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
	});

	it('never grants a viewer stop on a shared app', async () => {
		const app = { mode: 'app' as const, user_id: OWNER.id };
		await expect(
			service({ viewerMode: 'applications' }).authorize(VIEWER, 'session.stop', onSession(app)),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
	});

	it('fails closed to static viewer admission when viewer mode is unset', async () => {
		await expect(
			service().authorize(VIEWER, 'session.start', { kind: 'session-start', project, mode: 'app' }),
		).resolves.toMatchObject({ allowed: false, category: 'session' });
	});

	it('denies session starts on a deleted project as lifecycle', async () => {
		await expect(
			service().authorize(OWNER, 'session.start', {
				kind: 'session-start',
				project: deletedProject,
				mode: 'edit',
			}),
		).resolves.toEqual({ allowed: false, category: 'lifecycle', role: null });
	});
});

describe('AuthorizationService: list-entry edge cases', () => {
	it('fails closed (not indeterminate) when member_emails is missing', async () => {
		// An email-pending invitee may briefly miss the project in listings; this
		// must never surface as `null`, which would trigger a per-entry fallback.
		const entry = { owner: OWNER.id, member_ids: [VIEWER.id] };
		expect(service().projectEntryVisibility(subject('user_x', 'invitee@example.com'), entry)).toBe(
			false,
		);
	});

	it('normalizes stored invite emails before comparing', async () => {
		const entry = {
			owner: OWNER.id,
			member_ids: [],
			member_emails: ['  Invitee@Example.COM '],
		};
		expect(service().projectEntryVisibility(subject('user_x', 'invitee@example.com'), entry)).toBe(
			true,
		);
	});

	it('rejects the whole batch when any resource kind mismatches the action scope', async () => {
		// authorizeMany is Promise.all: a scope mismatch is a programming error and
		// must not silently drop to a per-item denial.
		await expect(
			service().authorizeMany(OWNER, 'project.read', [onProject(), { kind: 'deployment' }]),
		).rejects.toThrow(/requires a project resource/);
	});
});

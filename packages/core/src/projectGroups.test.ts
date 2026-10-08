import { describe, expect, it, vi } from 'vitest';
import { canSeeProjectEntry, resolveEffectiveRole } from './authz';
import { memberRefMatchesSelector, memberRefMatchesSubject } from './identityMatch';
import { ProjectMemberSchema } from './schema';
import { paths } from './paths';
import { ACTOR, makeProject, setupTestEnv, uid } from './testing';
import { claimInviteRows } from './services/content/ProjectService';
import { notificationRouter, resolveMemberRecipient } from './notifications';

const subject = { id: uid('outsider'), email: 'out@example.com', groups: ['/teams/Data', 'other'] };

describe('group principals', () => {
	it.each(['x', '/teams/Data', '工程', 'x'.repeat(128), 'a b', 'a@b.com', '💡'.repeat(128)])(
		'accepts an exact group id: %s',
		(group) => {
			expect(ProjectMemberSchema.parse({ group, role: 'editor' })).toEqual({
				group,
				role: 'editor',
			});
		},
	);
	it.each(['', ' x', 'x ', 'x,y', 'x\ny', 'x\u0000y', 'x\u007fy', 'x'.repeat(129)])(
		'rejects invalid group ids: %j',
		(group) => {
			expect(ProjectMemberSchema.safeParse({ group, role: 'viewer' }).success).toBe(false);
		},
	);
	it.each([
		{ role: 'editor' },
		{ group: 'team', email: 'a@b.com', role: 'editor' },
		{ group: 'team', user_id: 'team', role: 'editor' },
		{ group: 'team', role: 'admin' },
	])('rejects malformed or privileged group rows: %j', (row) => {
		expect(ProjectMemberSchema.safeParse(row).success).toBe(false);
	});
	it('keeps group, user and email namespaces separate', () => {
		const group = subject.email;
		expect(memberRefMatchesSubject({ group }, subject)).toBe(false);
		expect(memberRefMatchesSubject({ group: subject.id }, subject)).toBe(false);
		expect(memberRefMatchesSubject({ group: '/teams/data' }, subject)).toBe(false);
		expect(memberRefMatchesSubject({ group: '/teams/Data' }, subject)).toBe(true);
		expect(memberRefMatchesSubject({ group: '/teams/Data', user_id: subject.id }, subject)).toBe(
			false,
		);
		expect(memberRefMatchesSelector({ group }, group)).toBe(false);
		expect(memberRefMatchesSelector({ email: group }, { group })).toBe(false);
		expect(memberRefMatchesSelector({ user_id: uid(group) }, { group })).toBe(false);
		expect(memberRefMatchesSelector({ group }, { group })).toBe(true);
	});
	it('chooses the highest matching role before project and deployment defaults', () => {
		const members = [
			{ group: '/teams/Data', role: 'viewer' },
			{ group: 'other', role: 'editor' },
		] as const;
		for (const rows of [members, [...members].reverse()]) {
			const project = makeProject({ owner: ACTOR, members: [...rows], default_role: 'manager' });
			expect(
				resolveEffectiveRole(
					project,
					{ ...subject, entitlements: ['default-role:manager'] },
					{ defaultRole: 'manager' },
				),
			).toEqual({ role: 'editor', source: 'member-group' });
			expect(resolveEffectiveRole(project, { ...subject, groups: [] })).toEqual({
				role: 'manager',
				source: 'project-default',
			});
		}
	});
	it.each([
		[
			{ user_id: subject.id, role: 'viewer' as const },
			{ group: '/teams/Data', role: 'manager' as const },
			'member-group',
		],
		[
			{ group: '/teams/Data', role: 'viewer' as const },
			{ email: subject.email, role: 'manager' as const },
			'member-email',
		],
		[
			{ group: '/teams/Data', role: 'viewer' as const },
			{ user_id: subject.id, role: 'manager' as const },
			'member-id',
		],
	] as const)('chooses the highest role across member namespaces: %j', (lower, higher, source) => {
		for (const members of [
			[lower, higher],
			[higher, lower],
		])
			expect(resolveEffectiveRole(makeProject({ owner: ACTOR, members }), subject)).toEqual({
				role: 'manager',
				source,
			});
	});
	it('breaks equal-role ties by user id, then email, then group regardless of order', () => {
		const members = [
			{ group: '/teams/Data', role: 'editor' },
			{ email: subject.email, role: 'editor' },
			{ user_id: subject.id, role: 'editor' },
		] as const;
		for (const rows of [members, [...members].reverse()]) {
			expect(
				resolveEffectiveRole(makeProject({ owner: ACTOR, members: [...rows] }), subject).source,
			).toBe('member-id');
			expect(
				resolveEffectiveRole(
					makeProject({ owner: ACTOR, members: rows.filter((m) => !('user_id' in m)) }),
					subject,
				).source,
			).toBe('member-email');
		}
	});
	it('ignores in-memory group admin rows and leaves owner and super-admin precedence intact', () => {
		const project = makeProject({
			owner: ACTOR,
			members: [{ group: '/teams/Data', role: 'admin' }],
		});
		expect(resolveEffectiveRole(project, subject).role).toBeNull();
		expect(resolveEffectiveRole(project, { ...subject, id: ACTOR }).role).toBe('admin');
		expect(resolveEffectiveRole(project, subject, { superAdmins: [subject.id] }).role).toBe(
			'admin',
		);
		expect(resolveEffectiveRole(project, { ...subject, entitlements: ['super-admin'] }).role).toBe(
			'admin',
		);
	});
	it('never authorizes a group member from a catalog projection alone', () => {
		expect(canSeeProjectEntry({ owner: ACTOR, member_groups: subject.groups }, subject)).toBeNull();
	});
	it('does not normalize Unicode group ids when resolving access', () => {
		const group = 'caf\u00e9';
		const project = makeProject({ owner: ACTOR, members: [{ group, role: 'editor' }] });
		expect(resolveEffectiveRole(project, { ...subject, groups: ['cafe\u0301'] }).role).toBeNull();
		expect(resolveEffectiveRole(project, { ...subject, groups: [group] }).role).toBe('editor');
	});
	it('does not claim or merge groups during invitation resolution', async () => {
		const resolve = vi.fn(async () => new Map([['out@example.com', { id: subject.id }]]));
		const members = [
			{ group: 'out@example.com', role: 'manager' },
			{ email: 'out@example.com', role: 'viewer' },
			{ user_id: subject.id, role: 'editor' },
		] as const;
		const result = await claimInviteRows([...members], resolve);
		expect(result.members).toEqual([
			{ group: 'out@example.com', role: 'manager' },
			{ user_id: subject.id, role: 'editor' },
		]);
		expect(resolve).toHaveBeenCalledWith(['out@example.com']);
	});
	it('does not query identities for a group-only roster', async () => {
		const resolve = vi.fn();
		const members = [{ group: 'team@example.com', role: 'editor' as const }];
		expect((await claimInviteRows(members, resolve)).members).toEqual(members);
		expect(resolve).not.toHaveBeenCalled();
	});
	it('serializes concurrent duplicate group additions without losing other grants', async () => {
		const { projects } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		const results = await Promise.allSettled([
			projects.addMember(project.id, { group: 'team' }, 'editor', ACTOR),
			projects.addMember(project.id, { group: 'team' }, 'viewer', ACTOR),
			projects.addMember(project.id, { group: 'other' }, 'manager', ACTOR),
		]);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const members = (await projects.getProject(project.id)).members;
		expect(members.filter((member) => member.group === 'team')).toHaveLength(1);
		expect(members).toContainEqual({ group: 'other', role: 'manager' });
	});
	it('mutates group rows independently of matching owner and email names', async () => {
		const { projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		await projects.addMember(project.id, { group: ACTOR }, 'editor', ACTOR);
		await projects.addMember(project.id, { group: subject.email }, 'viewer', ACTOR);
		await projects.addMember(project.id, { email: subject.email }, 'editor', ACTOR);
		await expect(projects.addMember(project.id, { group: ACTOR }, 'viewer', ACTOR)).rejects.toThrow(
			'already a member',
		);
		await projects.updateMemberRole(project.id, { group: ACTOR }, 'manager', ACTOR);
		await projects.removeMember(project.id, { group: ACTOR }, ACTOR);
		await projects.removeMember(project.id, { group: subject.email }, ACTOR);
		expect((await projects.getProject(project.id)).members).toEqual([
			{ user_id: ACTOR, role: 'admin' },
			{ email: subject.email, role: 'editor' },
		]);
		expect(
			(await catalog.getCurrentSnapshot()).projects.find((p) => p.id === project.id)?.member_groups,
		).toEqual([]);
		await expect(projects.removeMember(project.id, { group: 'missing' }, ACTOR)).rejects.toThrow(
			'not a member',
		);
	});
	it('rejects admin group mutations without changing the authoritative roster', async () => {
		const { projects } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		await expect(
			projects.addMember(project.id, { group: 'team' }, 'admin' as never, ACTOR),
		).rejects.toThrow('Cannot assign admin');
		await projects.addMember(project.id, { group: 'team' }, 'editor', ACTOR);
		const before = await projects.getProject(project.id);
		await expect(
			projects.updateMemberRole(project.id, { group: 'team' }, 'admin' as never, ACTOR),
		).rejects.toThrow('Cannot assign admin');
		expect(await projects.getProject(project.id)).toEqual(before);
	});
	it('revokes group-only project and directory access even if catalog projection fails', async () => {
		const { projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		await projects.addMember(project.id, { group: subject.groups[0] }, 'viewer', ACTOR);
		expect(await catalog.hasProjectInvolvement(subject)).toBe(true);
		expect((await projects.listProjects({ subject })).map((p) => p.id)).toContain(project.id);
		vi.spyOn(catalog, 'updateProjectEntry').mockRejectedValueOnce(new Error('projection failed'));
		await expect(
			projects.removeMember(project.id, { group: subject.groups[0] }, ACTOR),
		).rejects.toThrow('projection failed');
		expect(await catalog.hasProjectInvolvement(subject)).toBe(false);
		expect(await projects.listProjects({ subject })).toEqual([]);
	});
	it.each(['add', 'update', 'remove'] as const)(
		'leaves the roster and catalog unchanged when the authoritative %s write fails',
		async (operation) => {
			const { projects, catalog, bucket } = await setupTestEnv();
			const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
			const selector = { group: subject.groups[0] };
			if (operation !== 'add') await projects.addMember(project.id, selector, 'viewer', ACTOR);
			const before = await projects.getProject(project.id);
			const snapshot = await catalog.getCurrentSnapshot();
			const put = bucket.put.bind(bucket);
			vi.spyOn(bucket, 'put').mockImplementation((key, ...args) => {
				if (key === paths.project(project.id).meta) throw new Error('storage unavailable');
				return put(key, ...args);
			});
			const mutation =
				operation === 'add'
					? projects.addMember(project.id, selector, 'manager', ACTOR)
					: operation === 'update'
						? projects.updateMemberRole(project.id, selector, 'manager', ACTOR)
						: projects.removeMember(project.id, selector, ACTOR);
			await expect(mutation).rejects.toThrow('storage unavailable');
			expect(await projects.getProject(project.id)).toEqual(before);
			expect(await catalog.getCurrentSnapshot()).toEqual(snapshot);
			expect(resolveEffectiveRole(await projects.getProject(project.id), subject).role).toBe(
				operation === 'add' ? null : 'viewer',
			);
		},
	);
	it('uses a committed demotion when the catalog write fails, and can retry the mutation', async () => {
		const { projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		const selector = { group: subject.groups[0] };
		await projects.addMember(project.id, selector, 'manager', ACTOR);
		vi.spyOn(catalog, 'updateProjectEntry').mockRejectedValueOnce(new Error('projection failed'));
		await expect(
			projects.updateMemberRole(project.id, selector, 'app-user', ACTOR),
		).rejects.toThrow('projection failed');
		expect(resolveEffectiveRole(await projects.getProject(project.id), subject).role).toBe(
			'app-user',
		);
		expect(await projects.listProjects({ subject })).toEqual([]);
		await projects.updateMemberRole(project.id, selector, 'app-user', ACTOR);
		expect((await projects.getProject(project.id)).members).toContainEqual({
			...selector,
			role: 'app-user',
		});
	});
	it('fails closed on missing group projections for directory access, but reads project heads for lists', async () => {
		const { projects, catalog, bucket } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...project, members: [{ group: subject.groups[0], role: 'viewer' }] }),
		);
		expect(await catalog.hasProjectInvolvement(subject)).toBe(false);
		expect((await projects.listProjects({ subject })).map((p) => p.id)).toContain(project.id);
	});
	it('does not grant directory access to a removed IdP group or a deleted project', async () => {
		const { projects, catalog } = await setupTestEnv();
		const project = await projects.createProject({ name: 'Groups', description: '' }, ACTOR);
		await projects.addMember(project.id, { group: subject.groups[0] }, 'viewer', ACTOR);
		expect(await catalog.hasProjectInvolvement(subject)).toBe(true);
		expect(await catalog.hasProjectInvolvement({ ...subject, groups: [] })).toBe(false);
		await projects.deleteProject(project.id, ACTOR);
		expect(await catalog.hasProjectInvolvement(subject)).toBe(false);
	});
	it('renders group alerts as broadcast-only with typed group data', () => {
		const project = makeProject();
		const member = { group: '/teams/Data', role: 'editor' } as const;
		const common = {
			project,
			member,
			actor: { id: ACTOR, email: 'owner@example.com' },
			mutationId: 'mutation',
		};
		for (const input of [
			{ ...common, kind: 'member.group_added' as const },
			{ ...common, kind: 'member.role_changed' as const, oldRole: 'viewer' as const },
			{ ...common, kind: 'member.removed' as const },
		]) {
			const rendered = notificationRouter.render(input);
			expect(rendered).toHaveLength(1);
			expect(rendered[0]).toMatchObject({
				audience: 'broadcast',
				recipients: [],
				data: { member_group: member.group },
			});
		}
		expect(resolveMemberRecipient(member)).toBeNull();
	});
});

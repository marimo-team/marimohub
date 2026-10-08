import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServices, paths, ProjectId } from '@marimo-hub/core';
import type { Authenticator, ProjectAlertDispatcher } from '@marimo-hub/core';
import { ACTOR, MemoryNotifier, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';

const GROUP = '/teams/Data + Research';
const groupQuery = `?group=${encodeURIComponent(GROUP)}`;

describe('project group member routes', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: string;
	beforeEach(async () => {
		bucket = await createInitializedBucket();
		owner = createTestApi({ bucket, deps: { policy: { groups_carried: true } } }).request;
		pid = (
			await expectOk(await owner('POST', '/projects', { name: 'Groups', description: '' }), 201)
		).id;
	});
	function caller(groups: string[] = [GROUP], kind: 'sso' | 'external-access-token' = 'sso') {
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: uid('group-user'),
				email: 'group-user@example.com',
				credential: { kind },
				groups,
			}),
		};
		return createTestApi({ bucket, deps: { authenticator, policy: { groups_carried: true } } });
	}
	const add = (role = 'viewer', group = GROUP) =>
		owner('POST', `/projects/${pid}/members`, { group, role });
	function withAlerts() {
		const notifier = new MemoryNotifier();
		const deliver = vi.fn<ProjectAlertDispatcher['deliver']>(async () => 'delivered');
		const tasks: Promise<unknown>[] = [];
		const api = createTestApi({
			bucket,
			deps: {
				notifier,
				policy: { groups_carried: true },
				backgroundTasks: {
					defer: (task) => {
						tasks.push(task);
					},
				},
				projectAlerts: {
					store: {} as never,
					dispatcher: { deliver, test: vi.fn() },
					maxDestinations: 10,
				},
			},
		});
		return { ...api, notifier, deliver, drain: () => Promise.all(tasks) };
	}
	it.each(['sso', 'external-access-token'] as const)(
		'grants project, list and directory access to %s groups and revokes it when groups change',
		async (kind) => {
			await expectOk(await add(), 201);
			await expectOk(
				await owner('POST', `/projects/${pid}/members`, {
					email: 'private@example.com',
					role: 'viewer',
				}),
				201,
			);
			const { request } = caller([GROUP], kind);
			const detail = await expectOk(await request('GET', `/projects/${pid}`));
			expect(detail.your_role).toBe('viewer');
			expect(detail.members).toContainEqual({ group: GROUP, role: 'viewer' });
			expect(detail.members.some((m: { email?: string }) => m.email)).toBe(false);
			expect(await expectOk(await request('GET', `/projects/${pid}/members`))).toEqual(
				detail.members,
			);
			expect((await expectPage(await request('GET', '/projects'))).map((p) => p.id)).toContain(pid);
			await expectOk(await request('GET', '/users/search?q=group'));
			const removed = caller([]).request;
			await expectError(await removed('GET', `/projects/${pid}`), 404);
			await expectError(await removed('GET', '/users/search?q=group'), 403);
			expect((await expectPage(await removed('GET', '/projects'))).map((p) => p.id)).not.toContain(
				pid,
			);
		},
	);
	it('carries group roles through app listings, deep links, and notebook guards', async () => {
		const services = createServices(bucket);
		const notebook = await services.notebooks.createNotebook(
			ProjectId.parse(pid),
			{ title: 'Group app', description: '', code: 'SOURCE_SENTINEL = 42' },
			ACTOR,
		);
		const base = `/projects/${pid}/notebooks/${notebook.id}`;
		await expectOk(await owner('POST', `${base}/deep-links`, { slug: 'group-app' }));
		await expectOk(await add('app-user'), 201);
		const { request } = caller();
		expect(await expectOk(await request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
		expect(await expectPage(await request('GET', '/apps'))).toContainEqual(
			expect.objectContaining({ notebook_id: notebook.id, your_role: 'app-user' }),
		);
		await expectOk(await request('GET', '/deep-links/group-app'));
		await expectError(await request('GET', `${base}/content`), 404);
		await expectError(await request('PATCH', base, { title: 'Changed' }), 403);
		await expectOk(
			await owner('PUT', `/projects/${pid}/group-members${groupQuery}`, { role: 'editor' }),
		);
		await expectOk(await request('GET', `${base}/content`));
		await expectOk(await request('PATCH', base, { title: 'Changed' }));
		await expectOk(await owner('DELETE', `/projects/${pid}/group-members${groupQuery}`));
		await expectError(await request('GET', '/deep-links/group-app'), 404);
	});
	it('does not give a personal access token its user’s SSO groups', async () => {
		await expectOk(await add(), 201);
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: uid('group-user'),
				email: 'group-user@example.com',
				credential: { kind: 'personal-access-token', id: 'token' },
			}),
		};
		const { request } = createTestApi({ bucket, deps: { authenticator } });
		await expectError(await request('GET', `/projects/${pid}`), 404);
	});
	it('keeps lower explicit group membership ahead of higher project and deployment defaults', async () => {
		await expectOk(await add('app-user'), 201);
		await expectOk(await owner('PATCH', `/projects/${pid}`, { default_role: 'manager' }));
		await expectError(await caller().request('GET', `/projects/${pid}`), 404);
		await expectError(
			await caller().request('POST', `/projects/${pid}/members`, { group: 'new', role: 'viewer' }),
			403,
		);
	});
	it('lets group managers manage memberships with slash-bearing group ids', async () => {
		await expectOk(await add('manager'), 201);
		const manager = caller().request;
		await expectOk(
			await manager('POST', `/projects/${pid}/members`, { group: '/other/team', role: 'viewer' }),
			201,
		);
		const updated = await expectOk(
			await owner('PUT', `/projects/${pid}/group-members${groupQuery}`, { role: 'editor' }),
		);
		expect(updated.members).toContainEqual({ group: GROUP, role: 'editor' });
		await expectOk(await owner('DELETE', `/projects/${pid}/group-members${groupQuery}`));
		await expectError(await manager('GET', `/projects/${pid}`), 404);
	});
	it.each(['PUT', 'DELETE'])(
		'revokes management after a group manager changes their own grant with %s, preserving other groups',
		async (method) => {
			await expectOk(await add('manager'), 201);
			await expectOk(await add('editor', 'other'), 201);
			const { request } = caller([GROUP, 'other']);
			await expectOk(
				await request(
					method,
					`/projects/${pid}/group-members${groupQuery}`,
					method === 'PUT' ? { role: 'viewer' } : undefined,
				),
			);
			expect((await expectOk(await request('GET', `/projects/${pid}`))).your_role).toBe('editor');
			const before = await bucket.head(paths.project(ProjectId.parse(pid)).meta);
			await expectError(
				await request('PUT', `/projects/${pid}/group-members?group=other`, { role: 'manager' }),
				403,
			);
			await expectError(
				await request('POST', `/projects/${pid}/members`, { user_id: 'new-user', role: 'manager' }),
				403,
			);
			expect((await bucket.head(paths.project(ProjectId.parse(pid)).meta))?.etag).toBe(
				before?.etag,
			);
		},
	);
	it.each(['PUT', 'DELETE'])(
		'prevents group managers from changing the owner with %s',
		async (method) => {
			await expectOk(await add('manager'), 201);
			const before = await bucket.head(paths.project(ProjectId.parse(pid)).meta);
			await expectError(
				await caller().request(
					method,
					`/projects/${pid}/members/${ACTOR}`,
					method === 'PUT' ? { role: 'viewer' } : undefined,
				),
				409,
			);
			expect((await bucket.head(paths.project(ProjectId.parse(pid)).meta))?.etag).toBe(
				before?.etag,
			);
		},
	);
	it('does not carry a group’s project role into a different project', async () => {
		await expectOk(await add('manager'), 201);
		const other = await expectOk(
			await owner('POST', '/projects', { name: 'Other', description: '' }),
			201,
		);
		await expectOk(
			await owner('POST', `/projects/${other.id}/members`, { group: GROUP, role: 'viewer' }),
			201,
		);
		const { request } = caller();
		expect((await expectOk(await request('GET', `/projects/${other.id}`))).your_role).toBe(
			'viewer',
		);
		const before = await bucket.head(paths.project(ProjectId.parse(other.id)).meta);
		await expectError(
			await request('PUT', `/projects/${other.id}/group-members${groupQuery}`, { role: 'manager' }),
			403,
		);
		expect((await bucket.head(paths.project(ProjectId.parse(other.id)).meta))?.etag).toBe(
			before?.etag,
		);
		expect((await expectOk(await request('GET', `/projects/${pid}`))).your_role).toBe('manager');
	});
	it.each(['/team/A&B?C#D+E%2F', '工程/分析', '💡'.repeat(128)])(
		'round-trips exact group selectors through add, update, and remove: %s',
		async (group) => {
			await expectOk(await add('viewer', group), 201);
			const route = `/projects/${pid}/group-members?group=${encodeURIComponent(group)}`;
			const { request } = caller([group]);
			await expectOk(await owner('PUT', route, { role: 'editor' }));
			expect((await expectOk(await request('GET', `/projects/${pid}`))).your_role).toBe('editor');
			await expectOk(await owner('DELETE', route));
			await expectError(await request('GET', `/projects/${pid}`), 404);
		},
	);
	it('keeps differently cased groups distinct during both matching and removal', async () => {
		await expectOk(await add('manager', 'Team'), 201);
		await expectOk(await add('viewer', 'team'), 201);
		expect(
			(await expectOk(await caller(['team']).request('GET', `/projects/${pid}`))).your_role,
		).toBe('viewer');
		await expectError(await caller(['TEAM']).request('GET', `/projects/${pid}`), 404);
		await expectOk(await owner('DELETE', `/projects/${pid}/group-members?group=Team`));
		await expectError(await caller(['Team']).request('GET', `/projects/${pid}`), 404);
		expect(
			(await expectOk(await caller(['team']).request('GET', `/projects/${pid}`))).your_role,
		).toBe('viewer');
	});
	it.each(['app-user', 'viewer', 'editor'])(
		'prevents a group %s from managing group members',
		async (role) => {
			await expectOk(await add(role), 201);
			for (const method of ['PUT', 'DELETE'])
				await expectError(
					await caller().request(
						method,
						`/projects/${pid}/group-members${groupQuery}`,
						method === 'PUT' ? { role: 'manager' } : undefined,
					),
					403,
				);
		},
	);
	it.each([
		{ group: GROUP, email: 'a@example.com', role: 'editor' },
		{ group: GROUP, user_id: 'a', role: 'editor' },
		{ group: GROUP, role: 'admin' },
		{ group: '', role: 'editor' },
		{ group: ' team', role: 'editor' },
		{ group: 'team ', role: 'editor' },
		{ group: 'a,b', role: 'editor' },
		{ group: 'a\nb', role: 'editor' },
		{ group: 'a'.repeat(129), role: 'editor' },
	])('rejects invalid additions without mutating the project: %j', async (body) => {
		const before = await bucket.get(paths.project(ProjectId.parse(pid)).meta);
		await expectError(await owner('POST', `/projects/${pid}/members`, body), 422);
		expect((await bucket.get(paths.project(ProjectId.parse(pid)).meta))?.etag).toBe(before?.etag);
	});
	it('rejects unsupported group creation but allows removal after support is disabled', async () => {
		const disabled = createTestApi({ bucket }).request;
		expect((await expectOk(await disabled('GET', '/capabilities'))).groups_carried).toBe(false);
		expect((await expectOk(await owner('GET', '/capabilities'))).groups_carried).toBe(true);
		await expectError(
			await disabled('POST', `/projects/${pid}/members`, { group: GROUP, role: 'viewer' }),
			422,
		);
		await expectOk(await add(), 201);
		await expectOk(await disabled('DELETE', `/projects/${pid}/group-members${groupQuery}`));
	});
	it('rejects missing, invalid and nonexistent group selectors and admin updates', async () => {
		await expectOk(await add(), 201);
		for (const method of ['PUT', 'DELETE']) {
			for (const query of ['', '?group=', '?group=bad%2Cgroup'])
				await expectError(
					await owner(
						method,
						`/projects/${pid}/group-members${query}`,
						method === 'PUT' ? { role: 'viewer' } : undefined,
					),
					422,
				);
			await expectError(
				await owner(
					method,
					`/projects/${pid}/group-members?group=missing`,
					method === 'PUT' ? { role: 'viewer' } : undefined,
				),
				404,
			);
		}
		await expectError(
			await owner('PUT', `/projects/${pid}/group-members${groupQuery}`, { role: 'admin' }),
			422,
		);
		await expectError(await add(), 409);
	});
	it('never mutates a group through an individual selector, including an owner collision', async () => {
		await expectOk(await add('viewer', ACTOR), 201);
		await expectError(await owner('DELETE', `/projects/${pid}/members/${ACTOR}`), 409);
		await expectOk(await owner('DELETE', `/projects/${pid}/group-members?group=${ACTOR}`));
		await expectOk(await add('viewer', 'other'), 201);
		await expectError(await owner('DELETE', `/projects/${pid}/members/other`), 404);
		await expectOk(
			await owner('POST', `/projects/${pid}/members`, { user_id: 'other', role: 'editor' }),
			201,
		);
		await expectOk(await owner('DELETE', `/projects/${pid}/members/other`));
		expect((await expectOk(await owner('GET', `/projects/${pid}`))).members).toContainEqual({
			group: 'other',
			role: 'viewer',
		});
	});
	it('fails closed if the authoritative group role is corrupt', async () => {
		await expectOk(await add(), 201);
		const services = createServices(bucket);
		const project = await services.projects.getProject(ProjectId.parse(pid));
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...project, members: [{ group: GROUP, role: 'admin' }] }),
		);
		await expectError(await caller().request('GET', `/projects/${pid}`), 503);
		await expectError(await caller().request('GET', '/projects'), 503);
		await expectError(await caller().request('GET', '/users/search?q=group'), 503);
	});
	it('emits only a broadcast alert when adding a group', async () => {
		const { request, notifier, deliver, drain } = withAlerts();
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { group: GROUP, role: 'editor' }),
			201,
		);
		await drain();
		expect(notifier.deliveries).toEqual([]);
		expect(deliver).toHaveBeenCalledWith(
			pid,
			'member.group_added',
			expect.objectContaining({
				audience: 'broadcast',
				data: expect.objectContaining({ member_group: GROUP }),
			}),
		);
	});
	it.each(['POST', 'PUT', 'DELETE'])(
		'does not send alerts or change the roster when the %s storage write fails',
		async (method) => {
			if (method !== 'POST') await expectOk(await add(), 201);
			const { request, notifier, deliver, drain } = withAlerts();
			const key = paths.project(ProjectId.parse(pid)).meta;
			const before = await bucket.head(key);
			const put = bucket.put.bind(bucket);
			vi.spyOn(bucket, 'put').mockImplementation((target, ...args) => {
				if (target === key) throw new Error('storage unavailable');
				return put(target, ...args);
			});
			await expectError(
				await request(
					method,
					method === 'POST'
						? `/projects/${pid}/members`
						: `/projects/${pid}/group-members${groupQuery}`,
					method === 'POST'
						? { group: GROUP, role: 'editor' }
						: method === 'PUT'
							? { role: 'editor' }
							: undefined,
				),
				500,
			);
			await drain();
			expect((await bucket.head(key))?.etag).toBe(before?.etag);
			expect(deliver).not.toHaveBeenCalled();
			expect(notifier.deliveries).toEqual([]);
		},
	);
	it('does not emit role-change alerts for no-op updates or rejected duplicates', async () => {
		await expectOk(await add(), 201);
		const { request, deliver, drain } = withAlerts();
		await expectOk(
			await request('PUT', `/projects/${pid}/group-members${groupQuery}`, { role: 'viewer' }),
		);
		await expectError(
			await request('POST', `/projects/${pid}/members`, { group: GROUP, role: 'manager' }),
			409,
		);
		await drain();
		expect(deliver).not.toHaveBeenCalled();
		expect((await expectOk(await caller().request('GET', `/projects/${pid}`))).your_role).toBe(
			'viewer',
		);
	});
	it('keeps a committed removal revoked when alert delivery fails', async () => {
		await expectOk(await add(), 201);
		const { request, deliver, drain } = withAlerts();
		deliver.mockRejectedValueOnce(new Error('webhook unavailable'));
		await expectOk(await request('DELETE', `/projects/${pid}/group-members${groupQuery}`));
		await drain();
		expect(deliver).toHaveBeenCalledTimes(1);
		await expectError(await caller().request('GET', `/projects/${pid}`), 404);
	});
});

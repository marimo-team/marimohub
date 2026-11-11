import { describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ACTOR, setupTestEnv, uid } from '../../testing';
import type { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { ProjectService } from './ProjectService';
import { CatalogService } from '../catalog/CatalogService';
import { createProjectId } from '../../ids';
import { PreconditionFailedError } from '../../errors';

function projectService(bucket: MemoryBucket, catalog = new CatalogService(bucket)) {
	return new ProjectService(bucket, catalog);
}

async function setupListingEnv() {
	const env = await setupTestEnv();
	return { ...env, projects: projectService(env.bucket, env.catalog) };
}

function metadataReads(get: MockInstance<MemoryBucket['get']>) {
	return get.mock.calls.filter(([key]) => key.endsWith('/project.json'));
}

describe('project listing operation counts', () => {
	it('avoids metadata reads for stable roles across 200 projects', async () => {
		const { bucket, projects, catalog } = await setupListingEnv();
		const member = { id: uid('member'), email: 'member@example.com', groups: ['analysts'] };
		const appUser = { id: uid('app-user'), email: 'apps@example.com' };
		const visible: string[] = [];
		for (let i = 0; i < 200; i++) {
			const project = await projects.createProject(
				{ name: `Project ${i}`, description: '' },
				ACTOR,
			);
			await projects.addMember(project.id, { user_id: appUser.id }, 'app-user', ACTOR);
			if (i < 3) {
				const identity = [{ user_id: member.id }, { email: member.email }, { group: 'analysts' }][
					i
				];
				await projects.addMember(project.id, identity, 'viewer', ACTOR);
				visible.push(project.id);
			}
		}
		const get = vi.spyOn(bucket, 'get');
		for (let call = 0; call < 2; call++) {
			expect((await projects.listProjects({ subject: member })).map((entry) => entry.id)).toEqual(
				visible,
			);
			expect(await projects.isAppOnly(member)).toBe(false);
			expect(await projects.isAppOnly(member, { defaultRole: 'app-user' })).toBe(false);
			expect(await projects.isAppOnly(appUser)).toBe(true);
			expect(await projects.listProjects({ subject: appUser })).toEqual([]);
			expect(
				await projects.listProjects({ subject: member, policy: { defaultRole: 'viewer' } }),
			).toHaveLength(200);
		}
		expect(metadataReads(get)).toHaveLength(0);

		await catalog.mutateSnapshot('test.legacy', ACTOR, (snapshot) => ({
			...snapshot,
			projects: snapshot.projects.map((entry, i) =>
				i < 2 ? { ...entry, access: undefined } : entry,
			),
		}));
		get.mockClear();
		expect((await projects.listProjects({ subject: member })).map((entry) => entry.id)).toEqual(
			visible,
		);
		expect(metadataReads(get)).toHaveLength(2);
		get.mockClear();
		expect(await projects.isAppOnly(appUser)).toBe(true);
		expect(metadataReads(get)).toHaveLength(2);
	});
});

describe('project access projection fencing', () => {
	const subject = { id: uid('member'), email: 'member@example.com' };

	async function pendingRevocation() {
		const env = await setupListingEnv();
		const { projects, catalog } = env;
		const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
		await projects.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
		const update = catalog.updateProjectEntry.bind(catalog);
		const spy = vi.spyOn(catalog, 'updateProjectEntry').mockImplementation((operation, ...args) => {
			if (operation === 'project.members') return Promise.reject(new Error('projection failed'));
			return update(operation, ...args);
		});
		await expect(
			projects.updateMemberRole(project.id, subject.id, 'app-user', ACTOR),
		).rejects.toThrow('projection failed');
		spy.mockRestore();
		return { ...env, project };
	}

	it.each(['membership', 'default'] as const)(
		'does not change %s when parking fails',
		async (kind) => {
			const { bucket, projects, catalog } = await setupListingEnv();
			const project = await projects.createProject({ name: 'Private', description: '' }, ACTOR);
			vi.spyOn(catalog, 'updateProjectEntry').mockRejectedValueOnce(
				new Error('catalog unavailable'),
			);
			const put = vi.spyOn(bucket, 'put');
			await expect(
				kind === 'membership'
					? projects.addMember(project.id, { user_id: subject.id }, 'app-user', ACTOR)
					: projects.updateProject(project.id, { default_role: 'app-user' }, ACTOR),
			).rejects.toThrow('catalog unavailable');
			expect(put.mock.calls).toEqual([]);
			expect(await projects.getProject(project.id)).toEqual(project);
		},
	);

	it('keeps other writers pending when a concurrent mutation finishes first', async () => {
		const { bucket, projects, catalog } = await setupListingEnv();
		const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
		await projects.addMember(project.id, { user_id: subject.id }, 'manager', ACTOR);
		const other = projectService(bucket);
		const put = bucket.put.bind(bucket);
		let raced = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
			if (!raced && key === paths.project(project.id).meta) {
				raced = true;
				await other.updateMemberRole(project.id, subject.id, 'viewer', ACTOR);
				await other.updateProject(project.id, { name: 'Renamed' }, ACTOR);
				const [entry] = (await catalog.getCurrentSnapshot()).projects;
				expect(entry.access).toBeUndefined();
				expect(entry.access_pending).toHaveLength(1);
				expect(await other.isAppOnly(subject)).toBe(false);
			}
			return put(key, ...args);
		});
		await projects.updateMemberRole(project.id, subject.id, 'app-user', ACTOR);
		const [entry] = (await catalog.getCurrentSnapshot()).projects;
		expect(raced).toBe(true);
		expect(entry.access_pending).toBeUndefined();
		expect(entry.access?.members).toContainEqual({ user_id: subject.id, role: 'app-user' });
		const get = vi.spyOn(bucket, 'get');
		expect(await other.listProjects({ subject })).toEqual([]);
		expect(await other.isAppOnly(subject)).toBe(true);
		expect(metadataReads(get)).toHaveLength(0);
	});

	it('keeps a failed revocation indeterminate through routine projections', async () => {
		const { bucket, projects, catalog, project } = await pendingRevocation();
		await projects.updateProject(project.id, { name: 'Renamed' }, ACTOR);
		const [entry] = (await catalog.getCurrentSnapshot()).projects;
		expect(entry.access).toBeUndefined();
		expect(entry.access_pending).toHaveLength(1);
		const other = projectService(bucket);
		const get = vi.spyOn(bucket, 'get');
		expect(await other.listProjects({ subject })).toEqual([]);
		expect(await other.isAppOnly(subject)).toBe(true);
		expect(metadataReads(get)).toHaveLength(2);
	});

	it.each([
		{ kind: 'membership', committed: false },
		{ kind: 'membership', committed: true },
		{ kind: 'default', committed: false },
		{ kind: 'default', committed: true },
	] as const)(
		'resolves an ambiguous $kind write from metadata (committed: $committed)',
		async ({ kind, committed }) => {
			const { bucket, projects, catalog } = await setupListingEnv();
			const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
			if (kind === 'membership')
				await projects.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
			else await projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR);
			expect(await projects.listProjects({ subject })).toHaveLength(1);
			await projects.getProject(project.id, { consistency: 'validated' });
			const put = bucket.put.bind(bucket);
			const spy = vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
				if (key !== paths.project(project.id).meta) return put(key, ...args);
				if (committed) await put(key, ...args);
				throw new Error('write outcome unknown');
			});
			await expect(
				kind === 'membership'
					? projects.updateMemberRole(project.id, subject.id, 'app-user', ACTOR)
					: projects.updateProject(project.id, { default_role: 'app-user' }, ACTOR),
			).rejects.toThrow('write outcome unknown');
			spy.mockRestore();
			await projects.updateProject(project.id, { name: 'Renamed' }, ACTOR);
			const [entry] = (await catalog.getCurrentSnapshot()).projects;
			expect(entry.access).toBeUndefined();
			expect(entry.access_pending).toHaveLength(1);
			expect(await projects.listProjects({ subject })).toHaveLength(committed ? 0 : 1);
			const reader = projectService(bucket);
			expect(await reader.listProjects({ subject })).toHaveLength(committed ? 0 : 1);
			expect(await reader.isAppOnly(subject)).toBe(committed);
		},
	);

	it.each(['unavailable', 'invalid-json', 'invalid-role'] as const)(
		'fails closed when pending metadata is %s',
		async (failure) => {
			const { bucket, projects, project } = await pendingRevocation();
			if (failure === 'unavailable') {
				const get = bucket.get.bind(bucket);
				vi.spyOn(bucket, 'get').mockImplementation((key, ...args) => {
					if (key === paths.project(project.id).meta) throw new Error('storage unavailable');
					return get(key, ...args);
				});
			} else {
				await bucket.put(
					paths.project(project.id).meta,
					failure === 'invalid-json'
						? '{'
						: JSON.stringify({ ...project, members: [{ user_id: subject.id, role: 'superuser' }] }),
				);
			}
			const message =
				failure === 'unavailable'
					? 'storage unavailable'
					: 'Stored data is temporarily unavailable';
			await expect(projects.listProjects({ subject })).rejects.toThrow(message);
			await expect(projects.isAppOnly(subject)).rejects.toThrow(message);
		},
	);

	it('does not restore a stale grant when pending metadata disappears', async () => {
		const { bucket, projects, project } = await pendingRevocation();
		await bucket.delete(paths.project(project.id).meta);
		expect(await projects.listProjects({ subject })).toEqual([]);
		expect(await projects.listProjects({ subject, action: 'app.read' })).toEqual([]);
		expect(await projects.isAppOnly(subject)).toBe(false);
	});

	it('ignores a retained summary while a pending marker exists', async () => {
		const { catalog, projects, project } = await pendingRevocation();
		await catalog.updateProjectEntry('test.stale-summary', ACTOR, project.id, () => ({
			access: {
				members: [{ user_id: subject.id, role: 'manager' }],
				default_role: 'manager',
				version: 1,
			},
		}));
		expect(await projects.listProjects({ subject })).toEqual([]);
		expect(await projects.isAppOnly(subject)).toBe(true);
	});

	it('filters a token-excluded pending project before attempting metadata reads', async () => {
		const { bucket, projects, project } = await pendingRevocation();
		await bucket.put(paths.project(project.id).meta, '{');
		const get = vi.spyOn(bucket, 'get');
		expect(
			await projects.listProjects({
				subject: {
					...subject,
					credential: {
						kind: 'personal-access-token',
						id: 'tok',
						grant: { actions: ['project.read'], projects: [createProjectId()] },
					},
				},
			}),
		).toEqual([]);
		expect(metadataReads(get)).toHaveLength(0);
	});

	it('rejects a stale default-role version before parking access', async () => {
		const { projects, catalog } = await setupListingEnv();
		const project = await projects.createProject({ name: 'Shared', description: '' }, ACTOR);
		const snapshot = await catalog.getCurrentSnapshot();
		await expect(
			projects.updateProject(project.id, { default_role: 'viewer' }, ACTOR, 'stale'),
		).rejects.toBeInstanceOf(PreconditionFailedError);
		expect(await catalog.getCurrentSnapshot()).toEqual(snapshot);
		expect(await projects.getProject(project.id)).toEqual(project);
	});

	it('rebuilds trusted access from authoritative metadata during offline recovery', async () => {
		const { bucket, projects, catalog } = await pendingRevocation();
		const source = { mode: 'rebuild' } as const;
		const report = await catalog.planRecovery(source);
		await catalog.recover(source, ACTOR, {
			token: report.token,
			writersStopped: true,
			acceptWarnings: true,
		});
		const [entry] = (await catalog.getCurrentSnapshot()).projects;
		expect(entry.access_pending).toBeUndefined();
		expect(entry.access?.members).toContainEqual({ user_id: subject.id, role: 'app-user' });
		const get = vi.spyOn(bucket, 'get');
		expect(await projects.listProjects({ subject })).toEqual([]);
		expect(await projects.isAppOnly(subject)).toBe(true);
		expect(metadataReads(get)).toHaveLength(0);
		await projects.updateProject(entry.id, { name: 'Refreshed' }, ACTOR);
		get.mockClear();
		expect(await projects.listProjects({ subject })).toEqual([]);
		expect(await projects.isAppOnly(subject)).toBe(true);
		expect(metadataReads(get)).toHaveLength(0);
	});
});

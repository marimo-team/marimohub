import { describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv, uid } from '../../testing';
import { paths } from '../../paths';
import { ProjectService } from './ProjectService';
import type { Project } from '../../schema';

const subject = { id: uid('member'), email: 'member@example.com' };

async function setup() {
	const env = await setupTestEnv();
	const service = (generation?: string) =>
		new ProjectService(env.bucket, env.catalog, undefined, undefined, undefined, generation);
	const writer = service('previous-deployment');
	const project = await writer.createProject({ name: 'Shared', description: '' }, ACTOR);
	return { ...env, project, writer, service };
}

describe('project access deployment generations', () => {
	it.each(['membership', 'default'] as const)(
		'ignores stale %s grants before and after a legacy writer projects a revocation',
		async (kind) => {
			const { bucket, catalog, project, writer, service } = await setup();
			if (kind === 'membership') {
				await writer.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
			} else {
				await writer.updateProject(project.id, { default_role: 'viewer' }, ACTOR);
			}
			const current = await writer.getProject(project.id);
			const revoked: Project = {
				...current,
				...(kind === 'membership'
					? { members: [{ user_id: subject.id, role: 'app-user' }] }
					: { default_role: 'app-user' }),
			};
			// Legacy writers do not park access before replacing metadata.
			await bucket.put(paths.project(project.id).meta, JSON.stringify(revoked));
			for (const projected of [false, true]) {
				if (projected) {
					await catalog.updateProjectEntry('project.members', ACTOR, project.id, () => ({
						member_ids: revoked.members.flatMap((member) => member.user_id ?? []),
						default_role: revoked.default_role ?? 'inherit',
					}));
				}
				for (const reader of [service(), service('new-deployment')]) {
					expect(await reader.listProjects({ subject })).toEqual([]);
					expect(await reader.isAppOnly(subject)).toBe(true);
				}
			}
			const reader = service('new-deployment');
			await reader.updateProject(project.id, { name: 'Refreshed' }, ACTOR);
			const get = vi.spyOn(bucket, 'get');
			expect(await reader.listProjects({ subject })).toEqual([]);
			expect(await reader.isAppOnly(subject)).toBe(true);
			expect(get.mock.calls.filter(([key]) => key.endsWith('/project.json'))).toEqual([]);
		},
	);

	it("does not reuse another generation's negative candidate index", async () => {
		const { bucket, project, writer, service } = await setup();
		expect(await writer.listProjects({ subject })).toEqual([]);
		const current = await writer.getProject(project.id);
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...current, members: [{ user_id: subject.id, role: 'viewer' }] }),
		);
		for (const reader of [service(), service('new-deployment')]) {
			expect((await reader.listProjects({ subject })).map((entry) => entry.id)).toEqual([
				project.id,
			]);
			expect(await reader.isAppOnly(subject)).toBe(false);
		}
	});

	it.each(['missing', 'invalid', 'unavailable'] as const)(
		'never falls back to an old grant when authoritative metadata is %s',
		async (failure) => {
			const { bucket, project, writer, service } = await setup();
			await writer.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
			const key = paths.project(project.id).meta;
			if (failure === 'missing') await bucket.delete(key);
			if (failure === 'invalid') await bucket.put(key, '{');
			if (failure === 'unavailable') {
				const get = bucket.get.bind(bucket);
				vi.spyOn(bucket, 'get').mockImplementation((path, ...args) => {
					if (path === key) return Promise.reject(new Error('storage unavailable'));
					return get(path, ...args);
				});
			}
			for (const reader of [service(), service('new-deployment')]) {
				if (failure === 'missing') {
					expect(await reader.listProjects({ subject })).toEqual([]);
					expect(await reader.isAppOnly(subject)).toBe(false);
				} else {
					await expect(reader.listProjects({ subject })).rejects.toThrow();
					await expect(reader.isAppOnly(subject)).rejects.toThrow();
				}
			}
		},
	);
});

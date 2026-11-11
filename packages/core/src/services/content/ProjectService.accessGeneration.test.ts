import { describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv, uid } from '../../testing';
import { paths } from '../../paths';
import { ProjectService } from './ProjectService';
import type { Project } from '../../schema';

const subject = { id: uid('member'), email: 'member@example.com' };

async function setup() {
	const env = await setupTestEnv();
	const service = () => new ProjectService(env.bucket, env.catalog);
	const writer = service();
	const project = await writer.createProject({ name: 'Shared', description: '' }, ACTOR);
	return { ...env, project, writer, service };
}

describe('project access version compatibility', () => {
	it.each(['rename', 'security labels'] as const)(
		'preserves future summaries during %s and still reads authoritative permissions',
		async (operation) => {
			const { bucket, catalog, project, writer, service } = await setup();
			await writer.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
			await catalog.updateProjectEntry('test.future', ACTOR, project.id, (entry) => ({
				access: { ...entry.access!, version: 2, future_policy: { deny: [subject.id] } },
			}));
			const before = (await catalog.getCurrentSnapshot()).projects[0].access;
			const current = await writer.getProject(project.id);
			await bucket.put(
				paths.project(project.id).meta,
				JSON.stringify({ ...current, members: [{ user_id: subject.id, role: 'app-user' }] }),
			);
			if (operation === 'rename') {
				await writer.updateProject(project.id, { name: 'Renamed' }, ACTOR);
			} else {
				await writer.setSecurityLabels(project.id, undefined, ACTOR);
			}
			expect((await catalog.getCurrentSnapshot()).projects[0].access).toEqual(before);
			for (const reader of [writer, service()]) {
				const get = vi.spyOn(bucket, 'get');
				expect(await reader.listProjects({ subject })).toEqual([]);
				expect(await reader.isAppOnly(subject)).toBe(true);
				expect(get.mock.calls.some(([key]) => key === paths.project(project.id).meta)).toBe(true);
				get.mockRestore();
			}
		},
	);

	it('preserves unknown access fields during ordinary projections', async () => {
		const { catalog, project, writer } = await setup();
		const extension = { denied_groups: ['external'], nested: { enabled: false } };
		await catalog.updateProjectEntry('test.extension', ACTOR, project.id, (entry) => ({
			access: { ...entry.access!, extension },
		}));
		await writer.updateProject(project.id, { name: 'Renamed' }, ACTOR);
		expect((await catalog.getCurrentSnapshot()).projects[0].access).toMatchObject({
			version: 1,
			extension,
		});
	});

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
			await catalog.updateProjectEntry('test.legacy', ACTOR, project.id, (entry) => ({
				access: { ...entry.access!, version: undefined, generation: 'project-access-v1' },
			}));
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
				for (const reader of [writer, service()]) {
					expect(await reader.listProjects({ subject })).toEqual([]);
					expect(await reader.isAppOnly(subject)).toBe(true);
				}
			}
			const reader = service();
			await reader.updateProject(project.id, { name: 'Refreshed' }, ACTOR);
			const get = vi.spyOn(bucket, 'get');
			expect(await reader.listProjects({ subject })).toEqual([]);
			expect(await reader.isAppOnly(subject)).toBe(true);
			expect(get.mock.calls.filter(([key]) => key.endsWith('/project.json'))).toEqual([]);
		},
	);

	it('does not reuse a trusted negative candidate index for an unknown version', async () => {
		const { bucket, catalog, project, writer, service } = await setup();
		expect(await writer.listProjects({ subject })).toEqual([]);
		await catalog.updateProjectEntry('test.future', ACTOR, project.id, (entry) => ({
			access: { ...entry.access!, version: 2 },
		}));
		const current = await writer.getProject(project.id);
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...current, members: [{ user_id: subject.id, role: 'viewer' }] }),
		);
		for (const reader of [writer, service()]) {
			expect((await reader.listProjects({ subject })).map((entry) => entry.id)).toEqual([
				project.id,
			]);
			expect(await reader.isAppOnly(subject)).toBe(false);
		}
	});

	it.each(
		(['missing', 'invalid', 'unavailable'] as const).flatMap((failure) =>
			[undefined, 2].map((version) => ({ failure, version })),
		),
	)(
		'never falls back to a version $version grant when authoritative metadata is $failure',
		async ({ failure, version }) => {
			const { bucket, catalog, project, writer, service } = await setup();
			await writer.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
			await catalog.updateProjectEntry('test.legacy', ACTOR, project.id, (entry) => ({
				access: { ...entry.access!, version, generation: 'project-access-v1' },
			}));
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
			for (const reader of [writer, service()]) {
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

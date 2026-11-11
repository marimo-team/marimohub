import { describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv, uid } from '../../testing';
import { createSnapshotId } from '../../ids';
import { paths } from '../../paths';
import { CatalogService } from '../catalog/CatalogService';
import { ProjectService } from './ProjectService';

async function setup() {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'Shared', description: '' }, ACTOR);
	const reader = new ProjectService(env.bucket, env.catalog);
	return { ...env, project, reader };
}

const subject = { id: uid('member'), email: 'member@example.com' };

describe('project access summary rebuild', () => {
	it.each([false, true])('retains unknown legacy access fields (force: %s)', async (force) => {
		const { bucket, catalog, project, reader } = await setup();
		const extension = { policies: ['future'], flags: { enabled: false } };
		await catalog.updateProjectEntry('test.legacy', ACTOR, project.id, (entry) => ({
			access: { ...entry.access!, version: undefined, extension },
		}));
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({
				...project,
				members: [{ user_id: subject.id, role: 'viewer' }],
				default_role: 'none',
			}),
		);
		expect(await reader.migrateAccessSummaries({ force })).toEqual({ done: true });
		expect((await catalog.getCurrentSnapshot()).projects[0].access).toEqual({
			members: [{ user_id: subject.id, role: 'viewer' }],
			default_role: 'none',
			version: 1,
			extension,
		});
	});

	it.each([false, true])('leaves newer access summaries intact (force: %s)', async (force) => {
		const { bucket, catalog, project, reader } = await setup();
		await catalog.updateProjectEntry('test.future', ACTOR, project.id, (entry) => ({
			access: { ...entry.access!, version: 2, extension: { policy: 'future' } },
		}));
		const before = (await catalog.getCurrentSnapshot()).projects[0].access;
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...project, members: [{ user_id: subject.id, role: 'viewer' }] }),
		);
		expect(await reader.migrateAccessSummaries({ force })).toEqual({ done: true });
		expect((await catalog.getCurrentSnapshot()).projects[0].access).toEqual(before);
		expect((await reader.listProjects({ subject })).map((entry) => entry.id)).toEqual([project.id]);
	});

	it('retains unknown current access fields during a forced rebuild', async () => {
		const { bucket, catalog, project, reader } = await setup();
		await catalog.updateProjectEntry('test.extension', ACTOR, project.id, (entry) => ({
			access: { ...entry.access!, extension: [null, false, { nested: 'value' }] },
		}));
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...project, default_role: 'viewer' }),
		);
		await reader.rebuildAccessSummaries();
		expect((await catalog.getCurrentSnapshot()).projects[0].access).toMatchObject({
			default_role: 'viewer',
			version: 1,
			extension: [null, false, { nested: 'value' }],
		});
	});

	it('rebuilds from metadata without changing project timestamps and is idempotent', async () => {
		const { bucket, catalog, project, reader } = await setup();
		const key = paths.project(project.id).meta;
		const metadata = JSON.stringify({
			...project,
			members: [{ user_id: subject.id, role: 'viewer' }],
		});
		await bucket.put(key, metadata);
		await reader.rebuildAccessSummaries();
		expect(await (await bucket.get(key))!.text()).toBe(metadata);
		const snapshot = await catalog.getCurrentSnapshot();
		expect(snapshot.projects[0].access).toEqual({
			members: [{ user_id: subject.id, role: 'viewer' }],
			default_role: 'inherit',
			version: 1,
		});
		const get = vi.spyOn(bucket, 'get');
		expect((await reader.listProjects({ subject })).map((p) => p.id)).toEqual([project.id]);
		expect(get.mock.calls.filter(([key]) => key.endsWith('/project.json'))).toEqual([]);
		await reader.rebuildAccessSummaries();
		expect((await catalog.getCurrentSnapshot()).snapshot_id).toBe(snapshot.snapshot_id);
	});

	it('preserves pending access and security markers instead of trusting an unfinished write', async () => {
		const { catalog, project, reader } = await setup();
		const marker = createSnapshotId();
		await catalog.updateProjectEntry('test.pending', ACTOR, project.id, () => ({
			access_pending: [marker],
			security_labels_pending: true,
		}));
		await reader.rebuildAccessSummaries();
		expect((await catalog.getCurrentSnapshot()).projects[0]).toMatchObject({
			access_pending: [marker],
			security_labels_pending: true,
		});
		expect((await catalog.getCurrentSnapshot()).projects[0].access).toBeUndefined();
	});

	it('rereads permissions after losing a catalog CAS to a concurrent revocation', async () => {
		const { bucket, catalog, project, reader } = await setup();
		await bucket.put(
			paths.project(project.id).meta,
			JSON.stringify({ ...project, members: [{ user_id: subject.id, role: 'viewer' }] }),
		);
		const other = new ProjectService(bucket, new CatalogService(bucket));
		const put = bucket.put.bind(bucket);
		let raced = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
			if (key === paths.catalog && !raced) {
				raced = true;
				await other.removeMember(project.id, subject.id, ACTOR);
			}
			return put(key, ...args);
		});
		await reader.rebuildAccessSummaries();
		expect(raced).toBe(true);
		expect((await catalog.getCurrentSnapshot()).projects[0].access?.members).toEqual([]);
		expect(await reader.listProjects({ subject })).toEqual([]);
	});

	it.each(['missing', 'invalid', 'unavailable'] as const)(
		'fails on %s metadata without publishing a trusted summary',
		async (failure) => {
			const { bucket, catalog, project, reader } = await setup();
			const key = paths.project(project.id).meta;
			const before = (await catalog.getCurrentSnapshot()).projects[0].access;
			if (failure === 'missing') await bucket.delete(key);
			if (failure === 'invalid') await bucket.put(key, '{');
			if (failure === 'unavailable') {
				const get = bucket.get.bind(bucket);
				vi.spyOn(bucket, 'get').mockImplementation((path, ...args) => {
					if (path === key) throw new Error('storage unavailable');
					return get(path, ...args);
				});
			}
			await expect(reader.rebuildAccessSummaries()).rejects.toThrow();
			expect((await catalog.getCurrentSnapshot()).projects[0].access).toEqual(before);
		},
	);
});

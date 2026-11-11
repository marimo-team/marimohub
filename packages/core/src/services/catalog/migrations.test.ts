import { describe, expect, it, vi } from 'vitest';
import { ACTOR, uid } from '../../testing';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { createSnapshotId } from '../../ids';
import { paths } from '../../paths';
import { createServices } from '../index';

const subject = { id: uid('reader'), email: 'reader@example.com' };
const receipt = paths.migration('project-access-v1');

async function seed(count = 1) {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const projects = [];
	for (let i = 0; i < count; i++) {
		const project = await services.projects.createProject(
			{ name: `Project ${i}`, description: '' },
			ACTOR,
		);
		await services.projects.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
		projects.push(project);
	}
	await services.catalog.mutateSnapshot('test.legacy', ACTOR, (snapshot) => {
		for (const entry of snapshot.projects) {
			entry.access = { ...entry.access!, version: undefined, generation: 'old-rollout' };
		}
		return snapshot;
	});
	return { bucket, services, projects };
}

async function finish(services: ReturnType<typeof createServices>) {
	for (let attempts = 0; attempts < 10; attempts++) if (await services.migrations.tick()) return;
	throw new Error('Migration did not finish');
}

const metadataCalls = (calls: [string, ...unknown[]][]) =>
	calls.filter(([key]) => key.endsWith('/project.json'));

describe('project access background migration', () => {
	it('falls back before migration, then uses summaries without request-time migration I/O', async () => {
		const { bucket, services, projects } = await seed();
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		expect((await services.projects.listProjects({ subject })).map((p) => p.id)).toEqual([
			projects[0].id,
		]);
		expect(metadataCalls(get.mock.calls)).toHaveLength(1);
		expect(get.mock.calls.some(([key]) => key.startsWith('_system/migrations/'))).toBe(false);
		expect(put).not.toHaveBeenCalled();
		await finish(services);
		const restarted = createServices(bucket);
		expect(await restarted.migrations.tick()).toBe(true);
		get.mockClear();
		put.mockClear();
		for (let i = 0; i < 3; i++) {
			expect((await restarted.projects.listProjects({ subject })).map((p) => p.id)).toEqual([
				projects[0].id,
			]);
			expect(await restarted.projects.isAppOnly(subject)).toBe(false);
		}
		expect(metadataCalls(get.mock.calls)).toHaveLength(0);
		expect(get.mock.calls.some(([key]) => key.startsWith('_system/migrations/'))).toBe(false);
		expect(put).not.toHaveBeenCalled();
	});

	it('batches catalog writes and resumes after restart without rereading migrated projects', async () => {
		const { bucket, services } = await seed(30);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		expect(await services.migrations.tick()).toBe(false);
		expect(metadataCalls(get.mock.calls)).toHaveLength(25);
		expect(put.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(1);
		get.mockClear();
		await finish(createServices(bucket));
		expect(metadataCalls(get.mock.calls)).toHaveLength(5);
		expect(put.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(2);
		expect((await services.projects.listProjects({ subject })).length).toBe(30);
	});

	it.each(['missing', 'corrupt', 'unavailable'])(
		'leaves a failed batch retryable when metadata is %s',
		async (failure) => {
			const { bucket, services, projects } = await seed();
			const key = paths.project(projects[0].id).meta;
			const original = await (await bucket.get(key))!.text();
			if (failure === 'missing') await bucket.delete(key);
			if (failure === 'corrupt') await bucket.put(key, '{');
			const get = bucket.get.bind(bucket);
			const spy = vi.spyOn(bucket, 'get').mockImplementation((path, ...args) => {
				if (failure === 'unavailable' && path === key) throw new Error('unavailable');
				return get(path, ...args);
			});
			await expect(services.migrations.tick()).rejects.toThrow();
			expect(
				(await services.catalog.getCurrentSnapshot()).projects[0].access?.version,
			).toBeUndefined();
			expect(await (await bucket.get(receipt))!.json()).toMatchObject({ status: 'pending' });
			spy.mockRestore();
			await bucket.put(key, original);
			await finish(createServices(bucket));
			expect((await services.catalog.getCurrentSnapshot()).projects[0].access?.version).toBe(1);
		},
	);

	it('preserves uncertain mutations without retrying them forever or trusting stale grants', async () => {
		const { bucket, services, projects } = await seed();
		const id = projects[0].id;
		const marker = createSnapshotId();
		await services.catalog.updateProjectEntry('test.pending', ACTOR, id, () => ({
			access_pending: [marker],
			security_labels_pending: true,
		}));
		const key = paths.project(id).meta;
		await bucket.put(key, JSON.stringify({ ...projects[0], members: [] }));
		await finish(services);
		const entry = (await services.catalog.getCurrentSnapshot()).projects[0];
		expect(entry.access_pending).toEqual([marker]);
		expect(entry.security_labels_pending).toBe(true);
		expect(entry.access).toBeUndefined();
		expect(await services.projects.listProjects({ subject })).toEqual([]);
		const get = vi.spyOn(bucket, 'get');
		await finish(services);
		expect(get).not.toHaveBeenCalled();
	});

	it('waits for catalog initialization without creating or completing it', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		expect(await services.migrations.tick()).toBe(false);
		expect(await bucket.get(paths.catalog)).toBeNull();
		await services.catalog.initialize(ACTOR);
		await finish(services);
	});

	it('skips current summaries and leaves new projects ready after migration completes', async () => {
		const { bucket, services } = await seed(0);
		await services.projects.createProject({ name: 'Current', description: '' }, ACTOR);
		const get = vi.spyOn(bucket, 'get');
		await finish(services);
		expect(metadataCalls(get.mock.calls)).toHaveLength(0);
		const project = await services.projects.createProject(
			{ name: 'Later', description: '' },
			ACTOR,
		);
		await services.projects.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
		get.mockClear();
		expect((await services.projects.listProjects({ subject })).map((p) => p.id)).toEqual([
			project.id,
		]);
		expect(metadataCalls(get.mock.calls)).toHaveLength(0);
	});

	it('does not overwrite a permission revocation when catalog publication races', async () => {
		const { bucket, services, projects } = await seed();
		const other = createServices(bucket);
		const put = bucket.put.bind(bucket);
		let raced = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
			if (key === paths.catalog && !raced) {
				raced = true;
				await other.projects.removeMember(projects[0].id, subject.id, ACTOR);
			}
			return put(key, ...args);
		});
		await finish(services);
		expect(raced).toBe(true);
		expect(await other.projects.listProjects({ subject })).toEqual([]);
	});

	it('handles deletion and insertion between batches without losing pending legacy entries', async () => {
		const { bucket, services } = await seed(26);
		expect(await services.migrations.tick()).toBe(false);
		const snapshot = await services.catalog.getCurrentSnapshot();
		const remaining = snapshot.projects.find((p) => p.access?.version === undefined)!;
		await services.catalog.mutateSnapshot('test.delete', ACTOR, (s) => {
			s.projects = s.projects.filter((p) => p.id !== remaining.id);
			return s;
		});
		await bucket.delete(paths.project(remaining.id).meta);
		const fresh = await services.projects.createProject(
			{ name: 'Concurrent', description: '' },
			ACTOR,
		);
		await services.projects.addMember(fresh.id, { user_id: subject.id }, 'viewer', ACTOR);
		await finish(createServices(bucket));
		expect((await services.projects.listProjects({ subject })).length).toBe(26);
	});

	it('ignores purged metadata for deleted entries but still migrates soft-deleted entries', async () => {
		const { bucket, services, projects } = await seed(2);
		await services.catalog.mutateSnapshot('test.deleted', ACTOR, (snapshot) => {
			for (const entry of snapshot.projects) entry.status = 'deleted';
			return snapshot;
		});
		await bucket.delete(paths.project(projects[0].id).meta);
		const key = paths.project(projects[1].id).meta;
		const meta = await (await bucket.get(key))!.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...meta, status: 'deleted' }));
		await finish(services);
		const entries = (await services.catalog.getCurrentSnapshot()).projects;
		expect(entries.find((p) => p.id === projects[0].id)?.access?.version).toBeUndefined();
		expect(entries.find((p) => p.id === projects[1].id)?.access?.version).toBe(1);
	});

	it('does not checkpoint a catalog write whose response was lost and resumes idempotently', async () => {
		const { bucket, services } = await seed();
		const put = bucket.put.bind(bucket);
		const spy = vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
			const result = await put(key, ...args);
			if (key === paths.catalog) throw new Error('catalog response lost');
			return result;
		});
		await expect(services.migrations.tick()).rejects.toThrow('catalog response lost');
		spy.mockRestore();
		const get = vi.spyOn(bucket, 'get');
		await finish(createServices(bucket));
		expect(metadataCalls(get.mock.calls)).toHaveLength(0);
	});

	it('cancels before storage access', async () => {
		const { bucket, services } = await seed();
		const get = vi.spyOn(bucket, 'get');
		await expect(services.migrations.tick(AbortSignal.abort(new Error('stop')))).rejects.toThrow(
			'stop',
		);
		expect(get).not.toHaveBeenCalled();
	});
});

it('does not downgrade a summary from a newer writer during automatic migration', async () => {
	const { bucket, services, projects } = await seed();
	await services.catalog.updateProjectEntry('test.future', ACTOR, projects[0].id, (entry) => ({
		access: { ...entry.access!, version: 2 },
	}));
	const get = vi.spyOn(bucket, 'get');
	await finish(services);
	expect(metadataCalls(get.mock.calls)).toHaveLength(0);
	expect((await services.catalog.getCurrentSnapshot()).projects[0].access?.version).toBe(2);
	expect((await services.projects.listProjects({ subject })).map((p) => p.id)).toEqual([
		projects[0].id,
	]);
	expect(metadataCalls(get.mock.calls)).toHaveLength(1);
});

it('keeps earlier batches committed but publishes none of a batch with corrupt metadata', async () => {
	const { bucket, services } = await seed(28);
	expect(await services.migrations.tick()).toBe(false);
	const before = await services.catalog.getCurrentSnapshot();
	const checkpoint = await (await bucket.get(receipt))!.json<{ cursor: string }>();
	const remaining = before.projects.filter((entry) => entry.access?.version === undefined);
	expect(remaining).toHaveLength(3);
	const broken = paths.project(remaining[1].id).meta;
	const original = await (await bucket.get(broken))!.text();
	await bucket.put(broken, '{');
	await expect(services.migrations.tick()).rejects.toThrow();
	expect((await services.catalog.getCurrentSnapshot()).snapshot_id).toBe(before.snapshot_id);
	expect(await (await bucket.get(receipt))!.json()).toEqual({
		version: 1,
		status: 'pending',
		cursor: checkpoint.cursor,
	});
	await bucket.put(broken, original);
	const get = vi.spyOn(bucket, 'get');
	await finish(createServices(bucket));
	expect(
		metadataCalls(get.mock.calls)
			.map(([key]) => key)
			.sort((a, b) => a.localeCompare(b)),
	).toEqual(
		remaining.map((entry) => paths.project(entry.id).meta).sort((a, b) => a.localeCompare(b)),
	);
	expect(await services.projects.listProjects({ subject })).toHaveLength(28);
});

it('resumes after the project used as its saved cursor has been deleted', async () => {
	const { bucket, services } = await seed(27);
	expect(await services.migrations.tick()).toBe(false);
	const { cursor } = await (await bucket.get(receipt))!.json<{ cursor: string }>();
	const boundary = (await services.catalog.getCurrentSnapshot()).projects.find(
		(entry) => entry.id === cursor,
	)!;
	await services.catalog.mutateSnapshot('test.remove-cursor', ACTOR, (snapshot) => {
		snapshot.projects = snapshot.projects.filter((entry) => entry.id !== boundary.id);
		return snapshot;
	});
	await bucket.delete(paths.project(boundary.id).meta);
	const get = vi.spyOn(bucket, 'get');
	await finish(createServices(bucket));
	expect(metadataCalls(get.mock.calls)).toHaveLength(2);
	expect(await services.projects.listProjects({ subject })).toHaveLength(26);
});

it('publishes neither summaries nor progress when cancelled during metadata reads', async () => {
	const { bucket, services, projects } = await seed(3);
	const before = await services.catalog.getCurrentSnapshot();
	const controller = new AbortController();
	const get = bucket.get.bind(bucket);
	const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key, ...args) => {
		const result = await get(key, ...args);
		if (key === paths.project(projects[0].id).meta) controller.abort(new Error('shutdown'));
		return result;
	});
	await expect(services.migrations.tick(controller.signal)).rejects.toThrow('shutdown');
	expect((await services.catalog.getCurrentSnapshot()).snapshot_id).toBe(before.snapshot_id);
	expect(await (await bucket.get(receipt))!.json()).toEqual({ version: 1, status: 'pending' });
	spy.mockRestore();
	await finish(createServices(bucket));
	expect(await services.projects.listProjects({ subject })).toHaveLength(3);
});

it('preserves a concurrent new permission grant when retrying catalog publication', async () => {
	const { bucket, services, projects } = await seed();
	const newcomer = { id: uid('new-reader'), email: 'new-reader@example.com' };
	expect(await services.projects.listProjects({ subject: newcomer })).toEqual([]);
	const other = createServices(bucket);
	const put = bucket.put.bind(bucket);
	let raced = false;
	vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
		if (key === paths.catalog && !raced) {
			raced = true;
			await other.projects.addMember(projects[0].id, { user_id: newcomer.id }, 'viewer', ACTOR);
		}
		return put(key, ...args);
	});
	await finish(services);
	expect(raced).toBe(true);
	const get = vi.spyOn(bucket, 'get');
	expect(
		(await services.projects.listProjects({ subject: newcomer })).map((entry) => entry.id),
	).toEqual([projects[0].id]);
	expect(metadataCalls(get.mock.calls)).toHaveLength(0);
});

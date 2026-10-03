import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { createNotebookId, createProjectId } from '../../ids';
import { ACTOR } from '../../testing/fixtures';
import { ConflictError, NotFoundError, ResourceExhaustedError } from '../../errors';
import {
	PreviewStore,
	PREVIEW_LIMITS,
	previewProjectKey,
	previewReceiptsKey,
	previewActiveProjectPrefix,
	previewActiveProjectKey,
} from './PreviewStore';
import { PreviewRecordSchema } from './notebookPreviews';

function fixture() {
	const bucket = new MemoryBucket();
	const store = new PreviewStore(bucket);
	const pid = createProjectId();
	const intent = (id = crypto.randomUUID().replaceAll('-', '')) =>
		PreviewRecordSchema.parse({
			schema_version: 1,
			id,
			project_id: pid,
			notebook_id: createNotebookId(),
			name: 'Preview',
			source: { type: 'branch', branch: 'feature' },
			repository: 'owner/repo',
			root_path: '',
			entry_notebook: 'app.py',
			created_by: ACTOR,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 86400000).toISOString(),
			request_fingerprint: 'request',
			state: 'active',
			preparation: 'pending',
			revisions: [],
		});
	return { bucket, store, pid, intent };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('PreviewStore membership and receipts', () => {
	it('reserves a single membership under concurrent retries', async () => {
		const { store, pid, intent } = fixture();
		const record = intent();
		const results = await Promise.all([store.reserve(record), store.reserve(record)]);
		expect(results).toEqual([record, record]);
		expect((await store.project(pid)).entries).toHaveLength(1);
	});

	it('enforces project capacity under concurrent creation and retains deleting slots', async () => {
		const { store, pid, intent } = fixture();
		for (let i = 0; i < PREVIEW_LIMITS.perProject - 1; i++) await store.reserve(intent());
		const results = await Promise.allSettled([store.reserve(intent()), store.reserve(intent())]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(
			(results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
		).toBeInstanceOf(ResourceExhaustedError);
		const record = (await store.project(pid)).entries[0].intent;
		await store.markCleaned(record);
		await expect(store.reserve(intent())).rejects.toThrow(ResourceExhaustedError);
		await store.forget(record);
		await expect(store.reserve(intent())).resolves.toBeDefined();
	});

	it('fences a delayed create after its membership has been reclaimed', async () => {
		const { store, intent } = fixture();
		const record = intent();
		const deadline = Date.now() + PREVIEW_LIMITS.creationMs;
		await store.reserve(record);
		vi.spyOn(Date, 'now').mockReturnValue(deadline);
		expect(await store.reserve(record, deadline)).toEqual(record);
		await store.forget(record);
		await expect(store.reserve(record, deadline)).rejects.toThrow(ConflictError);
	});

	it('replays receipts, rejects changed requests and retains deletion until expiry', async () => {
		const { store, pid } = fixture();
		const first = await store.receipt(pid, 'key', 'one');
		expect(await store.receipt(pid, 'key', 'one')).toEqual(first);
		await expect(store.receipt(pid, 'key', 'two')).rejects.toThrow(ConflictError);
		await store.pruneReceipts(pid, first.id);
		await expect(store.receipt(pid, 'key', 'one')).rejects.toThrow('deleted');
		vi.spyOn(Date, 'now').mockReturnValue(first.expires_at);
		const next = await store.receipt(pid, 'key', 'two');
		expect(next.id).not.toBe(first.id);
	});

	it('bounds receipt history independently and prunes it without listing previews', async () => {
		const { store, bucket, pid } = fixture();
		const first = await store.receipt(pid, 'key', 'one');
		await bucket.put(
			previewReceiptsKey(pid),
			JSON.stringify({
				entries: Array.from({ length: PREVIEW_LIMITS.receiptsPerProject }, (_, i) => ({
					...first,
					key: String(i),
				})),
			}),
		);
		await expect(store.receipt(pid, 'overflow', 'one')).rejects.toThrow(ResourceExhaustedError);
		vi.spyOn(Date, 'now').mockReturnValue(first.expires_at);
		await store.pruneReceipts(pid);
		expect(await (await bucket.get(previewReceiptsKey(pid)))!.json()).toEqual({ entries: [] });
		const reads = vi.spyOn(bucket, 'get');
		await store.project(pid);
		expect(reads).toHaveBeenCalledExactlyOnceWith(previewProjectKey(pid));
	});
});

describe('PreviewStore artifact quotas', () => {
	it('charges reservations before uploads and releases only explicitly reclaimed artifacts', async () => {
		const { store, pid, intent } = fixture();
		const record = intent();
		await store.reserve(record);
		const nid = createNotebookId();
		await store.reserveArtifact(record, nid, PREVIEW_LIMITS.bytesPerProject);
		await store.reserveArtifact(record, nid, PREVIEW_LIMITS.bytesPerProject);
		await expect(store.reserveArtifact(record, createNotebookId(), 1)).rejects.toThrow(
			ResourceExhaustedError,
		);
		await expect(
			store.commitArtifactBytes(record, nid, PREVIEW_LIMITS.bytesPerProject + 1),
		).rejects.toThrow(ResourceExhaustedError);
		await store.commitArtifactBytes(record, nid, 100);
		await store.reserveArtifact(record, createNotebookId(), 1);
		await store.releaseArtifact(record, nid);
		expect((await store.project(pid)).entries[0].artifacts).toHaveLength(1);
		await expect(store.commitArtifactBytes(record, nid, 0)).rejects.toThrow(NotFoundError);
		await store.forget(record);
		await store.releaseArtifact(record, nid);
		await expect(store.reserveArtifact(record, nid, 1)).rejects.toThrow(NotFoundError);
	});

	it('bounds revision count even for zero-byte artifacts', async () => {
		const { store, intent } = fixture();
		const record = intent();
		await store.reserve(record);
		for (let i = 0; i < PREVIEW_LIMITS.revisionsPerPreview; i++)
			await store.reserveArtifact(record, createNotebookId(), 0);
		await expect(store.reserveArtifact(record, createNotebookId(), 0)).rejects.toThrow(
			ResourceExhaustedError,
		);
	});

	it('shares the byte budget across previews and competing workers', async () => {
		const { store, intent } = fixture();
		const a = await store.reserve(intent());
		const b = await store.reserve(intent());
		const results = await Promise.allSettled([
			store.reserveArtifact(a, createNotebookId(), PREVIEW_LIMITS.bytesPerProject),
			store.reserveArtifact(b, createNotebookId(), PREVIEW_LIMITS.bytesPerProject),
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	});
});

describe('PreviewStore scheduling', () => {
	it('schedules active projects without reading a hundred retained empty heads', async () => {
		const { store, bucket, pid, intent } = fixture();
		for (let i = 0; i < 100; i++)
			await bucket.put(previewProjectKey(createProjectId()), JSON.stringify({ entries: [] }));
		const record = await store.reserve(intent());
		const reads = vi.spyOn(bucket, 'get');
		const lists = vi.spyOn(bucket, 'list');
		expect(await store.nextProjects('cleanup')).toEqual([pid]);
		expect(await store.nextProjects('prepare')).toEqual([pid]);
		expect(reads.mock.calls.filter(([key]) => key.startsWith('_system/preview-projects/'))).toEqual(
			[[previewProjectKey(pid)], [previewProjectKey(pid)]],
		);
		expect(
			lists.mock.calls.every(([options]) => options?.prefix === previewActiveProjectPrefix),
		).toBe(true);
		await store.forget(record);
		expect(await bucket.head(previewProjectKey(pid))).not.toBeNull();
		expect(await store.nextProjects('cleanup')).toEqual([]);
		expect((await bucket.list({ prefix: previewActiveProjectPrefix })).objects).toEqual([]);
		await store.reserve(intent());
		expect(await store.nextProjects('cleanup')).toEqual([pid]);
	});

	it('reclaims a marker left by an interrupted reservation', async () => {
		const { store, bucket, pid, intent } = fixture();
		const put = bucket.put.bind(bucket);
		const writes = vi
			.spyOn(bucket, 'put')
			.mockImplementation((key, value, options) =>
				key === previewProjectKey(pid)
					? Promise.reject(new Error('storage unavailable'))
					: put(key, value, options),
			);
		await expect(store.reserve(intent())).rejects.toThrow('storage unavailable');
		writes.mockRestore();
		expect((await bucket.list({ prefix: previewActiveProjectPrefix })).objects).toHaveLength(1);
		expect(await store.nextProjects('cleanup')).toEqual([]);
		expect((await bucket.list({ prefix: previewActiveProjectPrefix })).objects).toEqual([]);
	});

	it('retries failed marker removal without delaying other active projects', async () => {
		const { store, bucket, pid, intent } = fixture();
		const record = await store.reserve(intent());
		const key = previewActiveProjectKey(pid, (await store.project(pid)).work_id!);
		const remove = bucket.delete.bind(bucket);
		const failing = vi
			.spyOn(bucket, 'delete')
			.mockImplementation((target) =>
				target === key ? Promise.reject(new Error('delete unavailable')) : remove(target),
			);
		await expect(store.forget(record)).rejects.toThrow('delete unavailable');
		const active = { ...intent(), project_id: createProjectId() };
		await store.reserve(active);
		expect(await store.nextProjects('cleanup')).toEqual([active.project_id]);
		expect(await bucket.head(key)).not.toBeNull();
		failing.mockRestore();
		expect(await store.nextProjects('cleanup')).toEqual([active.project_id]);
		expect(await bucket.head(key)).toBeNull();
	});

	it('retains unreadable project work and continues scheduling healthy projects', async () => {
		const { store, bucket, pid, intent } = fixture();
		await store.reserve(intent());
		const key = previewActiveProjectKey(pid, (await store.project(pid)).work_id!);
		const head = await (await bucket.get(previewProjectKey(pid)))!.text();
		await bucket.put(previewProjectKey(pid), 'corrupt');
		const active = { ...intent(), project_id: createProjectId() };
		await store.reserve(active);
		expect(await store.nextProjects('cleanup')).toEqual([active.project_id]);
		expect(await bucket.head(key)).not.toBeNull();
		await bucket.put(previewProjectKey(pid), head);
		expect((await store.nextProjects('cleanup')).sort()).toEqual([pid, active.project_id].sort());
	});

	it('fences a pending publication before removing its marker', async () => {
		const { store, bucket, pid, intent } = fixture();
		const put = bucket.put.bind(bucket);
		const arrived = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let blocked = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === previewProjectKey(pid) && !blocked) {
				blocked = true;
				arrived.resolve();
				await resume.promise;
			}
			return put(key, value, options);
		});
		const reserving = store.reserve(intent());
		await arrived.promise;
		try {
			expect(await store.nextProjects('cleanup')).toEqual([]);
		} finally {
			resume.resolve();
		}
		await reserving;
		expect(await store.nextProjects('cleanup')).toEqual([pid]);
		const project = await store.project(pid);
		expect(await bucket.head(previewActiveProjectKey(pid, project.work_id!))).not.toBeNull();
	});

	it('does not remove a new activation when final cleanup overlaps creation', async () => {
		const { store, bucket, pid, intent } = fixture();
		const first = await store.reserve(intent());
		const old = (await store.project(pid)).work_id!;
		const remove = bucket.delete.bind(bucket);
		const arrived = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		vi.spyOn(bucket, 'delete').mockImplementation(async (key) => {
			if (key === previewActiveProjectKey(pid, old)) {
				arrived.resolve();
				await resume.promise;
			}
			return remove(key);
		});
		const forgetting = store.forget(first);
		await arrived.promise;
		try {
			await store.reserve(intent());
		} finally {
			resume.resolve();
		}
		await forgetting;
		expect((await store.project(pid)).work_id).not.toBe(old);
		expect(await store.nextProjects('cleanup')).toEqual([pid]);
	});

	it('keeps a marker whose publication completes during orphan inspection', async () => {
		const { store, bucket, pid, intent } = fixture();
		const put = bucket.put.bind(bucket);
		const arrived = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === previewProjectKey(pid)) {
				arrived.resolve();
				await resume.promise;
			}
			return put(key, value, options);
		});
		const reserving = store.reserve(intent());
		await arrived.promise;
		const project = store.project.bind(store);
		vi.spyOn(store, 'project').mockImplementationOnce(async (id) => {
			const stale = await project(id);
			resume.resolve();
			await reserving;
			return stale;
		});
		expect(await store.nextProjects('cleanup')).toEqual([]);
		expect(await store.nextProjects('cleanup')).toEqual([pid]);
		expect((await bucket.list({ prefix: previewActiveProjectPrefix })).objects).toHaveLength(1);
	});

	it('bounds orphan scanning and resumes to reach active work', async () => {
		const { store, bucket, pid, intent } = fixture();
		for (let i = 0; i < PREVIEW_LIMITS.projectsPerTick * PREVIEW_LIMITS.workPagesPerTick; i++)
			await bucket.put(previewActiveProjectKey(pid, `!orphan-${i}`), '{}');
		const record = intent();
		await store.reserve(record);
		const lists = vi.spyOn(bucket, 'list');
		expect(await store.nextProjects('cleanup')).toEqual([]);
		expect(lists).toHaveBeenCalledTimes(PREVIEW_LIMITS.workPagesPerTick);
		expect(await store.nextProjects('cleanup')).toEqual([record.project_id]);
	});

	it('enforces global and per-project concurrency, recovers leases, and fences stale releases', async () => {
		const { store, pid } = fixture();
		const id = 'a'.repeat(32);
		const first = (await store.claim(pid, id))!;
		expect(await store.claim(pid, 'b'.repeat(32))).toBeUndefined();
		for (let i = 1; i < PREVIEW_LIMITS.concurrency; i++)
			expect(await store.claim(createProjectId(), id)).toBeDefined();
		expect(await store.claim(createProjectId(), id)).toBeUndefined();
		vi.spyOn(Date, 'now').mockReturnValue(first.expires_at);
		const replacement = (await store.claim(pid, id))!;
		await store.release(first.token);
		expect(await store.claim(pid, id)).toBeUndefined();
		await store.release(replacement.token);
		expect(await store.claim(pid, id)).toBeDefined();
	});

	it('rotates bounded project pages independently for preparation and cleanup', async () => {
		const { store, intent } = fixture();
		const projects = [];
		for (let i = 0; i < PREVIEW_LIMITS.projectsPerTick + 1; i++) {
			const record = { ...intent(), project_id: createProjectId() };
			await store.reserve(record);
			projects.push(record.project_id);
		}
		const first = await store.nextProjects('prepare');
		expect(first).toHaveLength(PREVIEW_LIMITS.projectsPerTick);
		expect(await store.nextProjects('cleanup')).toEqual(first);
		const second = await store.nextProjects('prepare');
		expect([...first, ...second].sort()).toEqual(projects.sort());
		expect(await store.nextProjects('prepare')).toEqual(first);
	});
});

it('rejects delayed artifact reservations after lease expiry or cleanup', async () => {
	const { store, intent } = fixture();
	const record = await store.reserve(intent());
	await expect(store.reserveArtifact(record, createNotebookId(), 1, Date.now())).rejects.toThrow(
		ConflictError,
	);
	await store.markCleaned(record);
	await expect(store.reserveArtifact(record, createNotebookId(), 1)).rejects.toThrow(NotFoundError);
});

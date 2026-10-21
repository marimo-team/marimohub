import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { makeWorkspaceService } from '../../testing/workspaceFixtures';
import { NotebookId, ProjectId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { ResumableUploads, UPLOAD_PART_BYTES, UPLOAD_RETENTION_MS } from './ResumableUploads';

const actor = 'author' as UserId;
const other = 'other' as UserId;
const pid = ProjectId.create();
const nid = NotebookId.create();
afterEach(() => vi.useRealTimers());
function setup() {
	const bucket = new MemoryBucket();
	const { service } = makeWorkspaceService(bucket);
	return { bucket, service };
}
describe('resumable workspace uploads', () => {
	it('resumes missing parts, preserves an upload blocked by an editor, and publishes once', async () => {
		const { bucket, service } = setup();
		const upload = await service.startUpload(
			pid,
			nid,
			{ path: 'data.bin', size: UPLOAD_PART_BYTES + 3 },
			actor,
		);
		await service.putUploadPart(pid, nid, upload.id, 2, new Uint8Array([4, 5, 6]), actor);
		await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'missing parts',
		);
		expect((await service.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([2]);
		await service.putUploadPart(
			pid,
			nid,
			upload.id,
			1,
			new Uint8Array(UPLOAD_PART_BYTES).fill(9),
			actor,
		);
		await expect(
			service.completeUpload(pid, nid, upload.id, actor, {
				assertMutable: async () => {
					throw new Error('editor active');
				},
			}),
		).rejects.toThrow('editor active');
		expect((await service.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([1, 2]);
		const item = await service.completeUpload(pid, nid, upload.id, actor);
		const bytes = await (await bucket.get(
			paths.project(pid).notebook(nid).workspaceFile('data.bin'),
		))!.bytes();
		expect(bytes.length).toBe(UPLOAD_PART_BYTES + 3);
		expect([...bytes.slice(-4)]).toEqual([9, 4, 5, 6]);
		await service.write(pid, nid, 'data.bin', new Uint8Array([1]), actor);
		expect(await service.completeUpload(pid, nid, upload.id, actor)).toEqual(item);
		expect((await service.read(pid, nid, 'data.bin')).bytes).toEqual(new Uint8Array([1]));
	});
	it('rejects wrong owners, sizes, unsafe paths and different retries', async () => {
		const { service } = setup();
		await expect(
			service.startUpload(pid, nid, { path: '../escape', size: 1 }, actor),
		).rejects.toThrow();
		await expect(
			service.startUpload(pid, nid, { path: 'notebook.py', size: 1 }, actor),
		).rejects.toThrow('file editor');
		const upload = await service.startUpload(pid, nid, { path: 'data', size: 1 }, actor);
		await expect(service.getUpload(pid, nid, upload.id, other)).rejects.toThrow('another user');
		await expect(
			service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array(2), actor),
		).rejects.toThrow('size');
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array([1]), actor);
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array([1]), actor);
		await expect(
			service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array([2]), actor),
		).rejects.toThrow('different bytes');
	});
	it('rechecks capacity and create-only at completion without discarding parts', async () => {
		const bucket = new MemoryBucket();
		const { service } = makeWorkspaceService(bucket, undefined, {
			maxFileBytes: 5,
			maxTotalBytes: 5,
			maxFiles: 2,
		});
		const upload = await service.startUpload(
			pid,
			nid,
			{ path: 'data', size: 5, create_only: true },
			actor,
		);
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array(5), actor);
		await service.write(pid, nid, 'other', new Uint8Array(1), actor);
		await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'exceeds 5 bytes',
		);
		expect((await service.getUpload(pid, nid, upload.id, actor)).status).toBe('uploading');
		await service.delete(pid, nid, 'other');
		await service.write(pid, nid, 'data', new Uint8Array(1), actor);
		await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'already exists',
		);
	});
	it('cancels and sweeps expired parts, retaining receipts against late writes', async () => {
		vi.useFakeTimers();
		const { bucket, service } = setup();
		const upload = await service.startUpload(pid, nid, { path: 'data', size: 1 }, actor);
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array(1), actor);
		vi.setSystemTime(Date.now() + UPLOAD_RETENTION_MS + 1);
		await service.sweepUploads(pid, nid);
		await expect(service.getUpload(pid, nid, upload.id, actor)).rejects.toThrow('expired');
		expect(
			(
				await bucket.list({
					prefix: `${paths.project(pid).notebook(nid).base}/uploads/${upload.id}/parts/`,
				})
			).objects,
		).toEqual([]);
	});
	it('does not hold the workspace claim for staging parts', async () => {
		const { bucket, service } = setup();
		const upload = await service.startUpload(pid, nid, { path: 'data', size: 1 }, actor);
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array(1), actor);
		expect(await bucket.head(paths.project(pid).notebook(nid).workspaceMutationClaim)).toBeNull();
	});
	it('never retries an uncertain external publication', async () => {
		const uploads = new ResumableUploads(new MemoryBucket(), 'uploads/');
		const upload = await uploads.start(
			{ path: 'data', size: 0, create_only: false, content_type: 'text/plain' },
			actor,
			100,
		);
		const publish = vi.fn().mockRejectedValue(new Error('transport failed'));
		await expect(uploads.complete(upload.id, actor, async () => publish)).rejects.toThrow(
			'transport failed',
		);
		await expect(uploads.complete(upload.id, actor, async () => publish)).rejects.toThrow(
			'interrupted',
		);
		expect(publish).toHaveBeenCalledTimes(1);
	});
});

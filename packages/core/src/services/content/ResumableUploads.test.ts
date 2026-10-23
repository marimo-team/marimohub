import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { makeWorkspaceService } from '../../testing/workspaceFixtures';
import { NotebookId, ProjectId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { StoredObjectError } from '../../schema';
import { UPLOAD_PART_BYTES } from '../../uploads';
import { ResumableUploads, UploadIndexSchema, UPLOAD_RETENTION_MS } from './ResumableUploads';

const actor = 'author' as UserId;
const other = 'other' as UserId;
const pid = ProjectId.create();
const nid = NotebookId.create();
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
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
		).rejects.toThrow('Invalid workspace file path: ../escape');
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
		await expect(
			service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array(1), actor),
		).rejects.toThrow('expired');
		expect(
			await (await bucket.get(
				`${paths.project(pid).notebook(nid).base}/uploads/${upload.id}.json`,
			))!.json(),
		).toMatchObject({ status: 'cancelled' });
		expect(
			(
				await bucket.list({
					prefix: `${paths.project(pid).notebook(nid).base}/uploads/${upload.id}/parts/`,
				})
			).objects,
		).toEqual([]);
	});
	it('rechecks lowered file limits and keeps staged parts available for retry', async () => {
		const { bucket, service } = setup();
		const upload = await service.startUpload(pid, nid, { path: 'data', size: 3 }, actor);
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array([1, 2, 3]), actor);
		const { service: restricted } = makeWorkspaceService(bucket, undefined, {
			maxFileBytes: 2,
			maxTotalBytes: 10,
			maxFiles: 2,
		});
		await expect(restricted.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'exceeds 2 bytes',
		);
		expect((await service.getUpload(pid, nid, upload.id, actor)).status).toBe('uploading');
		await service.completeUpload(pid, nid, upload.id, actor);
		expect((await service.read(pid, nid, 'data')).bytes).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('allows replacement at file-count capacity but rejects a new file', async () => {
		const bucket = new MemoryBucket();
		const { service } = makeWorkspaceService(bucket, undefined, {
			maxFileBytes: 5,
			maxTotalBytes: 5,
			maxFiles: 1,
		});
		await service.write(pid, nid, 'data', new Uint8Array(5), actor);
		const upload = await service.startUpload(pid, nid, { path: 'data', size: 1 }, actor);
		await service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array([9]), actor);
		await service.completeUpload(pid, nid, upload.id, actor);
		expect((await service.read(pid, nid, 'data')).bytes).toEqual(new Uint8Array([9]));
		const extra = await service.startUpload(pid, nid, { path: 'extra', size: 0 }, actor);
		await expect(service.completeUpload(pid, nid, extra.id, actor)).rejects.toThrow('1 files');
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

function uploadStore() {
	const bucket = new MemoryBucket();
	const uploads = new ResumableUploads(bucket, 'uploads/');
	const start = (size = 1, maxBytes = 100) =>
		uploads.start(
			{ path: 'data', size, create_only: false, content_type: 'application/octet-stream' },
			actor,
			maxBytes,
		);
	return { bucket, uploads, start };
}

describe('upload failure recovery', () => {
	it('releases admission when creating the upload record fails', async () => {
		const { bucket, start } = uploadStore();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put')
			.mockImplementationOnce(put)
			.mockRejectedValueOnce(new Error('storage down'));
		await expect(start(100)).rejects.toThrow('storage down');
		await expect(start(100)).resolves.toMatchObject({ size: 100 });
	});

	it.each(['release', 'delete'] as const)(
		'recovers failed %s cleanup without republishing',
		async (failure) => {
			const { bucket, uploads, start } = uploadStore();
			const upload = await start(100);
			await uploads.putPart(upload.id, 1, new Uint8Array(100), actor);
			const publish = vi.fn(async () => ({ size: 100 }));
			if (failure === 'release') {
				const put = bucket.put.bind(bucket);
				vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
					if (key === 'uploads/index.json') throw new Error('cleanup unavailable');
					return put(key, value, options);
				});
			} else {
				vi.spyOn(bucket, 'delete').mockRejectedValue(new Error('cleanup unavailable'));
			}
			await expect(uploads.complete(upload.id, actor, async () => publish)).resolves.toEqual({
				size: 100,
			});
			vi.restoreAllMocks();
			await uploads.sweep();
			await expect(start(100)).resolves.toMatchObject({ size: 100 });
			expect((await bucket.list({ prefix: `uploads/${upload.id}/parts/` })).objects).toEqual([]);
			await expect(uploads.complete(upload.id, actor, async () => publish)).resolves.toEqual({
				size: 100,
			});
			expect(publish).toHaveBeenCalledTimes(1);
		},
	);

	it.each([new Uint8Array(), new Uint8Array([2]), new Uint8Array([1, 2])])(
		'refuses corrupt staged bytes without replacing the destination: %s',
		async (bytes) => {
			const { bucket, uploads, start } = uploadStore();
			const upload = await start();
			await uploads.putPart(upload.id, 1, new Uint8Array([1]), actor);
			await bucket.put(`uploads/${upload.id}/parts/1`, bytes);
			await bucket.put('destination', 'original');
			await expect(
				uploads.complete(upload.id, actor, async (record) => async () => {
					await uploads.publishToBucket(record, 'destination');
					return {};
				}),
			).rejects.toThrow('corrupt');
			expect(await (await bucket.get('destination'))!.text()).toBe('original');
		},
	);

	it('allows only one concurrent publisher', async () => {
		const { uploads, start } = uploadStore();
		const upload = await start(0);
		const gate = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		let prepared = 0;
		const publish = vi.fn(async () => ({ size: 0 }));
		const prepare = async () => {
			if (++prepared === 2) ready.resolve();
			await gate.promise;
			return publish;
		};
		const completions = [
			uploads.complete(upload.id, actor, prepare),
			uploads.complete(upload.id, actor, prepare),
		];
		await ready.promise;
		gate.resolve();
		const results = await Promise.allSettled(completions);
		expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
		expect(publish).toHaveBeenCalledTimes(1);
	});

	it('does not publish when cancellation wins during preparation', async () => {
		const { uploads, start } = uploadStore();
		const upload = await start(0);
		const publish = vi.fn();
		await expect(
			uploads.complete(upload.id, actor, async () => {
				await uploads.cancel(upload.id, actor);
				return publish;
			}),
		).rejects.toThrow('changed');
		expect(publish).not.toHaveBeenCalled();
	});

	it('does not publish when preparation outlives the upload', async () => {
		vi.useFakeTimers();
		const { uploads, start } = uploadStore();
		const upload = await start(0);
		const publish = vi.fn();
		await expect(
			uploads.complete(upload.id, actor, async () => {
				vi.setSystemTime(upload.expires_at);
				return publish;
			}),
		).rejects.toThrow('expired');
		expect(publish).not.toHaveBeenCalled();
	});

	it('fences a part arriving after cancellation and sweeps its late bytes', async () => {
		const { bucket, uploads, start } = uploadStore();
		const upload = await start();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key.endsWith('/parts/1')) await uploads.cancel(upload.id, actor);
			return put(key, value, options);
		});
		await expect(uploads.putPart(upload.id, 1, new Uint8Array([1]), actor)).rejects.toThrow(
			'cancelled',
		);
		await uploads.sweep();
		expect(await bucket.head(`uploads/${upload.id}/parts/1`)).toBeNull();
	});

	it('returns successful publication without reviving a receipt expired by maintenance', async () => {
		vi.useFakeTimers();
		const { bucket, uploads, start } = uploadStore();
		const upload = await start(0);
		await expect(
			uploads.complete(upload.id, actor, async () => async () => {
				vi.setSystemTime(upload.expires_at);
				await uploads.sweep();
				return {};
			}),
		).resolves.toEqual({});
		expect(await (await bucket.get(`uploads/${upload.id}.json`))!.json()).toMatchObject({
			status: 'cancelled',
		});
	});

	it('recovers an immutable part whose receipt write failed', async () => {
		const { bucket, uploads, start } = uploadStore();
		const upload = await start();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put')
			.mockImplementationOnce(put)
			.mockRejectedValueOnce(new Error('receipt unavailable'));
		await expect(uploads.putPart(upload.id, 1, new Uint8Array([1]), actor)).rejects.toThrow(
			'receipt unavailable',
		);
		expect((await uploads.get(upload.id, actor)).parts).toEqual([]);
		await expect(uploads.putPart(upload.id, 1, new Uint8Array([1]), actor)).resolves.toMatchObject({
			parts_done: [1],
		});
	});

	it.each([0, -1, 1.5, 2, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid part number %s without staging bytes',
		async (number) => {
			const { bucket, uploads, start } = uploadStore();
			const upload = await start();
			await expect(uploads.putPart(upload.id, number, new Uint8Array([1]), actor)).rejects.toThrow(
				'number or size',
			);
			expect((await bucket.list({ prefix: `uploads/${upload.id}/parts/` })).objects).toEqual([]);
		},
	);

	it('bounds zero-byte reservations and releases cancelled admission', async () => {
		const { uploads, start } = uploadStore();
		const first = await start(0);
		for (let i = 1; i < 16; i++) await start(0);
		await expect(start(0)).rejects.toThrow('Too many unfinished');
		await expect(uploads.cancel(first.id, other)).rejects.toThrow('another user');
		await uploads.cancel(first.id, actor);
		await expect(start(0)).resolves.toMatchObject({ size: 0 });
	});

	it('aborts native assembly when a part fails and never completes it', async () => {
		const { bucket, start } = uploadStore();
		const multipart = {
			create: vi.fn(async () => ({ uploadId: 'native-id' })),
			putPart: vi.fn().mockRejectedValue(new Error('native upload failed')),
			complete: vi.fn(),
			abort: vi.fn().mockRejectedValue(new Error('abort also failed')),
		};
		const uploads = new ResumableUploads(Object.assign(bucket, { multipart }), 'uploads/');
		const upload = await start();
		await uploads.putPart(upload.id, 1, new Uint8Array([1]), actor);
		await expect(
			uploads.complete(upload.id, actor, async (record) => async () => {
				await uploads.publishToBucket(record, 'destination');
				return {};
			}),
		).rejects.toThrow('native upload failed');
		expect(multipart.abort).toHaveBeenCalledWith('destination', 'native-id');
		expect(multipart.complete).not.toHaveBeenCalled();
		await expect(uploads.cancel(upload.id, actor)).rejects.toThrow('in progress');
	});
});

describe('upload receipt invariants', () => {
	it('serializes competing create-only completions across service instances', async () => {
		const { bucket, service } = setup();
		const { service: otherService } = makeWorkspaceService(bucket);
		const first = await service.startUpload(
			pid,
			nid,
			{ path: 'data', size: 1, create_only: true },
			actor,
		);
		const second = await otherService.startUpload(
			pid,
			nid,
			{ path: 'data', size: 1, create_only: true },
			actor,
		);
		await service.putUploadPart(pid, nid, first.id, 1, new Uint8Array([1]), actor);
		await otherService.putUploadPart(pid, nid, second.id, 1, new Uint8Array([2]), actor);
		const results = await Promise.allSettled([
			service.completeUpload(pid, nid, first.id, actor),
			otherService.completeUpload(pid, nid, second.id, actor),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			reason: { message: expect.stringContaining('already exists') },
		});
		const winner = results.findIndex((result) => result.status === 'fulfilled');
		expect((await service.read(pid, nid, 'data')).bytes).toEqual(new Uint8Array([winner + 1]));
	});

	it('retains a successful result across expiry and cancellation', async () => {
		vi.useFakeTimers();
		const { uploads, start } = uploadStore();
		const upload = await start(0);
		const publish = vi.fn(async () => {
			vi.setSystemTime(upload.expires_at + 1);
			return { size: 0 };
		});
		await expect(uploads.complete(upload.id, actor, async () => publish)).resolves.toEqual({
			size: 0,
		});
		await uploads.cancel(upload.id, actor);
		await uploads.sweep();
		await expect(uploads.complete(upload.id, actor, async () => publish)).resolves.toEqual({
			size: 0,
		});
		expect((await uploads.get(upload.id, actor)).status).toBe('complete');
		expect(publish).toHaveBeenCalledTimes(1);
		vi.setSystemTime(upload.expires_at + 7 * UPLOAD_RETENTION_MS);
		await expect(uploads.get(upload.id, actor)).rejects.toThrow('expired');
	});

	it('continues sweeping after a corrupt receipt', async () => {
		vi.useFakeTimers();
		const { bucket, uploads, start } = uploadStore();
		const receipts = [await start(), await start()].sort((a, b) => a.id.localeCompare(b.id));
		const [broken, healthy] = receipts;
		await uploads.putPart(healthy.id, 1, new Uint8Array([1]), actor);
		await bucket.put(`uploads/${broken.id}.json`, '{');
		vi.setSystemTime(healthy.expires_at);
		await uploads.sweep();
		expect(await bucket.head(`uploads/${healthy.id}/parts/1`)).toBeNull();
		expect(await (await bucket.get(`uploads/${healthy.id}.json`))!.json()).toMatchObject({
			status: 'cancelled',
		});
	});

	it.each([
		[2, 1],
		[1, 1],
	])('rejects invalid stored part ordering %s before publication', async (...numbers) => {
		const { bucket, uploads, start } = uploadStore();
		const upload = await start(UPLOAD_PART_BYTES + 1, UPLOAD_PART_BYTES + 1);
		const record = await uploads.get(upload.id, actor);
		record.parts = numbers.map((number) => ({
			number,
			key: `uploads/${upload.id}/parts/${number}`,
			sha256: 'a'.repeat(64),
		}));
		await bucket.put(`uploads/${upload.id}.json`, JSON.stringify(record));
		const prepare = vi.fn();
		await expect(uploads.complete(upload.id, actor, prepare)).rejects.toThrow('part ordering');
		expect(prepare).not.toHaveBeenCalled();
	});

	it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
		'rejects malformed stored checksums before publication: %s',
		async (sha256) => {
			const { bucket, uploads, start } = uploadStore();
			const upload = await start();
			await uploads.putPart(upload.id, 1, new Uint8Array([1]), actor);
			const record = await uploads.get(upload.id, actor);
			record.parts[0].sha256 = sha256;
			await bucket.put(`uploads/${upload.id}.json`, JSON.stringify(record));
			const prepare = vi.fn();
			await expect(uploads.complete(upload.id, actor, prepare)).rejects.toBeInstanceOf(
				StoredObjectError,
			);
			expect(prepare).not.toHaveBeenCalled();
		},
	);

	it('rejects oversized reservation indexes', () => {
		const reservation = { id: crypto.randomUUID(), size: 0, expires_at: Date.now() };
		expect(UploadIndexSchema.safeParse({ uploads: Array(16).fill(reservation) }).success).toBe(
			true,
		);
		expect(UploadIndexSchema.safeParse({ uploads: Array(17).fill(reservation) }).success).toBe(
			false,
		);
	});

	it.each(['data', 'data/child'])(
		'rejects create-only uploads for existing entries before reserving: %s',
		async (existing) => {
			const { bucket, service } = setup();
			await service.write(pid, nid, existing, new Uint8Array([1]), actor);
			await expect(
				service.startUpload(pid, nid, { path: 'data', size: 1, create_only: true }, actor),
			).rejects.toThrow('already exists');
			expect(
				(await bucket.list({ prefix: `${paths.project(pid).notebook(nid).base}/uploads/` }))
					.objects,
			).toEqual([]);
		},
	);
});

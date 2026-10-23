import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BucketMultipart, BucketMultipartOptions, BucketUploadPart } from '../../ports/bucket';
import { NotebookId, ProjectId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { ACTOR, setupTestEnv } from '../../testing/fixtures';
import { makeWorkspaceService } from '../../testing/workspaceFixtures';
import { UPLOAD_PART_BYTES } from '../../uploads';
import { ResumableUploads } from './ResumableUploads';

const actor = 'author' as UserId;
const pid = ProjectId.create();
const nid = NotebookId.create();
const destination = paths.project(pid).notebook(nid).workspaceFile('data');
const prefix = `${paths.project(pid).notebook(nid).base}/uploads/`;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function setup(isolated = true) {
	const bucket = new MemoryBucket();
	const sessions = new Map<
		string,
		{
			key: string;
			options?: BucketMultipartOptions;
			parts: Map<number, { bytes: Uint8Array; etag: string }>;
		}
	>();
	const multipart = {
		isolatedSessions: isolated ? (true as const) : undefined,
		create: vi.fn(async (key: string, options?: BucketMultipartOptions) => {
			const uploadId = crypto.randomUUID();
			sessions.set(uploadId, { key, options, parts: new Map() });
			return { uploadId };
		}),
		putPart: vi.fn(async (key: string, id: string, number: number, bytes: Uint8Array) => {
			const session = sessions.get(id);
			if (!session || session.key !== key) throw new Error('NoSuchUpload');
			const etag = [
				...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
			].join('-');
			session.parts.set(number, { bytes: new Uint8Array(bytes), etag });
			return { partNumber: number, etag };
		}),
		complete: vi.fn(async (key: string, id: string, parts: BucketUploadPart[]) => {
			const session = sessions.get(id);
			if (!session || session.key !== key) throw new Error('NoSuchUpload');
			const chunks = parts.map((part) => {
				const stored = session.parts.get(part.partNumber);
				if (!stored || stored.etag !== part.etag) throw new Error('InvalidPart');
				return stored.bytes;
			});
			const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			const object = await bucket.put(key, bytes, session.options);
			sessions.delete(id);
			return object;
		}),
		abort: vi.fn(async (_key: string, id: string) => {
			sessions.delete(id);
		}),
	} satisfies BucketMultipart;
	const nativeBucket = Object.assign(bucket, { multipart });
	const service = makeWorkspaceService(nativeBucket).service;
	const uploads = new ResumableUploads(nativeBucket, prefix);
	const start = (size = 1) => service.startUpload(pid, nid, { path: 'data', size }, actor);
	const send = (id: string, bytes = new Uint8Array([1])) =>
		service.putUploadPart(pid, nid, id, 1, bytes, actor);
	return { bucket: nativeBucket, multipart, sessions, service, uploads, start, send };
}

describe('destination workspace uploads', () => {
	it('resumes without staged objects and only commits at completion', async () => {
		const { bucket, multipart, service, start, uploads } = setup();
		const upload = await start(UPLOAD_PART_BYTES + 1);
		expect(multipart.create).toHaveBeenCalledExactlyOnceWith(destination, {
			httpMetadata: { contentType: 'application/octet-stream' },
		});
		await service.putUploadPart(pid, nid, upload.id, 2, new Uint8Array([9]), actor);
		const resumed = makeWorkspaceService(bucket).service;
		expect((await resumed.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([2]);
		await resumed.putUploadPart(
			pid,
			nid,
			upload.id,
			1,
			new Uint8Array(UPLOAD_PART_BYTES).fill(3),
			actor,
		);
		expect((await bucket.list({ prefix: `${prefix}${upload.id}/parts/` })).objects).toEqual([]);
		expect(await bucket.head(destination)).toBeNull();
		const chunks = vi.spyOn(ResumableUploads.prototype, 'chunks');
		const result = await resumed.completeUpload(pid, nid, upload.id, actor);
		expect(chunks).not.toHaveBeenCalled();
		expect(multipart.putPart).toHaveBeenCalledTimes(2);
		expect(multipart.complete).toHaveBeenCalledTimes(1);
		expect(result.size).toBe(UPLOAD_PART_BYTES + 1);
		expect((await (await bucket.get(destination))!.bytes()).slice(-2)).toEqual(
			new Uint8Array([3, 9]),
		);
		await service.completeUpload(pid, nid, upload.id, actor);
		expect(multipart.complete).toHaveBeenCalledTimes(1);
		expect((await uploads.get(upload.id, actor)).backend).toBeUndefined();
	});

	it('reserves checksums before provider I/O and rejects conflicting concurrent bytes', async () => {
		const { multipart, uploads, service, start, send } = setup();
		const upload = await start();
		const put = multipart.putPart.getMockImplementation()!;
		multipart.putPart.mockImplementationOnce(async (...args) => {
			expect((await service.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([]);
			await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
				'missing parts',
			);
			await expect(send(upload.id, new Uint8Array([2]))).rejects.toThrow('different bytes');
			return put(...args);
		});
		await send(upload.id);
		await send(upload.id);
		expect(multipart.putPart).toHaveBeenCalledTimes(1);
		expect((await uploads.get(upload.id, actor)).parts).toMatchObject([
			{ number: 1, etag: expect.any(String) },
		]);
	});

	it('resumes a failed provider part without accepting different bytes', async () => {
		const { multipart, service, start, send } = setup();
		const upload = await start();
		multipart.putPart.mockRejectedValueOnce(new Error('transport down'));
		await expect(send(upload.id)).rejects.toThrow('transport down');
		expect((await service.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([]);
		await expect(send(upload.id, new Uint8Array([2]))).rejects.toThrow('different bytes');
		await send(upload.id);
		await expect(service.completeUpload(pid, nid, upload.id, actor)).resolves.toMatchObject({
			size: 1,
		});
	});

	it('recovers after provider success and a failed receipt save', async () => {
		const { bucket, multipart, service, start, send } = setup();
		const upload = await start();
		const put = multipart.putPart.getMockImplementation()!;
		multipart.putPart.mockImplementationOnce(async (...args) => {
			const receipt = await put(...args);
			vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('receipt unavailable'));
			return receipt;
		});
		await expect(send(upload.id)).rejects.toThrow('receipt unavailable');
		await send(upload.id);
		await service.completeUpload(pid, nid, upload.id, actor);
		expect(multipart.complete).toHaveBeenCalledTimes(1);
	});

	it.each(['cancel', 'expire'] as const)(
		'aborts on %s and retains the session ID for late cleanup',
		async (action) => {
			vi.useFakeTimers();
			const { multipart, service, start, send, bucket } = setup();
			const upload = await start();
			await send(upload.id);
			if (action === 'cancel') await service.cancelUpload(pid, nid, upload.id, actor);
			else {
				vi.setSystemTime(upload.expires_at);
				await service.sweepUploads(pid, nid);
			}
			expect(multipart.abort).toHaveBeenCalledTimes(1);
			await service.sweepUploads(pid, nid);
			expect(multipart.abort).toHaveBeenCalledTimes(2);
			await expect(send(upload.id)).rejects.toThrow('expired');
			expect(await bucket.head(destination)).toBeNull();
			expect(await (await bucket.get(`${prefix}${upload.id}.json`))!.json()).toMatchObject({
				status: 'cancelled',
				backend: { direct: true },
			});
		},
	);

	it('does not acknowledge a part whose cancellation wins during provider I/O', async () => {
		const { multipart, service, start, send } = setup();
		const upload = await start();
		multipart.putPart.mockImplementationOnce(async () => {
			await service.cancelUpload(pid, nid, upload.id, actor);
			return { partNumber: 1, etag: 'late' };
		});
		await expect(send(upload.id)).rejects.toThrow('cancelled');
		await service.sweepUploads(pid, nid);
		expect(multipart.abort).toHaveBeenCalledTimes(2);
		expect(multipart.complete).not.toHaveBeenCalled();
	});

	it('retries failed aborts during maintenance without releasing the receipt', async () => {
		const { multipart, service, start, send, sessions } = setup();
		const upload = await start();
		await send(upload.id);
		multipart.abort.mockRejectedValueOnce(new Error('abort unavailable'));
		await expect(service.cancelUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'abort unavailable',
		);
		expect(sessions.size).toBe(1);
		await service.sweepUploads(pid, nid);
		expect(sessions.size).toBe(0);
	});

	it('aborts a session and releases quota if recording start fails', async () => {
		const { bucket, multipart, start, sessions } = setup();
		const create = multipart.create.getMockImplementation()!;
		multipart.create.mockImplementationOnce(async (...args) => {
			const session = await create(...args);
			vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('record unavailable'));
			return session;
		});
		await expect(start()).rejects.toThrow('record unavailable');
		expect(sessions.size).toBe(0);
		expect(multipart.abort).toHaveBeenCalledTimes(1);
		expect(await (await bucket.get(`${prefix}index.json`))!.json()).toEqual({ uploads: [] });
		await expect(start()).resolves.toMatchObject({ size: 1 });
	});

	it('releases admission if session creation fails', async () => {
		const { bucket, multipart, start } = setup();
		multipart.create.mockRejectedValueOnce(new Error('provider down'));
		await expect(start()).rejects.toThrow('provider down');
		expect(await (await bucket.get(`${prefix}index.json`))!.json()).toEqual({ uploads: [] });
	});

	it('keeps native parts when editor admission blocks completion', async () => {
		const { multipart, service, start, send } = setup();
		const upload = await start();
		await send(upload.id);
		await expect(
			service.completeUpload(pid, nid, upload.id, actor, {
				assertMutable: async () => {
					throw new Error('editor active');
				},
			}),
		).rejects.toThrow('editor active');
		expect(multipart.complete).not.toHaveBeenCalled();
		await service.completeUpload(pid, nid, upload.id, actor);
		expect(multipart.putPart).toHaveBeenCalledTimes(1);
	});

	it('rechecks create-only and lowered limits before committing', async () => {
		const { bucket, multipart, service, send } = setup();
		const upload = await service.startUpload(
			pid,
			nid,
			{ path: 'data', size: 2, create_only: true },
			actor,
		);
		await send(upload.id, new Uint8Array([1, 2]));
		const limited = makeWorkspaceService(bucket, undefined, {
			maxFileBytes: 1,
			maxTotalBytes: 2,
			maxFiles: 1,
		}).service;
		await expect(limited.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'exceeds 1 bytes',
		);
		await service.write(pid, nid, 'data', new Uint8Array([9]), actor);
		await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'already exists',
		);
		expect(multipart.complete).not.toHaveBeenCalled();
		expect((await service.read(pid, nid, 'data')).bytes).toEqual(new Uint8Array([9]));
	});

	it('never replays an uncertain commit', async () => {
		const { multipart, service, start, send } = setup();
		const upload = await start();
		await send(upload.id);
		const complete = multipart.complete.getMockImplementation()!;
		multipart.complete.mockImplementationOnce(async (...args) => {
			await complete(...args);
			throw new Error('response lost');
		});
		await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow(
			'response lost',
		);
		await service.write(pid, nid, 'data', new Uint8Array([9]), actor);
		await expect(service.completeUpload(pid, nid, upload.id, actor)).rejects.toThrow('interrupted');
		expect(multipart.complete).toHaveBeenCalledTimes(1);
		expect((await service.read(pid, nid, 'data')).bytes).toEqual(new Uint8Array([9]));
	});

	it('keeps staging for non-isolated multipart backends and legacy records', async () => {
		const { bucket, multipart, service, start, send } = setup(false);
		const upload = await start();
		expect(multipart.create).not.toHaveBeenCalled();
		await send(upload.id);
		expect(await bucket.head(`${prefix}${upload.id}/parts/1`)).not.toBeNull();
		multipart.isolatedSessions = true;
		await makeWorkspaceService(bucket).service.completeUpload(pid, nid, upload.id, actor);
		expect(multipart.create).toHaveBeenCalledTimes(1);
		expect((await service.read(pid, nid, 'data')).bytes).toEqual(new Uint8Array([1]));
	});

	it.each([
		{ partNumber: 2, etag: 'wrong' },
		{ partNumber: 1, etag: '' },
	])('rejects an invalid provider receipt %s', async (receipt) => {
		const { multipart, service, start, send } = setup();
		const upload = await start();
		multipart.putPart.mockResolvedValueOnce(receipt);
		await expect(send(upload.id)).rejects.toThrow('invalid upload part receipt');
		expect((await service.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([]);
		await send(upload.id);
		await service.completeUpload(pid, nid, upload.id, actor);
	});

	it('rejects other owners before forwarding bytes or committing', async () => {
		const { multipart, service, start } = setup();
		const upload = await start();
		const other = 'other' as UserId;
		await expect(
			service.putUploadPart(pid, nid, upload.id, 1, new Uint8Array([1]), other),
		).rejects.toThrow('another user');
		await expect(service.completeUpload(pid, nid, upload.id, other)).rejects.toThrow(
			'another user',
		);
		await expect(service.cancelUpload(pid, nid, upload.id, other)).rejects.toThrow('another user');
		expect(multipart.putPart).not.toHaveBeenCalled();
		expect(multipart.complete).not.toHaveBeenCalled();
		expect(multipart.abort).not.toHaveBeenCalled();
	});

	it('keeps a receipt if the adapter no longer supports abort', async () => {
		const { bucket, service, start } = setup();
		const upload = await start();
		Object.assign(bucket, { multipart: undefined });
		await expect(service.cancelUpload(pid, nid, upload.id, actor)).rejects.toThrow('cannot abort');
		expect(await bucket.head(`${prefix}${upload.id}.json`)).not.toBeNull();
	});

	it('publishes empty files without creating a native session', async () => {
		const { multipart, service, start } = setup();
		const upload = await start(0);
		await service.completeUpload(pid, nid, upload.id, actor);
		expect(multipart.create).not.toHaveBeenCalled();
		expect((await service.read(pid, nid, 'data')).bytes).toHaveLength(0);
	});
});

describe('native upload deletion', () => {
	it('preserves receipts when reading a lazy body fails', async () => {
		const { bucket, uploads, multipart, start } = setup();
		const upload = await start();
		const key = `${prefix}${upload.id}.json`;
		const receipt = await bucket.get(key);
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementation(async (requested) =>
			requested === key
				? {
						...receipt!,
						json: async () => {
							throw new TypeError('connection terminated');
						},
					}
				: get(requested),
		);
		await expect(uploads.cancelAll()).rejects.toMatchObject({
			name: 'StoredObjectError',
			cause_name: 'TypeError',
		});
		expect(await bucket.head(key)).not.toBeNull();
		expect(multipart.abort).not.toHaveBeenCalled();
	});

	it.each(['not json', JSON.stringify({ status: 'uploading' })])(
		'skips corrupt receipts while aborting readable sessions: %s',
		async (corrupt) => {
			const { bucket, uploads, multipart, start, sessions } = setup();
			await bucket.put(`${prefix}00000000-0000-4000-8000-000000000000.json`, corrupt);
			const upload = await start();
			await uploads.cancelAll();
			expect(multipart.abort).toHaveBeenCalledTimes(1);
			expect(sessions.size).toBe(0);
			expect(await (await bucket.get(`${prefix}${upload.id}.json`))!.json()).toMatchObject({
				status: 'cancelled',
			});
		},
	);

	it.each(['notebook', 'project'] as const)(
		'aborts sessions before deleting a %s and preserves receipts on abort failure',
		async (scope) => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'Uploads', description: '' }, ACTOR);
			const notebook = await env.notebooks.createNotebook(
				project.id,
				{ title: 'Upload', description: '', code: '' },
				ACTOR,
			);
			const abort = vi.fn(async () => {});
			Object.assign(env.bucket, {
				multipart: {
					isolatedSessions: true,
					create: vi.fn(async () => ({ uploadId: 'native' })),
					putPart: vi.fn(),
					complete: vi.fn(),
					abort,
				} satisfies BucketMultipart,
			});
			const upload = await env.notebooks.workspace.startUpload(
				project.id,
				notebook.id,
				{ path: 'data', size: 1 },
				ACTOR,
			);
			const nb = paths.project(project.id).notebook(notebook.id);
			const receiptKey = `${nb.base}/uploads/${upload.id}.json`;
			await env.bucket.put(
				`${nb.base}/uploads/00000000-0000-4000-8000-000000000000.json`,
				'not json',
			);
			if (scope === 'notebook') await env.notebooks.deleteNotebook(project.id, notebook.id, ACTOR);
			else await env.projects.deleteProject(project.id, ACTOR);
			const purge = () =>
				scope === 'notebook'
					? env.notebooks.hardDeleteNotebook(project.id, notebook.id)
					: env.projects.hardDeleteProject(project.id);
			abort.mockRejectedValueOnce(new Error('provider unavailable'));
			await expect(purge()).rejects.toThrow('provider unavailable');
			expect(await env.bucket.head(receiptKey)).not.toBeNull();
			await purge();
			expect(abort).toHaveBeenCalledTimes(2);
			expect(abort).toHaveBeenLastCalledWith(nb.workspaceFile('data'), 'native');
			expect(await env.bucket.head(receiptKey)).toBeNull();
		},
	);
});

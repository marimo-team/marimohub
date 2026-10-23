import { z } from 'zod';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
} from '../../errors';
import type { UserId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import type { Bucket, BucketObject, BucketMultipartOptions } from '../../ports/bucket';
import { readStored, StoredObjectError } from '../../schema';
import { UPLOAD_PART_BYTES, UploadStatusSchema } from '../../uploads';
import { withCasRetry } from '../catalog/cas';
import { deleteByPrefix, listAllObjects } from '../catalog/storage';

export const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 7 * UPLOAD_RETENTION_MS;
const MAX_ACTIVE_UPLOADS = 16;
const UploadPartSchema = z.object({
	number: z.number().int().positive(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	key: z.string().optional(),
	etag: z.string().min(1).optional(),
});
export const UploadRecordSchema = z.object({
	id: z.uuid(),
	path: z.string(),
	size: z.number().int().nonnegative(),
	part_size: z.number().int().positive(),
	created_by: z.string(),
	expires_at: z.number(),
	create_only: z.boolean(),
	content_type: z.string(),
	status: UploadStatusSchema.shape.status,
	parts: z.array(UploadPartSchema),
	result: z.record(z.string(), z.unknown()).optional(),
	backend: z
		.object({ key: z.string(), id: z.string(), direct: z.literal(true).optional() })
		.optional(),
	context: z.record(z.string(), z.string()),
});
export type UploadRecord = z.infer<typeof UploadRecordSchema>;
export const UploadIndexSchema = z.object({
	uploads: z
		.array(z.object({ id: z.uuid(), size: z.number(), expires_at: z.number() }))
		.max(MAX_ACTIVE_UPLOADS),
});

export function uploadStatus(record: UploadRecord): z.infer<typeof UploadStatusSchema> {
	return {
		id: record.id,
		path: record.path,
		size: record.size,
		part_size: record.part_size,
		parts_done: record.parts
			.filter((part) => !record.backend?.direct || part.etag)
			.map((part) => part.number),
		expires_at: record.expires_at,
		status: record.status,
	};
}

async function partHash(bytes: Uint8Array): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('');
}

/** Each owner supplies a scoped prefix; no key or backend upload ID comes from a client. */
export class ResumableUploads {
	constructor(
		private readonly bucket: Bucket,
		private readonly prefix: string,
	) {}
	private key(id: string) {
		if (!z.uuid().safeParse(id).success) throw new BadRequestError('Invalid upload ID');
		return `${this.prefix}${id}.json`;
	}
	private partsPrefix(id: string) {
		return `${this.prefix}${id}/parts/`;
	}
	async start(
		input: Pick<UploadRecord, 'path' | 'size' | 'create_only' | 'content_type'>,
		actor: UserId,
		maxBytes: number,
		context: Record<string, string> = {},
		destination?: { key: string; options?: BucketMultipartOptions },
	) {
		if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxBytes)
			throw new ResourceExhaustedError(`Upload exceeds the ${maxBytes}-byte limit`);
		const record: UploadRecord = {
			...input,
			id: crypto.randomUUID(),
			part_size: UPLOAD_PART_BYTES,
			created_by: actor,
			expires_at: Date.now() + UPLOAD_RETENTION_MS,
			parts: [],
			status: 'uploading',
			context,
		};
		const indexKey = `${this.prefix}index.json`;
		await withCasRetry(this.bucket, async (writer) => {
			const head = await this.bucket.get(indexKey);
			const index = head ? await readStored(UploadIndexSchema, head, indexKey) : { uploads: [] };
			const active = index.uploads.filter((upload) => upload.expires_at > Date.now());
			if (
				active.length >= MAX_ACTIVE_UPLOADS ||
				active.reduce((sum, upload) => sum + upload.size, 0) + input.size > maxBytes
			)
				throw new ResourceExhaustedError(
					'Too many unfinished uploads; finish or cancel an upload first',
				);
			await writer.put(
				indexKey,
				JSON.stringify({
					uploads: [...active, { id: record.id, size: record.size, expires_at: record.expires_at }],
				}),
				head ? { onlyIfEtagMatches: head.etag } : { onlyIfNotExists: true },
			);
		});
		try {
			if (destination && input.size > 0 && this.bucket.multipart?.isolatedSessions) {
				const { uploadId } = await this.bucket.multipart.create(
					destination.key,
					destination.options,
				);
				record.backend = { key: destination.key, id: uploadId, direct: true };
			}
			await this.bucket.put(this.key(record.id), JSON.stringify(record), { onlyIfNotExists: true });
		} catch (error) {
			if (record.backend) {
				await this.bucket
					.multipart!.abort(record.backend.key, record.backend.id)
					.catch((cleanupError) => {
						logOperationalError('upload_abort_failed', { upload_id: record.id }, cleanupError);
					});
			}
			// A failed start never exposes its ID, even if storage committed the record.
			await this.release(record.id).catch((cleanupError) => {
				logOperationalError(
					'upload_admission_release_failed',
					{ upload_id: record.id },
					cleanupError,
				);
			});
			throw error;
		}
		return uploadStatus(record);
	}
	private async load(id: string) {
		const key = this.key(id);
		const head = await this.bucket.get(key);
		if (!head) throw new NotFoundError('Upload not found');
		return { head, record: await readStored(UploadRecordSchema, head, key) };
	}
	private authorize(record: UploadRecord, actor: UserId) {
		if (record.created_by !== actor) throw new ForbiddenError('Upload belongs to another user');
		const expires = record.expires_at + (record.status === 'complete' ? RECEIPT_RETENTION_MS : 0);
		if (expires <= Date.now() || record.status === 'cancelled')
			throw new NotFoundError('Upload expired or was cancelled');
	}
	async get(id: string, actor: UserId) {
		const { record } = await this.load(id);
		this.authorize(record, actor);
		return record;
	}
	async putPart(id: string, number: number, bytes: Uint8Array, actor: UserId) {
		const record = await this.get(id, actor);
		const expected = Math.min(record.part_size, record.size - (number - 1) * record.part_size);
		if (
			!Number.isSafeInteger(number) ||
			number < 1 ||
			expected <= 0 ||
			expected !== bytes.byteLength
		)
			throw new BadRequestError('Upload part number or size does not match the upload');
		if (record.status !== 'uploading') throw new ConflictError('Upload no longer accepts parts');
		const sha256 = await partHash(bytes);
		if (record.backend?.direct) return this.putNativePart(id, number, bytes, sha256, actor);
		const key = `${this.partsPrefix(id)}${number}`;
		try {
			await this.bucket.put(key, bytes, { onlyIfNotExists: true });
		} catch (error) {
			if (!(error instanceof PreconditionFailedError)) throw error;
			const existing = await this.bucket.get(key);
			if (!existing || existing.size !== bytes.byteLength)
				throw new ConflictError('Upload part already contains different bytes');
			const hash = await partHash(await existing.bytes());
			if (hash !== sha256) throw new ConflictError('Upload part already contains different bytes');
		}
		return withCasRetry(this.bucket, async (writer) => {
			const { head, record: current } = await this.load(id);
			this.authorize(current, actor);
			if (current.status !== 'uploading') throw new ConflictError('Upload no longer accepts parts');
			const previous = current.parts.find((part) => part.number === number);
			if (previous && previous.sha256 !== sha256)
				throw new ConflictError('Upload part already contains different bytes');
			if (!previous) current.parts.push({ number, sha256, key });
			current.parts.sort((a, b) => a.number - b.number);
			await writer.put(this.key(id), JSON.stringify(current), { onlyIfEtagMatches: head.etag });
			return uploadStatus(current);
		});
	}
	private async putNativePart(
		id: string,
		number: number,
		bytes: Uint8Array,
		sha256: string,
		actor: UserId,
	) {
		const multipart = this.bucket.multipart;
		if (!multipart) throw new ConflictError('Upload storage changed; start a new upload');
		// Reserve the checksum before provider I/O: multipart uploads can overwrite a part number.
		const record = await withCasRetry(this.bucket, async (writer) => {
			const { head, record } = await this.load(id);
			this.authorize(record, actor);
			if (record.status !== 'uploading') throw new ConflictError('Upload no longer accepts parts');
			const previous = record.parts.find((part) => part.number === number);
			if (previous) {
				if (previous.sha256 !== sha256)
					throw new ConflictError('Upload part already contains different bytes');
				return record;
			}
			record.parts.push({ number, sha256 });
			record.parts.sort((a, b) => a.number - b.number);
			await writer.put(this.key(id), JSON.stringify(record), { onlyIfEtagMatches: head.etag });
			return record;
		});
		if (record.parts.find((part) => part.number === number)?.etag) return uploadStatus(record);
		const backend = record.backend!;
		const receipt = await multipart.putPart(backend.key, backend.id, number, bytes);
		if (receipt.partNumber !== number || !receipt.etag)
			throw new ConflictError('Storage returned an invalid upload part receipt');
		return withCasRetry(this.bucket, async (writer) => {
			const { head, record: current } = await this.load(id);
			this.authorize(current, actor);
			if (current.status !== 'uploading') throw new ConflictError('Upload no longer accepts parts');
			const part = current.parts.find((part) => part.number === number);
			if (!part || part.sha256 !== sha256) throw new ConflictError('Upload part changed');
			part.etag = receipt.etag;
			await writer.put(this.key(id), JSON.stringify(current), { onlyIfEtagMatches: head.etag });
			return uploadStatus(current);
		});
	}
	async *chunks(record: UploadRecord): AsyncGenerator<Uint8Array> {
		for (const part of record.parts) {
			if (!part.key) throw new ConflictError('Upload part has no staged bytes');
			const object = await this.bucket.get(part.key);
			if (!object) throw new ConflictError('Upload part is missing; upload the file again');
			const bytes = await object.bytes();
			const expected = Math.min(
				record.part_size,
				record.size - (part.number - 1) * record.part_size,
			);
			if (bytes.byteLength !== expected || (await partHash(bytes)) !== part.sha256)
				throw new ConflictError('Upload part is corrupt; upload the file again');
			yield bytes;
		}
	}
	async complete(
		id: string,
		actor: UserId,
		prepare: (record: UploadRecord) => Promise<() => Promise<Record<string, unknown>>>,
	) {
		const { head, record } = await this.load(id);
		this.authorize(record, actor);
		if (record.status === 'complete' && record.result) {
			await this.cleanupCompleted(id);
			return record.result;
		}
		if (record.status === 'publishing')
			throw new ConflictError(
				'Upload publication is in progress or was interrupted; check the destination before starting another upload',
			);
		if (
			record.parts.length !== Math.ceil(record.size / record.part_size) ||
			record.parts.some(
				(part, index) => part.number !== index + 1 || (record.backend?.direct && !part.etag),
			)
		)
			throw new ConflictError('Upload has missing parts or invalid part ordering');
		const publish = await prepare(record);
		this.authorize(record, actor);
		record.status = 'publishing';
		try {
			await this.bucket.put(this.key(id), JSON.stringify(record), { onlyIfEtagMatches: head.etag });
		} catch (error) {
			if (error instanceof PreconditionFailedError)
				throw new ConflictError('Upload changed; retry completion');
			throw error;
		}
		// Never replay an uncertain publication: another writer may already have changed the destination.
		const result = await publish();
		const current = await this.load(id);
		// Expiry can race a successful write. Do not revive a receipt already fenced by maintenance.
		if (current.record.status === 'cancelled') return result;
		if (current.record.status !== 'publishing')
			throw new ConflictError('Upload publication was cancelled');
		await this.bucket.put(
			this.key(id),
			JSON.stringify({ ...current.record, status: 'complete', backend: undefined, result }),
			{ onlyIfEtagMatches: current.head.etag },
		);
		await this.cleanupCompleted(id);
		return result;
	}
	private async cleanupCompleted(id: string) {
		try {
			await this.release(id);
			await deleteByPrefix(this.bucket, this.partsPrefix(id));
		} catch (error) {
			// Publication is durable; maintenance retries cleanup without replaying the write.
			logOperationalError('upload_cleanup_failed', { upload_id: id }, error);
		}
	}
	async publishToBucket(
		record: UploadRecord,
		key: string,
		options?: BucketMultipartOptions,
		assertMutable: () => Promise<void> = async () => {},
	): Promise<BucketObject> {
		if (record.backend?.direct) {
			if (!this.bucket.multipart || record.backend.key !== key)
				throw new ConflictError('Upload destination changed; start a new upload');
			await assertMutable();
			return this.bucket.multipart.complete(
				key,
				record.backend.id,
				record.parts.map((part) => ({ partNumber: part.number, etag: part.etag! })),
			);
		}
		if (this.bucket.multipart && record.size > 0) {
			const multipart = this.bucket.multipart;
			const { uploadId } = await multipart.create(key, options);
			try {
				const current = await this.load(record.id);
				if (current.record.status !== 'publishing' || current.record.expires_at <= Date.now())
					throw new ConflictError('Upload publication expired or was cancelled');
				await this.bucket.put(
					this.key(record.id),
					JSON.stringify({ ...current.record, backend: { key, id: uploadId } }),
					{ onlyIfEtagMatches: current.head.etag },
				);
				const parts = [];
				let partNumber = 0;
				for await (const bytes of this.chunks(record)) {
					await assertMutable();
					parts.push(await multipart.putPart(key, uploadId, ++partNumber, bytes));
				}
				await assertMutable();
				return await multipart.complete(key, uploadId, parts);
			} catch (error) {
				await multipart.abort(key, uploadId).catch(() => {});
				throw error;
			}
		}
		const chunks = this.chunks(record);
		if (this.bucket.putStream)
			return this.bucket.putStream(
				key,
				(async function* () {
					for await (const chunk of chunks) {
						await assertMutable();
						yield chunk;
					}
					await assertMutable();
				})(),
				record.size,
				options,
			);
		if (record.size > 64 * 1024 * 1024)
			throw new ResourceExhaustedError('This storage adapter supports uploads up to 64 MiB');
		const bytes = new Uint8Array(record.size);
		let offset = 0;
		for await (const chunk of this.chunks(record)) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		await assertMutable();
		return this.bucket.put(key, bytes, options);
	}
	async cancel(id: string, actor: UserId) {
		await this.expire(id, actor);
	}
	private async release(id: string) {
		const key = `${this.prefix}index.json`;
		await withCasRetry(this.bucket, async (writer) => {
			const head = await this.bucket.get(key);
			if (!head) return;
			const index = await readStored(UploadIndexSchema, head, key);
			await writer.put(
				key,
				JSON.stringify({ uploads: index.uploads.filter((upload) => upload.id !== id) }),
				{ onlyIfEtagMatches: head.etag },
			);
		});
	}
	private async expire(id: string, actor?: UserId) {
		const record = await withCasRetry(this.bucket, async (writer) => {
			const { head, record } = await this.load(id);
			if (actor) {
				if (record.created_by !== actor) throw new ForbiddenError('Upload belongs to another user');
				if (record.status === 'publishing')
					throw new ConflictError('Upload publication is in progress');
			}
			if (record.status === 'complete') return record;
			record.status = 'cancelled';
			await writer.put(this.key(id), JSON.stringify(record), { onlyIfEtagMatches: head.etag });
			return record;
		});
		if (record.backend) {
			if (!this.bucket.multipart)
				throw new ConflictError('Upload storage changed; cannot abort the session');
			await this.bucket.multipart.abort(record.backend.key, record.backend.id);
		}
		await deleteByPrefix(this.bucket, this.partsPrefix(id));
		await this.release(id);
	}
	private async recordIds() {
		return (await listAllObjects(this.bucket, this.prefix))
			.map((object) => object.key.slice(this.prefix.length).replace(/\.json$/, ''))
			.filter((id) => z.uuid().safeParse(id).success);
	}
	async cancelAll() {
		for (const id of await this.recordIds()) {
			try {
				await this.load(id);
			} catch (error) {
				const corrupt =
					error instanceof StoredObjectError &&
					(error.reason === 'schema_mismatch' || error.cause_name === 'SyntaxError');
				if (!corrupt && !(error instanceof NotFoundError)) throw error;
				logOperationalError('upload_cancel_failed', { upload_id: id }, error);
				continue;
			}
			await this.expire(id);
		}
	}
	async sweep(now = Date.now()) {
		for (const id of await this.recordIds()) {
			try {
				const { record } = await this.load(id);
				if (record.expires_at > now && record.status !== 'cancelled') {
					if (record.status === 'complete') await this.cleanupCompleted(id);
					continue;
				}
				await this.expire(id);
				if (record.expires_at + RECEIPT_RETENTION_MS <= now) await this.bucket.delete(this.key(id));
			} catch (error) {
				logOperationalError('upload_sweep_failed', { upload_id: id }, error);
			}
		}
	}
}

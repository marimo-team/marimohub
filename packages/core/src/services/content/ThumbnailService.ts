import { all } from 'better-all';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId, VersionId } from '../../ids';
import { paths } from '../../paths';
import { NotFoundError, PreconditionFailedError } from '../../errors';
import { ProjectSchema, readStored } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { listAllObjects } from '../catalog/storage';
import type { NotebookService } from './NotebookService';
import { validateThumbnailPng } from './thumbnailPng';
import { sha256Hex } from '../../internal/sha256';
import { Millis } from '../../duration';

const ImageSchema = z.object({ id: z.uuid(), captured_at: z.iso.datetime() });
export const AutomaticThumbnailSchema = ImageSchema.extend({
	version_id: z.string(),
	html_hash: z.string(),
	renderer_revision: z.string(),
});
export const ThumbnailRecordSchema = z.object({
	schema_version: z.literal(1),
	revision: z.uuid(),
	deleted: z.boolean().optional(),
	custom: ImageSchema.nullable(),
	automatic: AutomaticThumbnailSchema.nullable(),
});
export type ThumbnailRecord = z.infer<typeof ThumbnailRecordSchema>;
export const ThumbnailMetadataSchema = z.object({
	source: z.enum(['custom', 'automatic']).nullable(),
	revision: z.string().nullable(),
	captured_at: z.string().nullable(),
	has_custom: z.boolean(),
});
function thumbnailRecord(
	fields: Partial<Omit<ThumbnailRecord, 'schema_version' | 'revision'>> = {},
): ThumbnailRecord {
	return {
		schema_version: 1,
		custom: null,
		automatic: null,
		...fields,
		revision: crypto.randomUUID(),
	};
}

export const THUMBNAIL_RENDERER_REVISION = '1';
export interface ThumbnailCapture {
	html: string;
	hash: string;
	versionId: VersionId;
	revision: string | null;
}

export class ThumbnailService {
	constructor(
		private bucket: Bucket,
		private notebooks: Pick<NotebookService, 'getNotebook' | 'getVersionHtmlSnapshot'>,
	) {}

	async get(pid: ProjectId, nid: NotebookId): Promise<ThumbnailRecord | null> {
		const key = paths.project(pid).notebook(nid).thumbnail;
		const obj = await this.bucket.get(key);
		return obj ? readStored(ThumbnailRecordSchema, obj, key) : null;
	}

	async metadata(
		pid: ProjectId,
		nid: NotebookId,
	): Promise<z.infer<typeof ThumbnailMetadataSchema>> {
		const record = await this.get(pid, nid);
		const image = record?.custom ?? record?.automatic;
		return {
			source: record?.custom ? 'custom' : image ? 'automatic' : null,
			revision: record?.revision ?? null,
			captured_at: image?.captured_at ?? null,
			has_custom: !!record?.custom,
		};
	}

	async image(pid: ProjectId, nid: NotebookId) {
		const record = await this.get(pid, nid);
		const image = record?.custom ?? record?.automatic;
		return image
			? this.bucket.get(paths.project(pid).notebook(nid).thumbnailImage(image.id))
			: null;
	}

	private async assertActive(pid: ProjectId, nid: NotebookId) {
		const projectKey = paths.project(pid).meta;
		const { project, notebook } = await all({
			project: async () => {
				const object = await this.bucket.get(projectKey);
				return object ? readStored(ProjectSchema, object, projectKey) : null;
			},
			notebook: () => this.notebooks.getNotebook(pid, nid),
		});
		if (!project || project.status === 'deleted') throw new NotFoundError('Project not found');
		if (notebook.meta.status === 'deleted') throw new NotFoundError('Notebook not found');
	}

	async setCustom(pid: ProjectId, nid: NotebookId, bytes: Uint8Array) {
		await this.assertActive(pid, nid);
		const image = await this.writeImage(pid, nid, bytes);
		await this.update(pid, nid, (record) => ({ ...record, custom: image }));
		return this.metadata(pid, nid);
	}

	async removeCustom(pid: ProjectId, nid: NotebookId) {
		await this.update(pid, nid, (record) => ({ ...record, custom: null }));
		return this.metadata(pid, nid);
	}

	private async update(
		pid: ProjectId,
		nid: NotebookId,
		change: (record: ThumbnailRecord) => ThumbnailRecord,
	) {
		const key = paths.project(pid).notebook(nid).thumbnail;
		await withCasRetry(this.bucket, async (cas) => {
			const { obj } = await all({
				active: () => this.assertActive(pid, nid),
				obj: () => this.bucket.get(key),
			});
			const current = obj ? await readStored(ThumbnailRecordSchema, obj, key) : thumbnailRecord();
			if (current.deleted) throw new NotFoundError('Notebook not found');
			await cas.put(
				key,
				JSON.stringify(thumbnailRecord(change(current))),
				obj ? { onlyIfEtagMatches: obj.etag } : { onlyIfNotExists: true },
			);
		});
	}

	async retire(pid: ProjectId, nid: NotebookId): Promise<void> {
		await ThumbnailService.retire(this.bucket, pid, nid);
	}

	static async retire(bucket: Bucket, pid: ProjectId, nid: NotebookId): Promise<void> {
		const key = paths.project(pid).notebook(nid).thumbnail;
		await withCasRetry(bucket, async (cas) => {
			const obj = await bucket.get(key);
			await cas.put(
				key,
				JSON.stringify(thumbnailRecord({ deleted: true })),
				obj ? { onlyIfEtagMatches: obj.etag } : { onlyIfNotExists: true },
			);
		});
	}

	async claimAttempt(pid: ProjectId, nid: NotebookId, sandboxId: string): Promise<boolean> {
		const key = paths.project(pid).notebook(nid).thumbnailAttempt(sandboxId);
		try {
			await this.bucket.put(key, JSON.stringify({ started_at: new Date().toISOString() }), {
				onlyIfNotExists: true,
			});
			return true;
		} catch (error) {
			if (error instanceof PreconditionFailedError) return false;
			throw error;
		}
	}

	async prepare(
		pid: ProjectId,
		nid: NotebookId,
		onSkip?: (reason: string) => void,
	): Promise<ThumbnailCapture | null> {
		const skip = (reason: string) => {
			onSkip?.(reason);
			return null;
		};
		const {
			notebook: { meta, source },
			record,
		} = await all({
			notebook: () => this.notebooks.getNotebook(pid, nid),
			record: () => this.get(pid, nid),
		});
		if (meta.status === 'deleted') return skip('deleted');
		if (source.type !== 'local') return skip('non_local_source');
		if (record?.custom) return skip('custom_selected');
		if (record?.deleted) return skip('deleted');
		const snapshot = await this.notebooks.getVersionHtmlSnapshot(
			pid,
			nid,
			source.current_version_id,
		);
		if (!snapshot) return skip('missing_html');
		const hash = await sha256Hex(snapshot.html);
		if (
			record?.automatic?.html_hash === hash &&
			record.automatic.renderer_revision === THUMBNAIL_RENDERER_REVISION
		)
			return skip('unchanged_html');
		return {
			html: snapshot.html,
			hash,
			versionId: source.current_version_id,
			revision: record?.revision ?? null,
		};
	}

	async publish(
		pid: ProjectId,
		nid: NotebookId,
		capture: ThumbnailCapture,
		bytes: Uint8Array,
		deadlineAt = Infinity,
	): Promise<boolean> {
		if (Date.now() >= deadlineAt) return false;
		const key = paths.project(pid).notebook(nid).thumbnail;
		const obj = await this.bucket.get(key);
		const current = obj ? await readStored(ThumbnailRecordSchema, obj, key) : null;
		if ((current?.revision ?? null) !== capture.revision || current?.custom) return false;
		if (current?.deleted) return false;
		if (Date.now() >= deadlineAt) return false;
		const image = await this.writeImage(pid, nid, bytes);
		if (Date.now() >= deadlineAt) return false;
		// Image transfer can outlive a save or deletion; validate the source again before publication.
		const fresh = await this.prepare(pid, nid);
		if (!fresh || fresh.hash !== capture.hash || fresh.versionId !== capture.versionId)
			return false;
		await this.assertActive(pid, nid);
		if (Date.now() >= deadlineAt) return false;
		try {
			await this.bucket.put(
				key,
				JSON.stringify(
					thumbnailRecord({
						automatic: {
							...image,
							version_id: capture.versionId,
							html_hash: capture.hash,
							renderer_revision: THUMBNAIL_RENDERER_REVISION,
						},
					}),
				),
				obj ? { onlyIfEtagMatches: obj.etag } : { onlyIfNotExists: true },
			);
			return true;
		} catch (error) {
			if (error instanceof PreconditionFailedError) return false;
			throw error;
		}
	}

	private async writeImage(pid: ProjectId, nid: NotebookId, bytes: Uint8Array) {
		validateThumbnailPng(bytes);
		const image = { id: crypto.randomUUID(), captured_at: new Date().toISOString() };
		await this.bucket.put(paths.project(pid).notebook(nid).thumbnailImage(image.id), bytes, {
			onlyIfNotExists: true,
			httpMetadata: { contentType: 'image/png' },
		});
		return image;
	}

	async prune(pid: ProjectId, nid: NotebookId, now = Date.now()): Promise<void> {
		const nb = paths.project(pid).notebook(nid);
		const candidates = (await listAllObjects(this.bucket, nb.thumbnailImages)).filter(
			(o) => now - o.uploaded.getTime() > Millis.days(1),
		);
		// New publications only reference newly-created objects, so old unreferenced IDs cannot return.
		const current = await this.get(pid, nid);
		const keep = new Set(
			[current?.custom?.id, current?.automatic?.id]
				.filter(Boolean)
				.map((id) => nb.thumbnailImage(id)),
		);
		const stale = candidates.filter((o) => !keep.has(o.key)).map((o) => o.key);
		if (stale.length > 0) await this.bucket.delete(stale);
	}
}

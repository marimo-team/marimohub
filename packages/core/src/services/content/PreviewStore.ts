import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId } from '../../ids';
import { ConflictError, NotFoundError, ResourceExhaustedError } from '../../errors';
import { readStored, ProjectIdSchema, NotebookIdSchema } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { logOperationalError } from '../../operationalLog';
import { PreviewRecordSchema, PreviewIdSchema } from './notebookPreviews';
import type { NotebookPreview } from './notebookPreviews';

export const PREVIEW_LIMITS = {
	projectsPerTick: 4,
	workPagesPerTick: 16,
	creationMs: 60_000,
	perProject: 25,
	receiptsPerProject: 1000,
	bytesPerProject: 500 * 1024 * 1024,
	revisionsPerPreview: 12,
	concurrency: 4,
	concurrencyPerProject: 1,
	attemptMs: 120_000,
	idempotencyMs: 7 * 86_400_000,
} as const;
const Epoch = z.number().describe('Milliseconds since the Unix epoch.');
export const PreviewProjectSchema = z.object({
	revision: z.string().optional(),
	work_id: z.string().optional(),
	entries: z.array(
		z.object({
			intent: PreviewRecordSchema,
			artifacts: z.array(
				z.object({ notebook_id: NotebookIdSchema, bytes: z.number().nonnegative() }),
			),
		}),
	),
});
export const PreviewReceiptsSchema = z.object({
	entries: z.array(
		z.object({
			key: z.string(),
			fingerprint: z.string(),
			id: PreviewIdSchema,
			created_at: z.iso.datetime(),
			expires_at: Epoch,
			deleted: z.boolean(),
		}),
	),
});
export const PreviewWorkSchema = z.object({
	cursor: z.string().optional(),
	claims: z.array(
		z.object({
			project_id: ProjectIdSchema,
			preview_id: PreviewIdSchema,
			token: z.string(),
			expires_at: Epoch,
		}),
	),
});
export const previewProjectPrefix = '_system/preview-projects/';
export const previewProjectKey = (pid: ProjectId) => `${previewProjectPrefix}${pid}.json`;
export const previewActiveProjectPrefix = '_system/preview-active-projects/';
export const previewActiveProjectKey = (pid: ProjectId, workId: string) =>
	`${previewActiveProjectPrefix}${pid}/${workId}.json`;
export const PreviewActiveProjectSchema = z.object({
	project_id: ProjectIdSchema,
	work_id: z.string(),
});
export const previewReceiptsKey = (pid: ProjectId) => `_system/preview-receipts/${pid}.json`;
export const previewWorkKey = '_system/preview-work.json';
export const previewCleanupCursorKey = '_system/preview-cleanup-cursor.json';
export const PreviewCursorSchema = z.object({ cursor: z.string().optional() });

export class PreviewStore {
	constructor(private readonly bucket: Bucket) {}

	private async change<T, R>(
		key: string,
		schema: z.ZodType<T>,
		initial: T,
		apply: (value: T) => R | Promise<R>,
	): Promise<R> {
		return withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const value = object ? await readStored(schema, object, key) : structuredClone(initial);
			const result = await apply(value);
			await cas.put(
				key,
				JSON.stringify(value),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return result;
		});
	}

	private changeProject<R>(
		pid: ProjectId,
		apply: (project: z.infer<typeof PreviewProjectSchema>) => R,
	) {
		return this.change(
			previewProjectKey(pid),
			PreviewProjectSchema,
			{ entries: [] },
			async (project) => {
				const wasEmpty = project.entries.length === 0;
				const result = apply(project);
				// A fresh revision also fences writers when membership returns to the same empty value.
				project.revision = crypto.randomUUID();
				if (project.entries.length > 0 && (wasEmpty || !project.work_id)) {
					project.work_id = crypto.randomUUID();
					// Publish discovery before membership so interrupted creation remains recoverable.
					await this.bucket.put(
						previewActiveProjectKey(pid, project.work_id),
						JSON.stringify({
							project_id: pid,
							work_id: project.work_id,
						}),
						{ onlyIfNotExists: true },
					);
				}
				return result;
			},
		);
	}

	private async removeInactiveWork(pid: ProjectId, workId: string) {
		const removed = await this.changeProject(
			pid,
			(project) => project.entries.length === 0 || project.work_id !== workId,
		);
		// The CAS fences a pending publication before its marker is removed. Tokens are never reused.
		if (removed) await this.bucket.delete(previewActiveProjectKey(pid, workId));
		return removed;
	}

	async project(pid: ProjectId): Promise<z.infer<typeof PreviewProjectSchema>> {
		const key = previewProjectKey(pid);
		const object = await this.bucket.get(key);
		return object ? readStored(PreviewProjectSchema, object, key) : { entries: [] };
	}

	async receipt(pid: ProjectId, key: string, fingerprint: string) {
		return this.change(
			previewReceiptsKey(pid),
			PreviewReceiptsSchema,
			{ entries: [] },
			(record) => {
				record.entries = record.entries.filter((entry) => entry.expires_at > Date.now());
				const existing = record.entries.find((entry) => entry.key === key);
				if (existing) {
					if (existing.fingerprint !== fingerprint)
						throw new ConflictError('Idempotency key already used for another preview request');
					if (existing.deleted) throw new ConflictError('This preview has been deleted');
					return existing;
				}
				if (record.entries.length >= PREVIEW_LIMITS.receiptsPerProject)
					throw new ResourceExhaustedError('Preview idempotency receipt limit reached');
				const entry = {
					key,
					fingerprint,
					id: crypto.randomUUID().replaceAll('-', ''),
					created_at: new Date().toISOString(),
					expires_at: Date.now() + PREVIEW_LIMITS.idempotencyMs,
					deleted: false,
				};
				record.entries.push(entry);
				return entry;
			},
		);
	}

	async pruneReceipts(pid: ProjectId, deletedId?: string) {
		await this.change(previewReceiptsKey(pid), PreviewReceiptsSchema, { entries: [] }, (record) => {
			record.entries = record.entries.filter((entry) => entry.expires_at > Date.now());
			for (const entry of record.entries) if (entry.id === deletedId) entry.deleted = true;
		});
	}

	async reserve(
		intent: NotebookPreview,
		creationDeadline = Date.now() + PREVIEW_LIMITS.creationMs,
	): Promise<NotebookPreview> {
		return this.changeProject(intent.project_id, (record) => {
			const existing = record.entries.find((entry) => entry.intent.id === intent.id);
			if (existing) return existing.intent;
			// A delayed create must not restore membership after deletion and cleanup.
			if (Date.now() >= creationDeadline)
				throw new ConflictError('Preview creation attempt expired; retry the request');
			if (record.entries.length >= PREVIEW_LIMITS.perProject)
				throw new ResourceExhaustedError(
					'Project preview limit reached, including previews awaiting cleanup',
				);
			record.entries.push({ intent, artifacts: [] });
			return intent;
		});
	}

	async reserveArtifact(
		record: NotebookPreview,
		nid: NotebookId,
		bytes: number,
		expiresAt = Infinity,
	) {
		await this.changeProject(record.project_id, (project) => {
			const entry = project.entries.find((item) => item.intent.id === record.id);
			if (entry?.intent.state !== 'active') throw new NotFoundError('Preview not found');
			if (expiresAt <= Date.now()) throw new ConflictError('Preview preparation lease expired');
			if (entry.artifacts.some((item) => item.notebook_id === nid)) return;
			if (entry.artifacts.length >= PREVIEW_LIMITS.revisionsPerPreview)
				throw new ResourceExhaustedError('Preview revision limit reached; waiting for cleanup');
			const total = project.entries
				.flatMap((item) => item.artifacts)
				.reduce((sum, item) => sum + item.bytes, 0);
			if (total + bytes > PREVIEW_LIMITS.bytesPerProject)
				throw new ResourceExhaustedError('Project preview storage limit reached');
			entry.artifacts.push({ notebook_id: nid, bytes });
		});
	}

	async commitArtifactBytes(record: NotebookPreview, nid: NotebookId, bytes: number) {
		await this.changeProject(record.project_id, (project) => {
			const artifact = project.entries
				.find((entry) => entry.intent.id === record.id)
				?.artifacts.find((item) => item.notebook_id === nid);
			if (!artifact) throw new NotFoundError('Preview artifact reservation not found');
			if (bytes > artifact.bytes)
				throw new ResourceExhaustedError('Preview exceeded its artifact reservation');
			artifact.bytes = bytes;
		});
	}

	async markCleaned(record: NotebookPreview) {
		await this.changeProject(record.project_id, (project) => {
			const entry = project.entries.find((item) => item.intent.id === record.id);
			if (entry) entry.intent = { ...record, state: 'deleted' };
		});
	}

	async releaseArtifact(record: NotebookPreview, nid: NotebookId) {
		await this.changeProject(record.project_id, (project) => {
			const entry = project.entries.find((item) => item.intent.id === record.id);
			if (entry) entry.artifacts = entry.artifacts.filter((item) => item.notebook_id !== nid);
		});
	}

	async forget(record: NotebookPreview) {
		await this.pruneReceipts(record.project_id, record.id);
		const workId = await this.changeProject(record.project_id, (project) => {
			project.entries = project.entries.filter((entry) => entry.intent.id !== record.id);
			return project.entries.length === 0 ? project.work_id : undefined;
		});
		if (workId) await this.removeInactiveWork(record.project_id, workId);
	}

	async projectPage(startAfter?: string) {
		let cursor = startAfter;
		const projects: ProjectId[] = [];
		for (let scanned = 0; scanned < PREVIEW_LIMITS.workPagesPerTick; scanned++) {
			const page = await this.bucket.list({
				prefix: previewActiveProjectPrefix,
				startAfter: cursor,
				limit: PREVIEW_LIMITS.projectsPerTick - projects.length,
			});
			for (const object of page.objects) {
				try {
					const [pid, filename] = object.key.slice(previewActiveProjectPrefix.length).split('/');
					const projectId = ProjectIdSchema.parse(pid);
					const workId = filename.slice(0, -5);
					const project = await this.project(projectId);
					if (project.entries.length > 0 && project.work_id === workId) projects.push(projectId);
					else await this.removeInactiveWork(projectId, workId);
				} catch (error) {
					logOperationalError(
						'preview_work_scan_failed',
						{ operation: 'preview.scan', key: object.key },
						error,
					);
				}
			}
			cursor = page.truncated ? page.objects.at(-1)?.key : undefined;
			if (!cursor || projects.length === PREVIEW_LIMITS.projectsPerTick) break;
		}
		return { projects, cursor };
	}

	async nextProjects(lane: 'prepare' | 'cleanup'): Promise<ProjectId[]> {
		const key = lane === 'prepare' ? previewWorkKey : previewCleanupCursorKey;
		return withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const schema = lane === 'prepare' ? PreviewWorkSchema : PreviewCursorSchema;
			const record = object
				? await readStored(schema, object, key)
				: { cursor: undefined, claims: [] };
			const page = await this.projectPage(record.cursor);
			await cas.put(
				key,
				JSON.stringify({ ...record, cursor: page.cursor }),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return page.projects;
		});
	}

	async claim(pid: ProjectId, id: string) {
		return this.change(previewWorkKey, PreviewWorkSchema, { claims: [] }, (record) => {
			record.claims = record.claims.filter((entry) => entry.expires_at > Date.now());
			if (
				record.claims.length >= PREVIEW_LIMITS.concurrency ||
				record.claims.filter((entry) => entry.project_id === pid).length >=
					PREVIEW_LIMITS.concurrencyPerProject
			)
				return;
			const claim = {
				project_id: pid,
				preview_id: id,
				token: crypto.randomUUID(),
				expires_at: Date.now() + PREVIEW_LIMITS.attemptMs,
			};
			record.claims.push(claim);
			return claim;
		});
	}

	async release(token: string) {
		await this.change(previewWorkKey, PreviewWorkSchema, { claims: [] }, (record) => {
			record.claims = record.claims.filter((entry) => entry.token !== token);
		});
	}
}

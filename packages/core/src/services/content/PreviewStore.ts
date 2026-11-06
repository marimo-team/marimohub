import { utcTimestamp } from '../../stringFormats';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, PreviewId, ProjectId } from '../../ids';
import { createPreviewId } from '../../ids';
import { ConflictError, NotFoundError, ResourceExhaustedError } from '../../errors';
import { readStored, ProjectIdSchema, NotebookIdSchema } from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import { PreviewRecordSchema, PreviewIdSchema } from './notebookPreviews';
import type { NotebookPreview } from './notebookPreviews';
import {
	PreviewAutomationGroupSchema,
	applyPreviewEvent,
	automationExpiresAt,
	retireAutomationGroup,
} from './previewAutomation';
import type { PreviewReconcile } from './previewAutomation';

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
	defaultExpiryMs: 7 * 86_400_000,
	cleanupGraceMs: 900_000,
	admissionMs: 600_000,
} as const;
const Epoch = z.number().describe('Milliseconds since the Unix epoch.');
export const PreviewProjectSchema = z.object({
	automations: z.array(PreviewAutomationGroupSchema).optional(),
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
			created_at: utcTimestamp(),
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
export const previewProjectPrefix = paths.previewProjectsPrefix;
export const previewProjectKey = paths.previewProject;
export const previewActiveProjectPrefix = paths.previewActiveProjectsPrefix;
export const previewActiveProjectKey = paths.previewActiveProject;
export const PreviewActiveProjectSchema = z.object({
	project_id: ProjectIdSchema,
	work_id: z.string(),
});
export const previewReceiptsKey = paths.previewReceipts;
export const previewWorkKey = paths.previewWork;
export const previewCleanupCursorKey = paths.previewCleanupCursor;
export const PreviewCursorSchema = z.object({ cursor: z.string().optional() });

type PreviewProject = z.infer<typeof PreviewProjectSchema>;
type PreviewReceipts = z.infer<typeof PreviewReceiptsSchema>;

function admitMovedEntries(
	project: PreviewProject,
	entries: PreviewProject['entries'],
	destination: ProjectId,
	nid: NotebookId,
): void {
	for (const entry of entries) {
		const existing = project.entries.find((current) => current.intent.id === entry.intent.id);
		if (existing) {
			if (existing.intent.notebook_id !== nid)
				throw new ConflictError('Destination already contains this preview');
			continue;
		}
		if (project.entries.length >= PREVIEW_LIMITS.perProject)
			throw new ResourceExhaustedError('Destination preview limit reached');
		project.entries.push({ ...entry, intent: { ...entry.intent, project_id: destination } });
	}
	const bytes = project.entries
		.flatMap((entry) => entry.artifacts)
		.reduce((sum, item) => sum + item.bytes, 0);
	if (bytes > PREVIEW_LIMITS.bytesPerProject)
		throw new ResourceExhaustedError('Destination preview storage limit reached');
}

function admitMovedReceipts(record: PreviewReceipts, receipts: PreviewReceipts['entries']): void {
	record.entries = record.entries.filter((entry) => entry.expires_at > Date.now());
	for (const receipt of receipts) {
		const existing = record.entries.find((entry) => entry.key === receipt.key);
		if (existing && (existing.id !== receipt.id || existing.fingerprint !== receipt.fingerprint))
			throw new ConflictError('Destination already contains this preview request');
		record.entries = record.entries.filter((entry) => entry.key !== receipt.key);
		record.entries.push(receipt);
	}
	if (record.entries.length > PREVIEW_LIMITS.receiptsPerProject)
		throw new ResourceExhaustedError('Destination preview request limit reached');
}

function hasWork(project: PreviewProject): boolean {
	return (
		project.entries.length > 0 || !!project.automations?.some((group) => group.state === 'active')
	);
}

export class PreviewStore {
	private async movedRecords(source: ProjectId, nid: NotebookId) {
		const project = await this.project(source);
		const entries = project.entries.filter((entry) => entry.intent.notebook_id === nid);
		const groups = project.automations?.filter((group) => group.notebook_id === nid) ?? [];
		const receiptObject = await this.bucket.get(previewReceiptsKey(source));
		const ids = new Set(entries.map((entry) => entry.intent.id));
		const receipts = receiptObject
			? (await readStored(PreviewReceiptsSchema, receiptObject, receiptObject.key)).entries.filter(
					(entry) => ids.has(entry.id) && entry.expires_at > Date.now(),
				)
			: null;
		return { entries, receipts, groups };
	}

	/**
	 * Runs the destination admission checks of `copyForMove` without writing, so a move can
	 * refuse before it fences the source.
	 */
	async assertMoveCapacity(source: ProjectId, destination: ProjectId, nid: NotebookId) {
		const { entries, receipts } = await this.movedRecords(source, nid);
		admitMovedEntries(await this.project(destination), entries, destination, nid);
		if (!receipts) return;
		const object = await this.bucket.get(previewReceiptsKey(destination));
		admitMovedReceipts(
			object ? await readStored(PreviewReceiptsSchema, object, object.key) : { entries: [] },
			receipts,
		);
	}

	async copyForMove(source: ProjectId, destination: ProjectId, nid: NotebookId): Promise<void> {
		const { entries, receipts, groups } = await this.movedRecords(source, nid);
		await this.changeProject(
			destination,
			(project) => {
				for (const group of groups) {
					project.automations ??= [];
					if (!project.automations.some((item) => item.key === group.key))
						project.automations.push({
							...group,
							heads: group.heads.map((head) => ({
								...head,
								intent: { ...head.intent, project_id: destination },
							})),
						});
				}
				admitMovedEntries(project, entries, destination, nid);
			},
			{ fence: true },
		);
		if (receipts)
			await this.change(
				previewReceiptsKey(destination),
				PreviewReceiptsSchema,
				{ entries: [] },
				(record) => admitMovedReceipts(record, receipts),
			);
	}

	async finishMove(source: ProjectId, nid: NotebookId): Promise<void> {
		const ids = (await this.project(source)).entries
			.filter((entry) => entry.intent.notebook_id === nid)
			.map((entry) => entry.intent.id);
		for (const id of ids) await this.pruneReceipts(source, id);
		const workId = await this.changeProject(
			source,
			(project) => {
				project.entries = project.entries.filter((entry) => entry.intent.notebook_id !== nid);
				project.automations = project.automations?.filter((group) => group.notebook_id !== nid);
				return !hasWork(project) ? project.work_id : undefined;
			},
			{ fence: true },
		);
		if (workId) await this.removeInactiveWork(source, workId);
	}

	async reconcileAutomation(
		intent: NotebookPreview,
		input: PreviewReconcile,
		branch: string,
		branchHash: string,
	) {
		return this.changeProject(intent.project_id, (project) => {
			const groups = (project.automations ??= []);
			const index = groups.findIndex((group) => group.key === intent.automation!.key);
			if (index === -1 && groups.length >= 1000)
				throw new ResourceExhaustedError('Project preview automation limit reached');
			const group = applyPreviewEvent(groups[index], input, intent, branch, branchHash);
			if (index === -1) groups.push(group);
			else groups[index] = group;
			return group;
		});
	}

	async closeAutomation(pid: ProjectId, key: string, revision: number) {
		await this.changeProject(pid, (project) => {
			const group = project.automations?.find((item) => item.key === key);
			if (!group || group.revision !== revision || group.state !== 'active') return;
			retireAutomationGroup(group, 'closed');
		});
	}

	async checkedAutomation(pid: ProjectId, key: string, revision: number) {
		await this.changeProject(pid, (project) => {
			const group = project.automations?.find((item) => item.key === key);
			if (group?.revision === revision) group.checked_at = Date.now();
		});
	}

	async retireAutomationPreview(record: NotebookPreview) {
		if (!record.automation) return;
		await this.changeProject(record.project_id, (project) => {
			const group = project.automations?.find((item) => item.key === record.automation!.key);
			const head = group?.heads.find((item) => item.intent.id === record.id);
			if (!group || !head) return;
			group.floor = Math.max(group.floor, head.order);
			group.heads = group.heads.filter((item) => item !== head);
			group.revision++;
		});
	}

	async planAutomations(pid: ProjectId) {
		await this.changeProject(pid, (project) => {
			for (const group of project.automations ?? []) {
				const expiry = automationExpiresAt(group);
				if (group.state === 'active' && expiry && Date.parse(expiry) <= Date.now())
					retireAutomationGroup(group, 'expired');
				for (const entry of project.entries) {
					if (entry.intent.automation?.key !== group.key) continue;
					const head = group.heads.find((item) => item.intent.id === entry.intent.id);
					if (!head || group.state !== 'active') {
						if (entry.intent.state === 'active')
							entry.intent = {
								...entry.intent,
								state: 'deleting',
								automation: { ...entry.intent.automation, revision: group.revision },
							};
					} else if (entry.intent.state === 'active') entry.intent = head.intent;
				}
				if (group.state !== 'active') continue;
				for (const head of group.heads) {
					if (project.entries.some((entry) => entry.intent.id === head.intent.id)) continue;
					if (project.entries.length >= PREVIEW_LIMITS.perProject) break;
					project.entries.push({ intent: head.intent, artifacts: [] });
				}
			}
		});
	}

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
			const before = JSON.stringify(value);
			const result = await apply(value);
			const serialized = JSON.stringify(value);
			if (serialized === before) return result;
			await cas.put(
				key,
				serialized,
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return result;
		});
	}

	private changeProject<R>(
		pid: ProjectId,
		apply: (project: z.infer<typeof PreviewProjectSchema>) => R,
		{ fence = false } = {},
	) {
		return this.change(
			previewProjectKey(pid),
			PreviewProjectSchema,
			{ entries: [] },
			async (project) => {
				const wasEmpty = !hasWork(project);
				const before = JSON.stringify(project);
				const result = apply(project);
				if (!fence && JSON.stringify(project) === before && (!hasWork(project) || project.work_id))
					return result;
				// A fresh revision also fences writers when membership returns to the same empty value.
				project.revision = crypto.randomUUID();
				if (hasWork(project) && (wasEmpty || !project.work_id)) {
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
			(project) => !hasWork(project) || project.work_id !== workId,
			{ fence: true },
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
					id: createPreviewId(),
					created_at: new Date().toISOString(),
					expires_at: Date.now() + PREVIEW_LIMITS.idempotencyMs,
					deleted: false,
				};
				record.entries.push(entry);
				return entry;
			},
		);
	}

	async pruneReceipts(pid: ProjectId, deletedId?: PreviewId) {
		await this.change(previewReceiptsKey(pid), PreviewReceiptsSchema, { entries: [] }, (record) => {
			record.entries = record.entries.filter((entry) => entry.expires_at > Date.now());
			for (const entry of record.entries) if (entry.id === deletedId) entry.deleted = true;
		});
	}

	async reserve(
		intent: NotebookPreview,
		creationDeadline = Date.now() + PREVIEW_LIMITS.creationMs,
	): Promise<NotebookPreview> {
		return this.changeProject(
			intent.project_id,
			(record) => {
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
			},
			// An idempotent replay must still serialize with cleanup before the record is materialized.
			{ fence: true },
		);
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
			return !hasWork(project) ? project.work_id : undefined;
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
					if (hasWork(project) && project.work_id === workId) projects.push(projectId);
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
		const advance = async (record: { cursor?: string }) => {
			const page = await this.projectPage(record.cursor);
			record.cursor = page.cursor;
			return page.projects;
		};
		return lane === 'prepare'
			? this.change(previewWorkKey, PreviewWorkSchema, { claims: [] }, advance)
			: this.change(previewCleanupCursorKey, PreviewCursorSchema, {}, advance);
	}

	async claim(pid: ProjectId, id: PreviewId) {
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

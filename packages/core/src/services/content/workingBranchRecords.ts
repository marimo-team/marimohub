import {
	PublicationActorSchema,
	SignedPreparationSchema,
	CommitVerificationSchema,
} from '../../sourceControlPublication';
import { utcTimestamp } from '../../stringFormats';
import { logOperationalError } from '../../operationalLog';
import { listAllPrefixes } from '../catalog/storage';
import { NotebookId as NotebookIdValue } from '../../ids';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { ConflictError, NotFoundError } from '../../errors';
import {
	GitSourceConfigSchema,
	NotebookIdSchema,
	ProjectIdSchema,
	SessionIdSchema,
	UserIdSchema,
	VersionIdSchema,
	ProposalChangeSchema,
	readStored,
} from '../../schema';
import type { NotebookId, ProjectId } from '../../ids';
import { putIfAbsent, withCasRetry } from '../catalog/cas';

export const WORKING_BRANCH_RETENTION_MS = 24 * 60 * 60 * 1000;
// Well above any provider HTTP timeout: a `beforeOid`-fenced ref update still in flight after this
// window can no longer land, so an unconfirmed dispatch may be finished as a conflict.
export const WORKING_BRANCH_DISPATCH_BOUND_MS = 15 * 60 * 1000;
export const WorkingBranchCreationSchema = z.object({
	publication_actor: PublicationActorSchema.optional(),
	fingerprint: z.string(),
	notebook_id: NotebookIdSchema,
	id: z.string(),
	fork_commit: z.string(),
	source: GitSourceConfigSchema,
});
export const WorkingBranchCaptureSchema = z.array(
	z.intersection(ProposalChangeSchema, z.object({ content: z.string().optional() })),
);
export const WorkingBranchCleanupSchema = z.object({ cursor: z.string().optional() });
export const WORKING_BRANCH_CLEANUP_KEY = '_system/working-branches/cleanup.json';
export const WorkingBranchChangeRequestSchema = z.object({
	number: z.number().int().positive(),
	url: z.url(),
	state: z.enum(['open', 'closed', 'merged']),
	head_branch: z.string(),
	base_branch: z.string(),
});
export type WorkingBranchChangeRequest = z.infer<typeof WorkingBranchChangeRequestSchema>;
export const WorkingBranchRecordSchema = z.object({
	publication_actor: PublicationActorSchema.optional(),
	change_request_actor: PublicationActorSchema.optional(),
	schema_version: z.literal(1),
	id: z.string().regex(/^[a-f0-9]{64}$/),
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
	provider: z.string(),
	source: GitSourceConfigSchema,
	base_branch: z.string(),
	fork_commit: z.string(),
	created_by: UserIdSchema,
	created_at: utcTimestamp(),
	state: z.enum(['claimed', 'branch_dispatched', 'branch_created', 'ready', 'deleted']),
	active_save: z.string().optional(),
	last_save: z.string().optional(),
	change_request: WorkingBranchChangeRequestSchema.optional(),
	ended_reason: z.enum(['branch_deleted', 'pr_closed', 'pr_merged', 'pr_retargeted']).optional(),
	checked_at: utcTimestamp().optional(),
	remote_commit: z.string().nullable().optional(),
	lease: z.object({ owner: z.string(), until: z.number() }).optional(),
});
export type WorkingBranchRecord = z.infer<typeof WorkingBranchRecordSchema>;
export const WorkingBranchSaveSchema = z.object({
	verification: CommitVerificationSchema.optional(),
	publication_actor: PublicationActorSchema.optional(),
	signed_preparation: SignedPreparationSchema.optional(),
	schema_version: z.literal(1),
	id: z.string().regex(/^[a-f0-9]{64}$/),
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
	session_id: SessionIdSchema,
	author: UserIdSchema,
	fingerprint: z.string(),
	message: z.string(),
	co_author: z.object({ name: z.string(), email: z.string() }).optional(),
	created_at: utcTimestamp(),
	expires_at: utcTimestamp(),
	base_version_id: VersionIdSchema,
	base_commit: z.string(),
	state: z.enum([
		'claimed',
		'captured',
		'commit_prepared',
		'ref_dispatched',
		'remote_committed',
		'hub_synced',
		'complete',
		'no_changes',
		'conflict',
		'expired',
	]),
	changes: z.array(ProposalChangeSchema).default([]),
	commit: z.string().optional(),
	dispatched_at: utcTimestamp().optional(),
	version_id: VersionIdSchema.optional(),
	error: z.string().optional(),
});
export type WorkingBranchSave = z.infer<typeof WorkingBranchSaveSchema>;
export type WorkingBranchLease = (() => Promise<void>) & { owner: string };
type WorkingBranchUpdate = (
	apply: (record: WorkingBranchRecord) => WorkingBranchRecord,
) => Promise<WorkingBranchRecord>;

export function workingBranchPaths(pid: ProjectId, nid: NotebookId) {
	const base = `_system/working-branches/notebooks/${pid}/${nid}/`;
	return {
		base,
		head: `${base}head.json`,
		saves: `${base}saves/`,
		save: (id: string) => `${base}saves/${id}/receipt.json`,
		capture: (id: string) => `${base}saves/${id}/capture.json`,
	};
}

export class WorkingBranchStore {
	constructor(readonly bucket: Bucket) {}
	async read(pid: ProjectId, nid: NotebookId): Promise<WorkingBranchRecord> {
		const key = workingBranchPaths(pid, nid).head;
		const object = await this.bucket.get(key);
		if (!object) throw new NotFoundError('Working branch not found');
		return readStored(WorkingBranchRecordSchema, object, key);
	}
	async create(record: WorkingBranchRecord): Promise<WorkingBranchRecord> {
		const key = workingBranchPaths(record.project_id, record.notebook_id).head;
		await putIfAbsent(this.bucket, key, JSON.stringify(record));
		const stored = await this.read(record.project_id, record.notebook_id);
		if (stored.id !== record.id)
			throw new ConflictError('Working branch belongs to another operation');
		return stored;
	}
	async update(
		pid: ProjectId,
		nid: NotebookId,
		apply: (record: WorkingBranchRecord) => WorkingBranchRecord,
		owner?: string,
	): Promise<WorkingBranchRecord> {
		const key = workingBranchPaths(pid, nid).head;
		return withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			if (!object) throw new NotFoundError('Working branch not found');
			const current = await readStored(WorkingBranchRecordSchema, object, key);
			if (owner && (current.state === 'deleted' || current.lease?.owner !== owner))
				throw new ConflictError('Working branch operation lost its claim');
			const next = apply(current);
			await cas.put(key, JSON.stringify(next), { onlyIfEtagMatches: object.etag });
			return next;
		});
	}
	async retire(pid: ProjectId, nid: NotebookId): Promise<void> {
		if (!(await this.bucket.head(workingBranchPaths(pid, nid).head))) return;
		await this.update(pid, nid, (record) => ({ ...record, state: 'deleted' }));
	}
	async retireProject(pid: ProjectId): Promise<void> {
		const prefix = `_system/working-branches/notebooks/${pid}/`;
		for (const key of await listAllPrefixes(this.bucket, prefix)) {
			const nid = key.slice(prefix.length, -1);
			if (NotebookIdValue.is(nid)) await this.retire(pid, nid);
		}
	}

	async assertSyncAllowed(
		pid: ProjectId,
		nid: NotebookId,
		operation?: string,
		creation?: string,
	): Promise<void> {
		const record = await this.read(pid, nid);
		if (record.state === 'deleted') throw new ConflictError('Working notebook was deleted');
		if (record.state !== 'ready' && record.id !== creation)
			throw new ConflictError('Working notebook creation needs completion');
		if (record.active_save && record.active_save !== operation) {
			throw new ConflictError('Complete the pending working branch save before syncing');
		}
	}
	async withLease<T>(
		pid: ProjectId,
		nid: NotebookId,
		run: (
			check: WorkingBranchLease,
			update: WorkingBranchUpdate,
			leased: WorkingBranchRecord,
		) => Promise<T>,
	): Promise<T> {
		const owner = crypto.randomUUID();
		const leased = await this.update(pid, nid, (record) => {
			if (record.state === 'deleted') throw new ConflictError('Working notebook was deleted');
			if (record.lease && record.lease.until > Date.now())
				throw new ConflictError('Working branch operation is in progress; retry shortly');
			return { ...record, lease: { owner, until: Date.now() + 120_000 } };
		});
		const update: WorkingBranchUpdate = (apply) => this.update(pid, nid, apply, owner);
		const check = async () => {
			await update((record) => ({ ...record, lease: { owner, until: Date.now() + 120_000 } }));
		};
		try {
			return await run(Object.assign(check, { owner }), update, leased);
		} finally {
			await this.update(pid, nid, (record) =>
				record.lease?.owner === owner ? { ...record, lease: undefined } : record,
			).catch((error) => {
				logOperationalError(
					'working_branch.lease_release_failed',
					{ project_id: pid, notebook_id: nid },
					error,
				);
			});
		}
	}
}

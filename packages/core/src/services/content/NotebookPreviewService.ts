import { withAbortSignal } from '../../async';
import { logOperationalError } from '../../operationalLog';
import type { Bucket } from '../../ports/bucket';
import type { SourceControlReader, SourceControlRegistry } from '../../ports/sourceControl';
import type { NotebookId, ProjectId, SessionId, UserId } from '../../ids';
import { MAX_WORKSPACE_BYTES } from '../../constants';
import { PreviewStore, PREVIEW_LIMITS } from './PreviewStore';
import { createNotebookId, createVersionId } from '../../ids';
import {
	BadRequestError,
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
} from '../../errors';
import { paths } from '../../paths';
import { sha256Hex } from '../../internal/sha256';
import { parseStored, readStored } from '../../schema';
import type { GitSource } from '../../schema';
import { mutateObject } from '../catalog/cas';
import { deleteByPrefix } from '../catalog/storage';
import { AppPoolStore } from '../runtime/AppPoolStore';
import type { NotebookService } from './NotebookService';
import { buildVersion } from './notebookMeta';
import { toSyncedWorkspaceFileMap } from '../../integrations/remoteWorkspace';
import {
	PREVIEW_MAX_AGE_MS,
	PREVIEW_POLL_MS,
	PreviewRecordSchema,
	previewKey,
} from './notebookPreviews';
import type { NotebookPreview, PreviewCreate } from './notebookPreviews';

type RetireRuntime = (pid: ProjectId, nid: NotebookId) => Promise<boolean>;

export class NotebookPreviewService {
	readonly store: PreviewStore;
	constructor(
		private bucket: Bucket,
		private notebooks: NotebookService,
	) {
		this.store = new PreviewStore(bucket);
	}

	async get(pid: ProjectId, nid: NotebookId, id: string): Promise<NotebookPreview> {
		if (
			!(await this.store.project(pid)).entries.some(
				(entry) =>
					entry.intent.id === id &&
					entry.intent.notebook_id === nid &&
					entry.intent.state !== 'deleted',
			)
		)
			throw new NotFoundError('Preview not found');
		const key = previewKey(pid, nid, id);
		const object = await this.bucket.get(key);
		if (!object) throw new NotFoundError('Preview not found');
		return readStored(PreviewRecordSchema, object, key);
	}

	private async materialize(intent: NotebookPreview): Promise<NotebookPreview> {
		if (intent.state === 'deleted') return intent;
		const key = previewKey(intent.project_id, intent.notebook_id, intent.id);
		if (!(await this.bucket.head(key))) {
			try {
				await this.bucket.put(key, JSON.stringify(intent), { onlyIfNotExists: true });
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
		}
		return this.get(intent.project_id, intent.notebook_id, intent.id);
	}

	async projectRecords(pid: ProjectId, nid?: NotebookId): Promise<NotebookPreview[]> {
		const entries = (await this.store.project(pid)).entries.filter(
			(entry) => !nid || entry.intent.notebook_id === nid,
		);
		const records: NotebookPreview[] = [];
		for (const entry of entries) records.push(await this.materialize(entry.intent));
		return records;
	}

	async list(pid: ProjectId, nid: NotebookId): Promise<NotebookPreview[]> {
		return (await this.projectRecords(pid, nid))
			.filter((record) => record.state === 'active' && Date.parse(record.expires_at) > Date.now())
			.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
	}

	async source(
		pid: ProjectId,
		nid: NotebookId,
		registry?: SourceControlRegistry,
	): Promise<{ source: GitSource; reader: SourceControlReader }> {
		const notebook = await this.notebooks.getNotebook(pid, nid);
		const source = notebook.source;
		if (notebook.meta.status === 'deleted') throw new NotFoundError('Notebook not found');
		if (notebook.meta.preview || source.type !== 'git')
			throw new BadRequestError('Previews require a GitHub-connected notebook');
		const reader = registry?.getReader('github', pid);
		if (!reader?.previews || !reader.resolveCommit || !reader.supportsRepository(source.repo))
			throw new BadRequestError('Previews require a GitHub App connection');
		return { source, reader };
	}

	private mutate(
		record: Pick<NotebookPreview, 'project_id' | 'notebook_id' | 'id'>,
		update: (record: NotebookPreview) => NotebookPreview | null,
	) {
		const key = previewKey(record.project_id, record.notebook_id, record.id);
		return mutateObject(
			this.bucket,
			key,
			(raw) => parseStored(PreviewRecordSchema, raw, key),
			update,
		);
	}

	private mutateLeased(
		record: NotebookPreview,
		token: string,
		update: (record: NotebookPreview) => NotebookPreview,
	) {
		return this.mutate(record, (current) =>
			current.state === 'active' &&
			current.lease?.token === token &&
			current.lease.expires_at > Date.now()
				? update(current)
				: null,
		);
	}

	async create(
		pid: ProjectId,
		nid: NotebookId,
		input: PreviewCreate,
		actor: UserId,
		registry?: SourceControlRegistry,
		idempotencyKey?: string,
	): Promise<NotebookPreview> {
		const { source } = await this.source(pid, nid, registry);
		const now = Date.now();
		const expires = input.expires_at ? Date.parse(input.expires_at) : now + 7 * 24 * 60 * 60_000;
		if (expires <= now || expires > now + PREVIEW_MAX_AGE_MS)
			throw new BadRequestError('Preview expiry must be within the next 30 days');
		const fingerprint = JSON.stringify(input);
		const receipt = idempotencyKey
			? await this.store.receipt(
					pid,
					await sha256Hex(JSON.stringify([nid, actor, idempotencyKey])),
					fingerprint,
				)
			: undefined;
		const id = receipt?.id ?? crypto.randomUUID().replaceAll('-', '');
		const record: NotebookPreview = {
			schema_version: 1,
			id,
			project_id: pid,
			notebook_id: nid,
			...input,
			repository: source.repo,
			root_path: source.root_path,
			entry_notebook: source.entry_notebook,
			expires_at: new Date(expires).toISOString(),
			created_by: actor,
			created_at: receipt?.created_at ?? new Date(now).toISOString(),
			request_fingerprint: fingerprint,
			state: 'active',
			preparation: 'pending',
			preparation_failures: 0,
			revisions: [],
			admissions: [],
		};
		const intent = await this.store.reserve(record, now + PREVIEW_LIMITS.creationMs);
		const saved = await this.materialize(intent);
		if (saved.state !== 'active') throw new ConflictError('This preview has been deleted');
		return saved;
	}

	async prepare(
		record: NotebookPreview,
		registry?: SourceControlRegistry,
		force = false,
		externalSignal?: AbortSignal,
	): Promise<NotebookPreview> {
		externalSignal?.throwIfAborted();
		if (record.state !== 'active') return record;
		if (Date.parse(record.expires_at) <= Date.now()) return this.retire(record);
		if (
			!force &&
			((record.next_attempt_at ?? 0) > Date.now() ||
				(record.source.type === 'commit' && record.current && !record.pull_request))
		)
			return record;
		const claim = await this.store.claim(record.project_id, record.id);
		if (!claim) return record;
		const token = claim.token;
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			...(externalSignal ? [externalSignal] : []),
		]);
		const timeout = setTimeout(
			() => controller.abort(new Error('Preview preparation deadline exceeded')),
			Math.max(0, claim.expires_at - Date.now() - 1000),
		);
		try {
			return await this.prepareClaimed(record, registry, claim, signal, externalSignal);
		} finally {
			clearTimeout(timeout);
			await this.store.release(token);
		}
	}

	private async prepareClaimed(
		record: NotebookPreview,
		registry: SourceControlRegistry | undefined,
		claim: { token: string; expires_at: number },
		signal: AbortSignal,
		externalSignal?: AbortSignal,
	): Promise<NotebookPreview> {
		const token = claim.token;
		const checkpoint = () => {
			signal.throwIfAborted();
			if (Date.now() >= claim.expires_at) throw new Error('Preview preparation lease expired');
		};
		// Stop waiting on unresponsive I/O; checkpoints fence its eventual completion.
		const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
			checkpoint();
			const result = await withAbortSignal(operation(), signal);
			checkpoint();
			return result;
		};
		const claimed = await this.mutate(record, (current) => {
			if (current.state !== 'active' || (current.lease && current.lease.expires_at > Date.now()))
				return null;
			return {
				...current,
				preparation: 'preparing',
				lease: { token, expires_at: claim.expires_at },
			};
		});
		if (claimed.lease?.token !== token) return claimed;
		try {
			const { source, reader } = await bounded(() =>
				this.source(record.project_id, record.notebook_id, registry),
			);
			if (
				source.repo !== record.repository ||
				source.root_path !== record.root_path ||
				source.entry_notebook !== record.entry_notebook
			)
				throw new ConflictError('Notebook source configuration changed');
			if (record.pull_request) {
				if (!reader.getPullRequest)
					throw new BadRequestError('Pull request tracking is unavailable');
				const pr = await bounded(() =>
					reader.getPullRequest!(record.repository, record.pull_request!, { signal }),
				);
				if (!pr.sameRepository) throw new BadRequestError('Fork previews are not supported');
				if (pr.state === 'closed') return await this.retire(record);
				if (record.source.type === 'branch' && record.source.branch !== pr.branch)
					throw new ConflictError('Preview branch does not match the pull request');
			}
			const ref = record.source;
			const commit =
				ref.type === 'commit' && claimed.current
					? claimed.current.commit
					: ref.type === 'branch'
						? (
								await bounded(() =>
									reader.getBranchHead(record.repository, ref.branch, {
										signal,
									}),
								)
							).commit
						: (
								await bounded(() =>
									reader.resolveCommit!(record.repository, ref.commit, { signal }),
								)
							).commit;
			if (claimed.current?.commit === commit)
				return await this.mutateLeased(record, token, (current) => ({
					...current,
					preparation: 'ready',
					lease: undefined,
					error: undefined,
					checked_at: new Date().toISOString(),
					next_attempt_at: Date.now() + PREVIEW_POLL_MS,
					preparation_failures: 0,
				}));
			checkpoint();
			const runtimeId = createNotebookId();
			const reserved = await this.mutateLeased(record, token, (current) => ({
				...current,
				revisions: [
					...current.revisions,
					{
						notebook_id: runtimeId,
						state: 'preparing',
						cleanup_after: Date.now() + 900_000,
					},
				],
			}));
			if (reserved.state !== 'active' || reserved.lease?.token !== token) return reserved;
			try {
				await this.store.reserveArtifact(record, runtimeId, MAX_WORKSPACE_BYTES, claim.expires_at);
			} catch (error) {
				await this.mutateLeased(record, token, (current) => ({
					...current,
					revisions: current.revisions.filter((revision) => revision.notebook_id !== runtimeId),
				}));
				throw error;
			}
			checkpoint();
			const files = toSyncedWorkspaceFileMap(
				await bounded(() =>
					reader.fetchWorkspace(record.repository, commit, record.root_path, { signal }),
				),
			);
			if (!files.has(record.entry_notebook))
				throw new BadRequestError('The preview revision does not contain the configured notebook');
			checkpoint();
			const beforeWrite = await this.get(record.project_id, record.notebook_id, record.id);
			if (beforeWrite.state !== 'active' || beforeWrite.lease?.token !== token) return beforeWrite;
			const versionId = createVersionId();
			const nb = paths.project(record.project_id).notebook(runtimeId);
			const version = nb.version(versionId);
			const parent = await bounded(() =>
				this.notebooks.getNotebook(record.project_id, record.notebook_id),
			);
			const now = new Date().toISOString();
			await bounded(() =>
				this.bucket.put(
					nb.previewMeta,
					JSON.stringify({
						...parent.meta,
						id: runtimeId,
						preview: { notebook_id: record.notebook_id, preview_id: record.id },
						compute_profile: record.compute_profile,
						created_at: now,
						updated_at: now,
					}),
					{ onlyIfNotExists: true },
				),
			);
			for (const [path, bytes] of files) {
				await bounded(() =>
					this.bucket.put(version.workspaceFile(path), bytes, { onlyIfNotExists: true }),
				);
			}
			await bounded(() =>
				this.bucket.put(
					version.meta,
					JSON.stringify(
						buildVersion({
							versionId,
							notebookId: runtimeId,
							now,
							author: record.created_by,
							message: `Preview ${commit}`,
							parentId: null,
							commit,
						}),
					),
					{ onlyIfNotExists: true },
				),
			);
			await bounded(() =>
				this.bucket.put(
					nb.source,
					JSON.stringify({
						...source,
						pending_config: undefined,
						sync_mode: 'push',
						branch: record.source.type === 'branch' ? record.source.branch : source.branch,
						commit,
						current_version_id: versionId,
						last_synced_at: now,
					}),
					{ onlyIfNotExists: true },
				),
			);
			checkpoint();
			await this.store.commitArtifactBytes(
				record,
				runtimeId,
				[...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
			);
			checkpoint();
			const published = await this.mutateLeased(record, token, (current) => ({
				...current,
				current: { notebook_id: runtimeId, version_id: versionId, commit },
				revisions: current.revisions.map((revision) =>
					revision.notebook_id === runtimeId ? { ...revision, state: 'ready' } : revision,
				),
				preparation: 'ready',
				error: undefined,
				lease: undefined,
				checked_at: now,
				next_attempt_at: Date.now() + PREVIEW_POLL_MS,
				preparation_failures: 0,
			}));
			// Unpublished artifacts remain owned until the cleanup pass reclaims them.
			return published;
		} catch (error) {
			if (externalSignal?.aborted) {
				return this.mutateLeased(record, token, (current) => ({
					...current,
					preparation: current.current ? 'ready' : 'pending',
					error: undefined,
					lease: undefined,
				}));
			}
			if (error instanceof NotFoundError) {
				const parent = await this.notebooks
					.getNotebookMeta(record.project_id, record.notebook_id)
					.catch((failure) => {
						if (failure instanceof NotFoundError) return null;
						throw failure;
					});
				if (!parent || parent.status === 'deleted') return this.retire(record);
			}
			return this.mutateLeased(record, token, (current) => ({
				...current,
				preparation: 'failed',
				error: 'Unable to prepare the preview. Check the source and GitHub App access.',
				lease: undefined,
				checked_at: new Date().toISOString(),
				preparation_failures: current.preparation_failures + 1,
				next_attempt_at:
					Date.now() +
					Math.min(3_600_000, PREVIEW_POLL_MS * 2 ** Math.min(current.preparation_failures, 6)) *
						(0.75 + Math.random() * 0.5),
			}));
		}
	}

	async reapAdmissions(
		record: NotebookPreview,
		isRetained: (id: SessionId) => Promise<boolean | undefined>,
	): Promise<NotebookPreview> {
		const removable = new Set<SessionId>();
		for (const entry of record.admissions) {
			const retained = await isRetained(entry.session_id);
			// Committed sessions disappear only after reclamation; pending starts may not exist yet.
			if (
				retained === false ||
				(retained === undefined && (entry.committed || entry.expires_at <= Date.now()))
			)
				removable.add(entry.session_id);
		}
		if (removable.size === 0) return record;
		// A session committed after the scan must retain its reservation.
		return this.mutate(record, (current) => ({
			...current,
			admissions: current.admissions.filter(
				(entry) =>
					!removable.has(entry.session_id) ||
					entry.committed !==
						record.admissions.find((old) => old.session_id === entry.session_id)?.committed,
			),
		}));
	}

	// Admission and pruning CAS the same record, before any session or sandbox is created.
	async reserveAdmission(
		record: NotebookPreview,
		nid: NotebookId,
		sid: SessionId,
		limit: number,
	): Promise<void> {
		await this.mutate(record, (current) => {
			if (
				current.state !== 'active' ||
				Date.parse(current.expires_at) <= Date.now() ||
				!current.revisions.some(
					(revision) => revision.notebook_id === nid && revision.state === 'ready',
				)
			)
				throw new NotFoundError('Preview not found');
			if (current.admissions.some((entry) => entry.session_id === sid)) return null;
			if (current.admissions.length >= limit)
				throw new ResourceExhaustedError('Preview session limit reached');
			return {
				...current,
				admissions: [
					...current.admissions,
					{
						session_id: sid,
						notebook_id: nid,
						expires_at: Date.now() + 600_000,
						committed: false,
					},
				],
			};
		});
	}

	async releaseAdmission(record: NotebookPreview, sid: SessionId): Promise<void> {
		await this.mutate(record, (current) => ({
			...current,
			admissions: current.admissions.filter((entry) => entry.session_id !== sid || entry.committed),
		}));
	}

	async commitAdmission(record: NotebookPreview, sid: SessionId): Promise<void> {
		await this.mutate(record, (current) => {
			if (
				current.state !== 'active' ||
				Date.parse(current.expires_at) <= Date.now() ||
				!current.admissions.some((entry) => entry.session_id === sid)
			)
				throw new NotFoundError('Preview not found');
			return {
				...current,
				admissions: current.admissions.map((entry) =>
					entry.session_id === sid ? { ...entry, committed: true } : entry,
				),
			};
		});
	}

	async retire(record: NotebookPreview): Promise<NotebookPreview> {
		const retired = await this.mutate(record, (current) =>
			current.state === 'active'
				? {
						...current,
						state: 'deleting',
						cleanup_after: Math.max(Date.now() + 900_000, current.lease?.expires_at ?? 0),
						lease: undefined,
					}
				: null,
		);
		await this.store.pruneReceipts(record.project_id, record.id);
		return retired;
	}

	private async cleanupRuntime(
		pid: ProjectId,
		nid: NotebookId,
		retireRuntime: RetireRuntime,
		cleanupAfter = 0,
	) {
		await new AppPoolStore(this.bucket).retireForDeletion(pid, nid);
		if (!(await retireRuntime(pid, nid))) return false;
		// Revocation stops new admissions immediately; in-flight uploads need time to settle.
		if (Date.now() >= cleanupAfter)
			await deleteByPrefix(this.bucket, paths.project(pid).notebook(nid).base);
		return true;
	}

	async cleanup(record: NotebookPreview, retireRuntime: RetireRuntime): Promise<void> {
		if (record.state === 'active') return;
		let complete = true;
		for (const { notebook_id: nid } of record.revisions) {
			if (
				!(await this.cleanupRuntime(
					record.project_id,
					nid,
					retireRuntime,
					record.cleanup_after ?? Infinity,
				))
			)
				complete = false;
			else if ((record.cleanup_after ?? Infinity) <= Date.now())
				await this.store.releaseArtifact(record, nid);
		}
		if (complete && record.state !== 'deleted')
			await this.mutate(record, (current) => ({ ...current, state: 'deleted' }));
		if (complete && (record.cleanup_after ?? Infinity) <= Date.now()) {
			await this.store.markCleaned(record);
			await this.bucket.delete(previewKey(record.project_id, record.notebook_id, record.id));
			await this.store.forget(record);
		}
	}

	async prune(
		initial: NotebookPreview,
		hasRuntime: (nid: NotebookId) => Promise<boolean>,
		retireRuntime: RetireRuntime,
	): Promise<void> {
		let record = initial;
		if (record.state !== 'active' || (record.lease && record.lease.expires_at > Date.now())) return;
		for (const revision of record.revisions) {
			const nid = revision.notebook_id;
			if (
				revision.state === 'retiring' ||
				nid === record.current?.notebook_id ||
				(revision.state === 'preparing' && Date.now() < revision.cleanup_after) ||
				record.admissions.some((entry) => entry.notebook_id === nid) ||
				(await hasRuntime(nid))
			)
				continue;
			record = await this.mutate(record, (current) =>
				current.state === 'active' &&
				(!current.lease || current.lease.expires_at <= Date.now()) &&
				nid !== current.current?.notebook_id &&
				current.revisions.some(
					(revision) => revision.notebook_id === nid && revision.state !== 'retiring',
				) &&
				!current.admissions.some((entry) => entry.notebook_id === nid)
					? {
							...current,
							revisions: current.revisions.map((revision) =>
								revision.notebook_id === nid ? { ...revision, state: 'retiring' } : revision,
							),
						}
					: null,
			);
		}
		for (const { notebook_id: nid, state } of record.revisions) {
			if (state !== 'retiring') continue;
			if (!(await this.cleanupRuntime(record.project_id, nid, retireRuntime))) continue;
			await this.store.releaseArtifact(record, nid);
			await this.mutate(record, (current) => ({
				...current,
				revisions: current.revisions.filter((revision) => revision.notebook_id !== nid),
			}));
		}
	}

	async cleanupCandidates(): Promise<NotebookPreview[]> {
		const records: NotebookPreview[] = [];
		for (const pid of await this.store.nextProjects('cleanup')) {
			try {
				await this.store.pruneReceipts(pid);
				records.push(...(await this.projectRecords(pid)));
			} catch (error) {
				logOperationalError('preview_cleanup_scan_failed', { project_id: pid }, error);
			}
		}
		return records;
	}

	async preparePending(registry: SourceControlRegistry, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return;
		const projects = await this.store.nextProjects('prepare');
		// One candidate per project prevents a busy repository from monopolizing workers.
		for (let offset = 0; offset < projects.length; offset += PREVIEW_LIMITS.concurrency) {
			if (signal?.aborted) return;
			await Promise.allSettled(
				projects.slice(offset, offset + PREVIEW_LIMITS.concurrency).map(async (pid) => {
					try {
						const records = (await this.projectRecords(pid)).filter(
							(record) =>
								record.state === 'active' &&
								(record.next_attempt_at ?? 0) <= Date.now() &&
								!(record.source.type === 'commit' && record.current && !record.pull_request),
						);
						records.sort(
							(a, b) =>
								(a.next_attempt_at ?? 0) - (b.next_attempt_at ?? 0) ||
								a.created_at.localeCompare(b.created_at),
						);
						if (records[0]) await this.prepare(records[0], registry, false, signal);
					} catch (error) {
						logOperationalError('preview_preparation_failed', { project_id: pid }, error);
					}
				}),
			);
		}
	}
}

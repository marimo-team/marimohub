import { repoHost, reposMatch } from '../../integrations/gitRepo';
import { copyMovePrefix, moveJson } from './moveObjects';
import { forEachConcurrentUntilFailure, withAbortSignal } from '../../async';
import type { PromiseMemo } from '../../cache';
import { logOperationalError } from '../../operationalLog';
import type { Bucket } from '../../ports/bucket';
import type { SourceControlReader, SourceControlRegistry } from '../../ports/sourceControl';
import type { NotebookId, PreviewId, ProjectId, SessionId, UserId } from '../../ids';
import {
	BUCKET_SCAN_CONCURRENCY,
	BUCKET_WRITE_CONCURRENCY,
	MAX_WORKSPACE_BYTES,
} from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { PreviewStore, PREVIEW_LIMITS } from './PreviewStore';
import type { PreviewProject } from './PreviewStore';
import { createNotebookId, createPreviewId, createVersionId } from '../../ids';
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
import type { KnownObject } from '../catalog/cas';
import { mutateObject, mutateObjectWithOutcome } from '../catalog/cas';
import { deleteByPrefix } from '../catalog/storage';
import { AppPoolStore } from '../runtime/AppPoolStore';
import type { NotebookService } from './NotebookService';
import { buildVersion } from './notebookMeta';
import { toSyncedWorkspaceFileMap } from '../../integrations/remoteWorkspace';
import {
	PREVIEW_MAX_AGE_MS,
	previewAvailable,
	previewExpired,
	PREVIEW_POLL_MS,
	PreviewRecordSchema,
	PreviewIntentSchema,
	initialPreviewRecord,
	previewGeneration,
	requestedPreviewGeneration,
	previewKey,
} from './notebookPreviews';
import type { NotebookPreview, PreviewCreate, PreviewIntent } from './notebookPreviews';
import type { PreviewAutomationGroup, PreviewReconcile } from './previewAutomation';

type RetireRuntime = (pid: ProjectId, nid: NotebookId) => Promise<boolean>;
const MAX_PREPARATION_FAILURES = 5;

function preparationDue(record: NotebookPreview, force = false): boolean {
	if (record.state !== 'active') return false;
	if (record.lease) return record.lease.expires_at <= Date.now();
	return (
		force ||
		(record.preparation_failures < MAX_PREPARATION_FAILURES &&
			(record.next_attempt_at ?? 0) <= Date.now() &&
			!(
				record.source.type === 'commit' &&
				record.current &&
				!record.pull_request &&
				record.preparation !== 'pending'
			))
	);
}

// A successful PR check is persisted at most this often, so polling does not rewrite the project head.
const AUTOMATION_CHECK_STAMP_MS = 3_600_000;
// Managed groups may have no expiry; this closes them once GitHub access has failed for a week.
const AUTOMATION_UNVERIFIED_MS = 7 * 86_400_000;

function retirePreviewRecord(current: NotebookPreview): NotebookPreview | null {
	return current.state === 'active'
		? {
				...current,
				state: 'deleting',
				cleanup_after: Math.max(
					Date.now() + PREVIEW_LIMITS.cleanupGraceMs,
					current.lease?.expires_at ?? 0,
				),
				lease: undefined,
			}
		: null;
}

function applyAutomationIntent(
	current: NotebookPreview,
	intent: PreviewIntent,
): NotebookPreview | null {
	if (!intent.automation) return null;
	if (current.state !== 'active') return null;
	if (intent.state !== 'active') return retirePreviewRecord(current);
	if ((current.automation?.revision ?? -1) >= intent.automation.revision) return null;
	const changed = previewGeneration(current) !== previewGeneration(intent);
	return {
		...current,
		name: intent.name,
		source: intent.source,
		eager: intent.eager,
		expires_at: intent.expires_at,
		automation: intent.automation,
		...(changed
			? {
					requested_generation: undefined,
					observed_commit: undefined,
					demand: undefined,
					requested_commit: undefined,
					lease: undefined,
					next_attempt_at: 0,
					preparation: intent.eager === false ? ('deferred' as const) : ('pending' as const),
					preparation_failures: 0,
					error: undefined,
				}
			: {}),
	};
}

export class NotebookPreviewService {
	readonly store: PreviewStore;
	// Maintenance runs on one replica, so a restart only repeats one check per group.
	private readonly automationChecks = new Map<ProjectId, Map<string, number>>();
	async finishMove(source: ProjectId, nid: NotebookId): Promise<void> {
		await this.store.finishMove(source, nid);
		await deleteByPrefix(this.bucket, paths.previewRecords(source, nid));
	}

	/** Runtime notebooks the source's preview membership reserves for `nid`. */
	async runtimesForMove(source: ProjectId, nid: NotebookId): Promise<NotebookId[]> {
		return (await this.store.project(source)).entries
			.filter((entry) => entry.intent.notebook_id === nid)
			.flatMap((entry) => entry.artifacts.map((artifact) => artifact.notebook_id));
	}

	async copyForMove(
		source: ProjectId,
		destination: ProjectId,
		nid: NotebookId,
		runtimes: readonly NotebookId[],
		updatedAt: string,
		moveId: string,
	): Promise<void> {
		await this.store.copyForMove(source, destination, nid);
		await copyMovePrefix(
			this.bucket,
			paths.previewRecords(source, nid),
			paths.previewRecords(destination, nid),
			{
				transform: (_key, bytes) =>
					moveJson(bytes, (record) => ({ ...record, project_id: destination })),
			},
		);
		for (const id of runtimes) {
			await this.notebooks.copyForMove(source, destination, id, updatedAt, moveId);
			await this.notebooks.thumbnails.copyForMove(source, destination, id);
		}
	}

	constructor(
		private bucket: Bucket,
		private notebooks: NotebookService,
	) {
		this.store = new PreviewStore(bucket);
	}

	async get(
		pid: ProjectId,
		nid: NotebookId,
		id: PreviewId,
		memo?: PromiseMemo,
	): Promise<NotebookPreview> {
		const intent = (await this.store.project(pid, memo)).entries.find(
			(entry) =>
				entry.intent.id === id &&
				entry.intent.notebook_id === nid &&
				entry.intent.state !== 'deleted',
		)?.intent;
		if (!intent) throw new NotFoundError('Preview not found');
		return this.readRecord(intent, memo);
	}

	private async readRecord(intent: PreviewIntent, memo?: PromiseMemo): Promise<NotebookPreview> {
		const key = previewKey(intent.project_id, intent.notebook_id, intent.id);
		const read = async () => {
			const object = await this.bucket.get(key);
			if (!object) throw new NotFoundError('Preview not found');
			return readStored(PreviewRecordSchema, object, key);
		};
		const record = await (memo ? memo.read([this.bucket, key], read) : read());
		if (!intent.automation) return record;
		return applyAutomationIntent(record, intent) ?? record;
	}

	private async materialize(intent: PreviewIntent): Promise<NotebookPreview> {
		if (intent.state === 'deleted') return initialPreviewRecord(intent);
		const key = previewKey(intent.project_id, intent.notebook_id, intent.id);
		const object = await this.bucket.get(key);
		if (!object) {
			try {
				const initial = initialPreviewRecord(intent);
				if (initial.state === 'deleting')
					initial.cleanup_after = Date.now() + PREVIEW_LIMITS.cleanupGraceMs;
				await this.bucket.put(key, JSON.stringify(initial), { onlyIfNotExists: true });
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
			return this.readRecord(intent);
		}
		const current = await readStored(PreviewRecordSchema, object, key);
		if (!intent.automation || !applyAutomationIntent(current, intent)) return current;
		return this.mutate(intent, (latest) => applyAutomationIntent(latest, intent), {
			value: current,
			etag: object.etag,
		});
	}

	async projectRecords(
		pid: ProjectId,
		nid?: NotebookId,
		read?: PreviewProject,
	): Promise<NotebookPreview[]> {
		const entries = (read ?? (await this.store.project(pid))).entries.filter(
			(entry) => !nid || entry.intent.notebook_id === nid,
		);
		const records = await mapWithConcurrency(entries, BUCKET_SCAN_CONCURRENCY, async (entry) => {
			try {
				return await this.materialize(entry.intent);
			} catch (error) {
				if (error instanceof NotFoundError) return null;
				throw error;
			}
		});
		// Cleanup may remove membership while records are materialized.
		const current = new Map(
			(await this.store.project(pid)).entries.map(({ intent }) => [intent.id, intent]),
		);
		return (
			await mapWithConcurrency(records, BUCKET_SCAN_CONCURRENCY, async (record) => {
				if (!record) return [];
				const intent = current.get(record.id);
				if (!intent) return [];
				if (intent.state === 'deleted') return [initialPreviewRecord(intent)];
				if (!applyAutomationIntent(record, intent)) return [record];
				try {
					return [await this.mutate(record, (latest) => applyAutomationIntent(latest, intent))];
				} catch (error) {
					if (error instanceof NotFoundError) return [];
					throw error;
				}
			})
		).flat();
	}

	async list(pid: ProjectId, nid: NotebookId): Promise<NotebookPreview[]> {
		const entries = (await this.store.project(pid)).entries.filter(
			(entry) => entry.intent.notebook_id === nid && entry.intent.state === 'active',
		);
		const records = await mapWithConcurrency(entries, BUCKET_SCAN_CONCURRENCY, async (entry) => {
			try {
				return await this.readRecord(entry.intent);
			} catch (error) {
				if (error instanceof NotFoundError) return initialPreviewRecord(entry.intent);
				throw error;
			}
		});
		return records
			.filter(previewAvailable)
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
		known?: KnownObject<NotebookPreview>,
	) {
		const key = previewKey(record.project_id, record.notebook_id, record.id);
		return mutateObject(
			this.bucket,
			key,
			(raw) => parseStored(PreviewRecordSchema, raw, key),
			update,
			{ notFound: () => new NotFoundError('Preview not found'), known },
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

	private async failPreparation(
		record: NotebookPreview,
		token: string,
		error: unknown,
		expired = false,
	): Promise<NotebookPreview> {
		const key = previewKey(record.project_id, record.notebook_id, record.id);
		const result = await mutateObjectWithOutcome<NotebookPreview>(
			this.bucket,
			key,
			(raw) => parseStored(PreviewRecordSchema, raw, key),
			(current) => {
				const leaseExpired = (current.lease?.expires_at ?? 0) <= Date.now();
				if (
					current.state !== 'active' ||
					current.lease?.token !== token ||
					leaseExpired !== expired
				)
					return null;
				return {
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
				};
			},
			{ notFound: () => new NotFoundError('Preview not found') },
		);
		if (result.written && result.value.preparation_failures === MAX_PREPARATION_FAILURES) {
			logOperationalError(
				'preview_preparation_exhausted',
				{
					project_id: record.project_id,
					notebook_id: record.notebook_id,
					preview_id: record.id,
					preparation_failures: result.value.preparation_failures,
				},
				error,
			);
		}
		return result.value;
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
		const expires = input.expires_at
			? Date.parse(input.expires_at)
			: now + PREVIEW_LIMITS.defaultExpiryMs;
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
		const id = receipt?.id ?? createPreviewId();
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
			preparation: input.eager === false ? 'deferred' : 'pending',
			preparation_failures: 0,
			revisions: [],
			admissions: [],
		};
		const intent = await this.store.reserve(record, now + PREVIEW_LIMITS.creationMs);
		await this.materialize(intent);
		// Re-check membership: cleanup may have forgotten the preview after reservation.
		const saved = await this.get(pid, nid, intent.id);
		if (saved.state !== 'active') throw new ConflictError('This preview has been deleted');
		await this.prioritize(pid);
		return saved;
	}

	async reconcile(
		pid: ProjectId,
		nid: NotebookId,
		input: PreviewReconcile,
		actor: UserId,
		registry?: SourceControlRegistry,
	) {
		const { source, reader } = await this.source(pid, nid, registry);
		if (
			!reposMatch(source.repo, input.repository, {
				[repoHost(source.repo) ?? 'github.com']: 'github',
			}) ||
			!reader.getPullRequest
		)
			throw new BadRequestError('Preview repository must match the notebook repository');
		const pr = await reader.getPullRequest(source.repo, input.pull_request, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!pr.sameRepository) throw new BadRequestError('Fork previews are not supported');
		// A delayed close after reopening must not retire the new lifecycle.
		if ((input.event === 'closed') !== (pr.state === 'closed'))
			throw new ConflictError('Pull request state changed; run the workflow for its current state');
		if (Date.parse(input.event_at) > Date.now() + 60_000)
			throw new BadRequestError('Workflow event time is in the future');
		const key = await sha256Hex(JSON.stringify([nid, source.repo, input.pull_request]));
		const template = PreviewIntentSchema.parse({
			schema_version: 1,
			id: createPreviewId(),
			project_id: pid,
			notebook_id: nid,
			name: pr.branch,
			source: { type: 'commit', commit: input.commit },
			repository: source.repo,
			root_path: source.root_path,
			entry_notebook: source.entry_notebook,
			pull_request: input.pull_request,
			created_by: actor,
			created_at: input.event_at,
			expires_at: null,
			request_fingerprint: key,
			state: 'active',
			eager: input.policy.eager,
			automation: { key, revision: 0, commit: input.commit },
		});
		await this.store.reconcileAutomation(template, input, pr.branch, await sha256Hex(pr.branch));
		await this.prioritize(pid);
		const records = await this.projectRecords(pid, nid);
		const group = (await this.store.getAutomation(pid, key))!;
		return {
			state: group.state,
			pending: group.heads.some((head) => !records.some((record) => record.id === head.intent.id)),
			items: records.filter(
				(record) =>
					group.state === 'active' &&
					group.heads.some((head) => head.intent.id === record.id) &&
					previewAvailable(record),
			),
		};
	}

	private async prioritize(pid: ProjectId): Promise<void> {
		try {
			await this.store.prioritize(pid);
		} catch (error) {
			logOperationalError('preview_prioritize_failed', { project_id: pid }, error);
		}
	}

	async requestPreparation(record: NotebookPreview): Promise<NotebookPreview> {
		if (!previewAvailable(record)) throw new NotFoundError('Preview not found');
		const requested = await this.mutate(record, (persisted) => {
			const applied = applyAutomationIntent(persisted, record);
			const current = applied ?? persisted;
			if (!previewAvailable(current)) throw new NotFoundError('Preview not found');
			// Page views request preparation on mount, so they must not skip the failure backoff.
			const backoff =
				current.preparation === 'failed' && (current.next_attempt_at ?? 0) > Date.now();
			if (current.preparation === 'failed' && !backoff) {
				return {
					...current,
					preparation: 'pending',
					preparation_failures: 0,
					error: undefined,
					next_attempt_at: 0,
					requested_generation: previewGeneration(current),
					demand: current.automation ? undefined : current.eager === false,
					requested_commit: undefined,
					observed_commit: undefined,
				};
			}
			if (current.eager !== false) return applied;
			const nextAttemptAt = backoff ? current.next_attempt_at : 0;
			if (current.automation) {
				const generation = previewGeneration(current)!;
				if (
					requestedPreviewGeneration(current) === generation &&
					(current.preparation !== 'failed' || backoff)
				)
					return applied;
				return {
					...current,
					requested_generation: generation,
					demand: undefined,
					requested_commit: undefined,
					observed_commit: undefined,
					next_attempt_at: nextAttemptAt,
					preparation: current.preparation === 'deferred' ? 'pending' : current.preparation,
				};
			}
			if (
				current.demand ||
				(current.preparation === 'preparing' &&
					current.lease?.commit &&
					current.lease.expires_at > Date.now())
			)
				return null;
			return {
				...current,
				demand: true,
				requested_commit: undefined,
				next_attempt_at: nextAttemptAt,
				preparation: current.preparation === 'deferred' ? 'pending' : current.preparation,
			};
		});
		if (preparationDue(requested)) await this.prioritize(record.project_id);
		return requested;
	}

	/** Returns `project` when it is still current, so callers can skip another read. */
	private async reconcileAutomations(
		pid: ProjectId,
		project: PreviewProject,
		registry: SourceControlRegistry,
		signal?: AbortSignal,
	): Promise<PreviewProject | undefined> {
		const active = (project.automations ?? []).filter((group) => group.state === 'active');
		const previous = this.automationChecks.get(pid);
		const attempts = new Map<string, number>();
		for (const group of active) {
			const at = previous?.get(group.key);
			if (at !== undefined) attempts.set(group.key, at);
		}
		if (attempts.size > 0) this.automationChecks.set(pid, attempts);
		else this.automationChecks.delete(pid);
		if (!project.automations?.length) return project;
		const now = Date.now();
		const groups = active
			.filter((group) => (attempts.get(group.key) ?? 0) + PREVIEW_POLL_MS <= now)
			.sort(
				(a, b) =>
					(attempts.get(a.key) ?? 0) - (attempts.get(b.key) ?? 0) ||
					(a.checked_at ?? 0) - (b.checked_at ?? 0),
			)
			.slice(0, 1);
		const boundedSignal = AbortSignal.any([
			AbortSignal.timeout(30_000),
			...(signal ? [signal] : []),
		]);
		let changed = false;
		const close = async (group: PreviewAutomationGroup) => {
			changed = true;
			await this.store.closeAutomation(pid, group.key, group.revision);
		};
		for (const group of groups) {
			attempts.set(group.key, now);
			this.automationChecks.set(pid, attempts);
			try {
				const { source, reader } = await this.source(pid, group.notebook_id, registry);
				if (source.repo !== group.repository) {
					await close(group);
					continue;
				}
				const pr = await reader.getPullRequest!(group.repository, group.pull_request, {
					signal: boundedSignal,
				});
				if (pr.state === 'closed' || !pr.sameRepository) await close(group);
				else if ((group.checked_at ?? 0) + AUTOMATION_CHECK_STAMP_MS <= Date.now()) {
					changed = true;
					await this.store.checkedAutomation(pid, group.key, group.revision);
				}
			} catch (error) {
				if (error instanceof NotFoundError) {
					const parent = await this.notebooks
						.getNotebookMeta(pid, group.notebook_id)
						.catch((failure) => {
							if (failure instanceof NotFoundError) return null;
							throw failure;
						});
					if (!parent || parent.status === 'deleted') {
						await close(group);
						continue;
					}
				}
				const verifiedAt = Math.max(group.checked_at ?? 0, Date.parse(group.last_commit_at));
				if (verifiedAt + AUTOMATION_UNVERIFIED_MS <= Date.now()) await close(group);
				logOperationalError(
					'preview_automation_check_failed',
					{ project_id: pid, notebook_id: group.notebook_id },
					error,
				);
			}
		}
		// Each store write above already planned the head in its CAS.
		if (changed) return undefined;
		const planned = await this.store.planAutomations(pid, project);
		// Membership can change during a GitHub call; materializing a stale entry would recreate it.
		return planned || groups.length > 0 ? undefined : project;
	}

	async prepare(
		initial: NotebookPreview,
		registry?: SourceControlRegistry,
		force = false,
		externalSignal?: AbortSignal,
	): Promise<NotebookPreview> {
		externalSignal?.throwIfAborted();
		if (initial.state !== 'active') return initial;
		let record = await this.get(initial.project_id, initial.notebook_id, initial.id);
		if (record.state !== 'active') return record;
		if (previewExpired(record)) return this.retireExpired(record);
		if (!preparationDue(record, force)) return record;
		if (record.lease) {
			record = await this.failPreparation(
				record,
				record.lease.token,
				new Error('Preview preparation lease expired'),
				true,
			);
			if (!force || record.lease || record.state !== 'active') return record;
		}
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
			return await this.prepareClaimed(record, registry, claim, signal, force, externalSignal);
		} finally {
			clearTimeout(timeout);
			await this.store.release(token);
		}
	}

	private async prepareClaimed(
		initial: NotebookPreview,
		registry: SourceControlRegistry | undefined,
		claim: { token: string; expires_at: number },
		signal: AbortSignal,
		force: boolean,
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
		const claimed = await this.mutate(initial, (current) => {
			const effective = applyAutomationIntent(current, initial) ?? current;
			if (!preparationDue(effective, force) || effective.lease) return null;
			return {
				...effective,
				preparation: 'preparing',
				lease: { token, expires_at: claim.expires_at },
			};
		});
		if (claimed.lease?.token !== token) return claimed;
		const record = claimed;
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
			if (record.pull_request && !record.automation) {
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
				record.automation?.commit ??
				(ref.type === 'commit' && claimed.current
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
							).commit);
			const requested = await this.mutateLeased(record, token, (current) => {
				if (current.automation) {
					const generation = previewGeneration(current)!;
					const requestedGeneration = requestedPreviewGeneration(current);
					if (
						current.eager === false &&
						current.current?.commit !== commit &&
						requestedGeneration !== generation
					) {
						return {
							...current,
							preparation: 'deferred',
							preparation_failures: 0,
							lease: undefined,
							error: undefined,
							next_attempt_at: Date.now() + PREVIEW_POLL_MS,
						};
					}
					return {
						...current,
						requested_generation: requestedGeneration,
						demand: undefined,
						requested_commit: undefined,
						observed_commit: undefined,
					};
				}
				if (
					current.eager === false &&
					current.current?.commit !== commit &&
					!current.demand &&
					current.requested_commit !== commit
				) {
					return {
						...current,
						preparation: 'deferred',
						preparation_failures: 0,
						observed_commit: commit,
						requested_commit: undefined,
						lease: undefined,
						error: undefined,
						checked_at: new Date().toISOString(),
						next_attempt_at: Date.now() + PREVIEW_POLL_MS,
					};
				}
				return {
					...current,
					observed_commit: commit,
					requested_commit: commit,
					lease: { ...current.lease!, commit },
					demand: false,
				};
			});
			if (requested.state !== 'active' || requested.lease?.token !== token) return requested;
			if (claimed.current?.commit === commit)
				return await this.mutateLeased(record, token, (current) => ({
					...current,
					preparation: 'ready',
					requested_commit: undefined,
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
						cleanup_after: Date.now() + PREVIEW_LIMITS.cleanupGraceMs,
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
			await forEachConcurrentUntilFailure({
				items: [...files],
				concurrency: BUCKET_WRITE_CONCURRENCY,
				run: ([path, bytes]) =>
					bounded(async () => {
						await this.bucket.put(version.workspaceFile(path), bytes, { onlyIfNotExists: true });
					}),
			});
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
				requested_commit: undefined,
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
			return this.failPreparation(record, token, error);
		}
	}

	async reapAdmissions(
		identity: Pick<NotebookPreview, 'project_id' | 'notebook_id' | 'id'>,
		isRetained: (id: SessionId) => Promise<boolean | undefined>,
	): Promise<NotebookPreview> {
		const record = await this.get(identity.project_id, identity.notebook_id, identity.id);
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
				!previewAvailable(current) ||
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
						expires_at: Date.now() + PREVIEW_LIMITS.admissionMs,
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
				!previewAvailable(current) ||
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

	async retireExpired(record: NotebookPreview): Promise<NotebookPreview> {
		// Expiry and commit renewal must compete on the automation group's CAS head.
		if (record.automation) await this.store.planAutomations(record.project_id);
		const current = await this.get(record.project_id, record.notebook_id, record.id);
		const expired = record.automation ? current.state !== 'active' : previewExpired(current);
		return expired ? this.retire(current) : current;
	}

	async retire(record: NotebookPreview): Promise<NotebookPreview> {
		await this.store.retireAutomationPreview(record);
		const retired = await this.mutate(record, retirePreviewRecord);
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
			if (signal?.aborted) {
				for (const pid of projects.slice(offset)) await this.prioritize(pid);
				return;
			}
			await Promise.allSettled(
				projects.slice(offset, offset + PREVIEW_LIMITS.concurrency).map(async (pid) => {
					try {
						const project = await this.reconcileAutomations(
							pid,
							await this.store.project(pid),
							registry,
							signal,
						);
						const records = (await this.projectRecords(pid, undefined, project)).filter((record) =>
							preparationDue(record),
						);
						records.sort(
							(a, b) =>
								(a.next_attempt_at ?? 0) - (b.next_attempt_at ?? 0) ||
								a.created_at.localeCompare(b.created_at),
						);
						if (records[0]) records[0] = await this.prepare(records[0], registry, false, signal);
						if (
							records.some((record) => record.preparation === 'pending' && preparationDue(record))
						)
							await this.prioritize(pid);
					} catch (error) {
						logOperationalError('preview_preparation_failed', { project_id: pid }, error);
						await this.prioritize(pid);
					}
				}),
			);
		}
	}
}

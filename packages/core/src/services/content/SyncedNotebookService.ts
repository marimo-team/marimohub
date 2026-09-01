import type { Bucket } from '../../ports/bucket';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors';
import { createNotebookId, createVersionId, SYSTEM_ACTOR } from '../../ids';
import type { NotebookId, ProjectId, UserId, VersionId } from '../../ids';
import {
	applyGitSourceUpdate,
	assertSyncSourcePrecondition,
	assertSyncedSource,
	createGitSource,
	createSyncToken,
	createSyncTokenRecord,
	isAtBranchHead,
	prepareSync,
	providerForRepo,
	SyncTokenRecordSchema,
	verifySyncTokenRecord,
} from '../../integrations/syncedSource';
import type {
	CreateSyncedNotebookInput,
	SyncNotebookInput,
	UpdateSyncedNotebookSourceInput,
} from '../../integrations/syncedSource';
import type { Metrics } from '../../ports/metrics';
import { assertGitDirectoryLimits } from '../../ports/sourceControl';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type { VersionPaths } from '../../paths';
import { compensableWrite, metricsObserver, saga } from '../../saga';
import { NotebookMetaSchema, parseStored, readStored, SourceSchema } from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { mutateObject } from '../catalog/cas';
import { buildNotebookEntry, buildNotebookMeta, buildVersion } from './notebookMeta';
import { listAllKeys } from '../catalog/storage';
import type { GitSource, NotebookMeta, Source } from '../../schema';
import { loadNotebookCatalogPatch } from './catalogProjection';
import { toSyncedWorkspaceFileMap } from '../../integrations/remoteWorkspace';
import {
	createPackedWorkspaceArchive,
	isPackedWorkspaceInputWithinLimit,
	packedWorkspaceInputBytes,
} from '../../integrations/packedWorkspace';

interface SyncedNotebookServiceHooks {
	getNotebook: (
		projectId: ProjectId,
		notebookId: NotebookId,
	) => Promise<{ meta: NotebookMeta; source: Source }>;
	pruneVersions: (projectId: ProjectId, notebookId: NotebookId, keep: VersionId) => Promise<void>;
}

/**
 * Notebooks whose source is synced from an external git repo (see `GitSource`).
 * A version per sync is the unit of truth: each sync writes a fresh,
 * immutable `versions/{vid}/workspace/` mirror and then compare-and-swaps the
 * notebook's `source.json` pointer to it. There is no mutable workspace mirror to
 * corrupt, so concurrent pushes can only orphan a version, never interleave one.
 */
export class SyncedNotebookService {
	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
		private metrics: Metrics,
		private hooks: SyncedNotebookServiceHooks,
	) {}

	async create(
		projectId: ProjectId,
		input: CreateSyncedNotebookInput,
		actor: UserId,
	): Promise<{ meta: NotebookMeta; sync_token?: string }> {
		const notebookId = createNotebookId();
		const now = new Date().toISOString();
		const source = createGitSource(input);
		const syncToken = source.sync_mode === 'push' ? createSyncToken() : undefined;

		const meta = buildNotebookMeta({
			notebookId,
			projectId,
			actor,
			now,
			status: 'draft',
			title: input.title,
			description: input.description,
			tags: input.tags,
			runtime: input.runtime,
			baseImage: input.base_image,
			computeProfile: input.compute_profile,
		});

		const tokenRecord = syncToken ? await createSyncTokenRecord(syncToken, now) : undefined;

		const nb = paths.project(projectId).notebook(notebookId);
		const contentKeys = [nb.meta, nb.readme, nb.source];
		if (tokenRecord) contentKeys.push(nb.integrationSyncToken);

		await saga(metricsObserver(this.metrics, 'saga.synced_notebook_create'))
			.step(
				'write_files',
				compensableWrite(
					[
						() => this.bucket.put(nb.meta, JSON.stringify(meta)),
						() =>
							this.bucket.put(
								nb.readme,
								input.readme ?? `# ${input.title}\n\n${input.description}\n`,
							),
						() => this.bucket.put(nb.source, JSON.stringify(source)),
						...(tokenRecord
							? [() => this.bucket.put(nb.integrationSyncToken, JSON.stringify(tokenRecord))]
							: []),
					],
					() => this.bucket.delete(contentKeys),
				),
			)
			.step('catalog', () =>
				this.catalog.appendNotebookEntry(
					'notebook.synced.create',
					actor,
					projectId,
					buildNotebookEntry(meta, 'git', nb.base, actor),
				),
			)
			.run();

		return { meta, ...(syncToken ? { sync_token: syncToken } : {}) };
	}

	private async deleteVersion(versionPaths: VersionPaths): Promise<void> {
		const [workspaceKeys, gitKeys] = await Promise.all([
			listAllKeys(this.bucket, versionPaths.workspacePrefix),
			listAllKeys(this.bucket, versionPaths.gitPrefix),
		]);
		await this.bucket.delete([
			versionPaths.meta,
			versionPaths.workspaceArchive,
			...workspaceKeys,
			...gitKeys,
		]);
	}

	async rotateToken(projectId: ProjectId, notebookId: NotebookId): Promise<{ sync_token: string }> {
		const { source } = await this.hooks.getNotebook(projectId, notebookId);
		const git = assertSyncedSource(source);
		if (git.sync_mode !== 'push') {
			throw new ConflictError('Pull-mode sources do not use sync tokens');
		}
		const token = createSyncToken();
		const record = await createSyncTokenRecord(token, new Date().toISOString());
		await this.bucket.put(
			paths.project(projectId).notebook(notebookId).integrationSyncToken,
			JSON.stringify(record),
		);
		return { sync_token: token };
	}

	async updateSource(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: UpdateSyncedNotebookSourceInput,
		actor: UserId,
	): Promise<GitSource> {
		const nb = paths.project(projectId).notebook(notebookId);
		const source = await mutateObject(
			this.bucket,
			nb.source,
			(raw) => assertSyncedSource(parseStored(SourceSchema, raw, nb.source)),
			(current) => applyGitSourceUpdate(current, input),
		);
		const now = new Date().toISOString();
		await mutateObject(
			this.bucket,
			nb.meta,
			(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
			(current) => ({ ...current, updated_at: now }),
		);
		await this.catalog.updateNotebookEntry(
			'notebook.synced.source.update',
			actor,
			projectId,
			notebookId,
			(entry) => loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry),
		);
		return source;
	}

	async verifyToken(
		projectId: ProjectId,
		notebookId: NotebookId,
		token: string | undefined,
	): Promise<boolean> {
		if (!token) return false;
		const nb = paths.project(projectId).notebook(notebookId);
		const obj = await this.bucket.get(nb.integrationSyncToken);
		if (!obj) return false;
		let record;
		try {
			record = await readStored(SyncTokenRecordSchema, obj, nb.integrationSyncToken);
		} catch (err) {
			logOperationalError(
				'stored_object_skipped',
				{ operation: 'sync_token.verify', object: nb.integrationSyncToken },
				err,
			);
			return false;
		}
		return verifySyncTokenRecord(record, token);
	}

	/**
	 * `versionId` is the version this call created and the source now points at;
	 * null when the sync was a no-op — including the race where a concurrent
	 * sync of the same commit won the pointer advance. Callers use it to tell
	 * "this request synced" from "someone already had".
	 */
	async sync(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: SyncNotebookInput,
		actor: UserId = SYSTEM_ACTOR,
	): Promise<{ meta: NotebookMeta; versionId: VersionId | null }> {
		const { meta: existing, source } = await this.hooks.getNotebook(projectId, notebookId);
		if (existing.status === 'deleted') {
			throw new NotFoundError(`Notebook ${notebookId} not found`);
		}
		const syncedSource = assertSyncedSource(source);
		const prepared = prepareSync(syncedSource, input);
		if (input.git_files) assertGitDirectoryLimits(input.git_files);
		const gitFiles = input.git_files ? toSyncedWorkspaceFileMap(input.git_files) : undefined;
		if (syncedSource.sync_mode === 'pull' && !gitFiles) {
			throw new BadRequestError('Pull sync did not include Git metadata');
		}

		// Re-syncing the same commit (a retried CI run) is a genuine no-op, not a conflict.
		if (isAtBranchHead(syncedSource, prepared.commit)) {
			return { meta: existing, versionId: null };
		}
		// Fast-fail before writing any version files; the CAS callback re-checks.
		assertSyncSourcePrecondition(syncedSource, input);

		const nb = paths.project(projectId).notebook(notebookId);
		const now = new Date().toISOString();
		const versionId = createVersionId();
		const versionPaths = nb.version(versionId);
		let workspaceArchive: Uint8Array | undefined;
		const archiveInput = {
			workspace: prepared.files,
			...(gitFiles ? { git: gitFiles } : {}),
		};
		this.metrics.gauge(
			'sync.workspace_archive_input_bytes',
			packedWorkspaceInputBytes(archiveInput),
		);
		if (isPackedWorkspaceInputWithinLimit(archiveInput)) {
			try {
				workspaceArchive = createPackedWorkspaceArchive(archiveInput);
				this.metrics.gauge('sync.workspace_archive_bytes', workspaceArchive.byteLength);
			} catch (error) {
				this.metrics.increment('sync.workspace_archive_build_failed');
				logOperationalError(
					'sync_workspace_archive_build_failed',
					{
						operation: 'notebook.sync.workspace_archive.build',
						project_id: projectId,
						notebook_id: notebookId,
						recovered: true,
					},
					error,
				);
			}
		} else {
			this.metrics.increment('sync.workspace_archive_skipped_input_limit');
		}
		const version = buildVersion({
			versionId,
			notebookId,
			now,
			author: actor,
			message: `Sync ${prepared.commit.slice(0, 12)}`,
			parentId: syncedSource.current_version_id,
			commit: prepared.commit,
		});
		version.git_source = {
			provider: providerForRepo(syncedSource, prepared.config.repo),
			...prepared.config,
			commit: prepared.commit,
		};
		let versionToKeep = versionId;

		await saga(metricsObserver(this.metrics, 'saga.synced_notebook_sync'))
			// The version id is fresh, so this write never races another push.
			.step(
				'write_version',
				compensableWrite(
					[
						() => this.bucket.put(versionPaths.meta, JSON.stringify(version)),
						...(workspaceArchive
							? [
									async () => {
										try {
											await this.bucket.put(versionPaths.workspaceArchive, workspaceArchive, {
												httpMetadata: { contentType: 'application/zip' },
											});
											this.metrics.increment('sync.workspace_archive_stored');
										} catch (error) {
											this.metrics.increment('sync.workspace_archive_write_failed');
											logOperationalError(
												'sync_workspace_archive_write_failed',
												{
													operation: 'notebook.sync.workspace_archive.write',
													object: versionPaths.workspaceArchive,
													project_id: projectId,
													notebook_id: notebookId,
													recovered: true,
												},
												error,
											);
										}
									},
								]
							: []),
						...[...prepared.files.entries()].map(
							([path, bytes]) =>
								() =>
									this.bucket.put(versionPaths.workspaceFile(path), bytes),
						),
						...[...(gitFiles?.entries() ?? [])].map(
							([path, bytes]) =>
								() =>
									this.bucket.put(versionPaths.gitFile(path), bytes),
						),
					],
					() => this.deleteVersion(versionPaths),
				),
			)
			// `mutateObject` returns the concurrent winner when this commit already won.
			// Pruning must protect that pointer rather than this request's orphan.
			.step('advance_source', async () => {
				const advancedSource = await mutateObject(
					this.bucket,
					nb.source,
					(raw) => parseStored(SourceSchema, raw, nb.source),
					(current) => {
						const git = assertSyncedSource(current);
						const currentPrepared = prepareSync(git, input);
						if (isAtBranchHead(git, currentPrepared.commit)) return null;
						// A pull that resolved its head against an older source state must
						// not regress a pointer another sync advanced meanwhile. Failing
						// here aborts the saga, which cleans up the orphan version.
						assertSyncSourcePrecondition(git, input);
						const { pending_config: _pendingConfig, ...withoutPending } = git;
						return {
							...withoutPending,
							...currentPrepared.config,
							provider: providerForRepo(git, currentPrepared.config.repo),
							current_version_id: versionId,
							commit: currentPrepared.commit,
							last_synced_at: now,
						};
					},
				);
				versionToKeep = assertSyncedSource(advancedSource).current_version_id ?? versionId;
			})
			.run();

		// Past the commit point. Meta and the catalog entry are denormalized views that
		// reconciliation can rebuild, so they update outside the saga.
		const updatedMeta = await mutateObject(
			this.bucket,
			nb.meta,
			(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
			(current) => {
				if (current.status === 'deleted') {
					throw new NotFoundError(`Notebook ${notebookId} not found`);
				}
				return { ...current, status: 'active' as const, updated_at: new Date().toISOString() };
			},
		);

		await this.catalog.updateNotebookEntry(
			'notebook.synced.sync',
			actor,
			projectId,
			notebookId,
			(entry) => loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry),
		);

		await this.hooks.pruneVersions(projectId, notebookId, versionToKeep);
		return { meta: updatedMeta, versionId: versionToKeep === versionId ? versionId : null };
	}
}

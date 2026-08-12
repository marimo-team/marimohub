import type { Bucket } from '../../ports/bucket';
import { NotFoundError } from '../../errors';
import { createNotebookId, createVersionId, SYSTEM_ACTOR } from '../../ids';
import type { NotebookId, ProjectId, UserId, VersionId } from '../../ids';
import {
	assertSyncedSource,
	createGitSource,
	createSyncToken,
	createSyncTokenRecord,
	gitSourceConfig,
	gitSourceConfigsEqual,
	normalizeGitSourceConfig,
	prepareSync,
	providerForRepo,
	resolveUpdatedConfig,
	SyncTokenRecordSchema,
	verifySyncTokenRecord,
} from '../../integrations/syncedSource';
import type {
	CreateSyncedNotebookInput,
	SyncNotebookInput,
	UpdateSyncedNotebookSourceInput,
} from '../../integrations/syncedSource';
import type { Metrics } from '../../ports/metrics';
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

interface SyncedNotebookServiceHooks {
	getNotebook: (
		projectId: ProjectId,
		notebookId: NotebookId,
	) => Promise<{ meta: NotebookMeta; source: Source }>;
	pruneVersions: (projectId: ProjectId, notebookId: NotebookId, keep: VersionId) => Promise<void>;
	withNotebookWriteLock: <T>(
		projectId: ProjectId,
		notebookId: NotebookId,
		operation: (assertLeaseHeld: () => Promise<void>) => Promise<T>,
	) => Promise<T>;
}

/**
 * Notebooks whose source is push-synced from an external git repo (see
 * `GitSource`). A version per push is the unit of truth: each sync writes a fresh,
 * immutable `versions/{vid}/workspace/` mirror and then compare-and-swaps the
 * notebook's `source.json` pointer to it. The notebook write lease serializes sync
 * with deletion, while the source CAS protects configuration changes.
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
	): Promise<{ meta: NotebookMeta; sync_token: string }> {
		const notebookId = createNotebookId();
		const now = new Date().toISOString();
		const source = createGitSource(input);
		const syncToken = createSyncToken();

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

		const tokenRecord = await createSyncTokenRecord(syncToken, now);

		const nb = paths.project(projectId).notebook(notebookId);
		const contentKeys = [nb.meta, nb.readme, nb.source, nb.integrationSyncToken];

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
						() => this.bucket.put(nb.integrationSyncToken, JSON.stringify(tokenRecord)),
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

		return { meta, sync_token: syncToken };
	}

	private async deleteVersion(versionPaths: VersionPaths): Promise<void> {
		const keys = await listAllKeys(this.bucket, versionPaths.workspacePrefix);
		await this.bucket.delete([versionPaths.meta, ...keys]);
	}

	async rotateToken(projectId: ProjectId, notebookId: NotebookId): Promise<{ sync_token: string }> {
		const { source } = await this.hooks.getNotebook(projectId, notebookId);
		assertSyncedSource(source);
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
		const desired = normalizeGitSourceConfig(input);
		const nb = paths.project(projectId).notebook(notebookId);
		const source = await mutateObject(
			this.bucket,
			nb.source,
			(raw) => assertSyncedSource(parseStored(SourceSchema, raw, nb.source)),
			(current) => {
				const resolved = resolveUpdatedConfig(current, desired);
				const active = gitSourceConfig(current);
				if (current.pending_config && gitSourceConfigsEqual(current.pending_config, resolved)) {
					return null;
				}
				const { pending_config: _pendingConfig, ...withoutPending } = current;
				if (gitSourceConfigsEqual(active, resolved)) {
					return current.pending_config ? withoutPending : null;
				}
				if (current.current_version_id === null) {
					return {
						...withoutPending,
						...resolved,
						provider: providerForRepo(current, resolved.repo),
					};
				}
				return { ...current, pending_config: resolved };
			},
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
			() => loadNotebookCatalogPatch(this.bucket, projectId, notebookId),
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

	async sync(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: SyncNotebookInput,
		actor: UserId = SYSTEM_ACTOR,
	): Promise<NotebookMeta> {
		return this.hooks.withNotebookWriteLock(projectId, notebookId, (assertLeaseHeld) =>
			this.syncWithLock(projectId, notebookId, input, actor, assertLeaseHeld),
		);
	}

	private async syncWithLock(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: SyncNotebookInput,
		actor: UserId,
		assertLeaseHeld: () => Promise<void>,
	): Promise<NotebookMeta> {
		const { meta: existing, source } = await this.hooks.getNotebook(projectId, notebookId);
		if (existing.status === 'deleted') {
			throw new NotFoundError(`Notebook ${notebookId} not found`);
		}
		const syncedSource = assertSyncedSource(source);
		const prepared = prepareSync(syncedSource, input);

		// Git commits are content-addressed, so re-pushing the same commit (a retried
		// CI run) carries identical bytes — a genuine no-op, not a conflict.
		if (!syncedSource.pending_config && syncedSource.commit === prepared.commit) {
			return existing;
		}

		const nb = paths.project(projectId).notebook(notebookId);
		const now = new Date().toISOString();
		const versionId = createVersionId();
		const versionPaths = nb.version(versionId);
		const version = buildVersion({
			versionId,
			notebookId,
			now,
			author: actor,
			message: `Sync ${prepared.commit.slice(0, 12)}`,
			parentId: syncedSource.current_version_id,
			commit: prepared.commit,
		});
		let versionToKeep = versionId;

		await saga(metricsObserver(this.metrics, 'saga.synced_notebook_sync'))
			// The version id is fresh, so this write never races another push.
			.step(
				'write_version',
				compensableWrite(
					[
						() => this.bucket.put(versionPaths.meta, JSON.stringify(version)),
						...[...prepared.files.entries()].map(
							([path, bytes]) =>
								() =>
									this.bucket.put(versionPaths.workspaceFile(path), bytes),
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
						if (!git.pending_config && git.commit === currentPrepared.commit) return null;
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
					{ beforeWrite: assertLeaseHeld },
				);
				versionToKeep = assertSyncedSource(advancedSource).current_version_id ?? versionId;
			})
			.run();

		// Source advancement is the Git-content commit point. Publish the active status
		// with CAS so a concurrent metadata tombstone remains authoritative.
		const updatedMeta = await mutateObject(
			this.bucket,
			nb.meta,
			(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
			(current) => {
				if (current.status === 'deleted') {
					throw new NotFoundError(`Notebook ${notebookId} not found`);
				}
				return { ...current, status: 'active' as const, updated_at: now };
			},
			{ beforeWrite: assertLeaseHeld },
		);

		await this.catalog.updateNotebookEntry(
			'notebook.synced.sync',
			actor,
			projectId,
			notebookId,
			() => loadNotebookCatalogPatch(this.bucket, projectId, notebookId),
		);

		await this.hooks.pruneVersions(projectId, notebookId, versionToKeep);
		return updatedMeta;
	}
}

import type { Bucket } from '../../ports/bucket';
import { createNotebookId, createVersionId, SYSTEM_ACTOR } from '../../ids';
import type { NotebookId, ProjectId, UserId, VersionId } from '../../ids';
import {
	assertSyncedSource,
	createGitSource,
	createSyncToken,
	createSyncTokenRecord,
	prepareSync,
	SyncTokenRecordSchema,
	verifySyncTokenRecord,
} from '../../integrations/syncedSource';
import type { CreateSyncedNotebookInput, SyncNotebookInput } from '../../integrations/syncedSource';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import type { VersionPaths } from '../../paths';
import { compensableWrite, metricsObserver, saga } from '../../saga';
import { SourceSchema } from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { mutateObject } from '../catalog/cas';
import { buildNotebookEntry, buildNotebookMeta, buildVersion } from './notebookMeta';
import { listAllKeys } from '../catalog/storage';
import type { NotebookMeta, Source } from '../../schema';

interface SyncedNotebookServiceHooks {
	getNotebook: (
		projectId: ProjectId,
		notebookId: NotebookId,
	) => Promise<{ meta: NotebookMeta; source: Source }>;
	pruneVersions: (projectId: ProjectId, notebookId: NotebookId, keep: VersionId) => Promise<void>;
}

/**
 * Notebooks whose source is push-synced from an external git repo (see
 * `GitSource`). A version per push is the unit of truth: each sync writes a fresh,
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

	async verifyToken(
		projectId: ProjectId,
		notebookId: NotebookId,
		token: string | undefined,
	): Promise<boolean> {
		if (!token) return false;
		const nb = paths.project(projectId).notebook(notebookId);
		const obj = await this.bucket.get(nb.integrationSyncToken);
		if (!obj) return false;
		let rawRecord: unknown;
		try {
			rawRecord = await obj.json();
		} catch {
			return false;
		}
		const record = SyncTokenRecordSchema.safeParse(rawRecord);
		if (!record.success) return false;
		return verifySyncTokenRecord(record.data, token);
	}

	async sync(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: SyncNotebookInput,
		actor: UserId = SYSTEM_ACTOR,
	): Promise<NotebookMeta> {
		const { meta: existing, source } = await this.hooks.getNotebook(projectId, notebookId);
		const syncedSource = assertSyncedSource(source);
		const prepared = prepareSync(syncedSource, input);

		// Git commits are content-addressed, so re-pushing the same commit (a retried
		// CI run) carries identical bytes — a genuine no-op, not a conflict.
		if (syncedSource.commit === prepared.commit) {
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
		});

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
			// CAS the source pointer onto the new version. On a losing race we re-read: if
			// a concurrent push already took this commit we skip (our version is a harmless
			// orphan that pruning reaps); otherwise we advance over it.
			.step('advance_source', () =>
				mutateObject(
					this.bucket,
					nb.source,
					(raw) => SourceSchema.parse(raw),
					(current) => {
						const git = assertSyncedSource(current);
						if (git.commit === prepared.commit) return null;
						return {
							...git,
							current_version_id: versionId,
							commit: prepared.commit,
							last_synced_at: now,
						};
					},
				),
			)
			.run();

		// Past the commit point. Meta and the catalog entry are denormalized views that
		// reconciliation can rebuild, so they update outside the saga.
		const updatedMeta: NotebookMeta = { ...existing, status: 'active', updated_at: now };
		await this.bucket.put(nb.meta, JSON.stringify(updatedMeta));

		await this.catalog.updateNotebookEntry(
			'notebook.synced.sync',
			actor,
			projectId,
			notebookId,
			() => ({ status: updatedMeta.status, updated_at: now }),
			() => ({ updated_at: now }),
		);

		await this.hooks.pruneVersions(projectId, notebookId, versionId);
		return updatedMeta;
	}
}

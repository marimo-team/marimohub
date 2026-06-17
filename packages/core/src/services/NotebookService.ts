import type { Bucket } from '../ports/bucket';
import { NotFoundError } from '../errors';
import { createNotebookId, createVersionId, type NotebookId, type ProjectId } from '../ids';
import { paths } from '../paths';
import {
	NotebookMetaSchema,
	SourceSchema,
	toPublicNotebookEntry,
	VersionSchema,
	type NotebookMeta,
	type PublicNotebookEntry,
	type Snapshot,
	type Source,
	type Version,
} from '../schema';
import type { CatalogService } from './CatalogService';
import { listAllKeys } from './storage';

/**
 * Maximum number of immutable version folders to retain per notebook. Older
 * versions beyond this count are pruned after a code save. The current version
 * is always kept regardless of this bound. Conservative by design; make it
 * configurable if users ask for longer history.
 */
export const MAX_VERSIONS = 50;

export interface CreateNotebookInput {
	title: string;
	description: string;
	code: string;
	tags?: string[];
	readme?: string;
	deps?: string;
	runtime?: { python_version?: string; marimo_version?: string };
}

export interface UpdateNotebookInput {
	title?: string;
	description?: string;
	code?: string;
	tags?: string[];
	readme?: string;
	deps?: string;
	message?: string;
}

export interface NotebookDetail {
	meta: NotebookMeta;
	readme: string | null;
	source: Source;
}

export class NotebookService {
	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
	) {}

	async listNotebooks(projectId: ProjectId): Promise<PublicNotebookEntry[]> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const project = snapshot.projects.find((p) => p.id === projectId);
		if (!project) {
			throw new NotFoundError(`Project ${projectId} not found`);
		}
		return project.notebooks.filter((n) => n.status !== 'deleted').map(toPublicNotebookEntry);
	}

	async getNotebook(projectId: ProjectId, notebookId: NotebookId): Promise<NotebookDetail> {
		const nb = paths.project(projectId).notebook(notebookId);
		const [metaObj, readmeObj, sourceObj] = await Promise.all([
			this.bucket.get(nb.meta),
			this.bucket.get(nb.readme),
			this.bucket.get(nb.source),
		]);

		if (!metaObj || !sourceObj) {
			throw new NotFoundError(`Notebook ${notebookId} not found`);
		}

		const meta = NotebookMetaSchema.parse(await metaObj.json());
		const source = SourceSchema.parse(await sourceObj.json());
		const readme = readmeObj ? await readmeObj.text() : null;

		return { meta, readme, source };
	}

	async getNotebookContent(projectId: ProjectId, notebookId: NotebookId): Promise<string> {
		const { source } = await this.getNotebook(projectId, notebookId);

		if (source.type === 'local') {
			const nb = paths.project(projectId).notebook(notebookId);
			const codeObj = await this.bucket.get(nb.code);
			if (!codeObj) {
				throw new NotFoundError(`Notebook code for ${notebookId} not found`);
			}
			return codeObj.text();
		}

		// GitHub source: caller must handle external fetch
		throw new Error(`GitHub source resolution not yet implemented`);
	}

	async createNotebook(
		projectId: ProjectId,
		input: CreateNotebookInput,
		actor: string,
	): Promise<NotebookMeta> {
		const notebookId = createNotebookId();
		const versionId = createVersionId();
		const now = new Date().toISOString();

		const meta: NotebookMeta = {
			schema_version: 1,
			id: notebookId,
			project_id: projectId,
			title: input.title,
			description: input.description,
			status: 'active',
			author: actor,
			created_at: now,
			updated_at: now,
			last_run_at: null,
			tags: input.tags ?? [],
			runtime: input.runtime,
		};

		const source: Source = {
			schema_version: 1,
			type: 'local',
			current_version_id: versionId,
		};

		const version: Version = {
			schema_version: 1,
			version_id: versionId,
			notebook_id: notebookId,
			saved_at: now,
			author: actor,
			message: 'Initial version',
			parent_id: null,
		};

		// Write all content files
		const nb = paths.project(projectId).notebook(notebookId);
		await Promise.all([
			this.bucket.put(nb.meta, JSON.stringify(meta)),
			this.bucket.put(nb.readme, input.readme ?? `# ${input.title}\n\n${input.description}\n`),
			this.bucket.put(nb.source, JSON.stringify(source)),
			this.bucket.put(nb.code, input.code),
			this.bucket.put(nb.deps, input.deps ?? ''),
		]);

		// Write version snapshot
		const ver = nb.version(versionId);
		await Promise.all([
			this.bucket.put(ver.code, input.code),
			this.bucket.put(ver.deps, input.deps ?? ''),
			this.bucket.put(ver.meta, JSON.stringify(version)),
		]);

		// Mutate catalog snapshot
		await this.catalog.mutateSnapshot('notebook.create', actor, (snap: Snapshot) => ({
			...snap,
			projects: snap.projects.map((p) =>
				p.id === projectId
					? {
							...p,
							updated_at: now,
							notebook_count: p.notebook_count + 1,
							notebooks: [
								...p.notebooks,
								{
									id: notebookId,
									title: meta.title,
									description: meta.description,
									status: meta.status,
									source_type: 'local' as const,
									author: actor,
									created_at: now,
									updated_at: now,
									tags: meta.tags,
									last_run_at: null,
									key_prefix: nb.base,
								},
							],
						}
					: p,
			),
		}));

		return meta;
	}

	async updateNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: UpdateNotebookInput,
		actor: string,
	): Promise<NotebookMeta> {
		const { meta: existing, source } = await this.getNotebook(projectId, notebookId);
		const now = new Date().toISOString();

		const updated: NotebookMeta = {
			...existing,
			title: input.title ?? existing.title,
			description: input.description ?? existing.description,
			tags: input.tags ?? existing.tags,
			updated_at: now,
		};

		// Write updated meta
		const nb = paths.project(projectId).notebook(notebookId);
		await this.bucket.put(nb.meta, JSON.stringify(updated));

		if (input.readme !== undefined) {
			await this.bucket.put(nb.readme, input.readme);
		}

		// Write new version if code changed
		if (input.code !== undefined && source.type === 'local') {
			const versionId = createVersionId();

			// Preserve existing deps when the caller did not send new ones. Defaulting
			// to an empty string here would wipe pyproject.toml on a code-only save.
			// Read once, before the Promise.all, so the read does not race the write
			// of the same key inside the batch.
			let deps = input.deps;
			if (deps === undefined) {
				const existingDeps = await this.bucket.get(nb.deps);
				deps = existingDeps ? await existingDeps.text() : '';
			}

			const version: Version = {
				schema_version: 1,
				version_id: versionId,
				notebook_id: notebookId,
				saved_at: now,
				author: actor,
				message: input.message ?? 'Update',
				parent_id: source.current_version_id,
			};

			const newSource: Source = {
				schema_version: 1,
				type: 'local',
				current_version_id: versionId,
			};

			const ver = nb.version(versionId);
			await Promise.all([
				this.bucket.put(nb.code, input.code),
				this.bucket.put(nb.source, JSON.stringify(newSource)),
				this.bucket.put(nb.deps, deps),
				this.bucket.put(ver.code, input.code),
				this.bucket.put(ver.deps, deps),
				this.bucket.put(ver.meta, JSON.stringify(version)),
			]);

			// Prune old versions after the new one is written. This is best-effort
			// and non-fatal: the save has already committed the new version above,
			// so a prune failure must never fail the user's save. We always keep the
			// just-written version (the new current_version_id).
			await this.pruneVersions(projectId, notebookId, MAX_VERSIONS, versionId);
		}

		// Mutate catalog snapshot
		await this.catalog.mutateSnapshot('notebook.update', actor, (snap: Snapshot) => ({
			...snap,
			projects: snap.projects.map((p) =>
				p.id === projectId
					? {
							...p,
							updated_at: now,
							notebooks: p.notebooks.map((n) =>
								n.id === notebookId
									? {
											...n,
											title: updated.title,
											description: updated.description,
											tags: updated.tags,
											updated_at: now,
										}
									: n,
							),
						}
					: p,
			),
		}));

		return updated;
	}

	async deleteNotebook(projectId: ProjectId, notebookId: NotebookId, actor: string): Promise<void> {
		const { meta } = await this.getNotebook(projectId, notebookId);
		const now = new Date().toISOString();

		// Soft-delete: update status in meta.json
		const updated: NotebookMeta = {
			...meta,
			status: 'deleted',
			updated_at: now,
		};
		const nb = paths.project(projectId).notebook(notebookId);
		await this.bucket.put(nb.meta, JSON.stringify(updated));

		// Soft-delete in snapshot
		await this.catalog.mutateSnapshot('notebook.delete', actor, (snap: Snapshot) => ({
			...snap,
			projects: snap.projects.map((p) =>
				p.id === projectId
					? {
							...p,
							updated_at: now,
							notebook_count: Math.max(0, p.notebook_count - 1),
							notebooks: p.notebooks.map((n) =>
								n.id === notebookId ? { ...n, status: 'deleted' as const, updated_at: now } : n,
							),
						}
					: p,
			),
		}));
	}

	async listVersions(projectId: ProjectId, notebookId: NotebookId): Promise<Version[]> {
		const nb = paths.project(projectId).notebook(notebookId);
		const result = await this.bucket.list({ prefix: `${nb.prefix}versions/`, delimiter: '/' });

		const versions: Version[] = [];
		for (const pfx of result.delimitedPrefixes) {
			const versionMetaKey = `${pfx}version.json`;
			const obj = await this.bucket.get(versionMetaKey);
			if (obj) {
				versions.push(VersionSchema.parse(await obj.json()));
			}
		}

		return versions;
	}

	async getVersion(
		projectId: ProjectId,
		notebookId: NotebookId,
		versionId: string,
	): Promise<{ version: Version; code: string }> {
		const vid = versionId as import('../ids').VersionId;
		const ver = paths.project(projectId).notebook(notebookId).version(vid);
		const [metaObj, codeObj] = await Promise.all([
			this.bucket.get(ver.meta),
			this.bucket.get(ver.code),
		]);

		if (!metaObj || !codeObj) {
			throw new NotFoundError(`Version ${versionId} not found`);
		}

		const version = VersionSchema.parse(await metaObj.json());
		const code = await codeObj.text();

		return { version, code };
	}

	/**
	 * Prune immutable version folders beyond the newest `max`, reclaiming storage
	 * after a code save. Versions are keyed by ULID, which sorts chronologically
	 * (newest last), so we keep the lexicographically-largest `max` prefixes. The
	 * `keep` version (the current `source.current_version_id`) is ALWAYS retained,
	 * even if it would otherwise fall outside the window, so version rollback to
	 * the current version is never broken.
	 *
	 * Best-effort: failures are swallowed (logged) so a prune error never fails
	 * the caller's save, which has already committed.
	 */
	private async pruneVersions(
		projectId: ProjectId,
		notebookId: NotebookId,
		max: number,
		keep: import('../ids').VersionId,
	): Promise<void> {
		try {
			const nb = paths.project(projectId).notebook(notebookId);
			const versionsRoot = `${nb.prefix}versions/`;
			const listing = await this.bucket.list({ prefix: versionsRoot, delimiter: '/' });

			// Each delimited prefix is `.../versions/{vid}/`; sort ascending so the
			// newest (largest ULID) sort last.
			const versionPrefixes = [...listing.delimitedPrefixes].sort();
			if (versionPrefixes.length <= max) {
				return;
			}

			// Keep the newest `max`; the rest are prune candidates.
			const prunable = versionPrefixes.slice(0, versionPrefixes.length - max);
			const keepPrefix = `${versionsRoot}${keep}/`;

			const keysToDelete: string[] = [];
			for (const vpfx of prunable) {
				// Never delete the current version, even if it falls in the prune window.
				if (vpfx === keepPrefix) {
					continue;
				}
				const keys = await listAllKeys(this.bucket, vpfx);
				keysToDelete.push(...keys);
			}

			if (keysToDelete.length > 0) {
				await this.bucket.delete(keysToDelete);
			}
		} catch (err) {
			// Non-fatal: the save already committed. Log and move on.
			console.error(
				`pruneVersions failed for notebook ${notebookId} in project ${projectId}:`,
				err,
			);
		}
	}

	/**
	 * Hard-delete a notebook's entire object subtree
	 * (`projects/{pid}/notebooks/{nid}/`), reclaiming all of its files, versions,
	 * README, and deps. This is the destructive operation the deferred GC pass
	 * needs for soft-deleted notebooks past their grace period.
	 *
	 * Refuses unless the notebook is soft-deleted (`status === 'deleted'`) so a
	 * live notebook can never be hard-deleted by mistake. Not wired to any route
	 * or cron here — callers (a future GC sweep) own the orchestration.
	 */
	async hardDeleteNotebook(projectId: ProjectId, notebookId: NotebookId): Promise<void> {
		const { meta } = await this.getNotebook(projectId, notebookId);
		if (meta.status !== 'deleted') {
			throw new Error(
				`Refusing to hard-delete notebook ${notebookId}: status is "${meta.status}", expected "deleted"`,
			);
		}

		const nb = paths.project(projectId).notebook(notebookId);
		// Notebook base is `projects/{pid}/notebooks/{nid}`; the subtree prefix is
		// that with a trailing slash so every file under it is captured.
		const prefix = `${nb.base}/`;
		const keys = await listAllKeys(this.bucket, prefix);
		if (keys.length > 0) {
			await this.bucket.delete(keys);
		}
	}
}

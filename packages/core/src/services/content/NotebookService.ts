import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { Millis } from '../../duration';
import { assertVersionMatch, BadRequestError, NotFoundError } from '../../errors';
import { createNotebookId, createVersionId, SYSTEM_ACTOR, VersionId } from '../../ids';
import { remoteWorkspaceEntry } from '../../integrations/remoteWorkspace';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { compensableWrite, metricsObserver, saga } from '../../saga';
import {
	FsSnapshotSchema,
	NotebookMetaSchema,
	parseStored,
	SourceSchema,
	toPublicNotebookEntry,
	VersionSchema,
} from '../../schema';
import type {
	FsSnapshot,
	NotebookMeta,
	PublicNotebookEntry,
	Snapshot,
	SnapshotDescriptor,
	Source,
	Version,
} from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { mutateObject } from '../catalog/cas';
import { buildNotebookEntry, buildNotebookMeta, buildVersion, localSource } from './notebookMeta';
import { SyncedNotebookService } from './SyncedNotebookService';
import { deleteByPrefix, listAllKeys, listAllObjects } from '../catalog/storage';

/**
 * Maximum number of immutable version folders to retain per notebook. Older
 * versions beyond this count are pruned after a code save. The current version
 * is always kept regardless of this bound. Conservative by design; make it
 * configurable if users ask for longer history.
 */
export const MAX_VERSIONS = 50;

/** Grace period before a soft-deleted notebook's storage is purged by the GC sweep. */
export const DEFAULT_DELETED_NOTEBOOK_RETENTION_MS = Millis.days(30);

export interface CreateNotebookInput {
	title: string;
	description: string;
	code: string;
	tags?: string[];
	readme?: string;
	deps?: string;
	runtime?: { python_version?: string; marimo_version?: string };
	base_image?: string;
}

export interface UpdateNotebookInput {
	title?: string;
	description?: string;
	code?: string;
	tags?: string[];
	readme?: string;
	deps?: string;
	message?: string;
	/** `null` clears the choice back to the deployment default; `undefined` leaves it unchanged. */
	base_image?: string | null;
}

export interface NotebookDetail {
	meta: NotebookMeta;
	readme: string | null;
	source: Source;
}

/**
 * Artifacts read back from a sandbox on session teardown. `code`/`deps` are the
 * final notebook files; `html`/`session` are marimo's optional `__marimo__`
 * outputs. Every field is optional — the sandbox may be unreadable, or marimo
 * may not have produced a given file.
 */
export interface CommitSessionInput {
	code?: string;
	deps?: string;
	html?: string;
	session?: string;
}

export interface CommitSessionResult {
	/** The version the artifacts were attached to (new or the reused current one). */
	versionId: VersionId;
	/** True when the session's edits differed from the current version, so a new one was cut. */
	newVersion: boolean;
	capturedHtml: boolean;
	capturedSession: boolean;
}

export class NotebookService {
	readonly synced: SyncedNotebookService;

	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
		private metrics: Metrics = noopMetrics,
	) {
		this.synced = new SyncedNotebookService(bucket, catalog, metrics, {
			getNotebook: (projectId, notebookId) => this.getNotebook(projectId, notebookId),
			pruneVersions: (projectId, notebookId, keep) =>
				this.pruneVersions(projectId, notebookId, MAX_VERSIONS, keep),
		});
	}

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

		const meta = parseStored(NotebookMetaSchema, await metaObj.json(), nb.meta);
		const source = parseStored(SourceSchema, await sourceObj.json(), nb.source);
		const readme = readmeObj ? await readmeObj.text() : null;

		return { meta, readme, source };
	}

	async getNotebookContent(projectId: ProjectId, notebookId: NotebookId): Promise<string> {
		const { source } = await this.getNotebook(projectId, notebookId);
		return this.getContentForSource(projectId, notebookId, source);
	}

	private async getContentForSource(
		projectId: ProjectId,
		notebookId: NotebookId,
		source: Source,
	): Promise<string> {
		const nb = paths.project(projectId).notebook(notebookId);
		const entryNotebook = remoteWorkspaceEntry(source);

		if (!entryNotebook) {
			const codeObj = await this.bucket.get(nb.code);
			if (!codeObj) {
				throw new NotFoundError(`Notebook code for ${notebookId} not found`);
			}
			return codeObj.text();
		}

		// Synced sources serve the entry notebook from the immutable workspace of the
		// version the source pointer currently references.
		if (!source.current_version_id) {
			throw new NotFoundError(`Synced notebook ${notebookId} has not been synced`);
		}
		const codeObj = await this.bucket.get(
			nb.version(source.current_version_id).workspaceFile(entryNotebook),
		);
		if (!codeObj) {
			throw new NotFoundError(`Synced notebook ${notebookId} has not been synced`);
		}
		return codeObj.text();
	}

	/**
	 * Read every file under a notebook's `workspace/` mirror, each with its path
	 * relative to the workspace root (e.g. `notebook.py`, `data/cars.csv`). Used to
	 * package the workspace for download. The notebook must exist (404 otherwise);
	 * an empty workspace simply yields an empty list. Vendor-free by design — the
	 * caller (api) owns any archive encoding so `core` keeps no zip dependency.
	 */
	async listWorkspaceFiles(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<{ path: string; bytes: Uint8Array }[]> {
		// Assert the notebook exists so a missing notebook is a 404, not an empty zip.
		const { source } = await this.getNotebook(projectId, notebookId);

		const nb = paths.project(projectId).notebook(notebookId);
		// Local notebooks keep a live `workspace/` mirror; synced ones serve the
		// immutable workspace of the version their source points at (an unsynced
		// draft has none yet).
		const prefix = remoteWorkspaceEntry(source)
			? source.current_version_id && nb.version(source.current_version_id).workspacePrefix
			: nb.workspacePrefix;
		if (!prefix) return [];
		const objects = await listAllObjects(this.bucket, prefix);

		// Read the workspace files in bounded-parallel (download-to-zip path).
		const read = await mapWithConcurrency(objects, BUCKET_SCAN_CONCURRENCY, async ({ key }) => {
			const obj = await this.bucket.get(key);
			if (!obj) return; // listed-then-deleted race; skip rather than fail.
			return { path: key.slice(prefix.length), bytes: await obj.bytes() };
		});
		return read.filter((f): f is { path: string; bytes: Uint8Array } => f !== undefined);
	}

	/**
	 * The deps to persist for a save: the caller's `input.deps`, or — when they
	 * sent none — the currently-stored deps, so a code-only save never wipes the
	 * notebook's pyproject.toml.
	 */
	private async resolveDeps(depsKey: string, incoming: string | undefined): Promise<string> {
		if (incoming !== undefined) return incoming;
		const existing = await this.bucket.get(depsKey);
		return existing ? existing.text() : '';
	}

	async createNotebook(
		projectId: ProjectId,
		input: CreateNotebookInput,
		actor: UserId,
	): Promise<NotebookMeta> {
		const notebookId = createNotebookId();
		const versionId = createVersionId();
		const now = new Date().toISOString();

		const meta = buildNotebookMeta({
			notebookId,
			projectId,
			actor,
			now,
			status: 'active',
			title: input.title,
			description: input.description,
			tags: input.tags,
			runtime: input.runtime,
			baseImage: input.base_image,
		});

		const source = localSource(versionId);

		const version = buildVersion({
			versionId,
			notebookId,
			now,
			author: actor,
			message: 'Initial version',
			parentId: null,
		});

		const nb = paths.project(projectId).notebook(notebookId);
		const ver = nb.version(versionId);
		// Every blob this create writes; deleting them unreferences the notebook.
		const contentKeys = [
			nb.meta,
			nb.readme,
			nb.source,
			nb.code,
			nb.deps,
			ver.code,
			ver.deps,
			ver.meta,
		];

		// Write the immutable content + version blobs, then record the notebook in the
		// catalog. If the catalog write fails the notebook is unreferenced, so the
		// saga compensates by deleting the orphaned blobs.
		await saga(metricsObserver(this.metrics, 'saga.notebook_create'))
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
						() => this.bucket.put(nb.code, input.code),
						() => this.bucket.put(nb.deps, input.deps ?? ''),
						() => this.bucket.put(ver.code, input.code),
						() => this.bucket.put(ver.deps, input.deps ?? ''),
						() => this.bucket.put(ver.meta, JSON.stringify(version)),
					],
					() => this.bucket.delete(contentKeys),
				),
			)
			.step('catalog', () =>
				this.catalog.appendNotebookEntry(
					'notebook.create',
					actor,
					projectId,
					buildNotebookEntry(meta, 'local', nb.base, actor),
				),
			)
			.run();

		return meta;
	}

	/**
	 * Duplicate a notebook into a fresh local notebook in the same project: copy
	 * its current code, deps, readme, description, tags, and runtime under a new
	 * notebook id with its own initial version. Synced (git-backed) notebooks are
	 * duplicated as a plain local copy of their current entry-notebook code — the
	 * copy is detached from the upstream repo, so it is editable like any local
	 * notebook. The new title defaults to `"<title> (copy)"`.
	 */
	async duplicateNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		newTitle?: string,
	): Promise<NotebookMeta> {
		const { meta, readme, source } = await this.getNotebook(projectId, notebookId);
		const [code, depsObj] = await Promise.all([
			this.getContentForSource(projectId, notebookId, source),
			this.bucket.get(paths.project(projectId).notebook(notebookId).deps),
		]);
		const deps = depsObj ? await depsObj.text() : '';

		return this.createNotebook(
			projectId,
			{
				title: newTitle?.trim() || `${meta.title} (copy)`,
				description: meta.description,
				code,
				tags: meta.tags,
				readme: readme ?? undefined,
				deps,
				runtime: meta.runtime,
				base_image: meta.base_image,
			},
			actor,
		);
	}

	async updateNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: UpdateNotebookInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<NotebookMeta> {
		const detail = await this.getNotebook(projectId, notebookId);
		return this.updateNotebookFrom(detail, projectId, notebookId, input, actor, expectedVersion);
	}

	private async updateNotebookFrom(
		detail: NotebookDetail,
		projectId: ProjectId,
		notebookId: NotebookId,
		input: UpdateNotebookInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<NotebookMeta> {
		const { meta: existing, source } = detail;
		assertVersionMatch(existing.updated_at, expectedVersion);
		if (source.type !== 'local' && (input.code !== undefined || input.deps !== undefined)) {
			throw new BadRequestError('Remote-backed notebook source is updated only by sync');
		}
		const now = new Date().toISOString();

		const updated: NotebookMeta = {
			...existing,
			title: input.title ?? existing.title,
			description: input.description ?? existing.description,
			tags: input.tags ?? existing.tags,
			// null clears back to the deployment default (the key is dropped from
			// the written JSON); undefined leaves the stored choice as-is.
			base_image: input.base_image === null ? undefined : (input.base_image ?? existing.base_image),
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

			// Read once, before the Promise.all, so the read does not race the write
			// of the same key inside the batch.
			const deps = await this.resolveDeps(nb.deps, input.deps);

			const version = buildVersion({
				versionId,
				notebookId,
				now,
				author: actor,
				message: input.message ?? 'Update',
				parentId: source.current_version_id,
			});

			const newSource = localSource(versionId);

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

		await this.catalog.updateNotebookEntry(
			'notebook.update',
			actor,
			projectId,
			notebookId,
			() => ({
				title: updated.title,
				description: updated.description,
				tags: updated.tags,
				updated_at: now,
			}),
			() => ({ updated_at: now }),
		);

		return updated;
	}

	/**
	 * Restore a prior version: read its stored code + deps and cut a NEW version
	 * carrying them, leaving history intact (a restore is just another save). 404 if
	 * the version folder does not exist under this notebook. Returns the updated meta.
	 */
	async restoreVersion(
		projectId: ProjectId,
		notebookId: NotebookId,
		versionId: VersionId,
		actor: UserId,
	): Promise<NotebookMeta> {
		const detail = await this.getNotebook(projectId, notebookId);
		if (detail.source.type !== 'local') {
			throw new BadRequestError('Cannot restore a version of a non-local notebook');
		}

		const ver = paths.project(projectId).notebook(notebookId).version(versionId);
		const [metaObj, codeObj, depsObj] = await Promise.all([
			this.bucket.get(ver.meta),
			this.bucket.get(ver.code),
			this.bucket.get(ver.deps),
		]);
		if (!metaObj) {
			throw new NotFoundError(`Version ${versionId} not found`);
		}

		const code = codeObj ? await codeObj.text() : '';
		const deps = depsObj ? await depsObj.text() : undefined;
		return this.updateNotebookFrom(
			detail,
			projectId,
			notebookId,
			{ code, deps, message: `Restore version ${versionId}` },
			actor,
		);
	}

	/**
	 * Commit a session's final state on teardown: cut a new version from the
	 * notebook files read back out of the sandbox, then attach marimo's optional
	 * HTML / session snapshots to that version. This is the only path that versions
	 * interactive kernel edits — those land directly on the live `notebook.py` (via
	 * mount or copy-back) and never go through `updateNotebook`, so without this an
	 * editing session would leave no version record.
	 *
	 * A new version is cut only when the read-back code/deps differ from the current
	 * version, so a read-only session creates no spurious version. When unchanged,
	 * the snapshots attach to the existing current version folder. Returns null when
	 * the notebook is not `local` or no code could be read back (nothing to commit).
	 */
	async commitSession(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: CommitSessionInput,
		actor: UserId,
	): Promise<CommitSessionResult | null> {
		const { source } = await this.getNotebook(projectId, notebookId);
		// Remote-backed notebooks are updated by their integration sync path.
		if (source.type !== 'local') {
			return null;
		}
		// No code read back (sandbox unreadable / file missing) — nothing to version.
		if (input.code === undefined) {
			return null;
		}

		const nb = paths.project(projectId).notebook(notebookId);
		const now = new Date().toISOString();

		// Preserve existing deps when none were read back, so a missing pyproject.toml
		// in the sandbox does not wipe the stored one.
		const deps = await this.resolveDeps(nb.deps, input.deps);

		// Compare against the CURRENT version's stored code+deps to decide whether the
		// session actually changed anything. If not, reuse it (no spurious version).
		const current = nb.version(source.current_version_id);
		const [curCodeObj, curDepsObj] = await Promise.all([
			this.bucket.get(current.code),
			this.bucket.get(current.deps),
		]);
		const curCode = curCodeObj ? await curCodeObj.text() : undefined;
		const curDeps = curDepsObj ? await curDepsObj.text() : '';
		const changed = input.code !== curCode || deps !== curDeps;

		const htmlDescriptor: SnapshotDescriptor | undefined =
			input.html !== undefined
				? { captured_at: now, size_bytes: byteLength(input.html) }
				: undefined;
		const sessionDescriptor: SnapshotDescriptor | undefined =
			input.session !== undefined
				? { captured_at: now, size_bytes: byteLength(input.session) }
				: undefined;

		let versionId = source.current_version_id;
		let newVersion = false;

		if (changed) {
			versionId = createVersionId();
			newVersion = true;

			const version: Version = {
				...buildVersion({
					versionId,
					notebookId,
					now,
					author: actor,
					message: 'Session edits',
					parentId: source.current_version_id,
				}),
				...(htmlDescriptor ? { html_snapshot: htmlDescriptor } : {}),
				...(sessionDescriptor ? { session_snapshot: sessionDescriptor } : {}),
			};

			const newSource = localSource(versionId);

			const ver = nb.version(versionId);
			await Promise.all([
				// Live notebook files reflect the session's final state.
				this.bucket.put(nb.code, input.code),
				this.bucket.put(nb.deps, deps),
				this.bucket.put(nb.source, JSON.stringify(newSource)),
				// Immutable version snapshot (version.json already carries any descriptors).
				this.bucket.put(ver.code, input.code),
				this.bucket.put(ver.deps, deps),
				this.bucket.put(ver.meta, JSON.stringify(version)),
				...(input.html !== undefined
					? [this.bucket.put(ver.html, input.html, { httpMetadata: { contentType: 'text/html' } })]
					: []),
				...(input.session !== undefined
					? [
							this.bucket.put(ver.session, input.session, {
								httpMetadata: { contentType: 'application/json' },
							}),
						]
					: []),
			]);

			await this.pruneVersions(projectId, notebookId, MAX_VERSIONS, versionId);
		} else if (htmlDescriptor || sessionDescriptor) {
			// Unchanged code: attach the fresh snapshots to the existing current version.
			// This additively patches that version.json (adds optional descriptor
			// fields) and writes the sidecar artifacts — a newer render replaces an
			// older one for the same code.
			//
			// Read version.json FIRST: if it is somehow missing (it should never be —
			// the current version is always retained by pruning), skip the whole attach
			// rather than write sidecar files we can never record a descriptor for.
			const ver = nb.version(versionId);
			const metaObj = await this.bucket.get(ver.meta);
			if (metaObj) {
				await Promise.all([
					...(input.html !== undefined
						? [
								this.bucket.put(ver.html, input.html, {
									httpMetadata: { contentType: 'text/html' },
								}),
							]
						: []),
					...(input.session !== undefined
						? [
								this.bucket.put(ver.session, input.session, {
									httpMetadata: { contentType: 'application/json' },
								}),
							]
						: []),
				]);
				// CAS the descriptor patch so two concurrent teardowns of the same
				// notebook cannot drop each other's descriptor.
				try {
					await mutateObject(
						this.bucket,
						ver.meta,
						(raw) => VersionSchema.parse(raw),
						(current): Version => ({
							...current,
							...(htmlDescriptor ? { html_snapshot: htmlDescriptor } : {}),
							...(sessionDescriptor ? { session_snapshot: sessionDescriptor } : {}),
						}),
					);
				} catch (err) {
					// version.json deleted between the read above and the CAS write
					// (e.g. concurrent notebook purge). Best-effort remove the sidecars we
					// just wrote so we don't leak untracked artifacts no descriptor points
					// at — matching the read-first "skip the whole attach" contract.
					if (!(err instanceof NotFoundError)) throw err;
					const orphans = [
						input.html !== undefined ? ver.html : undefined,
						input.session !== undefined ? ver.session : undefined,
					].filter((k): k is string => k !== undefined);
					if (orphans.length > 0) await this.bucket.delete(orphans).catch(() => {});
				}
			}
		}

		return {
			versionId,
			newVersion,
			capturedHtml: input.html !== undefined,
			capturedSession: input.session !== undefined,
		};
	}

	async deleteNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		expectedVersion?: string,
	): Promise<void> {
		const { meta } = await this.getNotebook(projectId, notebookId);
		assertVersionMatch(meta.updated_at, expectedVersion);
		// Idempotent: a notebook already soft-deleted is left untouched, so a repeated
		// delete (retry / double-click) cannot decrement notebook_count twice.
		if (meta.status === 'deleted') {
			return;
		}
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
		await this.catalog.updateNotebookEntry(
			'notebook.delete',
			actor,
			projectId,
			notebookId,
			() => ({ status: 'deleted' as const, updated_at: now }),
			(p) => ({ updated_at: now, notebook_count: Math.max(0, p.notebook_count - 1) }),
		);
	}

	async listVersions(projectId: ProjectId, notebookId: NotebookId): Promise<Version[]> {
		const nb = paths.project(projectId).notebook(notebookId);
		const result = await this.bucket.list({ prefix: `${nb.base}/versions/`, delimiter: '/' });

		const fetched = await mapWithConcurrency(
			result.delimitedPrefixes,
			BUCKET_SCAN_CONCURRENCY,
			async (pfx) => {
				const obj = await this.bucket.get(`${pfx}version.json`);
				if (!obj) return; // listed-then-deleted race; skip rather than fail.
				return VersionSchema.parse(await obj.json());
			},
		);
		return fetched.filter((v): v is Version => v !== undefined);
	}

	async getVersion(
		projectId: ProjectId,
		notebookId: NotebookId,
		versionId: string,
	): Promise<{ version: Version; code: string }> {
		// A malformed id is a client mistake, not a server fault: map the bare parse
		// Error to a domain 404 so the API renders a 4xx instead of a raw 500.
		let vid: VersionId;
		try {
			vid = VersionId.parse(versionId);
		} catch {
			throw new NotFoundError(`Version ${versionId} not found`);
		}
		const { source } = await this.getNotebook(projectId, notebookId);
		const ver = paths.project(projectId).notebook(notebookId).version(vid);
		const entryNotebook = remoteWorkspaceEntry(source);
		const codeKey = entryNotebook ? ver.workspaceFile(entryNotebook) : ver.code;
		const [metaObj, codeObj] = await Promise.all([
			this.bucket.get(ver.meta),
			this.bucket.get(codeKey),
		]);

		if (!metaObj || !codeObj) {
			throw new NotFoundError(`Version ${versionId} not found`);
		}

		const version = VersionSchema.parse(await metaObj.json());
		const code = await codeObj.text();

		return { version, code };
	}

	/**
	 * The newest version's HTML snapshot, for the viewer static mode. Snapshots
	 * are captured best-effort at teardown, so the current version may lack one
	 * while an older version has it — walk newest-first (version ULIDs sort
	 * chronologically) to the newest version carrying an `html_snapshot`
	 * descriptor. Null when no version has one (or the object was pruned between
	 * list and read).
	 */
	async getLatestHtmlSnapshot(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<{ versionId: string; capturedAt: string; html: string } | null> {
		const versions = await this.listVersions(projectId, notebookId);
		const withSnapshot = versions
			.filter((v) => v.html_snapshot)
			.sort((a, b) => b.version_id.localeCompare(a.version_id));
		const nb = paths.project(projectId).notebook(notebookId);
		for (const v of withSnapshot) {
			const obj = await this.bucket.get(nb.version(v.version_id).html);
			if (!obj) continue;
			return {
				versionId: v.version_id,
				capturedAt: v.html_snapshot!.captured_at,
				html: await obj.text(),
			};
		}
		return null;
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
		keep: VersionId,
	): Promise<void> {
		try {
			const nb = paths.project(projectId).notebook(notebookId);
			const versionsRoot = `${nb.base}/versions/`;
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

			// Never delete the current version, even if it falls in the prune window.
			const targets = prunable.filter((vpfx) => vpfx !== keepPrefix);
			const keyLists = await mapWithConcurrency(targets, BUCKET_SCAN_CONCURRENCY, (vpfx) =>
				listAllKeys(this.bucket, vpfx),
			);
			const keysToDelete = keyLists.flat();

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
	 * Read the notebook's current filesystem-snapshot pointer, or null when none
	 * exists or it cannot be parsed. The pointer lives in a dedicated
	 * `fs_snapshot.json` sidecar so the teardown-path rewrites of source.json /
	 * meta.json never clobber it.
	 */
	async getFsSnapshot(projectId: ProjectId, notebookId: NotebookId): Promise<FsSnapshot | null> {
		const nb = paths.project(projectId).notebook(notebookId);
		const obj = await this.bucket.get(nb.fsSnapshot);
		if (!obj) return null;
		try {
			return FsSnapshotSchema.parse(await obj.json());
		} catch {
			return null;
		}
	}

	/**
	 * Overwrite the notebook's filesystem-snapshot pointer (latest-wins) and return
	 * the PREVIOUS one so the caller can delete the now-orphaned snapshot from the
	 * provider. Pass `null` to clear the pointer. A plain put (last-writer-wins, no
	 * CAS), which is acceptable under the latest-wins contract.
	 */
	async setFsSnapshot(
		projectId: ProjectId,
		notebookId: NotebookId,
		snapshot: FsSnapshot | null,
	): Promise<{ previous: FsSnapshot | null }> {
		const previous = await this.getFsSnapshot(projectId, notebookId);
		const nb = paths.project(projectId).notebook(notebookId);
		if (snapshot) {
			await this.bucket.put(nb.fsSnapshot, JSON.stringify(snapshot));
		} else {
			await this.bucket.delete(nb.fsSnapshot);
		}
		return { previous };
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
		await deleteByPrefix(this.bucket, `${nb.base}/`);
	}

	/**
	 * GC sweep: hard-delete soft-deleted notebooks whose grace period has elapsed
	 * (deletion time = `updated_at`), then drop them from the snapshot. Returns the
	 * number purged plus any filesystem-snapshot pointers found on the purged
	 * notebooks — the provider-native snapshots they reference are NOT in the
	 * bucket, so the caller (which holds the concrete provider) must delete them or
	 * they leak billable storage. They are read off `fs_snapshot.json` BEFORE the
	 * subtree wipe removes it.
	 *
	 * Notebooks under a soft-deleted project are skipped — `sweepDeletedProjects`
	 * reclaims that whole subtree in one shot, so run it first. `notebook_count`
	 * was already decremented at soft-delete time, so it is left untouched here.
	 */
	async sweepDeletedNotebooks(
		retentionMs: number = DEFAULT_DELETED_NOTEBOOK_RETENTION_MS,
	): Promise<{ purged: number; orphanedSnapshots: FsSnapshot[] }> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const now = Date.now();

		const stale: { projectId: ProjectId; notebookId: NotebookId }[] = [];
		for (const project of snapshot.projects) {
			if (project.status === 'deleted') continue; // owned by sweepDeletedProjects
			for (const nb of project.notebooks) {
				if (nb.status === 'deleted' && now - Date.parse(nb.updated_at) >= retentionMs) {
					stale.push({ projectId: project.id, notebookId: nb.id });
				}
			}
		}
		if (stale.length === 0) return { purged: 0, orphanedSnapshots: [] };

		const orphanedSnapshots: FsSnapshot[] = [];
		for (const { projectId, notebookId } of stale) {
			// Read the snapshot pointer before the subtree wipe destroys the sidecar.
			const fs = await this.getFsSnapshot(projectId, notebookId);
			if (fs) orphanedSnapshots.push(fs);
			await this.hardDeleteNotebook(projectId, notebookId);
		}

		// Drop the swept notebook entries from their projects. Group by project so a
		// project with multiple purged notebooks is rewritten once.
		const dropByProject = new Map<ProjectId, Set<NotebookId>>();
		for (const { projectId, notebookId } of stale) {
			const set = dropByProject.get(projectId) ?? new Set<NotebookId>();
			set.add(notebookId);
			dropByProject.set(projectId, set);
		}
		await this.catalog.mutateSnapshot(
			'notebook.gc',
			SYSTEM_ACTOR,
			(snap: Snapshot) => ({
				...snap,
				projects: snap.projects.map((p) => {
					const drop = dropByProject.get(p.id);
					if (!drop) return p;
					return { ...p, notebooks: p.notebooks.filter((n) => !drop.has(n.id)) };
				}),
			}),
			{
				notebooks: stale.map(({ projectId, notebookId }) => ({
					project_id: projectId,
					notebook_id: notebookId,
				})),
			},
		);

		return { purged: stale.length, orphanedSnapshots };
	}
}

/** UTF-8 byte length of a string, for snapshot `size_bytes` descriptors. */
function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

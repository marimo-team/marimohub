import {
	readLocalPublication,
	publishLocalSource,
	publishedVersion,
	publicationArtifactKey,
} from './localPublication';
import type { LocalPublicationToken } from './localPublication';
import {
	readRetentionCursor,
	writeRetentionCursor,
	retentionBatch,
} from '../catalog/retentionCursor';
import { BoundedLruMap } from '../../cache';
import type { PromiseMemo } from '../../cache';
import { sha256Hex } from '../../internal/sha256';
import { deferOrAwait } from '../../ports/backgroundWork';
import type { BackgroundWork } from '../../ports/backgroundWork';
import { copyMoveObject, copyMovePrefix, moveJson } from './moveObjects';
import { assertNotMoving, readNotebookMove } from './notebookMoveRecord';
import { ResumableUploads } from './ResumableUploads';
import type { WorkspaceLimits } from '../../integrations/remoteWorkspace';
import { MetadataCache } from './metadataCache';
import type { ReadConsistency } from './metadataCache';
import { NotebookImportService } from './NotebookImportService';
import { PreviewStore } from './PreviewStore';
import {
	WorkingBranchStore,
	workingBranchPaths,
	WorkingBranchSaveSchema,
	WorkingBranchRecordSchema,
} from './workingBranchRecords';
import { previewAvailable, previewKey, PreviewRecordSchema } from './notebookPreviews';
import type { GitProviderHosts } from '../../integrations/gitRepo';
import { ThumbnailService } from './ThumbnailService';
import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY, NOTEBOOK_META_CACHE_MAX_ENTRIES } from '../../constants';
import { Millis } from '../../duration';
import {
	assertVersionMatch,
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
} from '../../errors';
import { createNotebookId, createVersionId, SYSTEM_ACTOR, VersionId } from '../../ids';
import {
	isWorkspaceDirectoryMarkerPath,
	localEntryNotebook,
	remoteWorkspaceEntry,
	workspaceSourcePolicy,
} from '../../integrations/remoteWorkspace';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { compensableWrite, metricsObserver, saga } from '../../saga';
import {
	FsSnapshotSchema,
	JobRunMarkerSchema,
	NotebookMetaSchema,
	PreviewRuntimeMetaSchema,
	parseStored,
	readStored,
	SourceSchema,
	toPublicNotebookEntry,
	VersionSchema,
} from '../../schema';
import type { AuthSubject } from '../../authz';
import { AuthorizationService } from '../authorization/AuthorizationService';
import { filterByLabelConstraints } from '../authorization/labelFilter';
import type {
	AuthorizationPolicy,
	ResourceSecurityPolicy,
} from '../authorization/AuthorizationService';
import { normalizeSecurityLabels } from '../../securityLabels';
import type { ResourceSecurityLabels } from '../../securityLabels';
import type {
	FsSnapshot,
	NotebookMeta,
	PublicNotebookEntry,
	Snapshot,
	LocalPublicationVersion,
	PublicationArtifact,
	SnapshotNotebookEntry,
	Source,
	Version,
} from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { projectsById } from '../catalog/snapshotCache';
import { mutateObject, mutateObjectWithOutcome } from '../catalog/cas';
import {
	buildNotebookEntry,
	buildNotebookMeta,
	buildVersion,
	localSource,
	notebookCatalogPatch,
} from './notebookMeta';
import { SyncedNotebookService } from './SyncedNotebookService';
import { deleteByPrefix, listAllKeys, listAllObjects, listAllPrefixes } from '../catalog/storage';
import { loadNotebookCatalogPatch } from './catalogProjection';
import { createListFilter } from './listFilters';
import type { ListFilters } from './listFilters';
import { NotebookWorkspaceService } from './NotebookWorkspaceService';
import { DeepLinkService } from './DeepLinkService';
import { SessionService } from '../runtime/SessionService';
import { AppPoolStore } from '../runtime/AppPoolStore';
import { nextIsoTimestamp } from '../../utcDate';
import { decodeUtf8PreservingBom } from '../../text';

/**
 * Maximum number of immutable version folders to retain per notebook. Older
 * versions beyond this count are pruned after a code save. The current version
 * is always kept regardless of this bound. Conservative by design; make it
 * configurable if users ask for longer history.
 */
export const MAX_VERSIONS = 50;

/** Grace period before a soft-deleted notebook's storage is purged by the GC sweep. */
export const DEFAULT_DELETED_NOTEBOOK_RETENTION_MS = Millis.days(30);

const NOTEBOOK_GC_CURSOR_KEY = '_system/notebook-gc-cursor.json';
const GC_CYCLES_PER_DAY = 24;

export interface CreateNotebookInput {
	title: string;
	description: string;
	code: string;
	tags?: string[];
	readme?: string;
	deps?: string;
	runtime?: { python_version?: string; marimo_version?: string };
	base_image?: string;
	compute_profile?: string;
	app_compute_profile?: string;
	/** Explicit entrypoints opt local notebooks into full workspace persistence. */
	entry_notebook?: string;
	workspaceFiles?: { path: string; bytes: Uint8Array }[];
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
	/** `null` clears the choice back to the deployment default; `undefined` leaves it unchanged. */
	compute_profile?: string | null;
	app_compute_profile?: string | null;
}

export interface NotebookDeleteMutationResult {
	notebook: NotebookMeta;
	mutationId: Snapshot['snapshot_id'];
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

/**
 * A notebook in transit is unreadable and unwritable in both projects until the move
 * publishes. Every `meta.json` CAS callback repeats this check, because a writer that read
 * before the fence would otherwise retry onto the fenced record and keep its stamp.
 */
export class NotebookService {
	// This caches only the storage path; every request still validates the runtime metadata.
	private readonly previewMetadata = new BoundedLruMap<string, true>(
		NOTEBOOK_META_CACHE_MAX_ENTRIES,
	);

	private readonly metaCache: MetadataCache<NotebookMeta>;
	private readonly sourceCache: MetadataCache<Source>;
	private readonly versionContents = new BoundedLruMap<string, { code: string; deps: string }>(128);

	private async readVersionContents(key: string, depsKey: string) {
		const cached = this.versionContents.get(key);
		if (cached) return { ...cached, complete: true };
		const [codeObject, depsObject] = await Promise.all([
			this.bucket.get(key),
			this.bucket.get(depsKey),
		]);
		const code = codeObject ? decodeUtf8PreservingBom(await codeObject.bytes()) : undefined;
		const deps = depsObject ? await depsObject.text() : '';
		// Version payloads are immutable. Bound retained strings to 16 MiB per service.
		if (code !== undefined && depsObject && (code.length + deps.length) * 2 <= 128 * 1024)
			this.versionContents.set(key, { code, deps });
		return { code, deps, complete: code !== undefined && !!depsObject };
	}

	readonly synced: SyncedNotebookService;
	readonly thumbnails: ThumbnailService;
	readonly workspace: NotebookWorkspaceService;
	readonly imports: NotebookImportService;

	/** Removes the metadata records first so the source stops resolving before its files go. */
	async removeMovedObjects(projectId: ProjectId, notebookId: NotebookId): Promise<void> {
		const nb = paths.project(projectId).notebook(notebookId);
		await this.bucket.delete([nb.meta, nb.previewMeta]);
		await deleteByPrefix(this.bucket, `${nb.base}/`);
	}

	async pruneVersionsAfterMove(projectId: ProjectId, notebookId: NotebookId): Promise<void> {
		await this.pruneVersions(projectId, notebookId, MAX_VERSIONS);
	}

	/**
	 * Copies notebook files, versions, and source into the destination. The metadata record is
	 * written last and still fenced by `moveId`, so the copy never resolves before publication.
	 */
	async copyForMove(
		source: ProjectId,
		destination: ProjectId,
		nid: NotebookId,
		updatedAt: string,
		moveId: string,
	): Promise<void> {
		const from = paths.project(source).notebook(nid);
		const to = paths.project(destination).notebook(nid);
		const metaFiles = ['meta.json', 'preview-runtime.json'];
		await copyMovePrefix(this.bucket, `${from.base}/`, `${to.base}/`, {
			include: (key) =>
				!metaFiles.includes(key) &&
				!/^(jobs\/|job-index\/|proposals\/|thumbnail.json$|thumbnails\/|thumbnail-attempts\/|deep-links\/|uploads\/|workspace_mutation_claim.json$|integration_sync_token.json$|fs_snapshot.json$)/.test(
					key,
				),
		});
		for (const file of metaFiles) {
			await copyMoveObject(this.bucket, `${from.base}/${file}`, `${to.base}/${file}`, (bytes) =>
				moveJson(bytes, (meta) => ({
					...meta,
					project_id: destination,
					updated_at: updatedAt,
					move_id: moveId,
				})),
			);
		}
	}

	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
		private metrics: Metrics = noopMetrics,
		private sessions = new SessionService(bucket, metrics),
		private deepLinks = new DeepLinkService(bucket, metrics),
		repositoryHosts?: GitProviderHosts,
		workspaceLimits?: WorkspaceLimits,
		private backgroundWork?: BackgroundWork,
	) {
		this.metaCache = new MetadataCache(
			bucket,
			NOTEBOOK_META_CACHE_MAX_ENTRIES,
			undefined,
			metrics,
			{ cache: 'notebook', service: 'NotebookService' },
		);
		this.sourceCache = new MetadataCache(
			bucket,
			NOTEBOOK_META_CACHE_MAX_ENTRIES,
			undefined,
			metrics,
			{ cache: 'source', service: 'NotebookService' },
		);
		this.thumbnails = new ThumbnailService(bucket, this);
		this.imports = new NotebookImportService(bucket, this);
		this.synced = new SyncedNotebookService(bucket, catalog, metrics, {
			repositoryHosts,
			getNotebook: (projectId, notebookId) => this.getNotebook(projectId, notebookId),
			pruneVersions: (projectId, notebookId, keep) =>
				this.pruneVersions(projectId, notebookId, MAX_VERSIONS, keep),
		});
		this.workspace = new NotebookWorkspaceService(
			bucket,
			{
				getNotebook: (projectId, notebookId) => this.getNotebook(projectId, notebookId),
				saveSourceFile: (projectId, notebookId, path, content, actor, assertWritable) =>
					this.saveWorkspaceSourceFile(projectId, notebookId, path, content, actor, assertWritable),
			},
			workspaceLimits,
		);
	}

	/**
	 * `path` is a string, not a literal union, because an imported local source's
	 * entrypoint can be any notebook path. Callers only route the source's
	 * entrypoint and `pyproject.toml` here.
	 */
	private async saveWorkspaceSourceFile(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
		content: string,
		actor: UserId,
		assertWritable: () => Promise<void>,
	): Promise<void> {
		const detail = await this.getNotebook(projectId, notebookId);
		const input = path === 'pyproject.toml' ? { deps: content } : { code: content };
		await this.updateNotebookFrom(
			detail,
			projectId,
			notebookId,
			{ ...input, message: `Edit ${path}` },
			actor,
			detail.meta.updated_at,
			assertWritable,
		);
	}

	async listNotebooks(
		projectId: ProjectId,
		filter?: ListFilters<NotebookMeta['status']> & {
			subject?: AuthSubject;
			policy?: AuthorizationPolicy;
			resourceSecurity?: ResourceSecurityPolicy;
			action?: 'project.read' | 'app.read';
		},
		/** A caller listing several projects can share one snapshot read. */
		shared?: Snapshot,
	): Promise<PublicNotebookEntry[]> {
		const snapshot = shared ?? (await this.catalog.getCurrentSnapshot());
		const project = projectsById(snapshot).get(projectId);
		if (!project) {
			throw new NotFoundError(`Project ${projectId} not found`);
		}
		const matching = project.notebooks.filter(
			createListFilter<SnapshotNotebookEntry>(filter, (notebook) => [
				notebook.title,
				notebook.description,
			]),
		);
		if (filter?.subject === undefined) return matching.map(toPublicNotebookEntry);
		// Security-label override filter, mirroring the project list: the caller
		// already satisfied the PROJECT labels to see this list at all, so only
		// notebook overrides are decided here — one batch decision per page, with
		// indeterminate (legacy or mutation-in-flight) projections resolved from
		// the authoritative notebook record, failing closed when unreadable.
		const authz = new AuthorizationService(filter.policy, filter.resourceSecurity);
		return (
			await filterByLabelConstraints(
				authz,
				filter.subject,
				matching,
				(entry) =>
					// Meta-only read: an unavailable readme/source blob must not hide a
					// notebook whose label state is perfectly resolvable.
					this.getSecurityLabels(projectId, entry.id, {
						includeDeleted: filter.status === 'deleted',
					}),
				filter.action,
			)
		).map(toPublicNotebookEntry);
	}

	async getNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		options: { readMemo?: PromiseMemo } = {},
	): Promise<NotebookDetail> {
		const nb = paths.project(projectId).notebook(notebookId);
		const [storedMeta, ownReadmeObj, sourceObj] = await Promise.all([
			this.readNotebookMeta(projectId, notebookId),
			this.bucket.get(nb.readme),
			this.bucket.get(nb.source),
		]);

		if (!sourceObj) {
			throw new NotFoundError(`Notebook ${notebookId} not found`);
		}

		// Preview runtimes have no README of their own; they show the parent's.
		const [meta, readmeObj] = await Promise.all([
			this.resolvePreviewMeta(projectId, storedMeta, options.readMemo),
			storedMeta.preview
				? this.bucket.get(paths.project(projectId).notebook(storedMeta.preview.notebook_id).readme)
				: ownReadmeObj,
		]);
		const source = await readStored(SourceSchema, sourceObj, nb.source);
		const readme = readmeObj ? await readmeObj.text() : null;

		return { meta, readme, source };
	}

	private async readNotebookMeta(
		projectId: ProjectId,
		notebookId: NotebookId,
		options: { consistency?: ReadConsistency } = {},
	): Promise<NotebookMeta> {
		const nb = paths.project(projectId).notebook(notebookId);
		// Separate preview metadata keeps old replicas from stripping the preview marker.
		const meta = await this.metaCache.read(
			this.previewMetadata.has(nb.previewMeta)
				? [nb.previewMeta, nb.meta]
				: [nb.meta, nb.previewMeta],
			(object) =>
				object.key === nb.meta
					? readStored(NotebookMetaSchema, object, nb.meta)
					: readStored(PreviewRuntimeMetaSchema, object, nb.previewMeta),
			options.consistency,
		);
		if (!meta) throw new NotFoundError(`Notebook ${notebookId} not found`);
		assertNotMoving(meta, notebookId);
		if (meta.preview) this.previewMetadata.set(nb.previewMeta, true);
		else this.previewMetadata.delete(nb.previewMeta);
		return meta;
	}

	async getNotebookMeta(
		projectId: ProjectId,
		notebookId: NotebookId,
		options: { consistency?: ReadConsistency; readMemo?: PromiseMemo } = {},
	): Promise<NotebookMeta> {
		return this.resolvePreviewMeta(
			projectId,
			await this.readNotebookMeta(projectId, notebookId, options),
			options.readMemo,
		);
	}

	private async resolvePreviewMeta(
		projectId: ProjectId,
		meta: NotebookMeta,
		memo?: PromiseMemo,
	): Promise<NotebookMeta> {
		const notebookId = meta.id;
		if (!meta.preview) return meta;
		if (
			!(await new PreviewStore(this.bucket).project(projectId, memo)).entries.some(
				(entry) =>
					entry.intent.state === 'active' &&
					entry.intent.id === meta.preview!.preview_id &&
					entry.intent.notebook_id === meta.preview!.notebook_id,
			)
		)
			throw new NotFoundError('Preview not found');
		const recordKey = previewKey(projectId, meta.preview.notebook_id, meta.preview.preview_id);
		const readRecord = async () => {
			const object = await this.bucket.get(recordKey);
			if (!object) throw new NotFoundError('Preview not found');
			return readStored(PreviewRecordSchema, object, recordKey);
		};
		const [parent, record] = await Promise.all([
			this.getNotebookMeta(projectId, meta.preview.notebook_id, { readMemo: memo }),
			memo ? memo.read([this.bucket, recordKey], readRecord) : readRecord(),
		]);
		if (parent.preview || parent.status === 'deleted') throw new NotFoundError('Preview not found');
		if (
			!previewAvailable(record) ||
			!record.revisions.some(
				(revision) => revision.notebook_id === notebookId && revision.state === 'ready',
			)
		)
			throw new NotFoundError('Preview not found');
		return {
			...parent,
			id: notebookId,
			preview: meta.preview,
			title: record.name,
			compute_profile: record.compute_profile,
		};
	}

	async getNotebookSource(
		projectId: ProjectId,
		notebookId: NotebookId,
		options: { consistency?: ReadConsistency } = {},
	): Promise<Source> {
		const key = paths.project(projectId).notebook(notebookId).source;
		const source = await this.sourceCache.read(
			[key],
			(object) => readStored(SourceSchema, object, key),
			options.consistency,
		);
		if (!source) throw new NotFoundError(`Notebook ${notebookId} not found`);
		return source;
	}

	/**
	 * The notebook's security-label override from `meta` alone — one object read
	 * for the hot session/proxy gates, which must apply overrides without paying
	 * a full `getNotebook`. `null` = unlabeled. Only trash listings opt into
	 * deleted notebooks; session and proxy gates must reject them.
	 */
	async getSecurityLabels(
		projectId: ProjectId,
		notebookId: NotebookId,
		options: {
			includeDeleted?: boolean;
			consistency?: ReadConsistency;
			readMemo?: PromiseMemo;
		} = {},
	): Promise<ResourceSecurityLabels | null> {
		const meta = await this.getNotebookMeta(projectId, notebookId, options);
		if (meta.status === 'deleted' && !options.includeDeleted) {
			throw new NotFoundError(`Notebook ${notebookId} not found`);
		}
		return meta.security_labels ?? null;
	}

	async getNotebookContent(
		projectId: ProjectId,
		notebookId: NotebookId,
		source?: Source,
	): Promise<string> {
		const resolvedSource = source ?? (await this.getNotebook(projectId, notebookId)).source;
		return this.getContentForSource(projectId, notebookId, resolvedSource);
	}

	private async getContentForSource(
		projectId: ProjectId,
		notebookId: NotebookId,
		source: Source,
	): Promise<string> {
		const nb = paths.project(projectId).notebook(notebookId);
		const entryNotebook = remoteWorkspaceEntry(source);

		if (!entryNotebook) {
			const codeObj = await this.bucket.get(
				source.type === 'local' && source.publication
					? nb.version(source.current_version_id).code
					: nb.workspaceFile(workspaceSourcePolicy(source).entryNotebook),
			);
			if (!codeObj) {
				throw new NotFoundError(`Notebook code for ${notebookId} not found`);
			}
			return decodeUtf8PreservingBom(await codeObj.bytes());
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
		return decodeUtf8PreservingBom(await codeObj.bytes());
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
			if (isWorkspaceDirectoryMarkerPath(key.slice(prefix.length))) return;
			const obj = await this.bucket.get(key);
			if (!obj) return; // listed-then-deleted race; skip rather than fail.
			return { path: key.slice(prefix.length), bytes: await obj.bytes() };
		});
		const result = read.filter((f): f is { path: string; bytes: Uint8Array } => f !== undefined);
		if (source.type === 'local' && source.publication) {
			const entry = workspaceSourcePolicy(source).entryNotebook;
			const version = nb.version(source.current_version_id);
			for (const [path, key] of [
				[entry, version.code],
				['pyproject.toml', version.deps],
			]) {
				const object = await this.bucket.get(key);
				if (!object) throw new NotFoundError(`Committed notebook file ${path} not found`);
				const index = result.findIndex((file) => file.path === path);
				const file = { path, bytes: await object.bytes() };
				if (index === -1) result.push(file);
				else result[index] = file;
			}
		}
		return result;
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
		return this.createNotebookWithLabels(projectId, input, actor);
	}

	private async createNotebookWithLabels(
		projectId: ProjectId,
		input: CreateNotebookInput,
		actor: UserId,
		securityLabels?: ResourceSecurityLabels,
		staging?: { notebookId: NotebookId; beforeWrite?: () => Promise<void> },
	): Promise<NotebookMeta> {
		const notebookId = staging?.notebookId ?? createNotebookId();
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
			computeProfile: input.compute_profile,
			appComputeProfile: input.app_compute_profile,
			securityLabels,
		});

		const source = {
			...localSource(versionId, input.entry_notebook),
			publication: { generation: crypto.randomUUID(), versions: [{ version_id: versionId }] },
		};

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
		const entryNotebook = localEntryNotebook(input);
		const codeKey = nb.workspaceFile(entryNotebook);
		const workspaceFiles = (input.workspaceFiles ?? []).filter(
			(file) => file.path !== entryNotebook && file.path !== 'pyproject.toml',
		);
		// Every blob this create writes; deleting them unreferences the notebook.
		const contentKeys = [
			nb.meta,
			nb.readme,
			nb.source,
			codeKey,
			nb.deps,
			ver.code,
			ver.deps,
			ver.meta,
			...workspaceFiles.map((file) => nb.workspaceFile(file.path)),
		];

		// Write the immutable content + version blobs, then record the notebook in the
		// catalog. If the catalog write fails the notebook is unreferenced, so the
		// saga compensates by deleting the orphaned blobs.
		await saga(metricsObserver(this.metrics, 'saga.notebook_create'))
			.step(
				'write_files',
				compensableWrite(
					[
						...workspaceFiles.map(
							(file) => () => this.bucket.put(nb.workspaceFile(file.path), file.bytes),
						),
						() =>
							this.bucket.put(
								nb.readme,
								input.readme ?? `# ${input.title}\n\n${input.description}\n`,
							),
						() => this.bucket.put(nb.source, JSON.stringify(source)),
						() => this.bucket.put(codeKey, input.code),
						() => this.bucket.put(nb.deps, input.deps ?? ''),
						() => this.bucket.put(ver.code, input.code),
						() => this.bucket.put(ver.deps, input.deps ?? ''),
						() => this.bucket.put(ver.meta, JSON.stringify(version)),
					].map((write) => async () => {
						await staging?.beforeWrite?.();
						return write();
					}),
					() => this.bucket.delete(contentKeys),
				),
			)
			.step('metadata', async () => {
				await staging?.beforeWrite?.();
				return this.bucket.put(nb.meta, JSON.stringify(meta));
			})
			.step('catalog', () =>
				staging
					? Promise.resolve()
					: this.catalog.appendNotebookEntry(
							'notebook.create',
							actor,
							projectId,
							buildNotebookEntry(meta, 'local', nb.base, actor),
						),
			)
			.run();

		return meta;
	}

	async stageImportNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: CreateNotebookInput,
		actor: UserId,
		beforeWrite?: () => Promise<void>,
	): Promise<NotebookMeta> {
		return this.createNotebookWithLabels(projectId, input, actor, undefined, {
			notebookId,
			beforeWrite,
		});
	}

	async publishImportNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
	): Promise<NotebookMeta> {
		const meta = await this.getNotebookMeta(projectId, notebookId);
		// A replay after the user deleted the notebook must not report it as imported.
		if (meta.status === 'deleted') throw new NotFoundError(`Notebook ${notebookId} not found`);
		await this.catalog.appendNotebookEntry(
			'notebook.import',
			actor,
			projectId,
			buildNotebookEntry(meta, 'local', paths.project(projectId).notebook(notebookId).base, actor),
			{ ifAbsent: true },
		);
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
		const nb = paths.project(projectId).notebook(notebookId);
		const [code, depsObj] = await Promise.all([
			this.getContentForSource(projectId, notebookId, source),
			this.bucket.get(
				source.type === 'local' && source.publication
					? nb.version(source.current_version_id).deps
					: nb.deps,
			),
		]);
		const deps = depsObj ? await depsObj.text() : '';

		return this.createNotebookWithLabels(
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
				compute_profile: meta.compute_profile,
				app_compute_profile: meta.app_compute_profile,
				...(source.type === 'local' && source.entry_notebook
					? {
							entry_notebook: source.entry_notebook,
							workspaceFiles: await this.listWorkspaceFiles(projectId, notebookId),
						}
					: {}),
			},
			actor,
			meta.security_labels,
		);
	}

	/**
	 * Set or clear the notebook's security-label override (`labels: undefined`
	 * clears). Same fail-closed ordering as the project flow: park the snapshot
	 * projection at INDETERMINATE, write the authoritative `notebook.json`,
	 * then write the final projection — a crash between writes leaves the
	 * projection indeterminate, never wrong, and routine projections self-heal
	 * it. The override is enforced IN ADDITION to the project labels, so it can
	 * only add restrictions.
	 */
	async setSecurityLabels(
		projectId: ProjectId,
		notebookId: NotebookId,
		labels: ResourceSecurityLabels | undefined,
		actor: UserId,
		expectedVersion?: string,
	): Promise<NotebookMeta> {
		const normalized = labels === undefined ? undefined : normalizeSecurityLabels(labels);
		const nb = paths.project(projectId).notebook(notebookId);
		// A stale precondition is checked BEFORE parking the projection so a
		// rejected request never leaves the entry indeterminate; the CAS callback
		// repeats the authoritative check.
		if (expectedVersion !== undefined) {
			const metaObj = await this.bucket.get(nb.meta);
			if (!metaObj) throw new NotFoundError(`Notebook ${notebookId} not found`);
			const current = await readStored(NotebookMetaSchema, metaObj, nb.meta);
			assertVersionMatch(current.updated_at, expectedVersion);
		}
		// Park the projection at indeterminate AND mark the mutation in flight:
		// the marker keeps concurrent routine projections from resurrecting the
		// pre-mutation labels before finalization clears it.
		await this.catalog.updateNotebookEntry(
			'notebook.security_labels.pending',
			actor,
			projectId,
			notebookId,
			() => ({ security_labels: undefined, security_labels_pending: true }),
		);

		let previous: ResourceSecurityLabels | null = null;
		let updated: NotebookMeta;
		try {
			updated = await mutateObject(
				this.bucket,
				nb.meta,
				(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
				(current) => {
					assertNotMoving(current, notebookId);
					assertVersionMatch(current.updated_at, expectedVersion);
					if (current.status === 'deleted') {
						throw new NotFoundError(`Notebook ${notebookId} not found`);
					}
					previous = current.security_labels ?? null;
					const { security_labels: _cleared, ...rest } = current;
					return {
						...rest,
						...(normalized !== undefined ? { security_labels: normalized } : {}),
						updated_at: nextIsoTimestamp(current.updated_at, new Date().toISOString()),
					};
				},
				{ notFound: () => new NotFoundError(`Notebook ${notebookId} not found`) },
			);
		} catch (err) {
			// Thrown by the callback BEFORE the conditional put, so the record is
			// untouched and the projection can be re-derived from it (see the
			// project flow for why a put failure must stay indeterminate instead).
			if (err instanceof PreconditionFailedError || err instanceof NotFoundError) {
				await this.unparkSecurityLabels(projectId, notebookId, actor);
			}
			throw err;
		}

		await this.catalog.updateNotebookEntry(
			'notebook.security_labels',
			actor,
			projectId,
			notebookId,
			(entry) =>
				loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry, {
					finalizeSecurityLabels: true,
				}),
			undefined,
			{
				project_id: projectId,
				notebook_id: notebookId,
				previous_labels: previous,
				next_labels: normalized ?? null,
			},
		);

		return updated;
	}

	/** Notebook twin of `ProjectService.unparkSecurityLabels`; same rationale. */
	private async unparkSecurityLabels(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
	): Promise<void> {
		try {
			await this.catalog.updateNotebookEntry(
				'notebook.security_labels.rollback',
				actor,
				projectId,
				notebookId,
				(entry) =>
					loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry, {
						finalizeSecurityLabels: true,
					}),
			);
		} catch (err) {
			logOperationalError(
				'security_labels_rollback_failed',
				{
					operation: 'notebook.security_labels.rollback',
					project_id: projectId,
					notebook_id: notebookId,
				},
				err,
			);
		}
	}

	async updateNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: UpdateNotebookInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<NotebookMeta> {
		const update = async (assertWritable?: () => Promise<void>) =>
			this.updateNotebookFrom(
				await this.getNotebook(projectId, notebookId),
				projectId,
				notebookId,
				input,
				actor,
				expectedVersion,
				assertWritable,
			);
		// Blob writes must share the read lease so content matches its update token.
		if (input.code === undefined && input.deps === undefined && input.readme === undefined)
			return update();
		return this.workspace.withMutation(projectId, notebookId, {}, (lease) =>
			update(lease.heartbeat),
		);
	}

	private async assertSourceUpdateAllowed(projectId: ProjectId, notebookId: NotebookId) {
		const editors = await this.sessions.listEditorsBlockingSourceUpdate(projectId, notebookId);
		if (editors.length > 0) {
			throw new ConflictError(
				`Stored code cannot be replaced while persistent edit sessions can save: ${editors.map((session) => session.session_id).join(', ')}. Edit in the live session, or stop it and wait for sandbox cleanup. Then reread the notebook and retry.`,
			);
		}
	}

	private async updateNotebookFrom(
		detail: NotebookDetail,
		projectId: ProjectId,
		notebookId: NotebookId,
		input: UpdateNotebookInput,
		actor: UserId,
		expectedVersion?: string,
		assertWritable?: () => Promise<void>,
		forceVersion = false,
	): Promise<NotebookMeta> {
		const { meta: existing } = detail;
		let { source } = detail;
		const token =
			source.type === 'local' && (input.code !== undefined || input.deps !== undefined)
				? await this.beginSessionCapture(projectId, notebookId)
				: undefined;
		if (token) source = token.source;
		// Preserve stale If-Match precedence for remote-source content updates; the CAS
		// callback repeats the authoritative check against the latest metadata.
		assertVersionMatch(existing.updated_at, expectedVersion);
		if (source.type !== 'local' && (input.code !== undefined || input.deps !== undefined)) {
			throw new ConflictError('Remote-backed notebook source is updated only by sync');
		}
		if (input.code !== undefined || input.deps !== undefined)
			await this.assertSourceUpdateAllowed(projectId, notebookId);

		const nb = paths.project(projectId).notebook(notebookId);
		const depsKey =
			source.type === 'local' && source.publication
				? nb.version(source.current_version_id).deps
				: nb.deps;
		const [codeChanged, depsChanged, readmeChanged] = await Promise.all([
			input.code !== undefined
				? this.getContentForSource(projectId, notebookId, source).then(
						(code) => forceVersion || input.code !== code,
					)
				: false,
			input.deps !== undefined
				? this.resolveDeps(depsKey, undefined).then((deps) => input.deps !== deps)
				: false,
			input.readme !== undefined
				? this.bucket
						.get(nb.readme)
						.then(async (object) => input.readme !== (object ? await object.text() : ''))
				: false,
		]);
		let sourceChanged = codeChanged || depsChanged;
		if (
			source.type === 'local' &&
			(input.code !== undefined || input.deps !== undefined) &&
			!sourceChanged
		) {
			const version = nb.version(source.current_version_id);
			const [stored, versionMeta, code, deps] = await Promise.all([
				this.readVersionContents(version.code, version.deps),
				this.bucket.head(version.meta),
				input.code ?? this.getContentForSource(projectId, notebookId, source),
				this.resolveDeps(depsKey, input.deps),
			]);
			// Equal workspace files can survive a partially failed version publication.
			sourceChanged =
				!versionMeta || !stored.complete || stored.code !== code || stored.deps !== deps;
		}
		await assertWritable?.();
		const updated = await mutateObject(
			this.bucket,
			nb.meta,
			(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
			(current) => {
				assertNotMoving(current, notebookId);
				assertVersionMatch(current.updated_at, expectedVersion);
				if (current.status === 'deleted') {
					throw new NotFoundError(`Notebook ${notebookId} not found`);
				}
				const next = {
					...current,
					title: input.title ?? current.title,
					description: input.description ?? current.description,
					tags: input.tags ?? current.tags,
					// null clears back to the deployment default (the key is dropped from
					// the written JSON); undefined leaves the stored choice as-is.
					base_image:
						input.base_image === null ? undefined : (input.base_image ?? current.base_image),
					compute_profile:
						input.compute_profile === null
							? undefined
							: (input.compute_profile ?? current.compute_profile),
					app_compute_profile:
						input.app_compute_profile === null
							? undefined
							: (input.app_compute_profile ?? current.app_compute_profile),
				};
				const metadataChanged = JSON.stringify(next) !== JSON.stringify(current);
				if (!metadataChanged && !sourceChanged && !readmeChanged) return null;
				return {
					...next,
					updated_at: nextIsoTimestamp(current.updated_at, new Date().toISOString()),
				};
			},
			{ notFound: () => new NotFoundError(`Notebook ${notebookId} not found`) },
		);
		const now = updated.updated_at;

		if (input.readme !== undefined && readmeChanged) {
			await assertWritable?.();
			await this.bucket.put(nb.readme, input.readme);
		}

		if (sourceChanged && source.type === 'local' && token) {
			const code = input.code ?? (await this.getContentForSource(projectId, notebookId, source));
			const versionId = createVersionId();

			// Read once, before the Promise.all, so the read does not race the write
			// of the same key inside the batch.
			const deps = await this.resolveDeps(depsKey, input.deps);

			const version = buildVersion({
				versionId,
				notebookId,
				now,
				author: actor,
				message: input.message ?? 'Update',
				parentId: source.current_version_id,
			});

			const ver = nb.version(versionId);
			await assertWritable?.();
			await Promise.all([
				this.bucket.put(ver.code, code, { onlyIfNotExists: true }),
				this.bucket.put(ver.deps, deps, { onlyIfNotExists: true }),
				this.bucket.put(ver.meta, JSON.stringify(version), { onlyIfNotExists: true }),
			]);
			await publishLocalSource(this.bucket, token, versionId, [
				{ version_id: versionId },
				...token.versions,
			]);

			// Prune old versions after the new one is written. This is best-effort
			// and non-fatal: the save has already committed the new version above,
			// so a prune failure must never fail the user's save. We always keep the
			// just-written version (the new current_version_id).
			await this.pruneVersions(projectId, notebookId, MAX_VERSIONS, versionId);
		}

		await this.reconcileSavedNotebook(projectId, notebookId, actor);

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
			throw new ConflictError('Cannot restore a version of a non-local notebook');
		}

		if (
			detail.source.publication &&
			!detail.source.publication.versions.some((item) => item.version_id === versionId)
		)
			throw new NotFoundError(`Version ${versionId} is not published`);
		const ver = paths.project(projectId).notebook(notebookId).version(versionId);
		const [metaObj, codeObj, depsObj] = await Promise.all([
			this.bucket.get(ver.meta),
			this.bucket.get(ver.code),
			this.bucket.get(ver.deps),
		]);
		if (!metaObj || !codeObj || !depsObj) {
			throw new NotFoundError(`Version ${versionId} is incomplete`);
		}

		const code = decodeUtf8PreservingBom(await codeObj.bytes());
		const deps = await depsObj.text();
		return this.workspace.withMutation(projectId, notebookId, {}, (lease) =>
			this.updateNotebookFrom(
				detail,
				projectId,
				notebookId,
				{ code, deps, message: `Restore version ${versionId}` },
				actor,
				detail.meta.updated_at,
				lease.heartbeat,
				true,
			),
		);
	}

	// Acquire before reading runtime bytes or validating editor ownership.
	async beginSessionCapture(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<LocalPublicationToken> {
		return readLocalPublication(this.bucket, projectId, notebookId);
	}

	async fenceSessionPublications(projectId: ProjectId, notebookId: NotebookId): Promise<Source> {
		const token = await this.beginSessionCapture(projectId, notebookId);
		return publishLocalSource(this.bucket, token, token.source.current_version_id, token.versions);
	}

	async commitSession(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: CommitSessionInput,
		actor: UserId,
		capture?: LocalPublicationToken,
	): Promise<CommitSessionResult | null> {
		const { meta, source: configured } = await this.getNotebook(projectId, notebookId);
		if (meta.preview) throw new ConflictError('Preview sessions cannot persist changes');
		if (meta.status === 'deleted' || configured.type !== 'local' || input.code === undefined)
			return null;
		const token = capture ?? (await this.beginSessionCapture(projectId, notebookId));
		if (token.projectId !== projectId || token.notebookId !== notebookId)
			throw new ConflictError('Capture belongs to another notebook');
		const source = token.source;
		const nb = paths.project(projectId).notebook(notebookId);
		const current = nb.version(source.current_version_id);
		const stored = await this.readVersionContents(current.code, current.deps);
		const deps = input.deps ?? stored.deps;
		const existingObjects = await Promise.all(
			[current.code, current.deps, current.meta].map((key) => this.bucket.head(key)),
		);
		const changed =
			!stored.complete ||
			existingObjects.some((object) => !object) ||
			input.code !== stored.code ||
			deps !== stored.deps;
		const versionId = changed ? createVersionId() : source.current_version_id;
		const ver = nb.version(versionId);
		const previous = changed
			? undefined
			: token.versions.find((version) => version.version_id === versionId);
		const now = new Date().toISOString();
		const captureId = crypto.randomUUID();
		const publication: LocalPublicationVersion = { ...previous, version_id: versionId };
		let capturedHtml = input.html !== undefined;
		for (const [field, content] of [
			['html', input.html],
			['session', input.session],
		] as const) {
			if (content === undefined) continue;
			try {
				const descriptorField = field === 'html' ? 'html_snapshot' : 'session_snapshot';
				const hash = await sha256Hex(content);
				const old = previous?.[descriptorField];
				if (old) {
					const key = publicationArtifactKey(projectId, notebookId, versionId, field, old);
					const head = await this.bucket.head(key);
					const same =
						head &&
						head.size === byteLength(content) &&
						(old.sha256 === hash || (!old.sha256 && (await this.artifactMatches(key, hash))));
					if (same) {
						this.metrics.increment('notebook.artifact_uploads_skipped');
						continue;
					}
				}
				await this.bucket.put(ver.capture(captureId)[field], content, {
					onlyIfNotExists: true,
					httpMetadata: { contentType: field === 'html' ? 'text/html' : 'application/json' },
				});
				publication[descriptorField] = {
					captured_at: old ? nextIsoTimestamp(old.captured_at, now) : now,
					size_bytes: byteLength(content),
					capture_id: captureId,
					sha256: hash,
				};
			} catch (error) {
				if (field !== 'html') throw error;
				capturedHtml = false;
				logOperationalError(
					'notebook.html_capture_failed',
					{ operation: 'notebook.capture_html', notebook_id: notebookId },
					error,
				);
			}
		}
		if (changed) {
			await Promise.all([
				this.bucket.put(ver.code, input.code, { onlyIfNotExists: true }),
				this.bucket.put(ver.deps, deps, { onlyIfNotExists: true }),
				this.bucket.put(
					ver.meta,
					JSON.stringify(
						buildVersion({
							versionId,
							notebookId,
							now,
							author: actor,
							message: 'Session edits',
							parentId: source.current_version_id,
						}),
					),
					{ onlyIfNotExists: true },
				),
			]);
		}
		if (!changed && JSON.stringify(publication) === JSON.stringify(previous)) {
			// Even equal bytes must fence older, already-dispatched publications.
			await publishLocalSource(this.bucket, token, versionId, token.versions);
		} else {
			const versions = [
				publication,
				...token.versions.filter((version) => version.version_id !== versionId),
			];
			await publishLocalSource(this.bucket, token, versionId, versions);
			if (changed)
				await mutateObject(
					this.bucket,
					nb.meta,
					(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
					(current) => {
						assertNotMoving(current, notebookId);
						return { ...current, updated_at: nextIsoTimestamp(current.updated_at, now) };
					},
				).catch((error) =>
					logOperationalError(
						'notebook.capture_metadata_failed',
						{ operation: 'notebook.capture_metadata', notebook_id: notebookId },
						error,
					),
				);
		}
		await this.reconcileSavedNotebook(projectId, notebookId, actor, !changed);
		if (changed) await this.pruneVersions(projectId, notebookId, MAX_VERSIONS, versionId);
		return {
			versionId,
			newVersion: changed,
			capturedHtml,
			capturedSession: input.session !== undefined,
		};
	}

	private async artifactMatches(key: string, hash: string): Promise<boolean> {
		const body = await this.bucket.get(key);
		return !!body && (await sha256Hex(decodeUtf8PreservingBom(await body.bytes()))) === hash;
	}

	private async reconcileSavedNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		unchanged = false,
	): Promise<void> {
		const reconcile = () =>
			this.catalog.updateNotebookEntry('notebook.update', actor, projectId, notebookId, (entry) =>
				loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry),
			);
		try {
			if (unchanged) {
				const snapshot = await this.catalog.getCurrentSnapshotEntry();
				const entry = snapshot.byProjectId
					.get(projectId)
					?.notebooks.find((notebook) => notebook.id === notebookId);
				if (!entry) return;
				// Metadata can advance while the catalog lookup is in flight.
				const patch = await loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry);
				if (!patch || entry.updated_at === patch.updated_at) return;
			}
			await reconcile();
		} catch (error) {
			// Preserve save success. Each retry reads current metadata to avoid stale updates.
			const context = { project_id: projectId, notebook_id: notebookId };
			logOperationalError('notebook.catalog_projection_failed', context, error);
			await deferOrAwait(
				this.backgroundWork,
				'notebook.catalog_reconcile',
				reconcile,
				this.metrics,
				context,
			);
		}
	}

	async deleteNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		expectedVersion?: string,
	): Promise<void> {
		await this.deleteNotebookWithMutation(projectId, notebookId, actor, expectedVersion);
	}

	async deleteNotebookWithMutation(
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		expectedVersion?: string,
	): Promise<NotebookDeleteMutationResult | null> {
		const nb = paths.project(projectId).notebook(notebookId);
		const { value: updated, written } = await mutateObjectWithOutcome(
			this.bucket,
			nb.meta,
			(raw) => parseStored(NotebookMetaSchema, raw, nb.meta),
			(current) => {
				assertNotMoving(current, notebookId);
				assertVersionMatch(current.updated_at, expectedVersion);
				if (current.status === 'deleted') return null;
				return {
					...current,
					status: 'deleted' as const,
					updated_at: new Date().toISOString(),
				};
			},
			{ notFound: () => new NotFoundError(`Notebook ${notebookId} not found`) },
		);
		const snapshot = written
			? await this.catalog.updateNotebookEntry(
					'notebook.delete',
					actor,
					projectId,
					notebookId,
					async (entry) =>
						(await loadNotebookCatalogPatch(this.bucket, projectId, notebookId, entry)) ??
						notebookCatalogPatch(updated, entry),
					(p) => ({
						notebook_count: Math.max(0, p.notebook_count - 1),
					}),
				)
			: null;

		await new WorkingBranchStore(this.bucket).retire(projectId, notebookId);
		await new AppPoolStore(this.bucket, this.metrics).retireForDeletion(projectId, notebookId);
		await this.thumbnails.retire(projectId, notebookId);

		// Deleted notebook IDs never recur, so their claims cannot self-heal on admission.
		await this.bucket.delete(paths.appClaim(projectId, notebookId)).catch(() => {});
		await this.bucket.delete(paths.editorClaim(projectId, notebookId)).catch(() => {});
		await this.deepLinks.releaseNotebook(projectId, notebookId).catch((error) => {
			logOperationalError('deep_links.cleanup_failed', { operation: 'releaseNotebook' }, error);
		});
		return snapshot ? { notebook: updated, mutationId: snapshot.snapshot_id } : null;
	}

	async listVersions(projectId: ProjectId, notebookId: NotebookId): Promise<Version[]> {
		const nb = paths.project(projectId).notebook(notebookId);
		const source = await this.getNotebookSource(projectId, notebookId);
		const versionPrefixes =
			source.type === 'local' && source.publication
				? source.publication.versions.map((version) => `${nb.base}/versions/${version.version_id}/`)
				: await listAllPrefixes(this.bucket, `${nb.base}/versions/`);

		const fetched = await mapWithConcurrency(
			versionPrefixes,
			BUCKET_SCAN_CONCURRENCY,
			async (pfx) => {
				const key = `${pfx}version.json`;
				const obj = await this.bucket.get(key);
				if (!obj) return; // listed-then-deleted race; skip rather than fail.
				try {
					const version = await readStored(VersionSchema, obj, key);
					return source.type === 'local' ? publishedVersion(source, version) : version;
				} catch (err) {
					logOperationalError(
						'stored_object_skipped',
						{ operation: 'notebook.version_list', object: key },
						err,
					);
					return;
				}
			},
		);
		return fetched.filter((v): v is Version => v !== undefined);
	}

	/**
	 * A malformed id is a client mistake, not a server fault: map the bare parse
	 * Error to a domain 404 so the API renders a 4xx instead of a raw 500.
	 */
	private parseVersionId(versionId: string): VersionId {
		try {
			return VersionId.parse(versionId);
		} catch {
			throw new NotFoundError(`Version ${versionId} not found`);
		}
	}

	async getVersion(
		projectId: ProjectId,
		notebookId: NotebookId,
		versionId: string,
	): Promise<{ version: Version; code: string }> {
		const vid = this.parseVersionId(versionId);
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

		const stored = await readStored(VersionSchema, metaObj, ver.meta);
		if (
			source.type === 'local' &&
			source.publication &&
			!source.publication.versions.some((version) => version.version_id === vid)
		)
			throw new NotFoundError(`Version ${versionId} was not published`);
		const version = source.type === 'local' ? publishedVersion(source, stored) : stored;
		const code = decodeUtf8PreservingBom(await codeObj.bytes());
		return { version, code };
	}

	/**
	 * One version's HTML snapshot. NotFoundError when the version itself is
	 * unknown; null when the version exists but captured no snapshot (or the
	 * object was pruned).
	 */
	async getVersionHtmlSnapshot(
		projectId: ProjectId,
		notebookId: NotebookId,
		versionId: string,
	): Promise<{ versionId: string; capturedAt: string; html: string } | null> {
		const vid = this.parseVersionId(versionId);
		const source = await this.getNotebookSource(projectId, notebookId);
		const ver = paths.project(projectId).notebook(notebookId).version(vid);
		let descriptor: PublicationArtifact | undefined;
		if (source.type === 'local' && source.publication) {
			const published = source.publication.versions.find((version) => version.version_id === vid);
			if (!published) throw new NotFoundError(`Version ${versionId} not found`);
			descriptor = published.html_snapshot;
		} else {
			const object = await this.bucket.get(ver.meta);
			if (!object) throw new NotFoundError(`Version ${versionId} not found`);
			descriptor = (await readStored(VersionSchema, object, ver.meta)).html_snapshot;
		}
		if (!descriptor) return null;
		const object = await this.bucket.get(
			publicationArtifactKey(projectId, notebookId, vid, 'html', descriptor),
		);
		if (!object) return null;
		return { versionId: vid, capturedAt: descriptor.captured_at, html: await object.text() };
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
		const versions = (await this.listVersions(projectId, notebookId))
			.filter((version) => version.html_snapshot)
			.sort((a, b) => b.version_id.localeCompare(a.version_id));
		for (const version of versions) {
			const snapshot = await this.getVersionHtmlSnapshot(projectId, notebookId, version.version_id);
			if (snapshot) return snapshot;
		}
		return null;
	}

	/**
	 * Prune immutable version folders beyond the newest `max`, reclaiming storage
	 * after a code save. Versions are keyed by ULID, which sorts chronologically
	 * (newest last), so we keep the lexicographically-largest `max` prefixes. The
	 * current version and versions used by live sessions are retained even if
	 * they fall outside the window.
	 *
	 * Best-effort: failures are swallowed (logged) so a prune error never fails
	 * the caller's save, which has already committed.
	 */
	private async pruneVersions(
		projectId: ProjectId,
		notebookId: NotebookId,
		max: number,
		keep?: VersionId,
	): Promise<void> {
		await deferOrAwait(
			this.backgroundWork,
			'notebook.version_prune',
			async () => {
				const nb = paths.project(projectId).notebook(notebookId);
				const versionsRoot = `${nb.base}/versions/`;

				// `listAllPrefixes` returns sorted `.../versions/{vid}/` prefixes, so the
				// newest (largest ULID) come last.
				const versionPrefixes = await listAllPrefixes(this.bucket, versionsRoot);
				const source = await this.getNotebookSource(projectId, notebookId);
				let token =
					source.type === 'local' && source.publication
						? await this.beginSessionCapture(projectId, notebookId)
						: undefined;
				const committedPrefixes = token
					? token.versions.map((item) => `${versionsRoot}${item.version_id}/`).sort()
					: versionPrefixes;
				const prunable = committedPrefixes.slice(0, Math.max(0, committedPrefixes.length - max));
				if (prunable.length > 0) {
					const cutoff = VersionId.parse(prunable.at(-1)!.slice(versionsRoot.length, -1));
					await this.sessions.advanceVersionPruneCutoff(projectId, notebookId, cutoff);
				}
				const protectedVersionIds = new Set<VersionId>();
				if (prunable.length > 0) {
					for (const id of await this.sessions.listProtectedVersionIds(projectId, notebookId))
						protectedVersionIds.add(id);
					const branchObject = await this.bucket.get(
						workingBranchPaths(projectId, notebookId).head,
					);
					if (branchObject) {
						const branch = await readStored(
							WorkingBranchRecordSchema,
							branchObject,
							workingBranchPaths(projectId, notebookId).head,
						);
						if (branch.active_save) {
							const key = workingBranchPaths(projectId, notebookId).save(branch.active_save);
							const receipt = await this.bucket.get(key);
							if (receipt)
								protectedVersionIds.add(
									(await readStored(WorkingBranchSaveSchema, receipt, key)).base_version_id,
								);
						}
					}
				}
				if (source.current_version_id) protectedVersionIds.add(source.current_version_id);
				if (keep) protectedVersionIds.add(keep);
				const protectedPrefixes = new Set(
					[...protectedVersionIds].map((versionId) => `${versionsRoot}${versionId}/`),
				);

				const targets = prunable.filter((prefix) => !protectedPrefixes.has(prefix));
				if (source.type === 'local' && !token) {
					const removed = new Set(targets);
					token = await readLocalPublication(
						this.bucket,
						projectId,
						notebookId,
						new Set(
							versionPrefixes
								.filter((prefix) => !removed.has(prefix))
								.map((prefix) => prefix.slice(versionsRoot.length, -1)),
						),
					);
				}
				if (token) {
					// List before the CAS barrier: candidates staged using any older token
					// cannot publish after this barrier, including a paused upload.
					const candidates = await listAllKeys(this.bucket, versionsRoot);
					const removed = new Set(targets.map((prefix) => prefix.slice(versionsRoot.length, -1)));
					const retained = token.versions.filter((item) => !removed.has(item.version_id));
					const references = new Set<string>();
					for (const item of retained) {
						const version = nb.version(item.version_id);
						for (const key of [version.code, version.deps, version.meta]) references.add(key);
						if (item.html_snapshot)
							references.add(
								publicationArtifactKey(
									projectId,
									notebookId,
									item.version_id,
									'html',
									item.html_snapshot,
								),
							);
						if (item.session_snapshot)
							references.add(
								publicationArtifactKey(
									projectId,
									notebookId,
									item.version_id,
									'session',
									item.session_snapshot,
								),
							);
					}
					const garbage = candidates.filter((key) => !references.has(key));
					if (garbage.length === 0 && removed.size === 0) return;
					await publishLocalSource(this.bucket, token, token.source.current_version_id, retained);
					if (garbage.length > 0) await this.bucket.delete(garbage);
				} else {
					const keyLists = await mapWithConcurrency(targets, BUCKET_SCAN_CONCURRENCY, (prefix) =>
						listAllKeys(this.bucket, prefix),
					);
					if (keyLists.flat().length > 0) await this.bucket.delete(keyLists.flat());
				}
			},
			this.metrics,
			{ project_id: projectId, notebook_id: notebookId },
		);
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
			return await readStored(FsSnapshotSchema, obj, nb.fsSnapshot);
		} catch (err) {
			logOperationalError(
				'stored_object_skipped',
				{ operation: 'notebook.fs_snapshot.read', object: nb.fsSnapshot },
				err,
			);
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
		if ((await this.readNotebookMeta(projectId, notebookId)).preview)
			throw new ConflictError('Preview sessions cannot persist changes');
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
	 * live notebook can never be hard-deleted by mistake.
	 */
	async hardDeleteNotebook(projectId: ProjectId, notebookId: NotebookId): Promise<void> {
		const metaKey = paths.project(projectId).notebook(notebookId).meta;
		const obj = await this.bucket.get(metaKey);
		const meta = obj ? await readStored(NotebookMetaSchema, obj, metaKey) : null;
		if (meta && meta.status !== 'deleted') {
			throw new Error(
				`Refusing to hard-delete notebook ${notebookId}: status is "${meta.status}", expected "deleted"`,
			);
		}
		await new WorkingBranchStore(this.bucket).retire(projectId, notebookId);
		await new AppPoolStore(this.bucket, this.metrics).retireForDeletion(projectId, notebookId);

		await this.deepLinks.releaseNotebook(projectId, notebookId);
		const markerKeys = await listAllKeys(this.bucket, paths.jobRunMarkersForProject(projectId));
		const notebookMarkerKeys = await mapWithConcurrency(
			markerKeys,
			BUCKET_SCAN_CONCURRENCY,
			async (key) => {
				const obj = await this.bucket.get(key);
				if (!obj) return null;
				try {
					const marker = await readStored(JobRunMarkerSchema, obj, key);
					return marker.notebook_id === notebookId ? key : null;
				} catch (err) {
					logOperationalError(
						'stored_object_skipped',
						{ operation: 'notebook.hard-delete.job-marker', object: key },
						err,
					);
					return null;
				}
			},
		);
		const matchingMarkers = notebookMarkerKeys.filter((key): key is string => key !== null);
		if (matchingMarkers.length > 0) await this.bucket.delete(matchingMarkers);
		await this.bucket.delete(paths.appClaim(projectId, notebookId));
		await this.bucket.delete(paths.editorClaim(projectId, notebookId));
		await this.bucket.delete(paths.versionPruneCutoff(projectId, notebookId));
		const move = await readNotebookMove(this.bucket, paths.notebookMove(notebookId));
		// Only a completed record is the notebook's own; a pending move is another writer's.
		if (move?.move.phase === 'complete' && move.move.destination === projectId)
			await this.bucket.delete(paths.notebookMove(notebookId));
		await deleteByPrefix(this.bucket, paths.jobOperationClaimsForNotebook(projectId, notebookId));
		await deleteByPrefix(this.bucket, paths.jobDeletionClaimsForNotebook(projectId, notebookId));

		const nb = paths.project(projectId).notebook(notebookId);
		await new ResumableUploads(this.bucket, `${nb.base}/uploads/`).cancelAll();
		await deleteByPrefix(this.bucket, `${nb.base}/`);
	}

	private async sweepNotebookArtifacts(projects: Snapshot['projects']): Promise<void> {
		const cursor = await readRetentionCursor(this.bucket, NOTEBOOK_GC_CURSOR_KEY);
		const now = Date.now();
		if (cursor.next_at !== undefined && cursor.next_at > now) return;
		const notebooks = projects.flatMap((project) =>
			project.notebooks.map((notebook) => ({
				projectId: project.id,
				notebookId: notebook.id,
				key: `${project.id}/${notebook.id}`,
			})),
		);
		if (notebooks.length === 0) return;
		const batchSize = Math.ceil(notebooks.length / GC_CYCLES_PER_DAY);
		const batch = retentionBatch(notebooks, cursor.after, batchSize);
		const last = batch.at(-1)!.key;
		this.metrics.gauge('notebook_gc.rotation.total', notebooks.length);
		this.metrics.gauge(
			'notebook_gc.rotation.position',
			notebooks.filter((notebook) => notebook.key <= last).length,
		);
		this.metrics.increment('notebook_gc.visited', batch.length);
		await mapWithConcurrency(batch, BUCKET_SCAN_CONCURRENCY, async ({ projectId, notebookId }) => {
			await this.pruneVersions(projectId, notebookId, MAX_VERSIONS);
			await this.workspace.sweepUploads(projectId, notebookId).catch((error) => {
				logOperationalError(
					'workspace_uploads.cleanup_failed',
					{ operation: 'prune', project_id: projectId, notebook_id: notebookId },
					error,
				);
			});
			await this.thumbnails.prune(projectId, notebookId).catch((error) => {
				logOperationalError(
					'thumbnails.cleanup_failed',
					{ operation: 'prune', project_id: projectId, notebook_id: notebookId },
					error,
				);
			});
		});
		await writeRetentionCursor(
			this.bucket,
			NOTEBOOK_GC_CURSOR_KEY,
			last,
			cursor,
			Math.max(cursor.next_at ?? now, now - Millis.hours(1)) +
				Millis.days(1) / Math.ceil(notebooks.length / batchSize),
		);
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
	 * reclaims that whole subtree, so run it first. `notebook_count`
	 * was already decremented at soft-delete time, so it is left untouched here.
	 */
	async sweepDeletedNotebooks(
		retentionMs: number = DEFAULT_DELETED_NOTEBOOK_RETENTION_MS,
	): Promise<{ purged: number; orphanedSnapshots: FsSnapshot[] }> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const now = Date.now();

		const projects = snapshot.projects.filter((project) => project.status !== 'deleted');
		await mapWithConcurrency(projects, BUCKET_SCAN_CONCURRENCY, async (project) => {
			await new ResumableUploads(this.bucket, paths.project(project.id).objectUploadsPrefix)
				.sweep()
				.catch((error) =>
					logOperationalError(
						'object_uploads.cleanup_failed',
						{ operation: 'prune', project_id: project.id },
						error,
					),
				);
			await this.imports.sweep(project.id).catch((error) => {
				logOperationalError(
					'notebook_imports.cleanup_failed',
					{ operation: 'prune', project_id: project.id },
					error,
				);
			});
		});
		await this.sweepNotebookArtifacts(projects);
		const stale = projects.flatMap((project) =>
			project.notebooks
				.filter((nb) => nb.status === 'deleted' && now - Date.parse(nb.updated_at) >= retentionMs)
				.map((nb) => ({ projectId: project.id, notebookId: nb.id })),
		);
		if (stale.length === 0) return { purged: 0, orphanedSnapshots: [] };

		const orphanedSnapshots: FsSnapshot[] = [];
		const deadline = Date.now() + Millis.minutes(5);
		const cursorKey = '_system/notebook-purge-cursor.json';
		const cursor = await readRetentionCursor(this.bucket, cursorKey);
		let after = cursor.after;
		let purged = 0;
		for (const { projectId, notebookId, key } of retentionBatch(
			stale.map((item) => ({ ...item, key: `${item.projectId}/${item.notebookId}` })),
			cursor.after,
			25,
		)) {
			if (Date.now() >= deadline) break;
			try {
				const fs = await this.getFsSnapshot(projectId, notebookId);
				await this.hardDeleteNotebook(projectId, notebookId);
				if (fs) orphanedSnapshots.push(fs);
				// Commit each deletion so a later failure cannot replay the whole backlog.
				await this.catalog.mutateSnapshot(
					'notebook.gc',
					SYSTEM_ACTOR,
					(snap: Snapshot) => ({
						...snap,
						projects: snap.projects.map((project) =>
							project.id === projectId
								? {
										...project,
										notebooks: project.notebooks.filter((notebook) => notebook.id !== notebookId),
									}
								: project,
						),
					}),
					{ notebooks: [{ project_id: projectId, notebook_id: notebookId }] },
				);
				purged++;
			} catch (error) {
				logOperationalError(
					'notebook.gc.failed',
					{ project_id: projectId, notebook_id: notebookId },
					error,
				);
			}
			after = key;
		}
		await writeRetentionCursor(this.bucket, cursorKey, after, cursor);
		return { purged, orphanedSnapshots };
	}
}

/** UTF-8 byte length of a string, for snapshot `size_bytes` descriptors. */
function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

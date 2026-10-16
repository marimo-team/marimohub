import type { z } from 'zod';
import type { Bucket, BucketObjectBody } from '../../ports/bucket';
import { ConflictError } from '../../errors';
import { NotebookId, ProjectId, SnapshotId, UserId } from '../../ids';
import type { IdBrand } from '../../ids';
import { paths } from '../../paths';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import {
	CatalogSchema,
	JobDefinitionSchema,
	NotebookMetaSchema,
	ProjectSchema,
	SnapshotSchema,
	SourceSchema,
} from '../../schema';
import type { Snapshot, SnapshotProjectEntry } from '../../schema';
import { sha256Hex } from '../../internal/sha256';
import { NotebookImportItemSchema } from '../content/NotebookImportService';
import { buildNotebookEntry } from '../content/notebookMeta';
import { projectCatalogPatch } from '../content/catalogProjection';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { listAllObjects } from './storage';
import { jobIndexEntry } from '../jobs/JobsService';

export type CatalogRecoverySource =
	| { mode: 'rebuild' }
	| { mode: 'snapshot'; snapshotId: SnapshotId };

export interface CatalogRecoveryIssue {
	key: string;
	severity: 'error' | 'warning' | 'excluded';
	message: string;
}

export interface CatalogRecoveryCandidate {
	id: SnapshotId;
	/** Snapshot `created_at`, or the object's upload time when snapshot mode skipped its body. */
	createdAt: string;
	/** Omitted when snapshot mode skipped its body. */
	projects?: number;
	reference: 'current' | 'previous' | 'unverified';
}

export interface CatalogRecoveryReport {
	source: CatalogRecoverySource;
	catalogEtag: string | null;
	token: string;
	candidates: CatalogRecoveryCandidate[];
	issues: CatalogRecoveryIssue[];
	projects: SnapshotProjectEntry[];
	snapshot?: Snapshot;
}

const ABSENT_FROM_SNAPSHOT =
	'Present on storage but absent from the selected snapshot; recovery leaves it out of the catalog.';

const INVALID_SNAPSHOT = 'Snapshot is invalid and cannot be selected.';

async function decodeRecord<T>(
	object: BucketObjectBody | null,
	schema: z.ZodType<T>,
): Promise<{ data: T; error?: never } | { data?: never; error: string }> {
	if (!object) return { error: 'Required record is missing.' };
	let raw: unknown;
	try {
		raw = await object.json();
	} catch {
		return { error: 'Record is not valid JSON.' };
	}
	const parsed = schema.safeParse(raw);
	return parsed.success ? { data: parsed.data } : { error: 'Record does not match its schema.' };
}

function validIds<T extends string>(ids: Iterable<string>, id: IdBrand<T>): T[] {
	return [...ids].filter((child): child is T => id.is(child)).sort();
}

interface ProjectKeys {
	importReceipts: string[];
	/** Notebook ID → its job head keys. */
	notebooks: Map<string, string[]>;
}

/** One pass over the inventory so per-project and per-notebook lookups never rescan it. */
function indexProjectKeys(keys: Iterable<string>): Map<string, ProjectKeys> {
	const projects = new Map<string, ProjectKeys>();
	for (const key of keys) {
		if (!key.startsWith('projects/')) continue;
		const parts = key.slice('projects/'.length).split('/');
		let project = projects.get(parts[0]);
		if (!project) {
			project = { importReceipts: [], notebooks: new Map() };
			projects.set(parts[0], project);
		}
		if (parts[1] === 'imports' && parts.length > 2 && /\/items\/[^/]+\.json$/.test(key)) {
			project.importReceipts.push(key);
		} else if (parts[1] === 'notebooks' && parts[2] !== undefined) {
			let jobs = project.notebooks.get(parts[2]);
			if (!jobs) {
				jobs = [];
				project.notebooks.set(parts[2], jobs);
			}
			if (parts.length === 6 && parts[3] === 'jobs' && parts[5] === 'job.json') jobs.push(key);
		}
	}
	return projects;
}

async function inventory(bucket: Bucket) {
	const [projects, snapshots, deletions] = await Promise.all(
		['projects/', paths.snapshotsPrefix, '_system/job-deletions/'].map((prefix) =>
			listAllObjects(bucket, prefix),
		),
	);
	const catalog = await bucket.head(paths.catalog);
	const objects = [...projects, ...snapshots, ...deletions, ...(catalog ? [catalog] : [])]
		.map(({ key, etag, size }) => ({ key, etag, size }))
		.sort((a, b) => a.key.localeCompare(b.key));
	const digest = await sha256Hex(
		objects.map(({ key, etag, size }) => JSON.stringify([key, etag, size])).join('\n'),
	);
	return { objects, snapshots, digest };
}

/** Offline only: the catalog CAS does not fence writes to individual metadata records. */
export async function planCatalogRecovery(
	bucket: Bucket,
	source: CatalogRecoverySource,
): Promise<CatalogRecoveryReport> {
	const before = await inventory(bucket);
	const keys = new Set(before.objects.map((object) => object.key));
	const projectKeys = indexProjectKeys(keys);
	const issues: CatalogRecoveryIssue[] = [];
	const issue = (key: string, severity: CatalogRecoveryIssue['severity'], message: string) => {
		issues.push({ key, severity, message });
	};
	for (const object of before.objects) {
		if (!object.etag)
			issue(object.key, 'error', 'Storage must provide non-empty ETags for recovery.');
	}

	// A damaged pointer must not prevent inspecting the surviving snapshots.
	const catalogObject = await bucket.get(paths.catalog);
	const { data: catalog } = await decodeRecord(catalogObject, CatalogSchema);
	if (catalogObject && !catalog) {
		issue(paths.catalog, 'warning', 'Catalog is corrupt; recovery will replace it.');
	}
	const reference = (id: string, key: string): CatalogRecoveryCandidate['reference'] =>
		catalog?.current_snapshot_id === id && catalog.current_snapshot_key === key
			? 'current'
			: catalog?.previous_snapshot_id === id
				? 'previous'
				: 'unverified';
	// Snapshot mode needs only the selected body and the pointer's own snapshots.
	const mustRead = (key: string) =>
		source.mode === 'rebuild' ||
		key === paths.snapshot(source.snapshotId) ||
		key === catalog?.current_snapshot_key ||
		(catalog?.previous_snapshot_id != null && key === paths.snapshot(catalog.previous_snapshot_id));
	const snapshotObjects = [...before.snapshots].sort((a, b) => a.key.localeCompare(b.key));
	const snapshotBodies = await mapWithConcurrency(
		snapshotObjects,
		BUCKET_SCAN_CONCURRENCY,
		async (object) =>
			mustRead(object.key)
				? ((await decodeRecord(await bucket.get(object.key), SnapshotSchema)).data ?? null)
				: undefined,
	);
	const candidates: CatalogRecoveryCandidate[] = [];
	let selected: Snapshot | undefined;
	snapshotObjects.forEach((object, index) => {
		const snapshot = snapshotBodies[index];
		if (snapshot === undefined) {
			const id = object.key.slice(paths.snapshotsPrefix.length).replace(/\.json$/, '');
			if (!SnapshotId.is(id) || paths.snapshot(id) !== object.key) {
				issue(object.key, 'warning', INVALID_SNAPSHOT);
				return;
			}
			candidates.push({
				id,
				createdAt: object.uploaded.toISOString(),
				reference: reference(id, object.key),
			});
			return;
		}
		if (!snapshot || paths.snapshot(snapshot.snapshot_id) !== object.key) {
			issue(object.key, 'warning', INVALID_SNAPSHOT);
			return;
		}
		candidates.push({
			id: snapshot.snapshot_id,
			createdAt: snapshot.created_at,
			projects: snapshot.projects.length,
			reference: reference(snapshot.snapshot_id, object.key),
		});
		if (source.mode === 'snapshot' && snapshot.snapshot_id === source.snapshotId)
			selected = snapshot;
	});
	candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
	if (source.mode === 'snapshot' && !selected) {
		issue(paths.snapshot(source.snapshotId), 'error', 'Selected snapshot is missing or invalid.');
	}
	if (source.mode === 'rebuild') {
		issue(
			'projects/',
			'warning',
			'Record discovery cannot prove catalog publication. Review every recovered entry.',
		);
	} else if (
		candidates.find((candidate) => candidate.id === source.snapshotId)?.reference === 'unverified'
	) {
		issue(
			paths.snapshot(source.snapshotId),
			'warning',
			'No surviving pointer proves that this snapshot was committed.',
		);
	}

	const storedProjectIds = validIds(projectKeys.keys(), ProjectId);
	let projectIds: ProjectId[];
	if (source.mode === 'snapshot') {
		projectIds = selected?.projects.map((project) => project.id) ?? [];
		if (selected) {
			const kept = new Set<string>(projectIds);
			for (const id of storedProjectIds) {
				if (!kept.has(id)) {
					issue(paths.project(id).meta, 'excluded', ABSENT_FROM_SNAPSHOT);
				}
			}
		}
	} else {
		projectIds = storedProjectIds;
	}
	const planned = await mapWithConcurrency(projectIds, BUCKET_SCAN_CONCURRENCY, (projectId) =>
		planProject({
			bucket,
			source,
			keys,
			projectId,
			projectKeys: projectKeys.get(projectId),
			previous: selected?.projects.find((entry) => entry.id === projectId),
		}),
	);
	const projects: SnapshotProjectEntry[] = [];
	for (const result of planned) {
		issues.push(...result.issues);
		if (result.entry) projects.push(result.entry);
	}
	if (before.digest !== (await inventory(bucket)).digest) {
		throw new ConflictError(
			'Storage changed during recovery inspection. Stop all writers and retry.',
		);
	}
	const report = {
		source,
		catalogEtag: catalogObject?.etag ?? null,
		candidates,
		issues,
		projects,
		snapshot: selected,
	};
	return {
		...report,
		token: await sha256Hex(JSON.stringify({ inventory: before.digest, report })),
	};
}

async function planProject({
	bucket,
	source,
	keys,
	projectId,
	projectKeys,
	previous,
}: {
	bucket: Bucket;
	source: CatalogRecoverySource;
	keys: ReadonlySet<string>;
	projectId: ProjectId;
	projectKeys: ProjectKeys | undefined;
	previous: SnapshotProjectEntry | undefined;
}): Promise<{ entry?: SnapshotProjectEntry; issues: CatalogRecoveryIssue[] }> {
	const issues: CatalogRecoveryIssue[] = [];
	const issue = (key: string, severity: CatalogRecoveryIssue['severity'], message: string) => {
		issues.push({ key, severity, message });
	};
	async function read<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
		const result = await decodeRecord(await bucket.get(key), schema);
		if (result.error) issue(key, 'error', result.error);
		return result.data;
	}

	const projectPaths = paths.project(projectId);
	const project = await read(projectPaths.meta, ProjectSchema);
	if (!project) return { issues };
	if (project.id !== projectId) {
		issue(projectPaths.meta, 'error', 'Project ID does not match its storage path.');
		return { issues };
	}
	const entry: SnapshotProjectEntry = {
		...previous,
		id: project.id,
		name: project.name,
		description: project.description,
		owner: project.owner,
		status: project.status,
		created_at: project.created_at,
		updated_at: project.updated_at,
		notebook_count: 0,
		notebooks: [],
	};
	Object.assign(entry, projectCatalogPatch(project, entry, { finalizeSecurityLabels: true }));
	const unpublished = new Set<NotebookId>();
	for (const key of projectKeys?.importReceipts ?? []) {
		const receipt = await read(key, NotebookImportItemSchema);
		if (!receipt) continue;
		for (const id of new Set([...receipt.attempts, receipt.notebook_id])) {
			if (id !== receipt.notebook_id || receipt.state !== 'complete') unpublished.add(id);
		}
	}
	const storedNotebookIds = validIds(projectKeys?.notebooks.keys() ?? [], NotebookId);
	let notebookIds: NotebookId[];
	if (source.mode === 'snapshot') {
		notebookIds = previous?.notebooks.map((notebook) => notebook.id) ?? [];
		const kept = new Set<string>(notebookIds);
		for (const id of storedNotebookIds) {
			const nb = projectPaths.notebook(id);
			if (!kept.has(id) && !keys.has(nb.previewMeta)) {
				issue(nb.meta, 'excluded', ABSENT_FROM_SNAPSHOT);
			}
		}
	} else {
		notebookIds = storedNotebookIds;
	}
	for (const notebookId of notebookIds) {
		const nb = projectPaths.notebook(notebookId);
		if (keys.has(nb.previewMeta)) {
			issue(nb.previewMeta, 'excluded', 'Preview runtimes are not catalog notebooks.');
			continue;
		}
		if (unpublished.has(notebookId)) {
			issue(nb.meta, 'excluded', 'Import attempt is not confirmed complete.');
			continue;
		}
		const meta = await read(nb.meta, NotebookMetaSchema);
		if (!meta) continue;
		if (meta.preview) {
			issue(nb.meta, 'excluded', 'Preview runtimes are not catalog notebooks.');
			continue;
		}
		if (meta.id !== notebookId || meta.project_id !== projectId) {
			issue(nb.meta, 'error', 'Notebook IDs do not match its storage path.');
			continue;
		}
		if (!UserId.is(meta.author)) {
			issue(nb.meta, 'error', 'Notebook author is invalid.');
			continue;
		}
		const notebookSource = await read(nb.source, SourceSchema);
		if (!notebookSource) continue;
		if (meta.status !== 'deleted') {
			const requiredKeys: string[] = [];
			if (notebookSource.current_version_id) {
				requiredKeys.push(nb.version(notebookSource.current_version_id).meta);
			}
			try {
				const policy = workspaceSourcePolicy(notebookSource);
				if (notebookSource.type === 'local') {
					requiredKeys.push(nb.workspaceFile(policy.entryNotebook));
				} else if (notebookSource.current_version_id) {
					requiredKeys.push(
						nb.version(notebookSource.current_version_id).workspaceFile(policy.entryNotebook),
					);
				} else if (meta.status !== 'draft') {
					issue(nb.source, 'error', 'Published synced notebook has no current version.');
				}
			} catch {
				issue(nb.source, 'error', 'Notebook entry path is invalid.');
			}
			for (const key of requiredKeys) {
				if (!keys.has(key)) issue(key, 'error', 'Referenced notebook content is missing.');
			}
		}
		const old = previous?.notebooks.find((notebook) => notebook.id === notebookId);
		const notebook: SnapshotProjectEntry['notebooks'][number] = {
			...old,
			...buildNotebookEntry(meta, notebookSource.type, nb.base, meta.author),
			last_run_at: meta.last_run_at,
			security_labels_pending: undefined,
			jobs: [],
		};
		entry.notebooks.push(notebook);
		if (meta.status !== 'deleted') entry.notebook_count++;
		if (meta.updated_at > entry.updated_at) entry.updated_at = meta.updated_at;
		const storedJobKeys = projectKeys?.notebooks.get(notebookId) ?? [];
		let jobKeys: string[];
		if (source.mode === 'snapshot') {
			jobKeys = (old?.jobs ?? []).map((job) => nb.job(job.id).head);
			const kept = new Set(jobKeys);
			for (const key of storedJobKeys) {
				if (!kept.has(key)) issue(key, 'excluded', ABSENT_FROM_SNAPSHOT);
			}
		} else {
			jobKeys = storedJobKeys;
		}
		for (const key of jobKeys) {
			const job = await read(key, JobDefinitionSchema);
			if (!job) continue;
			if (
				job.project_id !== projectId ||
				job.notebook_id !== notebookId ||
				nb.job(job.id).head !== key
			) {
				issue(key, 'error', 'Job IDs do not match its storage path.');
				continue;
			}
			if (keys.has(paths.jobDeletionClaim(projectId, notebookId, job.id))) {
				issue(key, 'excluded', 'Job deletion is in progress.');
				continue;
			}
			if (!keys.has(nb.jobIndex(job.created_at, job.id))) {
				issue(key, 'error', 'Job history index is missing; repair it before catalog recovery.');
				continue;
			}
			notebook.jobs!.push({
				...old?.jobs?.find((entry) => entry.id === job.id),
				...jobIndexEntry(job),
			});
		}
	}
	return { entry, issues };
}

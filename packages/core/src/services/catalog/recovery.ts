import type { z } from 'zod';
import type { Bucket, BucketObjectBody } from '../../ports/bucket';
import { ConflictError } from '../../errors';
import { NotebookId, ProjectId, UserId } from '../../ids';
import type { IdBrand, SnapshotId } from '../../ids';
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
	createdAt: string;
	projects: number;
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

function childIds<T extends string>(
	keys: ReadonlySet<string>,
	prefix: string,
	id: IdBrand<T>,
): T[] {
	const children = new Set<T>();
	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		const child = key.slice(prefix.length).split('/')[0];
		if (id.is(child)) children.add(child);
	}
	return [...children].sort();
}

async function inventory(bucket: Bucket) {
	const groups = await Promise.all(
		['projects/', paths.snapshotsPrefix, '_system/job-deletions/'].map((prefix) =>
			listAllObjects(bucket, prefix),
		),
	);
	const catalog = await bucket.head(paths.catalog);
	return [...groups.flat(), ...(catalog ? [catalog] : [])]
		.map(({ key, etag, size }) => ({ key, etag, size }))
		.sort((a, b) => a.key.localeCompare(b.key));
}

/** Offline only: the catalog CAS does not fence writes to individual metadata records. */
export async function planCatalogRecovery(
	bucket: Bucket,
	source: CatalogRecoverySource,
): Promise<CatalogRecoveryReport> {
	const before = await inventory(bucket);
	const keys = new Set(before.map((object) => object.key));
	const issues: CatalogRecoveryIssue[] = [];
	const issue = (key: string, severity: CatalogRecoveryIssue['severity'], message: string) => {
		issues.push({ key, severity, message });
	};
	for (const object of before) {
		if (!object.etag)
			issue(object.key, 'error', 'Storage must provide non-empty ETags for recovery.');
	}
	async function read<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
		const result = await decodeRecord(await bucket.get(key), schema);
		if (result.error) issue(key, 'error', result.error);
		return result.data;
	}

	// A damaged pointer must not prevent inspecting the surviving snapshots.
	const catalogObject = await bucket.get(paths.catalog);
	const { data: catalog } = await decodeRecord(catalogObject, CatalogSchema);
	if (catalogObject && !catalog) {
		issue(paths.catalog, 'warning', 'Catalog is corrupt; recovery will replace it.');
	}
	const candidates: CatalogRecoveryCandidate[] = [];
	let selected: Snapshot | undefined;
	for (const key of keys) {
		if (!key.startsWith(paths.snapshotsPrefix)) continue;
		const { data: snapshot } = await decodeRecord(await bucket.get(key), SnapshotSchema);
		if (!snapshot || paths.snapshot(snapshot.snapshot_id) !== key) {
			issue(key, 'warning', 'Snapshot is invalid and cannot be selected.');
			continue;
		}
		candidates.push({
			id: snapshot.snapshot_id,
			createdAt: snapshot.created_at,
			projects: snapshot.projects.length,
			reference:
				catalog?.current_snapshot_id === snapshot.snapshot_id &&
				catalog.current_snapshot_key === key
					? 'current'
					: catalog?.previous_snapshot_id === snapshot.snapshot_id
						? 'previous'
						: 'unverified',
		});
		if (source.mode === 'snapshot' && snapshot.snapshot_id === source.snapshotId)
			selected = snapshot;
	}
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

	const projects: SnapshotProjectEntry[] = [];
	const projectIds =
		source.mode === 'snapshot'
			? (selected?.projects.map((project) => project.id) ?? [])
			: childIds(keys, 'projects/', ProjectId);
	for (const projectId of projectIds) {
		const projectPaths = paths.project(projectId);
		const project = await read(projectPaths.meta, ProjectSchema);
		if (!project) continue;
		if (project.id !== projectId) {
			issue(projectPaths.meta, 'error', 'Project ID does not match its storage path.');
			continue;
		}
		const previous = selected?.projects.find((entry) => entry.id === projectId);
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
		projects.push(entry);
		const unpublished = new Set<NotebookId>();
		for (const key of keys) {
			if (!key.startsWith(projectPaths.notebookImportsPrefix) || !/\/items\/[^/]+\.json$/.test(key))
				continue;
			const receipt = await read(key, NotebookImportItemSchema);
			if (!receipt) continue;
			for (const id of new Set([...receipt.attempts, receipt.notebook_id])) {
				if (id !== receipt.notebook_id || receipt.state !== 'complete') unpublished.add(id);
			}
		}
		const notebookPrefix = `projects/${projectId}/notebooks/`;
		const notebookIds =
			source.mode === 'snapshot'
				? (previous?.notebooks.map((notebook) => notebook.id) ?? [])
				: childIds(keys, notebookPrefix, NotebookId);
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
			const jobKeys =
				source.mode === 'snapshot'
					? (old?.jobs ?? []).map((job) => nb.job(job.id).head)
					: [...keys].filter(
							(key) =>
								key.startsWith(nb.jobsPrefix) &&
								/^jobs\/[^/]+\/job\.json$/.test(key.slice(nb.base.length + 1)),
						);
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
	}
	if (JSON.stringify(before) !== JSON.stringify(await inventory(bucket))) {
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
	return { ...report, token: await sha256Hex(JSON.stringify({ inventory: before, report })) };
}

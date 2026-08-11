import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import { NotebookMetaSchema, ProjectSchema, readStored } from '../../schema';
import type { Project, SnapshotNotebookEntry, SnapshotProjectEntry } from '../../schema';
import { notebookCatalogPatch } from './notebookMeta';

/**
 * These reads run inside each catalog CAS attempt. Reading only before the first
 * attempt is unsafe: a newer metadata writer can finish its catalog update first,
 * letting a stale projection commit without losing the catalog CAS. A missing
 * object means a hard-delete won. Active mutations leave the catalog unchanged;
 * delete callers can still project their committed tombstone.
 */
export async function loadNotebookCatalogPatch(
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<Partial<SnapshotNotebookEntry> | undefined> {
	const key = paths.project(projectId).notebook(notebookId).meta;
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	return notebookCatalogPatch(await readStored(NotebookMetaSchema, obj, key));
}

export async function loadProjectCatalogPatch(
	bucket: Bucket,
	projectId: ProjectId,
	entry: SnapshotProjectEntry,
): Promise<Partial<SnapshotProjectEntry> | undefined> {
	const key = paths.project(projectId).meta;
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	return projectCatalogPatch(await readStored(ProjectSchema, obj, key), entry);
}

export function projectCatalogPatch(
	project: Project,
	entry: SnapshotProjectEntry,
): Partial<SnapshotProjectEntry> {
	return {
		name: project.name,
		description: project.description,
		status: project.status,
		updated_at: entry.updated_at >= project.updated_at ? entry.updated_at : project.updated_at,
		member_ids: project.members.flatMap((member) =>
			member.user_id !== undefined ? [member.user_id] : [],
		),
		member_emails: project.members.flatMap((member) =>
			member.email !== undefined ? [member.email] : [],
		),
	};
}

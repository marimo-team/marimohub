import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import { NotebookMetaSchema, ProjectSchema, readStored } from '../../schema';
import type { Project, SnapshotNotebookEntry, SnapshotProjectEntry } from '../../schema';
import type { ResourceSecurityLabels } from '../../securityLabels';
import { notebookCatalogPatch } from './notebookMeta';

/**
 * These reads run inside each catalog CAS attempt. Reading only before the first
 * attempt is unsafe: a newer metadata writer can finish its catalog update first,
 * letting a stale projection commit without losing the catalog CAS. A missing
 * object means a hard-delete won. Active mutations leave the catalog unchanged;
 * delete callers can still project their committed tombstone.
 */
export interface SecurityLabelProjectionOptions {
	/**
	 * Only a label mutation's own finalization step may pass this: it writes the
	 * authoritative labels into the projection and clears the pending marker.
	 * Routine projections must never do either — between the pending marker and
	 * the authoritative write, `project.json`/`notebook.json` still hold the
	 * PRE-mutation labels, and resurrecting them into the projection would let a
	 * crash after the authoritative write leave listings trusting stale labels.
	 */
	finalizeSecurityLabels?: true;
}

/**
 * The label fields of a projection patch, honoring the in-flight pending
 * marker (see {@link SecurityLabelProjectionOptions}). While pending, the
 * projection stays indeterminate — readers fall back to the authoritative
 * record, which is correct at every instant of the mutation.
 */
function securityLabelsProjection(
	authoritative: { security_labels?: ResourceSecurityLabels },
	entry: { security_labels_pending?: true },
	options?: SecurityLabelProjectionOptions,
): Pick<SnapshotProjectEntry, 'security_labels' | 'security_labels_pending'> {
	if (options?.finalizeSecurityLabels) {
		return {
			security_labels: authoritative.security_labels ?? null,
			security_labels_pending: undefined,
		};
	}
	if (entry.security_labels_pending) {
		return { security_labels: undefined };
	}
	// Tri-state projection: null marks KNOWN-unlabeled so lists can skip the
	// authoritative read. Routine projections self-heal a stale (legacy,
	// non-pending) label state.
	return { security_labels: authoritative.security_labels ?? null };
}

export async function loadNotebookCatalogPatch(
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
	entry: SnapshotNotebookEntry,
	options?: SecurityLabelProjectionOptions,
): Promise<Partial<SnapshotNotebookEntry> | undefined> {
	const key = paths.project(projectId).notebook(notebookId).meta;
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	return notebookCatalogPatch(await readStored(NotebookMetaSchema, obj, key), entry, options);
}

export async function loadProjectCatalogPatch(
	bucket: Bucket,
	projectId: ProjectId,
	entry: SnapshotProjectEntry,
	options?: SecurityLabelProjectionOptions,
): Promise<Partial<SnapshotProjectEntry> | undefined> {
	const key = paths.project(projectId).meta;
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	return projectCatalogPatch(await readStored(ProjectSchema, obj, key), entry, options);
}

export function projectCatalogPatch(
	project: Project,
	entry: SnapshotProjectEntry,
	options?: SecurityLabelProjectionOptions,
): Partial<SnapshotProjectEntry> {
	return {
		name: project.name,
		description: project.description,
		status: project.status,
		tags: project.tags,
		updated_at: entry.updated_at >= project.updated_at ? entry.updated_at : project.updated_at,
		member_ids: project.members.flatMap((member) =>
			member.user_id !== undefined ? [member.user_id] : [],
		),
		member_emails: project.members.flatMap((member) =>
			member.email !== undefined ? [member.email] : [],
		),
		...securityLabelsProjection(project, entry, options),
	};
}

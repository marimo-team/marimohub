// Projection loaders reread metadata on every catalog CAS attempt.
// Otherwise, an older metadata write can overwrite a newer projection.
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId, SnapshotId } from '../../ids';
import { paths } from '../../paths';
import { NotebookMetaSchema, ProjectSchema, readStored } from '../../schema';
import type { Project, SnapshotNotebookEntry, SnapshotProjectEntry } from '../../schema';
import type { ResourceSecurityLabels } from '../../securityLabels';
import { notebookCatalogPatch } from './notebookMeta';

export interface SecurityLabelProjectionOptions {
	/**
	 * Only the label mutation can clear its pending marker.
	 * Routine projections must preserve the marker to prevent stale authorization.
	 */
	finalizeSecurityLabels?: true;
}

interface ProjectProjectionOptions extends SecurityLabelProjectionOptions {
	/** Clear only this mutation's marker. Other writers can still be active. */
	finalizeAccess?: SnapshotId;
}

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
	// null distinguishes a known absence of labels from an indeterminate projection.
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
	options?: ProjectProjectionOptions,
): Promise<Partial<SnapshotProjectEntry> | undefined> {
	const key = paths.project(projectId).meta;
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	return projectCatalogPatch(await readStored(ProjectSchema, obj, key), entry, options);
}

export function projectCatalogPatch(
	project: Project,
	entry: Pick<SnapshotProjectEntry, 'updated_at' | 'security_labels_pending' | 'access_pending'>,
	options?: ProjectProjectionOptions,
) {
	const pending = entry.access_pending?.filter((id) => id !== options?.finalizeAccess);
	const defaultRole = project.default_role ?? 'inherit';
	return {
		access_pending: pending?.length ? pending : undefined,
		access: pending?.length ? undefined : { members: project.members, default_role: defaultRole },
		name: project.name,
		description: project.description,
		status: project.status,
		tags: project.tags,
		default_role: defaultRole,
		updated_at: entry.updated_at >= project.updated_at ? entry.updated_at : project.updated_at,
		member_ids: project.members.flatMap((member) =>
			member.user_id !== undefined ? [member.user_id] : [],
		),
		member_emails: project.members.flatMap((member) =>
			member.email !== undefined ? [member.email] : [],
		),
		member_groups: project.members.flatMap((member) =>
			member.group !== undefined ? [member.group] : [],
		),
		...securityLabelsProjection(project, entry, options),
	};
}

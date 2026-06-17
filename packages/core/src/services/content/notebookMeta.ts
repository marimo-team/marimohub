import type { NotebookId, ProjectId, UserId, VersionId } from '../../ids';
import type { NotebookMeta, SnapshotNotebookEntry, Source, Version } from '../../schema';

interface BuildNotebookMetaArgs {
	notebookId: NotebookId;
	projectId: ProjectId;
	actor: UserId;
	now: string;
	status: NotebookMeta['status'];
	title: string;
	description: string;
	tags?: string[];
	runtime?: NotebookMeta['runtime'];
}

/**
 * Build the `notebook.json` meta blob shared by the local and synced create
 * paths — the two differ only in the initial `status` (`active` vs `draft`).
 */
export function buildNotebookMeta(args: BuildNotebookMetaArgs): NotebookMeta {
	return {
		schema_version: 1,
		id: args.notebookId,
		project_id: args.projectId,
		title: args.title,
		description: args.description,
		status: args.status,
		author: args.actor,
		created_at: args.now,
		updated_at: args.now,
		last_run_at: null,
		tags: args.tags ?? [],
		runtime: args.runtime,
	};
}

interface BuildVersionArgs {
	versionId: VersionId;
	notebookId: NotebookId;
	now: string;
	author: UserId;
	message: string;
	parentId: VersionId | null;
}

/**
 * Build the immutable `version.json` meta shared by every save path (create,
 * update, session commit, git sync). Optional teardown descriptors
 * (`html_snapshot` / `session_snapshot`) are spread on by the caller that has them.
 */
export function buildVersion(args: BuildVersionArgs): Version {
	return {
		schema_version: 1,
		version_id: args.versionId,
		notebook_id: args.notebookId,
		saved_at: args.now,
		author: args.author,
		message: args.message,
		parent_id: args.parentId,
	};
}

/** The `source.json` for a local notebook pointing at its current version. */
export function localSource(versionId: VersionId): Source {
	return { schema_version: 1, type: 'local', current_version_id: versionId };
}

/**
 * Project the freshly-built meta into its catalog summary entry. `author` is
 * passed separately because the entry brands it as a `UserId` (the meta stores
 * it as an opaque string).
 */
export function buildNotebookEntry(
	meta: NotebookMeta,
	sourceType: SnapshotNotebookEntry['source_type'],
	keyPrefix: string,
	author: UserId,
): SnapshotNotebookEntry {
	return {
		id: meta.id,
		title: meta.title,
		description: meta.description,
		status: meta.status,
		source_type: sourceType,
		author,
		created_at: meta.created_at,
		updated_at: meta.updated_at,
		tags: meta.tags,
		last_run_at: null,
		key_prefix: keyPrefix,
	};
}

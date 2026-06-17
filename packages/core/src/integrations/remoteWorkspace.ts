import { BadRequestError } from '../errors';
import type { Source } from '../schema';

export interface SyncedWorkspaceFile {
	path: string;
	bytes: Uint8Array;
}

export type SyncedWorkspaceFileMap = Map<string, Uint8Array>;

export type WorkspaceLoadMode = 'mount-or-copy' | 'copy-only';

/**
 * How a notebook's source behaves as a sandbox workspace. Local notebooks are
 * editable and round-trip session edits back to the store; synced (git) sources
 * are read-only mirrors restored fresh from their last push. Source-type-specific
 * behavior is funnelled through this one descriptor so the provisioner, session
 * route, and read paths stay source-agnostic — see `WORKSPACE_SOURCE_POLICIES`.
 */
export interface WorkspaceSourcePolicy {
	entryNotebook: string;
	loadMode: WorkspaceLoadMode;
	persistSessionEdits: boolean;
	restoreFilesystemSnapshot: boolean;
}

export function isSafeWorkspacePath(path: string, allowEmpty = false): boolean {
	if (path === '') return allowEmpty;
	if (path.startsWith('/') || path.endsWith('/') || path.includes('\\') || path.includes('\0')) {
		return false;
	}
	return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function normalizeWorkspaceRootPath(path: string | undefined): string {
	const raw = path?.trim() ?? '';
	const normalized = raw.replace(/\/+$/, '');
	if (!isSafeWorkspacePath(normalized, true)) {
		throw new BadRequestError('root_path must be a relative path without . or .. segments');
	}
	return normalized;
}

export function normalizeEntryNotebook(path: string): string {
	const normalized = path.trim().replace(/\/+$/, '');
	if (!isSafeWorkspacePath(normalized) || !normalized.endsWith('.py')) {
		throw new BadRequestError('entry_notebook must be a relative .py file path');
	}
	return normalized;
}

export function normalizeWorkspaceFilePath(path: string): string {
	const normalized = path.trim();
	if (!isSafeWorkspacePath(normalized)) {
		throw new BadRequestError(`Invalid workspace file path: ${path}`);
	}
	return normalized;
}

export function toSyncedWorkspaceFileMap(files: SyncedWorkspaceFile[]): SyncedWorkspaceFileMap {
	const mapped = new Map<string, Uint8Array>();
	for (const file of files) {
		const path = normalizeWorkspaceFilePath(file.path);
		if (mapped.has(path)) {
			throw new BadRequestError(`Duplicate workspace file path: ${path}`);
		}
		mapped.set(path, file.bytes);
	}
	if (mapped.size === 0) {
		throw new BadRequestError('Sync archive did not contain any files');
	}
	return mapped;
}

/**
 * Per-source-type policy. Adding a new source kind (a new `Source['type']`) means
 * adding one row here — the rest of the system reads the policy, never the type.
 */
const WORKSPACE_SOURCE_POLICIES: {
	[K in Source['type']]: (source: Extract<Source, { type: K }>) => WorkspaceSourcePolicy;
} = {
	local: () => ({
		entryNotebook: 'notebook.py',
		loadMode: 'mount-or-copy',
		persistSessionEdits: true,
		restoreFilesystemSnapshot: true,
	}),
	git: (source) => ({
		entryNotebook: source.entry_notebook,
		loadMode: 'copy-only',
		persistSessionEdits: false,
		restoreFilesystemSnapshot: false,
	}),
};

export function workspaceSourcePolicy(source: Source): WorkspaceSourcePolicy {
	const policy = WORKSPACE_SOURCE_POLICIES[source.type] as (s: Source) => WorkspaceSourcePolicy;
	return policy(source);
}

/**
 * The workspace-relative entry notebook for a synced (read-only) source, or
 * `null` for a local source whose code lives in the bucket. Lets read paths pick
 * between `workspace/<entry>` and the local `notebook.py` without a type switch.
 */
export function remoteWorkspaceEntry(source: Source): string | null {
	const policy = workspaceSourcePolicy(source);
	return policy.persistSessionEdits ? null : policy.entryNotebook;
}

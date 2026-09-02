import { BadRequestError } from '../errors';
import type { Source } from '../schema';
import { MAX_WORKSPACE_BYTES, MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_FILES } from '../constants';

export interface SyncedWorkspaceFile {
	path: string;
	bytes: Uint8Array;
}

export type SyncedWorkspaceFileMap = Map<string, Uint8Array>;

export type WorkspaceLoadMode = 'mount-or-copy' | 'copy-only';
export const WORKSPACE_OPERATIONS = ['create', 'write', 'move', 'copy', 'delete'] as const;
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceReadOnlyReason = 'git_source' | 'viewer' | 'active_session';
export const WORKSPACE_DIRECTORY_MARKER = '.marimohub-directory';

export const WORKSPACE_LIMITS = {
	maxFileBytes: MAX_WORKSPACE_FILE_BYTES,
	maxTotalBytes: MAX_WORKSPACE_BYTES,
	maxFiles: MAX_WORKSPACE_FILES,
} as const;

export interface WorkspacePathRule {
	path: string;
	deniedOperations: readonly WorkspaceOperation[];
}

function hasAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

/**
 * How a notebook's source behaves as a sandbox workspace. Local notebooks are
 * editable and round-trip session edits back to the store; synced (git) sources
 * are read-only mirrors restored fresh from their last sync. Source-type-specific
 * behavior is funnelled through this one descriptor so the provisioner, session
 * route, and read paths stay source-agnostic — see `WORKSPACE_SOURCE_POLICIES`.
 */
export interface WorkspaceSourcePolicy {
	entryNotebook: string;
	loadMode: WorkspaceLoadMode;
	persistSessionEdits: boolean;
	restoreFilesystemSnapshot: boolean;
	workspaceWritable: boolean;
	allowedOperations: readonly WorkspaceOperation[];
	protectedPaths: readonly WorkspacePathRule[];
}

const LOCAL_PROTECTED_PATHS: readonly WorkspacePathRule[] = [
	{ path: 'notebook.py', deniedOperations: ['move', 'delete'] },
	{ path: 'pyproject.toml', deniedOperations: ['move', 'delete'] },
];

export function isSafeWorkspacePath(path: string, allowEmpty = false): boolean {
	if (path === '') return allowEmpty;
	if (
		path.startsWith('/') ||
		path.endsWith('/') ||
		path.includes('\\') ||
		hasAsciiControlCharacter(path)
	) {
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

/**
 * Extensions marimo treats as first-class notebooks (mirrors marimo's
 * `MarimoPath.is_valid`, minus `.ipynb` which the runtime can't open yet).
 * Extend this list to admit new formats everywhere at once.
 */
export const NOTEBOOK_FILE_EXTENSIONS = ['.py', '.md', '.markdown', '.qmd'] as const;

export function isNotebookFilePath(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	// Require a non-empty stem: to `Path.suffix` a dotfile like `.md` has NO
	// extension, so marimo would refuse to open it.
	return NOTEBOOK_FILE_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length);
}

export function normalizeEntryNotebook(path: string): string {
	const normalized = path.trim().replace(/\/+$/, '');
	if (!isSafeWorkspacePath(normalized) || !isNotebookFilePath(normalized)) {
		throw new BadRequestError(
			`entry_notebook must be a relative notebook file path (${NOTEBOOK_FILE_EXTENSIONS.join(', ')})`,
		);
	}
	return normalized;
}

export function normalizeWorkspaceFilePath(path: string): string {
	const normalized = path;
	if (!isSafeWorkspacePath(normalized)) {
		throw new BadRequestError(`Invalid workspace file path: ${path}`);
	}
	if (isWorkspaceInternalPath(normalized)) {
		throw new BadRequestError(`Reserved workspace path: ${path}`);
	}
	return normalized;
}

export function isWorkspaceInternalPath(path: string): boolean {
	return path.split('/').includes(WORKSPACE_DIRECTORY_MARKER);
}

export function workspaceDirectoryMarkerPath(directory: string): string {
	return `${directory}/${WORKSPACE_DIRECTORY_MARKER}`;
}

export function workspaceDirectoryFromMarkerPath(path: string): string | null {
	if (path.endsWith('/')) return path.slice(0, -1);
	const suffix = `/${WORKSPACE_DIRECTORY_MARKER}`;
	return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
}

export function isWorkspaceDirectoryMarkerPath(path: string): boolean {
	return workspaceDirectoryFromMarkerPath(path) !== null;
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
		workspaceWritable: true,
		allowedOperations: WORKSPACE_OPERATIONS,
		protectedPaths: LOCAL_PROTECTED_PATHS,
	}),
	git: (source) => ({
		entryNotebook: source.entry_notebook,
		loadMode: 'copy-only',
		persistSessionEdits: false,
		restoreFilesystemSnapshot: false,
		workspaceWritable: false,
		allowedOperations: [],
		protectedPaths: [],
	}),
};

export function workspaceSourcePolicy(source: Source): WorkspaceSourcePolicy {
	const policy = WORKSPACE_SOURCE_POLICIES[source.type] as (s: Source) => WorkspaceSourcePolicy;
	return policy(source);
}

export function workspaceOperationDenied(
	source: Source,
	operation: WorkspaceOperation,
	path: string,
): boolean {
	const policy = workspaceSourcePolicy(source);
	if (!policy.allowedOperations.includes(operation)) return true;
	return policy.protectedPaths.some(
		(rule) => rule.path === path && rule.deniedOperations.includes(operation),
	);
}

/**
 * Whether `path` is a protected root anchor (`notebook.py`, `pyproject.toml`
 * for local sources). Such paths may only be written through the source owner,
 * so they are refused as the *target* of a copy or directory creation too.
 */
export function isProtectedWorkspacePath(source: Source, path: string): boolean {
	return workspaceSourcePolicy(source).protectedPaths.some((rule) => rule.path === path);
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

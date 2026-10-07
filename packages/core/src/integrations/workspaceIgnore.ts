import { BadRequestError } from '../errors';
import { normalizeWorkspaceFilePath, WORKSPACE_LIMITS } from './remoteWorkspace';

export const MAX_FOLDER_IMPORT_PATH_BYTES = 1024;
// Uncompressed ZIP: 30-byte local + 46-byte central headers, two UTF-8 filenames,
// then the 22-byte end record. The client supplies no comments or extra fields.
export const MAX_FOLDER_IMPORT_ARCHIVE_BYTES =
	WORKSPACE_LIMITS.maxTotalBytes +
	WORKSPACE_LIMITS.maxFiles * (76 + 2 * MAX_FOLDER_IMPORT_PATH_BYTES) +
	22;

export function validateFolderImportPath(path: string): string {
	normalizeWorkspaceFilePath(path);
	if (path.toLowerCase().startsWith('pyproject.toml/'))
		throw new BadRequestError('pyproject.toml must be a file');
	if (new TextEncoder().encode(path).byteLength > MAX_FOLDER_IMPORT_PATH_BYTES)
		throw new BadRequestError(
			`Folder paths must be at most ${MAX_FOLDER_IMPORT_PATH_BYTES} UTF-8 bytes: ${path}`,
		);
	return path;
}

/**
 * Directories tools rebuild on demand. Persisting them only spends the
 * workspace file and byte budgets, and proposing them as changes is noise.
 * Names match a path segment at any depth.
 */
export const REGENERABLE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
	'.ipynb_checkpoints',
	'.mypy_cache',
	'.pytest_cache',
	'.ruff_cache',
	'.venv',
	'__pycache__',
	'node_modules',
]);

export const REGENERABLE_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store']);

export function isRegenerableArtifactPath(path: string): boolean {
	const segments = path.split('/');
	return (
		segments.some((segment) => REGENERABLE_DIRECTORY_NAMES.has(segment)) ||
		REGENERABLE_FILE_NAMES.has(segments.at(-1) ?? '')
	);
}

export function isFolderImportExcludedPath(path: string): boolean {
	// Imported workspaces can run on case-insensitive filesystems, where .Git aliases .git.
	return (
		isRegenerableArtifactPath(path) ||
		path.split('/').some((segment) => segment.toLowerCase() === '.git')
	);
}

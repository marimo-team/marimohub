import { BadRequestError } from '../errors';
import { normalizeWorkspaceFilePath, WORKSPACE_LIMITS } from './remoteWorkspace';

// S3, R2 and GCS cap object keys at 1024 bytes. The longest key an imported path
// lands under is a version workspace,
// `projects/{pid}/notebooks/{nid}/versions/{vid}/workspace/` (111 bytes).
export const MAX_FOLDER_IMPORT_PATH_BYTES = 896;
// storage-fs maps each key segment to a file name, and NAME_MAX is 255 bytes.
export const MAX_FOLDER_IMPORT_SEGMENT_BYTES = 255;
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
	const encoder = new TextEncoder();
	if (encoder.encode(path).byteLength > MAX_FOLDER_IMPORT_PATH_BYTES)
		throw new BadRequestError(
			`Folder paths must be at most ${MAX_FOLDER_IMPORT_PATH_BYTES} UTF-8 bytes: ${path}`,
		);
	if (
		path
			.split('/')
			.some((segment) => encoder.encode(segment).byteLength > MAX_FOLDER_IMPORT_SEGMENT_BYTES)
	)
		throw new BadRequestError(
			`Folder and file names must be at most ${MAX_FOLDER_IMPORT_SEGMENT_BYTES} UTF-8 bytes: ${path}`,
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

/**
 * Virtualenvs that are not named `.venv` (`venv/`, `env/`, ...) are recognised by
 * their `pyvenv.cfg` marker. `site-packages` also catches installs without one.
 * Pass every candidate path so the marker can exclude its siblings.
 */
export function folderImportExcludedDirectories(paths: readonly string[]): string[] {
	const directories = new Set<string>();
	for (const path of paths) {
		const segments = path.split('/');
		if (segments.length > 1 && segments.at(-1) === 'pyvenv.cfg')
			directories.add(segments.slice(0, -1).join('/'));
		const sitePackages = segments.indexOf('site-packages');
		if (sitePackages !== -1 && sitePackages < segments.length - 1)
			directories.add(segments.slice(0, sitePackages + 1).join('/'));
	}
	return [...directories];
}

export function isFolderImportExcludedPath(
	path: string,
	excludedDirectories: readonly string[] = [],
): boolean {
	// Imported workspaces can run on case-insensitive filesystems, where .Git aliases .git.
	return (
		isRegenerableArtifactPath(path) ||
		path.split('/').some((segment) => segment.toLowerCase() === '.git') ||
		excludedDirectories.some((directory) => path.startsWith(`${directory}/`))
	);
}

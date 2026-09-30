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

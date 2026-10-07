import { describe, expect, it } from 'vitest';
import { zip } from 'fflate';
import { WORKSPACE_LIMITS } from './remoteWorkspace';
import {
	isRegenerableArtifactPath,
	isFolderImportExcludedPath,
	validateFolderImportPath,
	MAX_FOLDER_IMPORT_PATH_BYTES,
	MAX_FOLDER_IMPORT_ARCHIVE_BYTES,
} from './workspaceIgnore';

describe('isRegenerableArtifactPath', () => {
	it.each([
		'.venv/bin/python',
		'pkg/__pycache__/mod.pyc',
		'.ipynb_checkpoints/a.ipynb',
		'a/.mypy_cache/x',
		'.pytest_cache/v/cache',
		'.ruff_cache/0.1/x',
		'web/node_modules/pkg/index.js',
		'.DS_Store',
		'data/.DS_Store',
	])('matches %s', (path) => {
		expect(isRegenerableArtifactPath(path)).toBe(true);
	});

	it.each([
		'data/cars.csv',
		'.venv-backup/config',
		'__pycache__.txt',
		'.git/HEAD',
		'__marimo__/session/notebook.py.json',
		'.DS_Store.bak',
	])('does not match %s', (path) => {
		expect(isRegenerableArtifactPath(path)).toBe(false);
	});
});

describe('folder import paths and archive budget', () => {
	it.each(['.git/HEAD', '.Git/config', 'nested/.GIT/hooks/post-checkout'])(
		'excludes metadata aliases on case-insensitive filesystems: %s',
		(path) => expect(isFolderImportExcludedPath(path)).toBe(true),
	);

	it.each(['.gitignore', '.git-backup/config', 'data/.Git.csv'])(
		'keeps files that do not name a metadata directory: %s',
		(path) => expect(isFolderImportExcludedPath(path)).toBe(false),
	);

	it.each(['.marimohub-directory', 'a/.marimohub-directory/file', 'pyproject.toml/child.py'])(
		'rejects reserved import paths: %s',
		(path) => expect(() => validateFolderImportPath(path)).toThrow(),
	);

	it('caps UTF-8 bytes rather than characters without changing whitespace', () => {
		const path = 'é'.repeat(MAX_FOLDER_IMPORT_PATH_BYTES / 2);
		expect(validateFolderImportPath(path)).toBe(path);
		expect(() => validateFolderImportPath(`${path}a`)).toThrow('1024 UTF-8 bytes');
		expect(validateFolderImportPath(' dir / file.py')).toBe(' dir / file.py');
	});

	it('budgets both UTF-8 ZIP filenames for a full folder with long paths', async () => {
		const files = Object.fromEntries(
			Array.from({ length: WORKSPACE_LIMITS.maxFiles }, (_, index) => [
				`${`${'é'.repeat(100)}/`.repeat(5)}${String(index).padStart(4, '0')}.py`,
				new Uint8Array(0),
			]),
		);
		for (const path of Object.keys(files)) validateFolderImportPath(path);
		const archive = await new Promise<Uint8Array>((resolve, reject) => {
			zip(files, { level: 0 }, (error, bytes) => {
				if (error) reject(error);
				else resolve(bytes);
			});
		});
		const headerBytes = archive.byteLength;
		expect(headerBytes).toBeGreaterThan(1024 * 1024);
		expect(WORKSPACE_LIMITS.maxTotalBytes + headerBytes).toBeLessThanOrEqual(
			MAX_FOLDER_IMPORT_ARCHIVE_BYTES,
		);
	});
});

import { describe, expect, it } from 'vitest';
import { zip } from 'fflate';
import { WORKSPACE_LIMITS } from './remoteWorkspace';
import {
	isRegenerableArtifactPath,
	folderImportExcludedDirectories,
	isFolderImportExcludedPath,
	validateFolderImportPath,
	MAX_FOLDER_IMPORT_PATH_BYTES,
	MAX_FOLDER_IMPORT_SEGMENT_BYTES,
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

	it.each([
		'.marimohub-directory',
		'a/.marimohub-directory/file',
		'pyproject.toml/child.py',
		'PYPROJECT.TOML/child.py',
		'PyProject.toml/child.py',
	])('rejects reserved import paths: %s', (path) =>
		expect(() => validateFolderImportPath(path)).toThrow(),
	);

	it('caps UTF-8 bytes rather than characters without changing whitespace', () => {
		const segment = 'é'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES >> 1);
		const path = [segment, segment, segment].join('/');
		const padded = `${path}/${'a'.repeat(MAX_FOLDER_IMPORT_PATH_BYTES - new TextEncoder().encode(path).byteLength - 1)}`;
		expect(new TextEncoder().encode(padded).byteLength).toBe(MAX_FOLDER_IMPORT_PATH_BYTES);
		expect(validateFolderImportPath(padded)).toBe(padded);
		expect(() => validateFolderImportPath(`${padded}a`)).toThrow(
			`${MAX_FOLDER_IMPORT_PATH_BYTES} UTF-8 bytes`,
		);
		expect(validateFolderImportPath(' dir / file.py')).toBe(' dir / file.py');
	});

	it('caps each path segment at the file-name limit', () => {
		const name = 'é'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES >> 1);
		expect(validateFolderImportPath(`dir/${name}`)).toBe(`dir/${name}`);
		expect(() => validateFolderImportPath(`dir/${name}é`)).toThrow(
			`${MAX_FOLDER_IMPORT_SEGMENT_BYTES} UTF-8 bytes`,
		);
		expect(() => validateFolderImportPath(`${'x'.repeat(256)}/file.py`)).toThrow(
			`${MAX_FOLDER_IMPORT_SEGMENT_BYTES} UTF-8 bytes`,
		);
	});

	it('keeps the longest workspace key under the 1024-byte object-key limit', () => {
		const versionWorkspacePrefix =
			'projects/proj-0000000000000000/notebooks/nb-0000000000000000/versions/ver_00000000000000000000000000/workspace/';
		expect(versionWorkspacePrefix.length + MAX_FOLDER_IMPORT_PATH_BYTES).toBeLessThanOrEqual(1024);
	});

	it('excludes non-dot virtualenvs and site-packages directories', () => {
		const paths = [
			'venv/pyvenv.cfg',
			'venv/lib/python3.13/site-packages/pkg/__init__.py',
			'tools/env/pyvenv.cfg',
			'tools/env/bin/python',
			'vendor/lib/site-packages/mod.py',
			'app.py',
			'venv.py',
		];
		const excluded = folderImportExcludedDirectories(paths);
		expect(excluded.sort()).toEqual([
			'tools/env',
			'vendor/lib/site-packages',
			'venv',
			'venv/lib/python3.13/site-packages',
		]);
		expect(paths.filter((path) => isFolderImportExcludedPath(path, excluded))).toEqual([
			'venv/pyvenv.cfg',
			'venv/lib/python3.13/site-packages/pkg/__init__.py',
			'tools/env/pyvenv.cfg',
			'tools/env/bin/python',
			'vendor/lib/site-packages/mod.py',
		]);
		expect(isFolderImportExcludedPath('venv/lib/mod.py')).toBe(false);
	});

	it('excludes everything when the chosen folder is itself a virtualenv', () => {
		const paths = ['pyvenv.cfg', 'bin/python', 'lib/python3.13/site-packages/pkg.py', 'app.py'];
		const excluded = folderImportExcludedDirectories(paths);
		expect(excluded).toContain('');
		expect(paths.filter((path) => isFolderImportExcludedPath(path, excluded))).toEqual(paths);
	});

	it('budgets both UTF-8 ZIP filenames for a full folder with long paths', async () => {
		const files = Object.fromEntries(
			Array.from({ length: WORKSPACE_LIMITS.maxFiles }, (_, index) => [
				`${`${'é'.repeat(100)}/`.repeat(4)}${String(index).padStart(4, '0')}.py`,
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

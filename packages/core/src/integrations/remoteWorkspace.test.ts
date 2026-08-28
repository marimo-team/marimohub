import { describe, expect, it } from 'vitest';
import { createVersionId } from '../ids';
import { BadRequestError } from '../errors';
import type { Source } from '../schema';
import {
	isSafeWorkspacePath,
	isWorkspaceDirectoryMarkerPath,
	normalizeEntryNotebook,
	normalizeWorkspaceFilePath,
	normalizeWorkspaceRootPath,
	remoteWorkspaceEntry,
	toSyncedWorkspaceFileMap,
	workspaceOperationDenied,
	workspaceDirectoryFromMarkerPath,
	workspaceDirectoryMarkerPath,
	workspaceSourcePolicy,
} from './remoteWorkspace';

describe('remote workspace helpers', () => {
	it('describes local sources as editable mount-or-copy workspaces', () => {
		const source: Source = {
			schema_version: 1,
			type: 'local',
			current_version_id: createVersionId(),
		};

		expect(workspaceSourcePolicy(source)).toEqual({
			entryNotebook: 'notebook.py',
			loadMode: 'mount-or-copy',
			persistSessionEdits: true,
			restoreFilesystemSnapshot: true,
			workspaceWritable: true,
			allowedOperations: ['create', 'write', 'move', 'copy', 'delete'],
			protectedPaths: [
				{ path: 'notebook.py', deniedOperations: ['move', 'delete'] },
				{ path: 'pyproject.toml', deniedOperations: ['move', 'delete'] },
			],
		});
		expect(workspaceOperationDenied(source, 'write', 'notebook.py')).toBe(false);
		expect(workspaceOperationDenied(source, 'move', 'notebook.py')).toBe(true);
		expect(workspaceOperationDenied(source, 'delete', 'pyproject.toml')).toBe(true);
		expect(workspaceOperationDenied(source, 'move', 'data.csv')).toBe(false);
		expect(remoteWorkspaceEntry(source)).toBeNull();
	});

	it('describes git sources as copy-only remote mirrors', () => {
		const source: Source = {
			schema_version: 1,
			type: 'git',
			provider: 'github',
			repo: 'org/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'my_app.py',
			sync_mode: 'push',
			current_version_id: null,
			commit: null,
			last_synced_at: null,
		};

		expect(workspaceSourcePolicy(source)).toEqual({
			entryNotebook: 'my_app.py',
			loadMode: 'copy-only',
			persistSessionEdits: false,
			restoreFilesystemSnapshot: false,
			workspaceWritable: false,
			allowedOperations: [],
			protectedPaths: [],
		});
		expect(workspaceOperationDenied(source, 'write', 'my_app.py')).toBe(true);
		expect(remoteWorkspaceEntry(source)).toBe('my_app.py');
	});

	it('normalizes workspace roots and entry notebooks with one path contract', () => {
		expect(normalizeWorkspaceRootPath(' apps/ ')).toBe('apps');
		expect(normalizeWorkspaceRootPath(undefined)).toBe('');
		expect(normalizeEntryNotebook(' apps/main.py ')).toBe('apps/main.py');
		expect(normalizeEntryNotebook('docs/page.md')).toBe('docs/page.md');
		expect(normalizeEntryNotebook('docs/page.markdown')).toBe('docs/page.markdown');
		expect(normalizeEntryNotebook('docs/page.qmd')).toBe('docs/page.qmd');

		expect(isSafeWorkspacePath('data/cars.csv')).toBe(true);
		expect(isSafeWorkspacePath('', true)).toBe(true);
		expect(isSafeWorkspacePath('../cars.csv')).toBe(false);
		expect(isSafeWorkspacePath('/cars.csv')).toBe(false);
		expect(isSafeWorkspacePath('cars.csv/')).toBe(false);
	});

	it('rejects unsafe mirror file maps before writing to storage', () => {
		expect(() =>
			toSyncedWorkspaceFileMap([
				{ path: '../app.py', bytes: new TextEncoder().encode('print(1)') },
			]),
		).toThrow(BadRequestError);

		expect(() =>
			toSyncedWorkspaceFileMap([
				{ path: 'app.py', bytes: new Uint8Array() },
				{ path: 'app.py', bytes: new Uint8Array() },
			]),
		).toThrow(BadRequestError);
	});

	it('keeps directory markers internal and recognizes legacy marker keys', () => {
		expect(workspaceDirectoryMarkerPath('data/empty')).toBe('data/empty/.marimohub-directory');
		expect(workspaceDirectoryFromMarkerPath('data/empty/.marimohub-directory')).toBe('data/empty');
		expect(workspaceDirectoryFromMarkerPath('data/legacy/')).toBe('data/legacy');
		expect(isWorkspaceDirectoryMarkerPath('data/file.txt')).toBe(false);
		expect(() => normalizeWorkspaceFilePath('.marimohub-directory')).toThrow(BadRequestError);
		expect(() => normalizeWorkspaceFilePath('data/.marimohub-directory/file')).toThrow(
			BadRequestError,
		);
	});

	it('isSafeWorkspacePath rejects a null byte, a backslash, and a single-dot segment', () => {
		expect(isSafeWorkspacePath('data/\0.csv')).toBe(false);
		expect(isSafeWorkspacePath('data\\cars.csv')).toBe(false);
		expect(isSafeWorkspacePath('data/./cars.csv')).toBe(false);
		expect(isSafeWorkspacePath('.')).toBe(false);
	});

	it('rejects ASCII control characters anywhere in a workspace path', () => {
		for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
			expect(isSafeWorkspacePath(`data/a${String.fromCharCode(codePoint)}b.txt`)).toBe(false);
		}
	});

	it('normalizeEntryNotebook rejects a non-notebook path', () => {
		expect(() => normalizeEntryNotebook('apps/main.txt')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('apps/main')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('apps/main.md.bak')).toThrow(BadRequestError);
		// Not in NOTEBOOK_FILE_EXTENSIONS yet — the runtime can't open it.
		expect(() => normalizeEntryNotebook('apps/main.ipynb')).toThrow(BadRequestError);
	});

	it('normalizeEntryNotebook matches marimo suffix semantics on dotfiles and case', () => {
		// `Path('.md').suffix` is empty — marimo refuses a stemless dotfile.
		expect(() => normalizeEntryNotebook('.md')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('docs/.qmd')).toThrow(BadRequestError);
		// `Path('..md').suffix` is `.md` (stem `.`), so marimo accepts it.
		expect(normalizeEntryNotebook('..md')).toBe('..md');
		// Suffix matching is case-sensitive, as in `Path.suffix`.
		expect(() => normalizeEntryNotebook('page.MD')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('page.Py')).toThrow(BadRequestError);
	});

	it('normalizeEntryNotebook rejects traversal even with a notebook extension', () => {
		expect(() => normalizeEntryNotebook('../page.md')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('docs/../page.md')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('/docs/page.md')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('docs\\page.md')).toThrow(BadRequestError);
	});

	it('toSyncedWorkspaceFileMap rejects an empty archive', () => {
		expect(() => toSyncedWorkspaceFileMap([])).toThrow(BadRequestError);
	});
});

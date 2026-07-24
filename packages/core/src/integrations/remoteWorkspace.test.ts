import { describe, expect, it } from 'vitest';
import { createVersionId } from '../ids';
import { BadRequestError } from '../errors';
import type { Source } from '../schema';
import {
	isSafeWorkspacePath,
	normalizeEntryNotebook,
	normalizeWorkspaceRootPath,
	remoteWorkspaceEntry,
	toSyncedWorkspaceFileMap,
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
		});
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
		});
		expect(remoteWorkspaceEntry(source)).toBe('my_app.py');
	});

	it('normalizes workspace roots and entry notebooks with one path contract', () => {
		expect(normalizeWorkspaceRootPath(' apps/ ')).toBe('apps');
		expect(normalizeWorkspaceRootPath(undefined)).toBe('');
		expect(normalizeEntryNotebook(' apps/main.py ')).toBe('apps/main.py');

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

	it('isSafeWorkspacePath rejects a null byte, a backslash, and a single-dot segment', () => {
		expect(isSafeWorkspacePath('data/\0.csv')).toBe(false);
		expect(isSafeWorkspacePath('data\\cars.csv')).toBe(false);
		expect(isSafeWorkspacePath('data/./cars.csv')).toBe(false);
		expect(isSafeWorkspacePath('.')).toBe(false);
	});

	it('normalizeEntryNotebook rejects a non-.py path', () => {
		expect(() => normalizeEntryNotebook('apps/main.txt')).toThrow(BadRequestError);
		expect(() => normalizeEntryNotebook('apps/main')).toThrow(BadRequestError);
	});

	it('toSyncedWorkspaceFileMap rejects an empty archive', () => {
		expect(() => toSyncedWorkspaceFileMap([])).toThrow(BadRequestError);
	});
});

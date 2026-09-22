import { describe, expect, it } from 'vitest';
import { createNotebookId, createProjectId, createVersionId } from '../../ids';
import { paths } from '../../paths';
import { resolveNotebookLaunchSource } from './notebookLaunchSource';

const notebook = paths.project(createProjectId()).notebook(createNotebookId());
const version = notebook.version(createVersionId());

describe('resolveNotebookLaunchSource', () => {
	it('reads a local editor source from the live workspace without an overlay', () => {
		expect(
			resolveNotebookLaunchSource({
				entryNotebook: 'notebook.py',
				workspacePrefix: notebook.workspacePrefix,
			}),
		).toEqual({ entryNotebookKey: notebook.code, workspaceOverlay: undefined });
	});

	it('reads a nested synced entry from its immutable workspace without an overlay', () => {
		expect(
			resolveNotebookLaunchSource({
				entryNotebook: 'apps/dashboard.py',
				workspacePrefix: version.workspacePrefix,
			}),
		).toEqual({
			entryNotebookKey: version.workspaceFile('apps/dashboard.py'),
			workspaceOverlay: undefined,
		});
	});

	it('selects saved code and dependencies together over the live workspace', () => {
		expect(
			resolveNotebookLaunchSource({
				entryNotebook: 'notebook.py',
				workspacePrefix: notebook.workspacePrefix,
				localVersion: version,
			}),
		).toEqual({
			entryNotebookKey: version.code,
			workspaceOverlay: [
				{ path: 'notebook.py', key: version.code },
				{ path: 'pyproject.toml', key: version.deps },
			],
		});
	});
});

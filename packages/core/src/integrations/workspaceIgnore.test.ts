import { describe, expect, it } from 'vitest';
import { isRegenerableArtifactPath } from './workspaceIgnore';

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

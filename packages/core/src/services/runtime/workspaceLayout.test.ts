import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../errors';
import { createVersionId } from '../../ids';
import {
	pullSourceGitOptions,
	pullSourceRootPath,
	sandboxWorkspaceLayout,
} from './workspaceLayout';

describe('sandboxWorkspaceLayout', () => {
	it('collapses to the workdir without a root path', () => {
		expect(sandboxWorkspaceLayout('/workspace', '')).toEqual({
			workdir: '/workspace',
			gitRoot: '/workspace',
			rootPath: '',
		});
	});

	it('nests the workspace under the Git root for a subtree', () => {
		expect(sandboxWorkspaceLayout('/workspace', 'python/apps')).toEqual({
			workdir: '/workspace/python/apps',
			gitRoot: '/workspace',
			rootPath: 'python/apps',
		});
	});

	it('normalizes a trailing slash on the workdir', () => {
		expect(sandboxWorkspaceLayout('/workspace/', 'python')).toMatchObject({
			workdir: '/workspace/python',
			gitRoot: '/workspace',
		});
		expect(sandboxWorkspaceLayout('/workspace///', '')).toMatchObject({
			workdir: '/workspace',
			gitRoot: '/workspace',
		});
	});

	it('handles the filesystem root as the workdir', () => {
		expect(sandboxWorkspaceLayout('/', 'python')).toMatchObject({
			workdir: '/python',
			gitRoot: '/',
		});
		expect(sandboxWorkspaceLayout('/', '')).toMatchObject({ workdir: '/', gitRoot: '/' });
	});

	it.each([
		'..',
		'../escape',
		'a/../b',
		'/absolute',
		'trailing/',
		'a//b',
		'.',
		'back\\slash',
		'.git',
		'a/.git',
		'A/.GIT',
		'line\nbreak',
		'nul\u0000byte',
	])('rejects the unsafe root path %j as a corrupt record', (rootPath) => {
		expect(() => sandboxWorkspaceLayout('/workspace', rootPath)).toThrow(ConflictError);
		expect(() => sandboxWorkspaceLayout('/workspace', rootPath)).toThrow(
			'Unsafe workspace root path',
		);
	});

	it.each(['données', 'my dir'])('accepts the root path %j', (rootPath) => {
		expect(sandboxWorkspaceLayout('/workspace', rootPath).workdir).toBe(`/workspace/${rootPath}`);
	});
});

describe('pullSourceRootPath', () => {
	it('returns the subtree only for pull sources', () => {
		expect(pullSourceRootPath({ sync_mode: 'pull', root_path: 'python' })).toBe('python');
		expect(pullSourceRootPath({ sync_mode: 'pull', root_path: '' })).toBe('');
		expect(pullSourceRootPath({ sync_mode: 'push', root_path: 'python' })).toBe('');
	});
});

describe('pullSourceGitOptions', () => {
	const gitSource = {
		schema_version: 1 as const,
		type: 'git' as const,
		provider: 'github',
		repo: 'org/repo',
		branch: 'main',
		root_path: 'python',
		entry_notebook: 'app.py',
		current_version_id: null,
		commit: null,
		last_synced_at: null,
	};

	it('ships the stored Git directory and subtree only for pull sources', () => {
		const version = { gitPrefix: 'projects/p/notebooks/n/versions/v/git/' };
		expect(pullSourceGitOptions({ ...gitSource, sync_mode: 'pull' }, version)).toEqual({
			gitPrefix: version.gitPrefix,
			gitRootPath: 'python',
		});
		expect(pullSourceGitOptions({ ...gitSource, sync_mode: 'pull' }, undefined)).toEqual({
			gitPrefix: undefined,
			gitRootPath: 'python',
		});
		expect(pullSourceGitOptions({ ...gitSource, sync_mode: 'push' }, version)).toEqual({});
		expect(
			pullSourceGitOptions(
				{ schema_version: 1, type: 'local', current_version_id: createVersionId() },
				version,
			),
		).toEqual({});
	});
});

import { describe, expect, it } from 'vitest';
import {
	canApplyWorkspaceOperation,
	isWorkspacePathProtected,
	workspaceAccessMessage,
} from './workspacePolicy';
import type { WorkspaceAccess } from './workspacePolicy';

const writable: WorkspaceAccess = {
	writable: true,
	read_only_reason: null,
	protected_paths: [
		{ path: '/notebook.py', denied_operations: ['move', 'delete'] },
		{ path: '/pyproject.toml', denied_operations: ['move', 'delete'] },
	],
};

describe('workspace policy helpers', () => {
	it.each([
		['git_source', 'Git-backed workspaces are read-only.'],
		['viewer', 'Your project role allows browsing, but not workspace changes.'],
		['active_session', 'Workspace changes are disabled while an edit session is active.'],
	] as const)('describes the %s restriction', (reason, expected) => {
		expect(workspaceAccessMessage({ ...writable, writable: false, read_only_reason: reason })).toBe(
			expected,
		);
	});

	it('describes protected anchors for writable workspaces', () => {
		expect(workspaceAccessMessage(writable)).toContain(
			'notebook.py and pyproject.toml can be edited',
		);
	});

	it('matches only the exact protected path and denied operation', () => {
		expect(isWorkspacePathProtected(writable, '/notebook.py', 'move')).toBe(true);
		expect(isWorkspacePathProtected(writable, '/notebook.py', 'write')).toBe(false);
		expect(isWorkspacePathProtected(writable, '/nested/notebook.py', 'move')).toBe(false);
	});

	it('checks writable state, selection, and every selected path', () => {
		expect(canApplyWorkspaceOperation(writable, ['/data.csv'], 'delete')).toBe(true);
		expect(canApplyWorkspaceOperation(writable, [], 'delete')).toBe(false);
		expect(canApplyWorkspaceOperation(writable, ['/data.csv', '/notebook.py'], 'delete')).toBe(
			false,
		);
		expect(
			canApplyWorkspaceOperation(
				{ ...writable, writable: false, read_only_reason: 'viewer' },
				['/data.csv'],
				'delete',
			),
		).toBe(false);
	});
});

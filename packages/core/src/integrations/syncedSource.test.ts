import { describe, expect, it } from 'vitest';
import type { GitSource } from '../schema';
import { createGitSource, isAtBranchHead, sourceDrift } from './syncedSource';

function syncedSource(overrides: Partial<GitSource> = {}): GitSource {
	return {
		...createGitSource({
			title: 'Dash',
			description: 'd',
			repo: 'org/repo',
			branch: 'main',
			entry_notebook: 'app.py',
		}),
		current_version_id: null,
		commit: 'aaa111',
		last_synced_at: '2025-03-05T14:00:00Z',
		...overrides,
	};
}

const PENDING = { repo: 'org/repo', branch: 'main', root_path: '', entry_notebook: 'other.py' };

describe('isAtBranchHead', () => {
	it('is true only for the synced commit with nothing pending', () => {
		expect(isAtBranchHead(syncedSource(), 'aaa111')).toBe(true);
		expect(isAtBranchHead(syncedSource(), 'bbb222')).toBe(false);
		expect(isAtBranchHead(syncedSource({ commit: null }), 'aaa111')).toBe(false);
		expect(isAtBranchHead(syncedSource({ pending_config: PENDING }), 'aaa111')).toBe(false);
	});
});

describe('sourceDrift', () => {
	it('reports in-sync at the synced commit', () => {
		expect(sourceDrift(syncedSource(), 'aaa111', '2025-03-05T15:00:00Z')).toEqual({
			current_commit: 'aaa111',
			remote_commit: 'aaa111',
			in_sync: true,
			pending_config: false,
			checked_at: '2025-03-05T15:00:00Z',
		});
	});

	it('reports drift behind a moved head and before the first sync', () => {
		expect(sourceDrift(syncedSource(), 'bbb222', 't')).toMatchObject({
			current_commit: 'aaa111',
			remote_commit: 'bbb222',
			in_sync: false,
		});
		expect(sourceDrift(syncedSource({ commit: null }), 'bbb222', 't')).toMatchObject({
			current_commit: null,
			in_sync: false,
		});
	});

	it('never reports in-sync while a settings edit is pending', () => {
		expect(sourceDrift(syncedSource({ pending_config: PENDING }), 'aaa111', 't')).toMatchObject({
			in_sync: false,
			pending_config: true,
		});
	});
});

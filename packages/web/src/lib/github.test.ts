import { describe, it, expect } from 'vitest';
import {
	gitEntryPath,
	githubCommitUrl,
	githubRepoUrl,
	githubSourceUrl,
	shortCommit,
	versionCommit,
} from './github';

const SOURCE = {
	repo: 'acme/analytics',
	branch: 'main',
	root_path: '',
	entry_notebook: 'app.py',
	commit: 'abc123def4567890',
};

describe('github link builders', () => {
	it('builds repo and commit urls', () => {
		expect(githubRepoUrl('acme/analytics')).toBe('https://github.com/acme/analytics');
		expect(githubCommitUrl('acme/analytics', 'abc123')).toBe(
			'https://github.com/acme/analytics/commit/abc123',
		);
	});

	it('joins root_path into the entry path only when set', () => {
		expect(gitEntryPath(SOURCE)).toBe('app.py');
		expect(gitEntryPath({ ...SOURCE, root_path: 'apps' })).toBe('apps/app.py');
	});

	it('pins the source url to the synced commit, falling back to the branch', () => {
		expect(githubSourceUrl(SOURCE)).toBe(
			'https://github.com/acme/analytics/blob/abc123def4567890/app.py',
		);
		expect(githubSourceUrl({ ...SOURCE, commit: null })).toBe(
			'https://github.com/acme/analytics/blob/main/app.py',
		);
	});

	it('abbreviates commits to 7 characters', () => {
		expect(shortCommit('abc123def4567890')).toBe('abc123d');
	});

	it('percent-encodes reserved characters per segment, keeping / separators', () => {
		expect(
			githubSourceUrl({
				...SOURCE,
				commit: null,
				branch: 'release?rc',
				root_path: 'reports',
				entry_notebook: 'q#1 final.py',
			}),
		).toBe('https://github.com/acme/analytics/blob/release%3Frc/reports/q%231%20final.py');
		expect(githubSourceUrl({ ...SOURCE, entry_notebook: 'アプリ.py' })).toBe(
			'https://github.com/acme/analytics/blob/abc123def4567890/%E3%82%A2%E3%83%97%E3%83%AA.py',
		);
		expect(githubRepoUrl('acme/repo#2')).toBe('https://github.com/acme/repo%232');
		expect(githubCommitUrl('acme/repo', 'abc#123')).toBe(
			'https://github.com/acme/repo/commit/abc%23123',
		);
	});

	it('a branch containing slashes keeps them as separators', () => {
		expect(githubSourceUrl({ ...SOURCE, commit: null, branch: 'feature/x y' })).toBe(
			'https://github.com/acme/analytics/blob/feature/x%20y/app.py',
		);
	});
});

describe('versionCommit', () => {
	it('prefers the stamped commit field', () => {
		expect(versionCommit({ commit: 'abc123def456', message: 'Sync deadbeefcafe' })).toBe(
			'abc123def456',
		);
	});

	it('falls back to parsing the legacy "Sync <sha>" message', () => {
		expect(versionCommit({ message: 'Sync deadbeefcafe' })).toBe('deadbeefcafe');
	});

	it('returns null for non-sync messages', () => {
		expect(versionCommit({ message: 'Session save' })).toBeNull();
		expect(versionCommit({ message: 'Sync not-a-sha!' })).toBeNull();
		expect(versionCommit({ message: '' })).toBeNull();
	});
});

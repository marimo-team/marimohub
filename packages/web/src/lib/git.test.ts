import { describe, it, expect } from 'vitest';
import type { NotebookDetail } from '@/types';
import {
	ENTRY_NOTEBOOK_PATTERN,
	gitBranchUrl,
	gitCommitUrl,
	gitCoords,
	gitEntryPath,
	gitSourceUrl,
	isGitHubRepoInput,
	isRepoInput,
	providerLabel,
	shortCommit,
	versionCommit,
} from './git';

const gitSource = (overrides: Record<string, unknown> = {}) =>
	({
		type: 'git',
		provider: 'github',
		repo: 'acme/analytics',
		branch: 'main',
		root_path: '',
		entry_notebook: 'app.py',
		sync_mode: 'push',
		current_version_id: 'v1',
		commit: 'abc123def4567890',
		last_synced_at: null,
		...overrides,
	}) as NotebookDetail['source'];

const COORDS = gitCoords(gitSource())!;

describe('gitCoords', () => {
	it('maps owner/repo shorthand to a github.com base URL', () => {
		expect(COORDS).toMatchObject({
			provider: 'github',
			baseUrl: 'https://github.com/acme/analytics',
			commit: 'abc123def4567890',
		});
	});

	it('uses a URL repo as the base, detecting the provider from the host', () => {
		const coords = gitCoords(
			gitSource({ provider: null, repo: 'https://my-gitlab-url.my-company.org/group1/marimo/nb' }),
		);
		expect(coords).toMatchObject({
			provider: 'gitlab',
			baseUrl: 'https://my-gitlab-url.my-company.org/group1/marimo/nb',
		});
	});

	it('strips trailing slash and .git from URL repos', () => {
		expect(gitCoords(gitSource({ repo: 'https://github.com/acme/analytics.git' }))?.baseUrl).toBe(
			'https://github.com/acme/analytics',
		);
		expect(gitCoords(gitSource({ repo: 'https://gitlab.com/group/project/' }))?.baseUrl).toBe(
			'https://gitlab.com/group/project',
		);
	});

	it('strips a legacy .git suffix from shorthand repos', () => {
		expect(gitCoords(gitSource({ repo: 'acme/analytics.git' }))?.baseUrl).toBe(
			'https://github.com/acme/analytics',
		);
	});

	it('keeps ports on self-hosted URLs', () => {
		expect(
			gitCoords(gitSource({ repo: 'https://gitlab.example.com:8443/group/project' }))?.baseUrl,
		).toBe('https://gitlab.example.com:8443/group/project');
	});

	it('falls back to the stored provider claim for unrecognizable hosts', () => {
		expect(
			gitCoords(gitSource({ provider: 'gitlab', repo: 'https://code.my-company.org/team/repo' })),
		).toMatchObject({ provider: 'gitlab', baseUrl: 'https://code.my-company.org/team/repo' });
	});

	it('returns null for non-git, undefined, or unrecognized-host sources', () => {
		expect(gitCoords(undefined)).toBeNull();
		expect(gitCoords({ type: 'local', current_version_id: 'v1' })).toBeNull();
		expect(
			gitCoords(gitSource({ provider: null, repo: 'https://code.my-company.org/team/repo' })),
		).toBeNull();
	});

	it('returns null when repo is neither owner/repo nor a URL (never a wrong link)', () => {
		expect(gitCoords(gitSource({ repo: 'git@github.com:acme/analytics.git' }))).toBeNull();
		expect(gitCoords(gitSource({ repo: 'just-a-name' }))).toBeNull();
		expect(gitCoords(gitSource({ repo: 'a/b/c' }))).toBeNull();
		expect(gitCoords(gitSource({ repo: 'https://gitlab.com/only-group' }))).toBeNull();
	});

	it('returns null for dot segments that would escape the repo path', () => {
		expect(gitCoords(gitSource({ repo: 'acme/..' }))).toBeNull();
		expect(gitCoords(gitSource({ repo: 'https://gitlab.example.com/acme/../other' }))).toBeNull();
	});
});

describe('link builders', () => {
	it('builds GitHub urls', () => {
		expect(gitCommitUrl(COORDS, 'abc123')).toBe('https://github.com/acme/analytics/commit/abc123');
		expect(gitBranchUrl(COORDS, 'feature/x y')).toBe(
			'https://github.com/acme/analytics/tree/feature/x%20y',
		);
		expect(gitSourceUrl(COORDS)).toBe(
			'https://github.com/acme/analytics/blob/abc123def4567890/app.py',
		);
	});

	it('builds GitLab urls under the /-/ namespace', () => {
		const coords = gitCoords(gitSource({ repo: 'https://gitlab.com/group/sub/project' }))!;
		expect(coords.provider).toBe('gitlab');
		expect(gitCommitUrl(coords, 'abc123')).toBe(
			'https://gitlab.com/group/sub/project/-/commit/abc123',
		);
		expect(gitBranchUrl(coords, 'main')).toBe('https://gitlab.com/group/sub/project/-/tree/main');
		expect(gitSourceUrl(coords)).toBe(
			'https://gitlab.com/group/sub/project/-/blob/abc123def4567890/app.py',
		);
	});

	it('joins root_path into the entry path only when set', () => {
		expect(gitEntryPath(COORDS)).toBe('app.py');
		expect(gitEntryPath({ ...COORDS, root_path: 'apps' })).toBe('apps/app.py');
	});

	it('pins the source url to the synced commit, falling back to the branch', () => {
		expect(gitSourceUrl({ ...COORDS, commit: null })).toBe(
			'https://github.com/acme/analytics/blob/main/app.py',
		);
	});

	it('percent-encodes reserved characters per segment, keeping / separators', () => {
		expect(
			gitSourceUrl({
				...COORDS,
				commit: null,
				branch: 'release?rc',
				root_path: 'reports',
				entry_notebook: 'q#1 final.py',
			}),
		).toBe('https://github.com/acme/analytics/blob/release%3Frc/reports/q%231%20final.py');
		expect(gitSourceUrl({ ...COORDS, entry_notebook: 'アプリ.py' })).toBe(
			'https://github.com/acme/analytics/blob/abc123def4567890/%E3%82%A2%E3%83%97%E3%83%AA.py',
		);
		expect(gitCommitUrl(COORDS, 'abc#123')).toBe(
			'https://github.com/acme/analytics/commit/abc%23123',
		);
	});

	it('a branch containing slashes keeps them as separators', () => {
		expect(gitSourceUrl({ ...COORDS, commit: null, branch: 'feature/x y' })).toBe(
			'https://github.com/acme/analytics/blob/feature/x%20y/app.py',
		);
	});
});

describe('providerLabel', () => {
	it('names the host', () => {
		expect(providerLabel('github')).toBe('GitHub');
		expect(providerLabel('gitlab')).toBe('GitLab');
	});
});

describe('isRepoInput', () => {
	it('accepts owner/repo, URLs, scheme-less hosts, and SSH remotes', () => {
		expect(isRepoInput('acme/analytics')).toBe(true);
		expect(isRepoInput('acme/analytics.git')).toBe(true);
		expect(isRepoInput('https://gitlab.com/group/sub/project')).toBe(true);
		expect(isRepoInput('http://gitlab/group/project')).toBe(true);
		expect(isRepoInput('my-gitlab-url.my-company.org/group1/marimo/nb')).toBe(true);
		expect(isRepoInput('git@github.com:acme/analytics.git')).toBe(true);
		expect(isRepoInput('ssh://git@gitlab.com:2222/group/project.git')).toBe(true);
	});

	it('rejects inputs that name no owner+repo path', () => {
		expect(isRepoInput('')).toBe(false);
		expect(isRepoInput('just-a-name')).toBe(false);
		expect(isRepoInput('a/b/c')).toBe(false);
		expect(isRepoInput('gitlab/group/project')).toBe(false);
		expect(isRepoInput('owner/..')).toBe(false);
		expect(isRepoInput('https://gitlab.com/only-group')).toBe(false);
		expect(isRepoInput('https://oauth2:token@gitlab.com/group/project')).toBe(false);
		expect(isRepoInput('ftp://gitlab.com/group/project')).toBe(false);
	});
});

describe('isGitHubRepoInput', () => {
	it('accepts GitHub shorthand and HTTPS URL forms', () => {
		for (const repo of [
			'acme/analytics',
			'acme/analytics.git',
			'https://github.com/acme/analytics',
			'HTTPS://GitHub.COM/acme/analytics.git/',
		]) {
			expect(isGitHubRepoInput(repo), repo).toBe(true);
		}
	});

	it('rejects other providers and unsupported GitHub hosts or coordinates', () => {
		for (const repo of [
			'https://gitlab.com/acme/analytics',
			'https://github.mycompany.com/acme/analytics',
			'https://github.com:444/acme/analytics',
			'http://github.com/acme/analytics',
			'https://notgithub.com/acme/analytics',
			'https://github.com/acme/team/analytics',
			'https://github.com/acme/analytics?tab=readme',
			'https://github.com/acme/analytics#readme',
			'github.com/acme/analytics',
			'git@github.com:acme/analytics.git',
			'ssh://git@github.com/acme/analytics.git',
			'-acme/analytics',
		]) {
			expect(isGitHubRepoInput(repo), repo).toBe(false);
		}
	});
});

describe('shortCommit', () => {
	it('abbreviates commits to 7 characters', () => {
		expect(shortCommit('abc123def4567890')).toBe('abc123d');
	});
});

describe('ENTRY_NOTEBOOK_PATTERN', () => {
	it('accepts every marimo notebook extension, at the root or nested', () => {
		for (const path of ['app.py', 'docs/page.md', 'page.markdown', 'reports/q3.qmd']) {
			expect(path).toMatch(ENTRY_NOTEBOOK_PATTERN);
		}
	});

	it('rejects other extensions, stemless dotfiles, and case mismatches (server parity)', () => {
		for (const path of ['app.txt', 'notes.ipynb', 'app', '.md', 'docs/.qmd', 'page.MD']) {
			expect(path).not.toMatch(ENTRY_NOTEBOOK_PATTERN);
		}
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

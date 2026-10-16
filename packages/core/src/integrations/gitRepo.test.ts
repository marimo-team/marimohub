import { describe, expect, it } from 'vitest';
import {
	detectProvider,
	gitLabRepositoryUrl,
	normalizeRepo,
	repoPath,
	reposMatch,
} from './gitRepo';

describe('gitLabRepositoryUrl', () => {
	it.each(['https:///gitlab.com/g/r', 'https:////gitlab.com/g/r', 'https://'])(
		'rejects a missing authority in %s',
		(value) => expect(gitLabRepositoryUrl(value)).toBeNull(),
	);

	it('canonicalizes the host without changing the project path', () => {
		expect(gitLabRepositoryUrl('HTTPS://GitLab.COM/Group/Sub/Project.git')).toBe(
			'https://gitlab.com/Group/Sub/Project',
		);
	});
});

describe('normalizeRepo', () => {
	it('keeps owner/repo shorthand as-is', () => {
		expect(normalizeRepo('acme/analytics')).toBe('acme/analytics');
		expect(normalizeRepo('  acme/analytics  ')).toBe('acme/analytics');
	});

	it('strips a .git suffix from shorthand', () => {
		expect(normalizeRepo('acme/analytics.git')).toBe('acme/analytics');
		expect(normalizeRepo('acme/.git')).toBeNull();
	});

	it('rejects dot-only shorthand repo names but keeps dotted ones', () => {
		expect(normalizeRepo('acme/.')).toBeNull();
		expect(normalizeRepo('acme/..')).toBeNull();
		expect(normalizeRepo('acme/.github')).toBe('acme/.github');
	});

	it('canonicalizes repository URLs, stripping trailing slashes and .git', () => {
		expect(normalizeRepo('https://gitlab.com/group/project')).toBe(
			'https://gitlab.com/group/project',
		);
		expect(normalizeRepo('https://gitlab.com/group/project.git')).toBe(
			'https://gitlab.com/group/project',
		);
		expect(normalizeRepo('https://gitlab.com/group/project.git/')).toBe(
			'https://gitlab.com/group/project',
		);
		expect(normalizeRepo('https://gitlab.com/group/project///')).toBe(
			'https://gitlab.com/group/project',
		);
	});

	it('collapses duplicate path separators', () => {
		expect(normalizeRepo('https://gitlab.com//group//project')).toBe(
			'https://gitlab.com/group/project',
		);
	});

	it('lowercases the host but preserves path case', () => {
		expect(normalizeRepo('HTTPS://GitHub.COM/Acme/Analytics')).toBe(
			'https://github.com/Acme/Analytics',
		);
	});

	it('keeps explicit ports and http schemes (self-hosted instances)', () => {
		expect(normalizeRepo('http://git.internal:8080/team/repo')).toBe(
			'http://git.internal:8080/team/repo',
		);
		expect(normalizeRepo('http://gitlab/group/project')).toBe('http://gitlab/group/project');
	});

	it('supports nested GitLab group paths', () => {
		expect(normalizeRepo('https://gitlab.example.com/group1/marimo/test-sync')).toBe(
			'https://gitlab.example.com/group1/marimo/test-sync',
		);
	});

	it('drops query strings and fragments', () => {
		expect(normalizeRepo('https://gitlab.com/group/project?tab=readme#top')).toBe(
			'https://gitlab.com/group/project',
		);
	});

	it('prefixes https:// onto scheme-less host/path inputs', () => {
		expect(normalizeRepo('my-gitlab-url.my-company.org/group1/marimo/nb')).toBe(
			'https://my-gitlab-url.my-company.org/group1/marimo/nb',
		);
		expect(normalizeRepo('gitlab.com/group/project')).toBe('https://gitlab.com/group/project');
		expect(normalizeRepo('gitlab.example.com:8443/group/project')).toBe(
			'https://gitlab.example.com:8443/group/project',
		);
	});

	it('converts SSH remotes to https URLs, dropping SSH ports', () => {
		expect(normalizeRepo('git@github.com:acme/analytics.git')).toBe(
			'https://github.com/acme/analytics',
		);
		expect(normalizeRepo('git@github.com:acme/analytics')).toBe(
			'https://github.com/acme/analytics',
		);
		expect(normalizeRepo('ssh://git@gitlab.com/group/project.git')).toBe(
			'https://gitlab.com/group/project',
		);
		expect(normalizeRepo('ssh://git@gitlab.com:2222/group/project.git')).toBe(
			'https://gitlab.com/group/project',
		);
	});

	it('rejects inputs that name no owner+repo path', () => {
		expect(normalizeRepo('')).toBeNull();
		expect(normalizeRepo('   ')).toBeNull();
		expect(normalizeRepo('just-a-name')).toBeNull();
		expect(normalizeRepo('a/b/c')).toBeNull();
		expect(normalizeRepo('gitlab/group/project')).toBeNull();
		expect(normalizeRepo('https://gitlab.com/only-group')).toBeNull();
		expect(normalizeRepo('https://gitlab.com')).toBeNull();
		expect(normalizeRepo('ftp://gitlab.com/group/project')).toBeNull();
		expect(normalizeRepo('git@github.com:only-owner')).toBeNull();
		expect(normalizeRepo('https://gitlab.com/group/../project')).toBeNull();
	});

	it('rejects URLs carrying credentials', () => {
		expect(normalizeRepo('https://oauth2:token@gitlab.com/group/project')).toBeNull();
		expect(normalizeRepo('https://user@gitlab.com/group/project')).toBeNull();
	});
});

describe('detectProvider', () => {
	it('treats owner/repo shorthand as GitHub', () => {
		expect(detectProvider('acme/analytics')).toBe('github');
	});

	it('uses exact configured hosts without inherited object properties', () => {
		const hosts = { 'git.acme.corp': 'github' as const };
		expect(detectProvider('https://git.acme.corp/acme/analytics', hosts)).toBe('github');
		expect(detectProvider('https://other.corp/acme/analytics', hosts)).toBeNull();
		expect(detectProvider('https://constructor/acme/analytics', hosts)).toBeNull();
	});

	it('recognizes github and gitlab hosts, including self-hosted names', () => {
		expect(detectProvider('https://github.com/acme/analytics')).toBe('github');
		expect(detectProvider('https://www.github.com/acme/analytics')).toBe('github');
		expect(detectProvider('https://github.my-company.org/acme/analytics')).toBe('github');
		expect(detectProvider('https://gitlab.com/group/project')).toBe('gitlab');
		expect(detectProvider('https://my-gitlab-url.my-company.org/group1/marimo/nb')).toBe('gitlab');
		expect(detectProvider('https://gitlab.example.com:8443/group/project')).toBe('gitlab');
	});

	it('returns null for unrecognized hosts and unparseable repos', () => {
		expect(detectProvider('https://code.my-company.org/team/repo')).toBeNull();
		expect(detectProvider('https://bitbucket.org/team/repo')).toBeNull();
		expect(detectProvider('just-a-name')).toBeNull();
	});
});

describe('repoPath', () => {
	it('strips the host from URLs and passes shorthand through', () => {
		expect(repoPath('https://gitlab.com/group/sub/project')).toBe('group/sub/project');
		expect(repoPath('acme/analytics')).toBe('acme/analytics');
	});
});

describe('reposMatch', () => {
	it('matches identical values and path-only restatements', () => {
		expect(reposMatch('acme/analytics', 'acme/analytics')).toBe(true);
		expect(reposMatch('https://gitlab.com/group/sub/project', 'group/sub/project')).toBe(true);
		expect(
			reposMatch('https://gitlab.com/group/project', 'https://gitlab.com/group/project.git'),
		).toBe(true);
	});

	it('matches across shapes of the same repository', () => {
		expect(reposMatch('acme/analytics', 'https://github.com/acme/analytics')).toBe(true);
		expect(reposMatch('https://gitlab.com/group/project', 'git@gitlab.com:group/project.git')).toBe(
			true,
		);
		expect(reposMatch('  acme/analytics  ', 'acme/analytics.git')).toBe(true);
	});

	it('folds case only for GitHub, whose paths are case-insensitive', () => {
		expect(reposMatch('Acme/Analytics', 'acme/analytics')).toBe(true);
		expect(reposMatch('https://github.com/Acme/Analytics', 'acme/analytics')).toBe(true);
		expect(reposMatch('https://gitlab.com/Group/Project', 'group/project')).toBe(false);
		expect(reposMatch('https://code.example.com/Team/Repo', 'team/repo')).toBe(false);
	});

	it('requires a received URL to be on the stored host', () => {
		expect(
			reposMatch(
				'https://gitlab-a.example.com/group/repo',
				'https://gitlab-b.example.com/group/repo',
			),
		).toBe(false);
		expect(reposMatch('acme/analytics', 'https://gitlab.com/acme/analytics')).toBe(false);
		expect(reposMatch('https://gitlab.com/group/repo', 'https://gitlab.com:8443/group/repo')).toBe(
			false,
		);
	});

	it.each([
		['https://git.acme.corp/Team/Repo', 'team/repo', true],
		['https://git.acme.corp/Team/Repo', 'https://git.acme.corp/team/repo.git', true],
		['https://git.acme.corp/Team/Repo', 'https://other.corp/team/repo', false],
		['https://git.acme.corp/Team/Repo', 'https://git.acme.corp:8443/team/repo', false],
		['https://git.acme.corp:8443/Team/Repo', 'team/repo', false],
		['https://gitlab.com/Team/Repo', 'team/repo', false],
		['https://git.internal/Team/Repo', 'team/repo', false],
		['https://unknown.corp/Team/Repo', 'team/repo', false],
	])('matches %s against %s using configured hosts: %s', (expected, received, matches) => {
		expect(
			reposMatch(expected, received, {
				'git.acme.corp': 'github',
				'git.internal': 'gitlab',
			}),
		).toBe(matches);
	});

	it('rejects different repositories', () => {
		expect(reposMatch('acme/analytics', 'other/analytics')).toBe(false);
		expect(reposMatch('acme/analytics', 'acme/analytics2')).toBe(false);
		expect(reposMatch('https://gitlab.com/group/project', 'group/other')).toBe(false);
		expect(reposMatch('https://gitlab.com/group/sub/project', 'sub/project')).toBe(false);
		expect(reposMatch('', '')).toBe(false);
	});
});

it('detects hosted Azure DevOps without matching lookalike hosts', () => {
	expect(detectProvider('https://dev.azure.com/acme/project/_git/notebooks')).toBe('azure-devops');
	expect(detectProvider('https://dev.azure.com.evil.test/acme/project/_git/notebooks')).toBeNull();
});

it.each([
	['https://dev.azure.com:443/acme/project/_git/notebooks', 'azure-devops'],
	['https://dev.azure.com:8443/acme/project/_git/notebooks', null],
	['http://dev.azure.com/acme/project/_git/notebooks', null],
])('detects Azure only at its hosted HTTPS origin: %s', (repo, provider) => {
	expect(detectProvider(repo)).toBe(provider);
});

it('preserves Azure repository names ending in .git through normalization and comparison', () => {
	const repo = 'https://dev.azure.com/acme/project/_git/notebooks.git';
	expect(normalizeRepo(`${repo}/`)).toBe(repo);
	expect(repoPath(repo)).toBe('acme/project/_git/notebooks.git');
	expect(reposMatch(repo, `${repo}/`)).toBe(true);
	expect(reposMatch(repo, 'acme/project/_git/notebooks.git')).toBe(true);
	expect(reposMatch(repo, 'https://dev.azure.com/acme/project/_git/notebooks')).toBe(false);
	expect(reposMatch(repo, 'acme/project/_git/notebooks')).toBe(false);
});

// Host-link builders for git-synced notebooks. The stored `repo` is either
// `owner/repo` (GitHub shorthand) or a repository URL; links are built only
// when the host's URL layout is known (GitHub or GitLab) — an unrecognized
// host degrades to "no link", never a wrong one.

import type { NotebookDetail, NotebookVersion } from '@/types';

export type GitProvider = 'github' | 'gitlab';

/** The git-source coordinates the link builders need (a subset of GitSource). */
export interface GitSourceCoords {
	provider: GitProvider;
	/** The repository home page, no trailing slash. */
	baseUrl: string;
	branch: string;
	root_path: string;
	entry_notebook: string;
	commit: string | null;
}

// Server-validated on new sources; older or API-written records may carry
// other shapes, which must degrade to "no link". Mirrors the server's
// OWNER_REPO_PATTERN (core gitRepo.ts), including the dot-only repo-name
// rejection (`owner/..` would escape the owner in a built URL).
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_-]+\/(?!\.+$)[A-Za-z0-9._-]+$/;
// Pull support is narrower than the generic source shape. Keep these rules in
// sync with source-control-github's parseRepository boundary.
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;

interface ParsedRepoInput {
	path: string;
	url: URL | null;
}

function parseRepoInput(input: string): ParsedRepoInput | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const bare = trimmed.replace(/\.git$/, '');
	if (OWNER_REPO_PATTERN.test(bare)) return { path: bare, url: null };

	let candidate = trimmed;
	const ssh =
		/^ssh:\/\/git@([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(candidate) ??
		/^git@([^/:\s]+):(.+)$/.exec(candidate);
	if (ssh) {
		candidate = `https://${ssh[1]}/${ssh[2]}`;
	} else if (!/^https?:\/\//i.test(candidate)) {
		const [firstSegment] = candidate.split('/', 1);
		if (!firstSegment?.includes('.')) return null;
		candidate = `https://${candidate}`;
	}
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (!url.hostname || url.username || url.password) return null;
	const segments = url.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/, '')
		.split('/')
		.filter(Boolean);
	if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..')) {
		return null;
	}
	return { path: segments.join('/'), url };
}

/**
 * Percent-encode each segment while keeping `/` separators — branches and
 * file paths may carry URL-reserved characters (`#`, `?`, spaces, …) that
 * would otherwise truncate or reroute the link.
 */
function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

function parseStoredRepo(
	repo: string,
	claim: unknown,
): { baseUrl: string; provider: GitProvider | null } | null {
	// Old records may carry a `.git` suffix the server now strips on write.
	const bare = repo.replace(/\.git$/, '');
	if (OWNER_REPO_PATTERN.test(bare)) {
		return { baseUrl: `https://github.com/${encodePath(bare)}`, provider: 'github' };
	}
	if (!/^https?:\/\//i.test(repo)) return null;
	let url: URL;
	try {
		url = new URL(repo);
	} catch {
		return null;
	}
	if (!url.hostname || url.username || url.password) return null;
	const segments = url.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/, '')
		.split('/')
		.filter(Boolean);
	if (segments.length < 2) return null;
	if (segments.some((s) => s === '.' || s === '..')) return null;
	const host = url.hostname.toLowerCase();
	// Host-name detection first; the stored provider is an unverified claim,
	// used only when the host says nothing (e.g. a self-hosted instance whose
	// name doesn't mention the product).
	const provider = host.includes('github')
		? 'github'
		: host.includes('gitlab')
			? 'gitlab'
			: claim === 'github' || claim === 'gitlab'
				? claim
				: null;
	return { baseUrl: `${url.protocol}//${url.host}/${segments.join('/')}`, provider };
}

/**
 * The coordinates to build host links from, or null when no trustworthy link
 * exists: a non-git source, a repo that parses to neither `owner/repo` nor a
 * repository URL, or a host whose URL layout is unknown.
 */
export function gitCoords(source: NotebookDetail['source'] | undefined): GitSourceCoords | null {
	if (source?.type !== 'git') return null;
	const parsed = parseStoredRepo(source.repo, source.provider);
	if (!parsed?.provider) return null;
	return {
		provider: parsed.provider,
		baseUrl: parsed.baseUrl,
		branch: source.branch,
		root_path: source.root_path,
		entry_notebook: source.entry_notebook,
		commit: source.commit,
	};
}

export function providerLabel(provider: GitProvider): string {
	return provider === 'gitlab' ? 'GitLab' : 'GitHub';
}

// GitLab namespaces deep links under `/-/` to keep them clear of nested
// group paths; GitHub nests them directly under the repo.
function deepLinkBase(coords: Pick<GitSourceCoords, 'provider' | 'baseUrl'>): string {
	return coords.provider === 'gitlab' ? `${coords.baseUrl}/-` : coords.baseUrl;
}

export function gitCommitUrl(
	coords: Pick<GitSourceCoords, 'provider' | 'baseUrl'>,
	commit: string,
): string {
	return `${deepLinkBase(coords)}/commit/${encodeURIComponent(commit)}`;
}

export function gitBranchUrl(
	coords: Pick<GitSourceCoords, 'provider' | 'baseUrl'>,
	branch: string,
): string {
	return `${deepLinkBase(coords)}/tree/${encodePath(branch)}`;
}

/** The repo-relative path of the synced entry notebook. */
export function gitEntryPath(
	source: Pick<GitSourceCoords, 'root_path' | 'entry_notebook'>,
): string {
	return source.root_path ? `${source.root_path}/${source.entry_notebook}` : source.entry_notebook;
}

/**
 * Link to the entry file on the host — pinned to the synced commit when known
 * (stable even if the branch moves on), falling back to the branch before the
 * first push.
 */
export function gitSourceUrl(coords: GitSourceCoords): string {
	const ref = coords.commit ?? coords.branch;
	return `${deepLinkBase(coords)}/blob/${encodePath(ref)}/${encodePath(gitEntryPath(coords))}`;
}

export function shortCommit(commit: string): string {
	return commit.slice(0, 7);
}

/**
 * The synced commit behind a version: the stamped `commit` field, or — for
 * versions written before the field existed — the sha parsed back out of the
 * `Sync <sha12>` message the sync path has always written.
 */
export function versionCommit(version: Pick<NotebookVersion, 'message' | 'commit'>): string | null {
	if (version.commit) return version.commit;
	return /^Sync ([0-9a-f]{7,40})$/.exec(version.message)?.[1] ?? null;
}

/**
 * Client-side pre-check of a repo form input, mirroring the shapes the server
 * accepts (core `normalizeRepo`): `owner/repo`, a repository URL, a
 * scheme-less `host.tld/group/repo`, or an SSH remote.
 */
export function isRepoInput(input: string): boolean {
	return parseRepoInput(input) !== null;
}

export const REPO_INPUT_HINT =
	'Use owner/repo or a repository URL, e.g. acme/analytics or https://gitlab.example.com/group/project';

export function isGitHubRepoInput(input: string): boolean {
	let path = input.trim();
	if (/^https:\/\//i.test(path)) {
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			return false;
		}
		if (
			url.hostname.toLowerCase() !== 'github.com' ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return false;
		}
		path = url.pathname.replaceAll(/^\/+|\/+$/g, '');
	}
	const parts = path.replace(/\.git$/, '').split('/');
	return (
		parts.length === 2 &&
		GITHUB_OWNER_PATTERN.test(parts[0] ?? '') &&
		GITHUB_REPO_PATTERN.test(parts[1] ?? '')
	);
}

export const GITHUB_REPO_INPUT_HINT =
	'Pull mode supports github.com repositories, e.g. acme/analytics or https://github.com/acme/analytics';

// Mirrors the server's notebook-extension gate (core `isNotebookFilePath`),
// including its non-empty-stem rule: a bare dotfile like `.md` is not a notebook.
export const ENTRY_NOTEBOOK_PATTERN = /[^/]\.(py|md|markdown|qmd)$/;

export const ENTRY_NOTEBOOK_HINT =
	'Must point to a marimo notebook (.py, .md, .markdown, or .qmd), e.g. dashboard.py';

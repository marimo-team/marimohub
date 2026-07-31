// GitHub URL builders for git-synced notebooks. The platform is host-agnostic
// (content arrives by push), but the sole `provider` today is GitHub, so links
// are built for it directly.

import type { NotebookDetail, NotebookVersion } from '@/types';

/** The git-source coordinates the link builders need (a subset of GitSource). */
export interface GitSourceCoords {
	repo: string;
	branch: string;
	root_path: string;
	entry_notebook: string;
	commit: string | null;
}

// Server-validated on new sources; older or API-written records may carry a
// clone URL or `git@` remote, which must degrade to "no link", never a wrong one.
// Mirrors the server's OWNER_REPO_PATTERN (syncedSource.ts).
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

/**
 * The coordinates to build GitHub links from, or null when no trustworthy link
 * exists: a non-git source, a future non-GitHub provider (the stored `provider`
 * is a claim, not verified), or a repo that isn't plain `owner/repo`.
 */
export function githubCoords(source: NotebookDetail['source'] | undefined): GitSourceCoords | null {
	if (source?.type !== 'git' || source.provider !== 'github') return null;
	if (!OWNER_REPO_PATTERN.test(source.repo)) return null;
	return {
		repo: source.repo,
		branch: source.branch,
		root_path: source.root_path,
		entry_notebook: source.entry_notebook,
		commit: source.commit,
	};
}

/**
 * Percent-encode each segment while keeping `/` separators — repos, branches,
 * and file paths may carry URL-reserved characters (`#`, `?`, spaces, …) that
 * would otherwise truncate or reroute the link.
 */
function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

export function githubRepoUrl(repo: string): string {
	return `https://github.com/${encodePath(repo)}`;
}

export function githubCommitUrl(repo: string, commit: string): string {
	return `${githubRepoUrl(repo)}/commit/${encodeURIComponent(commit)}`;
}

export function githubBranchUrl(repo: string, branch: string): string {
	return `${githubRepoUrl(repo)}/tree/${encodePath(branch)}`;
}

/** The repo-relative path of the synced entry notebook. */
export function gitEntryPath(
	source: Pick<GitSourceCoords, 'root_path' | 'entry_notebook'>,
): string {
	return source.root_path ? `${source.root_path}/${source.entry_notebook}` : source.entry_notebook;
}

/**
 * Link to the entry file on GitHub — pinned to the synced commit when known
 * (stable even if the branch moves on), falling back to the branch before the
 * first push.
 */
export function githubSourceUrl(source: GitSourceCoords): string {
	const ref = source.commit ?? source.branch;
	return `${githubRepoUrl(source.repo)}/blob/${encodePath(ref)}/${encodePath(gitEntryPath(source))}`;
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

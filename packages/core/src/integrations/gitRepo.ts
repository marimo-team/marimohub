// Parsing for the `repo` coordinate of a git source. Two stored shapes:
// plain `owner/repo` (GitHub shorthand) or a canonical `http(s)://host/path`
// URL for any other host (GitLab group paths may nest). SSH remotes and
// scheme-less `host.tld/path` inputs normalize to the URL shape.

export type GitProvider = 'github' | 'gitlab';

// Plain `owner/repo` coordinates — not a clone URL or `git@` remote (a bare
// "anything/anything" check would admit both). Owners cannot contain dots,
// which is also what keeps `host.tld/path` inputs out of this branch.
export const OWNER_REPO_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

// `ssh://git@host:port/path` — the port is an SSH port, meaningless in an
// https link, so it is dropped.
const SSH_URL_PATTERN = /^ssh:\/\/git@([^/:\s]+)(?::\d+)?\/(.+)$/i;
// scp-style `git@host:path` (no port syntax exists in this form).
const SCP_REMOTE_PATTERN = /^git@([^/:\s]+):(.+)$/;

function parseRepoUrl(value: string): URL | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	// Never store credentials (e.g. a pasted `https://oauth2:token@…` remote).
	if (!url.hostname || url.username || url.password) return null;
	return url;
}

function pathSegments(url: URL): string[] {
	return url.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/, '')
		.split('/')
		.filter(Boolean);
}

/**
 * Canonicalize a repo input to one of the two stored shapes, or null when it
 * is neither an `owner/repo` pair nor something that resolves to a repository
 * URL with at least an owner and a name in its path.
 */
export function normalizeRepo(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const bare = trimmed.replace(/\.git$/, '');
	if (OWNER_REPO_PATTERN.test(bare)) return bare;

	let candidate = trimmed;
	const ssh = SSH_URL_PATTERN.exec(candidate) ?? SCP_REMOTE_PATTERN.exec(candidate);
	if (ssh) {
		candidate = `https://${ssh[1]}/${ssh[2]}`;
	} else if (!/^https?:\/\//i.test(candidate)) {
		// Scheme-less `host.tld/group/repo` — a dot in the first segment is what
		// distinguishes a hostname from an owner (owners cannot contain dots).
		const [firstSegment] = candidate.split('/', 1);
		if (!firstSegment?.includes('.')) return null;
		candidate = `https://${candidate}`;
	}

	const url = parseRepoUrl(candidate);
	if (!url) return null;
	const segments = pathSegments(url);
	if (segments.length < 2) return null;
	if (segments.some((s) => s === '.' || s === '..')) return null;
	return `${url.protocol}//${url.host}/${segments.join('/')}`;
}

/**
 * The host a repo lives on, when recognizable: `owner/repo` shorthand is
 * GitHub by convention; URL hosts are matched by name, which also catches
 * self-hosted instances like `gitlab.my-company.org`. Null means links
 * cannot be built safely.
 */
export function detectProvider(repo: string): GitProvider | null {
	if (OWNER_REPO_PATTERN.test(repo)) return 'github';
	const url = parseRepoUrl(repo);
	if (!url) return null;
	const host = url.hostname.toLowerCase();
	if (host.includes('github')) return 'github';
	if (host.includes('gitlab')) return 'gitlab';
	return null;
}

/** The `group/subgroup/repo` path of a repo, host stripped. */
export function repoPath(repo: string): string {
	const url = parseRepoUrl(repo);
	if (!url) return repo;
	return pathSegments(url).join('/');
}

/** The `host[:port]` a stored repo lives on: github.com for shorthand. */
export function repoHost(repo: string): string | null {
	if (OWNER_REPO_PATTERN.test(repo)) return 'github.com';
	return parseRepoUrl(repo)?.host ?? null;
}

/**
 * Whether a pusher-supplied repo names the same repository as the stored one.
 * CI environments state the repo as a bare path (`$GITHUB_REPOSITORY`,
 * `$CI_PROJECT_PATH`), so a received path is compared host-free; a received
 * URL must be on the stored host. Case folds only on GitHub, whose paths are
 * case-insensitive.
 */
export function reposMatch(expected: string, received: string): boolean {
	const a = normalizeRepo(expected) ?? expected.trim();
	const b = normalizeRepo(received) ?? received.trim();
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	const receivedHost = parseRepoUrl(b)?.host ?? null;
	if (receivedHost && receivedHost !== repoHost(a)) return false;
	const fold = (path: string) => (detectProvider(a) === 'github' ? path.toLowerCase() : path);
	const pathA = fold(repoPath(a));
	return pathA.length > 0 && pathA === fold(repoPath(b));
}

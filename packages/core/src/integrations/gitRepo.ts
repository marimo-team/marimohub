// Parsing for the `repo` coordinate of a git source. Two stored shapes:
// plain `owner/repo` (GitHub shorthand) or a canonical `http(s)://host/path`
// URL for any other host (GitLab group paths may nest). SSH remotes and
// scheme-less `host.tld/path` inputs normalize to the URL shape.

import { hasControlCharacter } from '../internal/validation';
import { parseHttpUrl } from '../url';

export const GIT_PROVIDERS = ['github', 'gitlab', 'azure-devops'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export function isGitProvider(value: unknown): value is GitProvider {
	return GIT_PROVIDERS.some((provider) => provider === value);
}

export type GitProviderHosts = Readonly<Record<string, GitProvider>>;

/** A repository URL recognized by one provider's parser. */
export interface GitRepositoryRef<P extends GitProvider = GitProvider> {
	provider: P;
	/** Canonical `https://` repository URL without a trailing slash. */
	url: string;
	/** Decoded path segments of {@link url}. */
	parts: string[];
}

export interface GitHubRepositoryRef extends GitRepositoryRef<'github'> {
	origin: string;
	owner: string;
	repo: string;
}

export interface AzureDevOpsRepositoryRef extends GitRepositoryRef<'azure-devops'> {
	/** Lowercased: Azure DevOps organization names are case-insensitive. */
	organization: string;
	project: string;
	name: string;
}

export const GITHUB_ORIGIN = 'https://github.com';
export const AZURE_DEVOPS_ORIGIN = 'https://dev.azure.com';
export const AZURE_DEVOPS_ORGANIZATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
const GIT_SUFFIX = /\.git$/i;

function decodeParts(parts: readonly string[]): string[] | null {
	try {
		return parts.map(decodeURIComponent);
	} catch {
		return null;
	}
}

/**
 * A GitHub repository: `owner/repo` shorthand (github.com), `github.com/owner/repo`,
 * or an `https://` URL. Without `origin` any HTTPS host is accepted (a GHES host
 * may be unknown to the caller); with it, the repository must live there, and
 * shorthand only resolves when `origin` is github.com.
 */
export function gitHubRepository(input: string, origin?: string): GitHubRepositoryRef | null {
	let path = input.trim();
	let repoOrigin = GITHUB_ORIGIN;
	if (/^github\.com\//i.test(path)) path = `https://${path}`;
	if (/^https:\/\//i.test(path)) {
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			return null;
		}
		if (url.username || url.password || url.search || url.hash) return null;
		repoOrigin = url.origin;
		path = url.pathname.replaceAll(/^\/+|\/+$/g, '');
	}
	if (origin !== undefined && repoOrigin !== origin) return null;
	const parts = path.replace(GIT_SUFFIX, '').split('/');
	const [owner, repo] = parts;
	if (
		parts.length !== 2 ||
		!owner ||
		!repo ||
		!GITHUB_OWNER_PATTERN.test(owner) ||
		!GITHUB_REPO_PATTERN.test(repo)
	)
		return null;
	return {
		provider: 'github',
		url: `${repoOrigin}/${owner}/${repo}`,
		parts: [owner, repo],
		origin: repoOrigin,
		owner,
		repo,
	};
}

function azureHostedParts(value: string): string[] | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.hostname !== 'dev.azure.com') return null;
	if (url.port || url.password || url.search || url.hash) return null;
	const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
	// The portal's clone URLs carry the organization as userinfo; nothing else may.
	if (url.username && url.username.toLowerCase() !== parts[0]?.toLowerCase()) return null;
	return parts;
}

/**
 * An Azure DevOps Services repository URL,
 * `https://dev.azure.com/{org}/{project}/_git/{repo}`, optionally in the
 * portal's clone form with `{org}@` userinfo. Repository names may
 * legitimately end in `.git`, so no suffix is stripped.
 */
export function azureDevOpsRepository(input: string): AzureDevOpsRepositoryRef | null {
	const raw = azureHostedParts(input.trim());
	if (raw?.length !== 4 || raw[2] !== '_git') return null;
	const decoded = decodeParts(raw);
	if (!decoded) return null;
	const unsafe = (part: string) =>
		!part || part === '.' || part === '..' || hasControlCharacter(part) || /[/\\]/.test(part);
	if (decoded.some(unsafe)) return null;
	const [org, project, , name] = decoded;
	if (!AZURE_DEVOPS_ORGANIZATION_PATTERN.test(org)) return null;
	const organization = org.toLowerCase();
	return {
		provider: 'azure-devops',
		url: `${AZURE_DEVOPS_ORIGIN}/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
		parts: [organization, project, '_git', name],
		organization,
		project,
		name,
	};
}

/** A GitLab project URL: `https://` origin plus a `group[/subgroup…]/project` path. */
export function gitLabRepository(input: string): GitRepositoryRef<'gitlab'> | null {
	try {
		const value = input.trim();
		if (!/^https:\/\/[^/]/i.test(value) || /[\\\s]/.test(value)) return null;
		const url = new URL(value);
		if (url.username || url.password || url.search || url.hash) return null;
		const path = value.slice(value.indexOf('/', 8)).replace(/\/$/, '').replace(GIT_SUFFIX, '');
		const parts = path.split('/').slice(1).map(decodeURIComponent);
		if (
			parts.length < 2 ||
			parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) || part.endsWith('.'))
		)
			return null;
		return {
			provider: 'gitlab',
			url: `${url.origin}/${parts.map(encodeURIComponent).join('/')}`,
			parts,
		};
	} catch {
		return null;
	}
}

export function gitLabRepositoryUrl(input: string): string | null {
	return gitLabRepository(input)?.url ?? null;
}

// Plain `owner/repo` coordinates — not a clone URL or `git@` remote (a bare
// "anything/anything" check would admit both). Owners cannot contain dots,
// which is also what keeps `host.tld/path` inputs out of this branch. The
// lookahead rejects dot-only repo names (`owner/..` would escape the owner in
// a built URL) while allowing dotted names like `acme/.github`.
export const OWNER_REPO_PATTERN = /^[A-Za-z0-9_-]+\/(?!\.+$)[A-Za-z0-9._-]+$/;

// `ssh://git@host:port/path` — the port is an SSH port, meaningless in an
// https link, so it is dropped.
const SSH_URL_PATTERN = /^ssh:\/\/git@([^/:\s]+)(?::\d+)?\/(.+)$/i;
// scp-style `git@host:path` (no port syntax exists in this form).
const SCP_REMOTE_PATTERN = /^git@([^/:\s]+):(.+)$/;

const WELL_KNOWN_HOSTS: GitProviderHosts = {
	'github.com': 'github',
	'www.github.com': 'github',
	'gitlab.com': 'gitlab',
};

function isHostedAzure(url: URL): boolean {
	return url.protocol === 'https:' && !url.port && url.hostname === 'dev.azure.com';
}

// Self-hosted instances are commonly named after the product (`github.acme.org`,
// `my-gitlab.corp`). Matching whole hostname words, not substrings, keeps
// `notgithub.evil.com` out; a host naming both products is left unrecognized.
function providerFromHostName(hostname: string): GitProvider | null {
	const words = new Set(hostname.split(/[.-]/));
	const github = words.has('github');
	const gitlab = words.has('gitlab');
	if (github === gitlab) return null;
	return github ? 'github' : 'gitlab';
}

function providerForUrl(url: URL, hosts?: GitProviderHosts): GitProvider | null {
	const configured = hosts && Object.hasOwn(hosts, url.host) ? hosts[url.host] : undefined;
	if (configured) return configured;
	if (isHostedAzure(url)) return 'azure-devops';
	if (Object.hasOwn(WELL_KNOWN_HOSTS, url.host)) return WELL_KNOWN_HOSTS[url.host];
	return providerFromHostName(url.hostname);
}

function parseRepoUrl(value: string): URL | null {
	const parsed = parseHttpUrl(value);
	return parsed.ok ? parsed.url : null;
}

function pathSegments(url: URL, hosts?: GitProviderHosts): string[] {
	let path = url.pathname.replace(/\/+$/, '');
	// Azure repository names may end in `.git`; on every other host it is a clone suffix.
	if (providerForUrl(url, hosts) !== 'azure-devops') path = path.replace(GIT_SUFFIX, '');
	return path.split('/').filter(Boolean);
}

/**
 * Canonicalize a repo input to one of the two stored shapes, or null when it
 * is neither an `owner/repo` pair nor something that resolves to a repository
 * URL with at least an owner and a name in its path. Hosted Azure DevOps
 * inputs become their canonical `https://dev.azure.com/...` URL.
 */
export function normalizeRepo(input: string, hosts?: GitProviderHosts): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const bare = trimmed.replace(GIT_SUFFIX, '');
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

	const azure = azureDevOpsRepository(trimmed) ?? azureDevOpsRepository(candidate);
	if (azure) return azure.url;
	const url = parseRepoUrl(candidate);
	if (!url) return null;
	const segments = pathSegments(url, hosts);
	if (segments.length < 2) return null;
	if (segments.some((s) => s === '.' || s === '..')) return null;
	return `${url.protocol}//${url.host}/${segments.join('/')}`;
}

/**
 * The host a repo lives on, when recognizable: `owner/repo` shorthand is
 * GitHub by convention; configured hosts win, then the hosted services, then
 * self-hosted names like `gitlab.my-company.org`. Null means links cannot be
 * built safely.
 */
export function detectProvider(repo: string, hosts?: GitProviderHosts): GitProvider | null {
	if (OWNER_REPO_PATTERN.test(repo)) return 'github';
	const url = parseRepoUrl(repo);
	return url ? providerForUrl(url, hosts) : null;
}

// URLs carry percent-encoded segments (`My%20Project`) while CI-supplied paths carry them raw.
// A segment that is malformed or would decode to a separator stays as written.
function decodeSegment(segment: string): string {
	try {
		const decoded = decodeURIComponent(segment);
		return decoded.includes('/') ? segment : decoded;
	} catch {
		return segment;
	}
}

/** The decoded `group/subgroup/repo` path of a repo, host stripped. */
export function repoPath(repo: string, hosts?: GitProviderHosts): string {
	const url = parseRepoUrl(repo);
	const segments = url ? pathSegments(url, hosts) : repo.split('/');
	return segments.map(decodeSegment).join('/');
}

/** The `host[:port]` a stored repo lives on: github.com for shorthand. */
export function repoHost(repo: string): string | null {
	if (OWNER_REPO_PATTERN.test(repo)) return 'github.com';
	return parseRepoUrl(repo)?.host ?? null;
}

/** The `scheme://host[:port]` of a URL-shaped repo; null for shorthand. */
export function repoOrigin(repo: string): string | null {
	const url = parseRepoUrl(repo);
	return url ? `${url.protocol}//${url.host}` : null;
}

/**
 * Whether a pusher-supplied repo names the same repository as the stored one.
 * CI environments state the repo as a bare path (`$GITHUB_REPOSITORY`,
 * `$CI_PROJECT_PATH`), so a received path is compared host-free; a received
 * URL must be on the stored host. Case folds on every recognized provider
 * (GitHub, GitLab, and Azure DevOps all resolve paths case-insensitively), but
 * not on unknown hosts.
 */
export function reposMatch(expected: string, received: string, hosts?: GitProviderHosts): boolean {
	const a = normalizeRepo(expected, hosts) ?? expected.trim();
	const b = normalizeRepo(received, hosts) ?? received.trim();
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	const receivedHost = parseRepoUrl(b)?.host ?? null;
	if (receivedHost && receivedHost !== repoHost(a)) return false;
	const fold = (path: string) => (detectProvider(a, hosts) ? path.toLowerCase() : path);
	const pathA = fold(repoPath(a, hosts));
	return pathA.length > 0 && pathA === fold(repoPath(b, hosts));
}

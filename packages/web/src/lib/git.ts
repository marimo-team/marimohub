import { z } from 'zod';
import {
	azureDevOpsRepository,
	gitHubRepository,
	gitLabRepositoryUrl,
	detectProvider,
	isGitProvider,
	normalizeRepo,
	OWNER_REPO_PATTERN,
} from '@marimo-hub/core/git-repo';
import type { GitProvider } from '@marimo-hub/core/git-repo';
import type { NotebookDetail, NotebookVersion } from '@/types';

export type { GitProvider } from '@marimo-hub/core/git-repo';

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
	const bare = repo.replace(/\.git$/i, '');
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
	const baseUrl = normalizeRepo(repo);
	if (!baseUrl) return null;
	// A recognizable host takes precedence over unverified metadata on old records.
	const provider =
		detectProvider(repo) ??
		(isGitProvider(claim) && PROVIDER_UI[claim].allowUnrecognizedHost ? claim : null);
	return { baseUrl, provider };
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
	return PROVIDER_UI[provider].label;
}

export function gitCommitUrl(
	coords: Pick<GitSourceCoords, 'provider' | 'baseUrl'>,
	commit: string,
): string {
	return PROVIDER_UI[coords.provider].commitUrl(coords.baseUrl, commit);
}

export function gitBranchUrl(
	coords: Pick<GitSourceCoords, 'provider' | 'baseUrl'>,
	branch: string,
): string {
	return PROVIDER_UI[coords.provider].branchUrl(coords.baseUrl, branch);
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
	return PROVIDER_UI[coords.provider].fileUrl(coords);
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
	return normalizeRepo(input) !== null;
}

export const REPO_INPUT_HINT =
	'Use owner/repo or a repository URL, e.g. acme/analytics or https://gitlab.example.com/group/project';

export function isGitHubRepoInput(input: string): boolean {
	return gitHubRepository(input) !== null;
}

export const GITHUB_REPO_INPUT_HINT =
	'Use owner/repo for github.com or a full HTTPS repository URL for the configured GitHub Enterprise host';

// Mirrors the server's notebook-extension gate (core `isNotebookFilePath`),
// including its non-empty-stem rule: a bare dotfile like `.md` is not a notebook.
export const ENTRY_NOTEBOOK_PATTERN = /[^/]\.(py|md|markdown|qmd)$/;

export const ENTRY_NOTEBOOK_HINT =
	'Must point to a marimo notebook (.py, .md, .markdown, or .qmd), e.g. dashboard.py';

export const ROOT_PATH_HINT =
	'Folder must be a relative path such as apps or python/apps, without a leading slash, . or .. segments, or a .git folder';

/** Trims and drops trailing slashes, as the server does before validating (`apps/` → `apps`). */
export function normalizeRootPathInput(input: string): string {
	return input.trim().replace(/\/+$/, '');
}

function hasAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

/** Mirrors the server's root path rule so a bad folder fails in the form, not at the next sync. */
export function isValidRootPath(input: string): boolean {
	const value = normalizeRootPathInput(input);
	if (value === '') return true;
	if (value.startsWith('/') || value.includes('\\') || hasAsciiControlCharacter(value))
		return false;
	return value
		.split('/')
		.every(
			(part) => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
		);
}

/** An optional repository folder field validated with {@link isValidRootPath}. */
export function rootPathText() {
	return z.string().refine(isValidRootPath, ROOT_PATH_HINT);
}

export function isAzureDevOpsRepoInput(input: string): boolean {
	return azureDevOpsRepository(input) !== null;
}

interface PullInput {
	validate: (input: string) => boolean;
	hint: string;
	placeholder: string;
}
interface ProviderUI {
	label: string;
	allowUnrecognizedHost: boolean;
	changeRequest: { kind: string; abbreviation: string };
	pullInput: PullInput | null;
	commitUrl: (baseUrl: string, commit: string) => string;
	branchUrl: (baseUrl: string, branch: string) => string;
	fileUrl: (coords: GitSourceCoords) => string;
}

function pathLinks(separator: string): Pick<ProviderUI, 'commitUrl' | 'branchUrl' | 'fileUrl'> {
	return {
		commitUrl: (baseUrl, commit) => `${baseUrl}${separator}/commit/${encodeURIComponent(commit)}`,
		branchUrl: (baseUrl, branch) => `${baseUrl}${separator}/tree/${encodePath(branch)}`,
		fileUrl: (coords) =>
			`${coords.baseUrl}${separator}/blob/${encodePath(coords.commit ?? coords.branch)}/${encodePath(gitEntryPath(coords))}`,
	};
}
const pullRequest = { kind: 'pull request', abbreviation: 'PR' };
const PROVIDER_UI: Record<GitProvider, ProviderUI> = {
	github: {
		label: 'GitHub',
		allowUnrecognizedHost: true,
		changeRequest: pullRequest,
		pullInput: {
			validate: isGitHubRepoInput,
			hint: GITHUB_REPO_INPUT_HINT,
			placeholder: 'owner/repo',
		},
		...pathLinks(''),
	},
	gitlab: {
		label: 'GitLab',
		allowUnrecognizedHost: true,
		changeRequest: { kind: 'merge request', abbreviation: 'MR' },
		pullInput: {
			validate: (value) => gitLabRepositoryUrl(value) !== null,
			hint: 'Use a full HTTPS GitLab repository URL, including any nested groups',
			placeholder: 'https://gitlab.com/group/project',
		},
		...pathLinks('/-'),
	},
	'azure-devops': {
		label: 'Azure DevOps',
		allowUnrecognizedHost: false,
		changeRequest: pullRequest,
		pullInput: {
			validate: isAzureDevOpsRepoInput,
			hint: 'Use https://dev.azure.com/organization/project/_git/repository for Azure DevOps',
			placeholder: 'https://dev.azure.com/organization/project/_git/repository',
		},
		commitUrl: (baseUrl, commit) => `${baseUrl}/commit/${encodeURIComponent(commit)}`,
		branchUrl: (baseUrl, branch) => `${baseUrl}?version=${encodeURIComponent(`GB${branch}`)}`,
		fileUrl: (coords) =>
			`${coords.baseUrl}?path=${encodeURIComponent(`/${gitEntryPath(coords)}`)}&version=${encodeURIComponent(`${coords.commit ? 'GC' : 'GB'}${coords.commit ?? coords.branch}`)}`,
	},
};

export function changeRequestTerms(provider: string) {
	const { kind, abbreviation } = isGitProvider(provider)
		? PROVIDER_UI[provider].changeRequest
		: { kind: 'change request', abbreviation: 'change request' };
	return {
		kind,
		open: `Open ${abbreviation}`,
		view: `View ${abbreviation}`,
		update: `Update ${abbreviation}`,
		create: `Create new ${abbreviation}`,
	};
}

export function pullRepositoryInput(providers: readonly string[]) {
	const supported = providers.filter(
		(provider): provider is GitProvider =>
			isGitProvider(provider) && PROVIDER_UI[provider].pullInput !== null,
	);
	const inputs = supported.flatMap((provider) => PROVIDER_UI[provider].pullInput ?? []);
	return {
		available: supported.length > 0,
		label:
			supported.length === 1
				? `Connect to ${providerLabel(supported[0])}`
				: 'Connect to a repository',
		placeholder: inputs.length === 1 ? inputs[0].placeholder : 'Repository HTTPS URL',
		hint: inputs.map((input) => input.hint).join('. '),
		validate: (input: string) => {
			const normalized = normalizeRepo(input);
			const detected = normalized ? detectProvider(normalized) : null;
			return supported.some(
				(provider) =>
					(!detected || detected === provider) && PROVIDER_UI[provider].pullInput?.validate(input),
			);
		},
	};
}

import { z } from 'zod';
import { BadRequestError, ConflictError, ValidationError } from '../errors';
import { toBase64Url } from '../internal/base64url';
import { toHex } from '../internal/hex';
import type { GitSource, GitSourceConfig, Source } from '../schema';
import type { VersionId } from '../ids';
import {
	detectProvider,
	normalizeRepo,
	OWNER_REPO_PATTERN,
	repoHost,
	repoOrigin,
	reposMatch,
} from './gitRepo';
import {
	normalizeEntryNotebook,
	normalizeWorkspaceRootPath,
	toSyncedWorkspaceFileMap,
} from './remoteWorkspace';
import type { SyncedWorkspaceFile, SyncedWorkspaceFileMap } from './remoteWorkspace';

export interface CreateSyncedNotebookInput {
	title: string;
	description: string;
	provider?: string;
	repo: string;
	branch: string;
	root_path?: string;
	entry_notebook: string;
	tags?: string[];
	readme?: string;
	runtime?: { python_version?: string; marimo_version?: string };
	base_image?: string;
	compute_profile?: string;
	sync_mode?: 'push' | 'pull';
}

export interface SyncNotebookInput {
	repo: string;
	branch: string;
	root_path: string;
	commit: string;
	files: SyncedWorkspaceFile[];
	/** Files relative to `.git`, present only for pull-mode sources. */
	git_files?: SyncedWorkspaceFile[];
	/**
	 * Optimistic precondition for server-initiated pulls: the source
	 * `current_version_id` observed when the branch head was resolved (null for
	 * a never-synced source). When present, the sync conflicts if another sync
	 * advanced the source in the meantime, so a pull of a stale head can never
	 * regress the pointer. Version ids are the token — unlike the commit, which
	 * can cycle back (A → B → A) while a pull downloads, a fresh ULID per sync
	 * can never falsely match. Pushes omit it — a CI archive is authoritative
	 * for its commit.
	 */
	expected_source_version?: VersionId | null;
}

export type UpdateSyncedNotebookSourceInput = GitSourceConfig & {
	sync_mode?: 'push' | 'pull';
};

export const SyncTokenRecordSchema = z.object({
	schema_version: z.literal(1),
	token_sha256: z.string(),
	created_at: z.iso.datetime(),
});

export type SyncTokenRecord = z.infer<typeof SyncTokenRecordSchema>;

const SYNC_TOKEN_BYTES = 32;
const SYNC_TOKEN_PREFIX = 'mhsync_';

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return toHex(new Uint8Array(digest));
}

// Constant-time comparison of two equal-length hex digests. Both operands are
// SHA-256 outputs, so length is fixed; the loop still avoids an early-exit leak.
function timingSafeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

export function normalizeGitSourceConfig(input: {
	repo: string;
	branch: string;
	root_path?: string;
	entry_notebook: string;
}): GitSourceConfig {
	if (!input.repo.trim()) {
		throw new BadRequestError('repo is required');
	}
	const repo = normalizeRepo(input.repo);
	if (repo === null) {
		throw new ValidationError(
			'repo must be owner/repo (hosted on github.com) or a repository URL, e.g. acme/analytics or https://gitlab.example.com/group/project',
		);
	}
	const branch = input.branch.trim();
	if (!branch) {
		throw new BadRequestError('branch is required');
	}
	return {
		repo,
		branch,
		root_path: normalizeWorkspaceRootPath(input.root_path),
		entry_notebook: normalizeEntryNotebook(input.entry_notebook),
	};
}

export function gitSourceConfig(source: GitSource): GitSourceConfig {
	return {
		repo: source.repo,
		branch: source.branch,
		root_path: source.root_path,
		entry_notebook: source.entry_notebook,
	};
}

export function effectiveGitSourceConfig(source: GitSource): GitSourceConfig {
	return source.pending_config ?? gitSourceConfig(source);
}

export function gitSourceConfigsEqual(a: GitSourceConfig, b: GitSourceConfig): boolean {
	return (
		a.repo === b.repo &&
		a.branch === b.branch &&
		a.root_path === b.root_path &&
		a.entry_notebook === b.entry_notebook
	);
}

/**
 * Host detection wins; an explicit claim it couldn't make (e.g. GitLab at
 * `code.example.com`) survives moves within the same host and is discarded on
 * a host change.
 */
export function providerForRepo(
	current: Pick<GitSource, 'repo' | 'provider'>,
	nextRepo: string,
): string | null {
	const detected = detectProvider(nextRepo);
	if (detected) return detected;
	const host = repoHost(nextRepo);
	return host !== null && host === repoHost(current.repo) ? current.provider : null;
}

function rehomeShorthand(config: GitSourceConfig, origin: string | null): GitSourceConfig {
	if (!origin || !OWNER_REPO_PATTERN.test(config.repo)) return config;
	return { ...config, repo: `${origin}/${config.repo}` };
}

/**
 * Resolve an updated config against the current source so shorthand keeps the
 * same meaning on create and update: a bare `owner/repo` names a path on the
 * host the source already lives on (github.com shorthand stays bare, matching
 * create — recognized by host so every canonical GitHub origin qualifies).
 */
export function resolveUpdatedConfig(
	current: GitSource,
	desired: GitSourceConfig,
): GitSourceConfig {
	const onGitHub = repoHost(current.repo) === 'github.com';
	const rehomed = rehomeShorthand(desired, onGitHub ? null : repoOrigin(current.repo));
	// A bare edit that names the repository the source already tracks must not
	// stage a phantom change when the stored spelling differs — e.g. a URL-form
	// GitHub source (`https://github.com/owner/repo`) edited with bare
	// `owner/repo`. Return the stored spelling verbatim so equality holds.
	if (rehomed.repo !== current.repo && reposMatch(current.repo, rehomed.repo)) {
		return { ...rehomed, repo: current.repo };
	}
	return rehomed;
}

export function applyGitSourceUpdate(
	current: GitSource,
	input: UpdateSyncedNotebookSourceInput,
): GitSource | null {
	const desired = normalizeGitSourceConfig(input);
	if (input.sync_mode && input.sync_mode !== current.sync_mode) {
		throw new BadRequestError('Changing sync_mode is not supported');
	}
	if (current.sync_mode === 'pull' && desired.root_path !== '') {
		throw new BadRequestError('Pull-mode sources require root_path to be empty');
	}
	const resolved = resolveUpdatedConfig(current, desired);
	const active = gitSourceConfig(current);
	if (current.pending_config && gitSourceConfigsEqual(current.pending_config, resolved))
		return null;
	const { pending_config: _pendingConfig, ...withoutPending } = current;
	if (gitSourceConfigsEqual(active, resolved)) {
		return current.pending_config ? withoutPending : null;
	}
	if (current.current_version_id === null) {
		return {
			...withoutPending,
			...resolved,
			provider: providerForRepo(current, resolved.repo),
		};
	}
	return { ...current, pending_config: resolved };
}

export function createGitSource(input: CreateSyncedNotebookInput): GitSource {
	// Shorthand means github.com — unless the caller says GitLab, then gitlab.com.
	const config = rehomeShorthand(
		normalizeGitSourceConfig(input),
		input.provider === 'gitlab' ? 'https://gitlab.com' : null,
	);
	if (input.sync_mode === 'pull' && config.root_path !== '') {
		throw new BadRequestError('Pull-mode sources require root_path to be empty');
	}
	return {
		schema_version: 1,
		type: 'git',
		// Host detection wins over the caller's claim so the stored provider can
		// never contradict a recognized host; the claim covers unknown hosts.
		provider: detectProvider(config.repo) ?? input.provider ?? null,
		...config,
		sync_mode: input.sync_mode ?? 'push',
		current_version_id: null,
		commit: null,
		last_synced_at: null,
	};
}

export function createSyncToken(): string {
	const bytes = new Uint8Array(SYNC_TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	return `${SYNC_TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

export async function createSyncTokenRecord(
	token: string,
	createdAt: string,
): Promise<SyncTokenRecord> {
	return {
		schema_version: 1,
		token_sha256: await sha256(token),
		created_at: createdAt,
	};
}

export async function verifySyncTokenRecord(
	record: SyncTokenRecord,
	token: string,
): Promise<boolean> {
	return timingSafeEqual(record.token_sha256, await sha256(token));
}

export function assertSyncedSource(source: Source): GitSource {
	if (source.type !== 'git') {
		throw new ConflictError('Notebook is not backed by a synced source');
	}
	return source;
}

/**
 * Whether a sync at `headCommit` would be a no-op: the source already serves
 * that commit and no settings edit is waiting for a matching sync. Git commits
 * are content-addressed, so a same-commit sync carries identical bytes.
 */
export function isAtBranchHead(source: GitSource, headCommit: string): boolean {
	return !source.pending_config && source.commit === headCommit;
}

/** Enforce `expected_source_version` (see {@link SyncNotebookInput}) against the live source. */
export function assertSyncSourcePrecondition(source: GitSource, input: SyncNotebookInput): void {
	if (
		input.expected_source_version !== undefined &&
		source.current_version_id !== input.expected_source_version
	) {
		throw new ConflictError('The synced source advanced while this sync was in flight; retry');
	}
}

export interface SourceDrift {
	/** Commit of the last successful sync; null before the first sync. */
	current_commit: string | null;
	/** Live head of the configured branch. */
	remote_commit: string;
	in_sync: boolean;
	/** Whether a settings edit is waiting for a matching sync. */
	pending_config: boolean;
	/** When the branch head was resolved. */
	checked_at: string;
}

/** Drift between a synced source and a freshly resolved branch head. */
export function sourceDrift(source: GitSource, headCommit: string, checkedAt: string): SourceDrift {
	return {
		current_commit: source.commit,
		remote_commit: headCommit,
		in_sync: isAtBranchHead(source, headCommit),
		pending_config: source.pending_config !== undefined,
		checked_at: checkedAt,
	};
}

export function prepareSync(
	source: GitSource,
	input: SyncNotebookInput,
): { commit: string; config: GitSourceConfig; files: SyncedWorkspaceFileMap } {
	const config = effectiveGitSourceConfig(source);
	const rootPath = normalizeWorkspaceRootPath(input.root_path);
	// Repo matches by repository, not byte-for-byte: CI pushers send bare paths
	// (`$GITHUB_REPOSITORY`, `$CI_PROJECT_PATH`) while the store may hold a URL.
	const checks: [header: string, received: string, expected: string, ok: boolean][] = [
		['X-Marimohub-Repo', input.repo, config.repo, reposMatch(config.repo, input.repo)],
		['X-Marimohub-Branch', input.branch, config.branch, input.branch === config.branch],
		['X-Marimohub-Root-Path', rootPath, config.root_path, rootPath === config.root_path],
	];
	const mismatches = checks
		.filter(([, , , ok]) => !ok)
		.map(
			([header, received, expected]) =>
				`${header} received ${JSON.stringify(received)}, expected ${JSON.stringify(expected)}`,
		);
	if (mismatches.length > 0) {
		throw new ValidationError(
			`Sync source mismatch: ${mismatches.join('; ')}. Update the request headers or the notebook's sync settings.`,
		);
	}
	const commit = input.commit.trim();
	if (commit.length === 0) {
		throw new BadRequestError('commit is required');
	}

	const files = toSyncedWorkspaceFileMap(input.files);
	if (!files.has(config.entry_notebook)) {
		throw new ValidationError(`entry_notebook not found in sync archive: ${config.entry_notebook}`);
	}
	return { commit, config, files };
}

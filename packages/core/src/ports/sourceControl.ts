import { MAX_WORKSPACE_FILE_BYTES } from '../constants';
import { BadRequestError } from '../errors';

export interface SourceControlContentChange {
	/** Repository-relative path; absolute paths and `..` segments are invalid. */
	path: string;
	operation: 'add' | 'modify';
	content: Uint8Array;
}

export interface SourceControlDeleteChange {
	/** Repository-relative path; absolute paths and `..` segments are invalid. */
	path: string;
	operation: 'delete';
}

export type SourceControlChange = SourceControlContentChange | SourceControlDeleteChange;

export interface SourceControlCommitIdentity {
	name: string;
	email: string;
}

export interface OpenChangeRequestInput {
	/** Provider-specific repository coordinate from the synced source revision. */
	repository: string;
	/** Branch configured on the synced source. */
	baseBranch: string;
	/** Immutable commit from which the notebook session was created. */
	baseCommit: string;
	/** Preselected retry-stable branch for the proposed commit. */
	headBranch: string;
	title: string;
	body: string;
	draft: boolean;
	/** Person whose workspace edits produced the commit. The provider keeps its integration as committer. */
	coAuthor?: SourceControlCommitIdentity;
	changes: readonly SourceControlChange[];
}

export interface OpenChangeRequestResult {
	number: number;
	/** HTTPS browser URL for the provider's pull request, merge request, or equivalent. */
	url: string;
	headBranch: string;
	headCommit: string;
}

export interface UpdateChangeRequestInput {
	/** Provider-specific repository coordinate from the synced source revision. */
	repository: string;
	/** Branch and commit against which the change request was originally opened. */
	baseBranch: string;
	baseCommit: string;
	/** Previously published change request whose provider branch should be updated. */
	changeRequest: OpenChangeRequestResult;
	title: string;
	body: string;
	/** Person whose workspace edits produced the commit. The provider keeps its integration as committer. */
	coAuthor?: SourceControlCommitIdentity;
	changes: readonly SourceControlChange[];
}

export const SOURCE_CONTROL_PUBLISH_STAGES = [
	'auth',
	'installation',
	'branch',
	'push',
	'pr',
] as const;

export type SourceControlPublishStage = (typeof SOURCE_CONTROL_PUBLISH_STAGES)[number];

export const SOURCE_CONTROL_PUBLISH_CONDITIONS = ['branch_deleted', 'branch_changed'] as const;

export type SourceControlPublishCondition = (typeof SOURCE_CONTROL_PUBLISH_CONDITIONS)[number];

export interface SourceControlPublishFailure {
	provider: string;
	stage: SourceControlPublishStage;
	condition?: SourceControlPublishCondition;
	/** HTTP status returned by the source-control provider. */
	status?: string | number;
}

const sourceControlPublishFailures = new WeakMap<Error, SourceControlPublishFailure>();

export function markSourceControlPublishFailure(
	error: unknown,
	failure: SourceControlPublishFailure,
): Error {
	const annotated =
		error instanceof Error ? error : new Error('Source control failed', { cause: error });
	const current = sourceControlPublishFailures.get(annotated);
	const merged = { ...failure, ...current };
	if (current?.condition === undefined && failure.condition !== undefined) {
		merged.condition = failure.condition;
	}
	if (current?.status === undefined && failure.status !== undefined) {
		merged.status = failure.status;
	}
	if (merged.condition === undefined) delete merged.condition;
	if (merged.status === undefined) delete merged.status;
	sourceControlPublishFailures.set(annotated, merged);
	return annotated;
}

export function sourceControlPublishFailure(
	error: unknown,
): SourceControlPublishFailure | undefined {
	return error instanceof Error ? sourceControlPublishFailures.get(error) : undefined;
}

export interface SourceControlPublisher {
	/** Stable id stored on source revisions, such as `github` or `gitlab`. */
	readonly provider: string;
	openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult>;
	/** Update an existing open change request, when supported by the provider. */
	updateChangeRequest?(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult>;
}

export interface SourceBranchHead {
	/** Full commit SHA at the branch tip. */
	commit: string;
}

export interface SourceWorkspaceFile {
	/** Path relative to the requested root path. */
	path: string;
	bytes: Uint8Array;
}

/** Maximum number of materialized files accepted in a pull source's `.git` directory. */
export const MAX_GIT_DIRECTORY_FILES = 1000;

/** Maximum cumulative size of a pull source's materialized `.git` directory. */
export const MAX_GIT_DIRECTORY_BYTES = 100 * 1024 * 1024;

/** Maximum cumulative size of Git protocol responses for one fetch. */
export const MAX_GIT_FETCH_BYTES = MAX_WORKSPACE_FILE_BYTES;

/** Maximum file count after the fetched Git objects are expanded into a checkout. */
export const MAX_GIT_EXPANDED_FILES = 1000;

/** Maximum byte count after the fetched Git objects are expanded into a checkout. */
export const MAX_GIT_EXPANDED_BYTES = 100 * 1024 * 1024;

export class GitDirectoryLimitTracker {
	private fileCount = 0;
	private totalBytes = 0;

	add(path: string, size: number): void {
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WORKSPACE_FILE_BYTES) {
			throw new BadRequestError(
				`Git directory file exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit: ${path}`,
			);
		}
		if (this.fileCount + 1 > MAX_GIT_DIRECTORY_FILES) {
			throw new BadRequestError(`Git directory exceeds the ${MAX_GIT_DIRECTORY_FILES}-file limit`);
		}
		if (this.totalBytes + size > MAX_GIT_DIRECTORY_BYTES) {
			throw new BadRequestError(`Git directory exceeds the ${MAX_GIT_DIRECTORY_BYTES}-byte limit`);
		}
		this.fileCount += 1;
		this.totalBytes += size;
	}
}

export function assertGitDirectoryLimits(files: readonly SourceWorkspaceFile[]): void {
	const limits = new GitDirectoryLimitTracker();
	for (const file of files) limits.add(file.path, file.bytes.byteLength);
}

/** The read side of a provider: resolve branch heads and fetch workspace trees. */
export interface SourceControlReader {
	/** Same id namespace as `SourceControlPublisher` (`github`, `gitlab`, …). */
	readonly provider: string;
	/**
	 * Whether this reader can serve the repository coordinate. Provider ids are
	 * host-detected, so a provider match is not enough — e.g. the GitHub App
	 * serves github.com only, while a GitHub Enterprise repository carries the
	 * same `github` id. Unsupported repositories stay push-only.
	 */
	supportsRepository(repository: string): boolean;
	/** Resolve the current tip of a branch. */
	getBranchHead(repository: string, branch: string): Promise<SourceBranchHead>;
	/**
	 * Fetch the tree under `rootPath` at `commit` as workspace files.
	 * Implementations MUST enforce the same caps as archive ingest (file count,
	 * per-file bytes, total bytes) and skip symlinks/specials, so pull-created
	 * versions are never laxer than push-created ones.
	 */
	fetchWorkspace(
		repository: string,
		commit: string,
		rootPath: string,
	): Promise<SourceWorkspaceFile[]>;
	/**
	 * Materialize a credential-free Git directory for the exact commit. Paths
	 * are relative to `.git`; the returned object database must resolve commit.
	 * Implementations MUST enforce `MAX_GIT_DIRECTORY_FILES`,
	 * `MAX_WORKSPACE_FILE_BYTES` per entry, and `MAX_GIT_DIRECTORY_BYTES` on the
	 * materialized output before buffering file bodies. Implementations MUST also
	 * enforce `MAX_GIT_FETCH_BYTES` across all protocol responses and
	 * `MAX_GIT_EXPANDED_FILES`/`MAX_GIT_EXPANDED_BYTES` after pack expansion.
	 */
	fetchGitDirectory?(
		repository: string,
		commit: string,
		branch: string,
	): Promise<SourceWorkspaceFile[]>;
}

/** Server-side source-control capabilities configured for this deployment. */
export interface SourceControlRegistry {
	getPublisher(provider: string): SourceControlPublisher | undefined;
	getReader(provider: string): SourceControlReader | undefined;
	/** Provider ids that can publish change requests. */
	publisherProviders(): readonly string[];
	/** Provider ids that can serve server-initiated pull sync. */
	readerProviders(): readonly string[];
	/** Provider ids that can create pull-mode sources with a real Git working tree. */
	pullSourceProviders(): readonly string[];
}

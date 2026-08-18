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

export interface SourceControlPublisher {
	/** Stable id stored on source revisions, such as `github` or `gitlab`. */
	readonly provider: string;
	openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult>;
	/** Update an existing open change request, when supported by the provider. */
	updateChangeRequest?(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult>;
}

/** Server-side publishers configured for this deployment. */
export interface SourceControlPublisherRegistry {
	getPublisher(provider: string): SourceControlPublisher | undefined;
	configuredProviders(): readonly string[];
}

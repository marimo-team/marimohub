import { createPublishStage } from '@marimo-hub/source-control-git/publication';
import {
	ConflictError,
	NotFoundError,
	ProposalRetryRequiredError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { markSourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type {
	SourceControlReader,
	SourceControlPublisher,
	SourceReadOptions,
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';
import { materializeGitDirectory } from '@marimo-hub/source-control-git';
import { pushGitTree } from '@marimo-hub/source-control-git/publish';
import { applyChanges, sameTree } from '@marimo-hub/source-control-git/file-tree';
import type { FileTree } from '@marimo-hub/source-control-git/file-tree';
import {
	coAuthorTrailer,
	normalizeCommit,
	normalizeProviderCommit,
	validateBranch,
	validatePublication,
} from '@marimo-hub/source-control-git/validation';
import { GitLabClient, record, stringField } from './client';
import type { GitLabOptions, GitLabRuntime } from './client';
import { parseGitLabRepository } from './repository';
import type { GitLabRepository } from './repository';
import { GitLabTrees, list } from './trees';
export { gitLabOrigin, parseGitLabRepository } from './repository';
export type { GitLabOptions, GitLabRuntime } from './client';

// GitLab resolves namespace paths case-insensitively and returns `web_url` in canonical case,
// which can differ from the case the repository URL was configured with.
function sameMergeRequestUrl(actual: string, expected: string): boolean {
	let url: URL;
	try {
		url = new URL(actual);
	} catch {
		return false;
	}
	const want = new URL(expected);
	return (
		url.origin === want.origin &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		url.pathname.toLowerCase() === want.pathname.toLowerCase()
	);
}

export class GitLabSourceControl implements SourceControlReader, SourceControlPublisher {
	readonly provider = 'gitlab';
	private readonly client: GitLabClient;
	constructor(options: GitLabOptions, runtime: GitLabRuntime = {}) {
		this.client = new GitLabClient(options, runtime);
	}
	private repository(value: string) {
		return parseGitLabRepository(value, this.client.origin);
	}
	supportsRepository(value: string) {
		try {
			this.repository(value);
			return true;
		} catch {
			return false;
		}
	}
	private readonly stage = createPublishStage(this.provider);
	private async head(
		repo: GitLabRepository,
		branch: string,
		options: SourceReadOptions = {},
	): Promise<string | null> {
		validateBranch(branch);
		try {
			const branchData = (
				await this.client.json(
					repo,
					`/repository/branches/${encodeURIComponent(branch)}`,
					{},
					options,
				)
			).value;
			if (stringField(branchData, 'name') !== branch)
				throw new UnavailableError('GitLab returned a different branch');
			return normalizeProviderCommit(stringField(record(branchData).commit, 'id'));
		} catch (error) {
			if (error instanceof NotFoundError) return null;
			throw error;
		}
	}
	async getBranchHead(repository: string, branch: string, options: SourceReadOptions = {}) {
		const commit = await this.head(this.repository(repository), branch, options);
		if (!commit) throw new NotFoundError('GitLab branch was not found');
		return { commit };
	}
	async fetchWorkspace(
		repository: string,
		commit: string,
		rootPath: string,
		options: SourceReadOptions = {},
	) {
		return new GitLabTrees(this.client, this.repository(repository)).workspace(
			commit,
			rootPath,
			options,
		);
	}
	async fetchGitDirectory(
		repository: string,
		commit: string,
		branch: string,
		options: SourceReadOptions = {},
	) {
		validateBranch(branch);
		const repo = this.repository(repository);
		return materializeGitDirectory({
			repository: repo.url,
			remoteUrl: repo.remoteUrl,
			commit: normalizeCommit(commit),
			branch,
			authorization: this.client.gitAuthorization(),
			fetcher: this.client.fetcher,
			signal: options.signal,
		});
	}
	private branchChanged(deleted = false) {
		return markSourceControlPublishFailure(
			new ConflictError(
				deleted
					? 'GitLab proposal branch was deleted'
					: 'GitLab proposal branch changed outside marimohub',
			),
			{
				provider: this.provider,
				stage: 'branch',
				condition: deleted ? 'branch_deleted' : 'branch_changed',
			},
		);
	}
	private async matches(trees: GitLabTrees, head: string, parent: string, desired: FileTree) {
		return this.stage('push', async () => {
			const commit = await trees.commit(head);
			return (
				Array.isArray(commit.parent_ids) &&
				commit.parent_ids.length === 1 &&
				typeof commit.parent_ids[0] === 'string' &&
				normalizeProviderCommit(commit.parent_ids[0]) === parent &&
				sameTree(await trees.files(head), desired)
			);
		});
	}
	private result(
		repo: GitLabRepository,
		value: unknown,
		branch: string,
		baseBranch: string,
		headCommit: string,
		expectedNumber?: number,
	): OpenChangeRequestResult {
		const mr = record(value);
		if (
			typeof mr.iid !== 'number' ||
			!Number.isSafeInteger(mr.iid) ||
			mr.iid <= 0 ||
			(expectedNumber !== undefined && mr.iid !== expectedNumber) ||
			mr.source_branch !== branch ||
			mr.target_branch !== baseBranch ||
			typeof mr.source_project_id !== 'number' ||
			mr.source_project_id !== mr.target_project_id ||
			!sameMergeRequestUrl(stringField(mr, 'web_url'), `${repo.url}/-/merge_requests/${mr.iid}`)
		)
			throw new UnavailableError('GitLab returned a different merge request');
		return {
			number: mr.iid,
			url: `${repo.url}/-/merge_requests/${mr.iid}`,
			headBranch: branch,
			headCommit,
		};
	}
	private async publish(
		repo: GitLabRepository,
		trees: GitLabTrees,
		input: OpenChangeRequestInput | UpdateChangeRequestInput,
		branch: string,
		parent: string,
		expected: string | null,
		current: FileTree,
		desired: FileTree,
	) {
		return this.stage('push', async () => {
			const contents = await trees.contents(current, desired, input.changes);
			const trailer = coAuthorTrailer(input.coAuthor);
			return pushGitTree({
				repository: repo.url,
				remoteUrl: repo.remoteUrl,
				commit: parent,
				branch: expected === null ? input.baseBranch : branch,
				headBranch: branch,
				expectedHead: expected,
				tree: desired,
				contents,
				message: [input.title, input.body, trailer].filter(Boolean).join('\n\n'),
				authorization: this.client.gitAuthorization(),
				fetcher: this.client.fetcher,
			});
		});
	}
	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { branch, baseCommit } = validatePublication(input);
		const repo = this.repository(input.repository);
		const trees = new GitLabTrees(this.client, repo);
		const { base, desired } = await this.stage('push', async () => {
			const base = await trees.files(baseCommit);
			const desired = applyChanges(base, input.changes);
			if (sameTree(base, desired)) throw new ConflictError('Proposal contains no changes');
			return { base, desired };
		});
		let head = await this.stage('branch', () => this.head(repo, branch));
		if (!head)
			head = await this.publish(repo, trees, input, branch, baseCommit, null, base, desired);
		if (!(await this.matches(trees, head, baseCommit, desired)))
			throw new ProposalRetryRequiredError(
				'GitLab proposal branch no longer matches; retry with a new idempotency key',
			);
		const publishedHead = head;
		return this.stage('pr', async () => {
			if ((await this.stage('branch', () => this.head(repo, branch))) !== publishedHead)
				throw this.branchChanged();
			const candidates = await list(this.client, repo, '/merge_requests', {
				scope: 'all',
				state: 'all',
				source_branch: branch,
				target_branch: input.baseBranch,
			});
			let closed: OpenChangeRequestResult | undefined;
			for (const candidate of candidates) {
				const result = this.result(repo, candidate, branch, input.baseBranch, publishedHead);
				const mr = record(candidate);
				if (mr.state === 'opened') return result;
				if (typeof mr.sha === 'string' && normalizeProviderCommit(mr.sha) === publishedHead)
					closed ??= result;
			}
			if (closed) return closed;
			if (candidates.length > 0)
				throw new ProposalRetryRequiredError(
					'Existing GitLab merge request does not match; retry with a new idempotency key',
				);
			const created = await this.client.json(
				repo,
				'/merge_requests',
				{},
				{
					method: 'POST',
					body: JSON.stringify({
						source_branch: branch,
						target_branch: input.baseBranch,
						title: input.draft ? `Draft: ${input.title}` : input.title,
						description: input.body,
					}),
				},
			);
			return this.result(repo, created.value, branch, input.baseBranch, publishedHead);
		});
	}
	async updateChangeRequest(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { branch, baseCommit } = validatePublication(input);
		const expected = normalizeCommit(input.changeRequest.headCommit);
		const repo = this.repository(input.repository);
		const id = input.changeRequest.number;
		if (
			!Number.isSafeInteger(id) ||
			id <= 0 ||
			input.changeRequest.url !== `${repo.url}/-/merge_requests/${id}`
		)
			throw new ConflictError('Invalid GitLab merge request identity');
		const pull = record(
			(await this.stage('pr', () => this.client.json(repo, `/merge_requests/${id}`))).value,
		);
		this.result(repo, pull, branch, input.baseBranch, expected, id);
		if (pull.state !== 'opened') throw new ConflictError('GitLab merge request is closed');
		const trees = new GitLabTrees(this.client, repo);
		const desired = await this.stage('push', async () =>
			applyChanges(await trees.files(baseCommit), input.changes),
		);
		let head = await this.stage('branch', () => this.head(repo, branch));
		if (!head) throw this.branchChanged(true);
		if (head !== expected) {
			if (!(await this.matches(trees, head, expected, desired))) throw this.branchChanged();
		} else {
			const current = await this.stage('push', () => trees.files(expected));
			if (!sameTree(current, desired))
				head = await this.publish(repo, trees, input, branch, expected, expected, current, desired);
		}
		const publishedHead = head;
		if (!sameTree(await this.stage('push', () => trees.files(publishedHead)), desired))
			throw this.branchChanged();
		if ((await this.stage('branch', () => this.head(repo, branch))) !== publishedHead)
			throw this.branchChanged();
		const updated = await this.stage('pr', () =>
			this.client.json(
				repo,
				`/merge_requests/${id}`,
				{},
				{
					method: 'PUT',
					body: JSON.stringify({
						title: pull.draft === true ? `Draft: ${input.title}` : input.title,
						description: input.body,
					}),
				},
			),
		);
		return this.result(repo, updated.value, branch, input.baseBranch, publishedHead, id);
	}
}

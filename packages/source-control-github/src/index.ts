import { ConflictError, UnavailableError, ValidationError } from '@marimo-hub/core';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	SourceBranchHead,
	SourceControlPublisher,
	SourceControlReader,
	SourceWorkspaceFile,
	UpdateChangeRequestInput,
} from '@marimo-hub/core';
import { GitHubClient } from './githubClient';
import type { GitHubAppPublisherOptions, GitHubAppPublisherRuntime } from './githubClient';
import { GitHubPullRequests } from './githubPullRequests';
import type { PullRequestCandidate } from './githubPullRequests';
import { GitHubRepositoryWriter } from './githubRepository';
import { nestedString, responseJson } from './githubResponses';
import {
	parseRepository,
	refPath,
	validateBranch,
	validateOpenInput,
	validateUpdateInput,
} from './githubValidation';
import { collectTarballWorkspace, validateCommit, validateRootPath } from './githubWorkspace';

export type { GitHubAppPublisherOptions, GitHubAppPublisherRuntime } from './githubClient';

interface GitHubPublicationContext {
	repository: GitHubRepositoryWriter;
	pullRequests: GitHubPullRequests;
}

export class GitHubAppPublisher implements SourceControlPublisher, SourceControlReader {
	readonly provider = 'github' as const;
	private readonly client: GitHubClient;

	constructor(options: GitHubAppPublisherOptions, runtime: GitHubAppPublisherRuntime = {}) {
		this.client = new GitHubClient(options, runtime);
	}

	private async publicationContext(owner: string, repo: string): Promise<GitHubPublicationContext> {
		const token = await this.client.installationToken(owner, repo);
		const repository = new GitHubRepositoryWriter(this.client, owner, repo, token);
		return {
			repository,
			pullRequests: new GitHubPullRequests(this.client, repository, owner, repo, token),
		};
	}

	/** Repo API prefix + short-lived installation token, shared by the reader methods. */
	private async readContext(repository: string): Promise<{ base: string; token: string }> {
		const { owner, repo } = parseRepository(repository);
		return {
			base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
			token: await this.client.installationToken(owner, repo),
		};
	}

	supportsRepository(repository: string): boolean {
		try {
			parseRepository(repository);
			return true;
		} catch {
			return false;
		}
	}

	async getBranchHead(repository: string, branch: string): Promise<SourceBranchHead> {
		validateBranch(branch);
		const { base, token } = await this.readContext(repository);
		const response = await this.client.request(
			`${base}/branches/${refPath(branch)}`,
			token,
			{},
			[404],
		);
		if (response.status === 404) {
			throw new ValidationError(`GitHub branch not found: ${branch}`);
		}
		return { commit: nestedString(await responseJson(response), 'commit', 'sha') };
	}

	async fetchWorkspace(
		repository: string,
		commit: string,
		rootPath: string,
	): Promise<SourceWorkspaceFile[]> {
		validateCommit(commit);
		validateRootPath(rootPath);
		const { base, token } = await this.readContext(repository);
		const response = await this.client.request(
			`${base}/tarball/${encodeURIComponent(commit)}`,
			token,
		);
		return collectTarballWorkspace(response, rootPath);
	}

	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { owner, repo } = validateOpenInput(input);
		const { repository, pullRequests } = await this.publicationContext(owner, repo);
		const existingRef = await repository.getRef(input.headBranch);
		const candidates = await pullRequests.listForBranch(input.headBranch, input.baseBranch);
		const treeSha = await repository.createProposalTree(input, input.baseCommit);
		const existing = await pullRequests.matchingProposal(candidates, input.baseCommit, treeSha);
		if (existing) return existing;

		if (existingRef) {
			await repository.assertProposalCommit(existingRef, input.baseCommit, treeSha);
			return pullRequests.create(input, existingRef);
		}

		const proposedCommit = await repository.createProposalCommit(
			input.baseCommit,
			treeSha,
			input.title,
			input.body,
			input.coAuthor,
		);
		const createdRef = await repository.createRef(input.headBranch, proposedCommit);
		if (createdRef.existed) {
			await repository.assertProposalCommit(createdRef.headCommit, input.baseCommit, treeSha);
		}
		return pullRequests.create(input, createdRef.headCommit);
	}

	async updateChangeRequest(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { owner, repo } = validateUpdateInput(input);
		const { repository, pullRequests } = await this.publicationContext(owner, repo);
		const candidates = await pullRequests.listForBranch(
			input.changeRequest.headBranch,
			input.baseBranch,
		);
		this.assertTargetPullRequest(candidates, input);
		const expectedHead = input.changeRequest.headCommit;
		let currentHead = await repository.getRef(input.changeRequest.headBranch);
		if (!currentHead) {
			throw new ConflictError(
				'The GitHub pull request branch was deleted; create a new pull request',
			);
		}

		let appendTree: string | undefined;
		try {
			appendTree = await repository.createProposalTree(input, expectedHead);
		} catch (error) {
			if (!(error instanceof ConflictError)) throw error;
		}
		if (currentHead !== expectedHead) {
			const recovered = await this.recoverCompletedUpdate(
				input,
				repository,
				currentHead,
				appendTree,
			);
			return pullRequests.updateMetadata(input, recovered.headCommit);
		}

		if (appendTree) {
			const appendCommit = await repository.createProposalCommit(
				expectedHead,
				appendTree,
				input.title,
				input.body,
				input.coAuthor,
			);
			if (await repository.updateRef(input.changeRequest.headBranch, appendCommit, false)) {
				return pullRequests.updateMetadata(input, appendCommit);
			}
			currentHead = await repository.getRef(input.changeRequest.headBranch);
			if (currentHead === appendCommit) {
				return pullRequests.updateMetadata(input, appendCommit);
			}
			if (currentHead !== expectedHead) {
				throw new ConflictError('The GitHub pull request branch changed while updating');
			}
		}

		const replaced = await this.replacePullRequestHead(input, repository, expectedHead);
		return pullRequests.updateMetadata(input, replaced.headCommit);
	}

	private assertTargetPullRequest(
		candidates: PullRequestCandidate[],
		input: UpdateChangeRequestInput,
	): void {
		const pull = candidates.find((candidate) => candidate.number === input.changeRequest.number);
		if (!pull || pull.url !== input.changeRequest.url) {
			throw new ConflictError('The GitHub pull request no longer matches the published proposal');
		}
		if (pull.state !== 'open') {
			throw new ConflictError('The GitHub pull request is closed; create a new pull request');
		}
	}

	private async recoverCompletedUpdate(
		input: UpdateChangeRequestInput,
		repository: GitHubRepositoryWriter,
		currentHead: string,
		appendTree?: string,
	): Promise<OpenChangeRequestResult> {
		const expectedHead = input.changeRequest.headCommit;
		if (
			appendTree &&
			(await repository.proposalCommitMatches(currentHead, expectedHead, appendTree))
		) {
			return { ...input.changeRequest, headCommit: currentHead };
		}
		const replacementTree = await repository.createProposalTree(input, input.baseCommit);
		if (await repository.proposalCommitMatches(currentHead, input.baseCommit, replacementTree)) {
			return { ...input.changeRequest, headCommit: currentHead };
		}
		throw new ConflictError('The GitHub pull request branch changed outside marimohub');
	}

	private async replacePullRequestHead(
		input: UpdateChangeRequestInput,
		repository: GitHubRepositoryWriter,
		expectedHead: string,
	): Promise<OpenChangeRequestResult> {
		const replacementTree = await repository.createProposalTree(input, input.baseCommit);
		const replacementCommit = await repository.createProposalCommit(
			input.baseCommit,
			replacementTree,
			input.title,
			input.body,
			input.coAuthor,
		);
		await repository.forceUpdateRef(
			input.changeRequest.headBranch,
			expectedHead,
			replacementCommit,
		);
		if ((await repository.getRef(input.changeRequest.headBranch)) !== replacementCommit) {
			throw new UnavailableError('GitHub did not update the pull request branch');
		}
		return { ...input.changeRequest, headCommit: replacementCommit };
	}
}

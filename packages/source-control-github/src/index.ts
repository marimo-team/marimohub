import { ConflictError, UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import { markSourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type {
	SourceReadOptions,
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	SourceBranchHead,
	SourcePullRequest,
	SourceControlPublisher,
	SourceControlPublishStage,
	SourceControlReader,
	SourceWorkspaceFile,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';
import { GitHubClient } from './githubClient';
import type { GitHubAppPublisherOptions, GitHubAppPublisherRuntime } from './githubClient';
import { GitHubPullRequests } from './githubPullRequests';
import type { PullRequestCandidate } from './githubPullRequests';
import { GitHubRepositoryWriter } from './githubRepository';
import { nestedString, responseJson, stringField, isRecord } from './githubResponses';
import {
	parseRepository,
	refPath,
	validateBranch,
	validateOpenInput,
	validateUpdateInput,
} from './githubValidation';
import { collectTarballWorkspace, validateCommit, validateRootPath } from './githubWorkspace';
import { materializeGitDirectory } from './githubGitDirectory';

export type { GitHubAppPublisherOptions, GitHubAppPublisherRuntime } from './githubClient';
export { parseRepository as parseGitHubRepository } from './githubValidation';

interface GitHubPublicationContext {
	repository: GitHubRepositoryWriter;
	pullRequests: GitHubPullRequests;
}

export class GitHubAppPublisher implements SourceControlPublisher, SourceControlReader {
	readonly provider = 'github' as const;
	readonly previews = true;
	private readonly client: GitHubClient;
	private readonly fetcher: NonNullable<GitHubAppPublisherRuntime['fetcher']>;

	constructor(options: GitHubAppPublisherOptions, runtime: GitHubAppPublisherRuntime = {}) {
		this.client = new GitHubClient(options, runtime);
		this.fetcher = runtime.fetcher ?? fetch;
	}

	private async atStage<T>(stage: SourceControlPublishStage, action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			const status =
				typeof (error as { providerStatus?: unknown })?.providerStatus === 'number'
					? (error as { providerStatus: number }).providerStatus
					: undefined;
			throw markSourceControlPublishFailure(error, { provider: 'github', stage, status });
		}
	}

	private async publicationContext(owner: string, repo: string): Promise<GitHubPublicationContext> {
		const token = await this.client.installationToken(owner, repo, 'write');
		const repository = new GitHubRepositoryWriter(this.client, owner, repo, token);
		return {
			repository,
			pullRequests: new GitHubPullRequests(this.client, repository, owner, repo, token),
		};
	}

	/** Repo API prefix + short-lived installation token, shared by the reader methods. */
	private async readContext(
		repository: string,
		options?: SourceReadOptions,
	): Promise<{ base: string; token: string }> {
		const { owner, repo } = parseRepository(repository);
		return {
			base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
			token: await this.client.installationToken(owner, repo, 'read', options?.signal),
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

	async getBranchHead(
		repository: string,
		branch: string,
		options?: SourceReadOptions,
	): Promise<SourceBranchHead> {
		validateBranch(branch);
		const { base, token } = await this.readContext(repository, options);
		const response = await this.client.request(
			`${base}/branches/${refPath(branch)}`,
			token,
			{ signal: options?.signal },
			[404],
		);
		if (response.status === 404) {
			throw new ValidationError(`GitHub branch not found: ${branch}`);
		}
		return { commit: nestedString(await responseJson(response, options?.signal), 'commit', 'sha') };
	}

	async resolveCommit(
		repository: string,
		commit: string,
		options?: SourceReadOptions,
	): Promise<SourceBranchHead> {
		const head = await this.findCommit(repository, commit, options);
		if (!head) throw new ValidationError('Commit not found in the configured repository');
		return head;
	}

	private async findCommit(
		repository: string,
		commit: string,
		options?: SourceReadOptions,
	): Promise<SourceBranchHead | undefined> {
		validateCommit(commit);
		const { base, token } = await this.readContext(repository, options);
		const response = await this.client.request(
			`${base}/commits/${encodeURIComponent(commit)}`,
			token,
			{ signal: options?.signal },
			[404, 422],
		);
		if (!response.ok) return undefined;
		return { commit: stringField(await responseJson(response, options?.signal), 'sha') };
	}

	async listBranches(repository: string, query: string, options?: SourceReadOptions) {
		const { base, token } = await this.readContext(repository, options);
		const data = await responseJson(
			await this.client.request(`${base}/branches?per_page=100`, token, {
				signal: options?.signal,
			}),
			options?.signal,
		);
		if (!Array.isArray(data)) throw new UnavailableError('Invalid GitHub branch response');
		return data
			.map((item) => ({
				value: stringField(item, 'name'),
				label: stringField(item, 'name'),
				commit: nestedString(item, 'commit', 'sha'),
			}))
			.filter((item) => item.value.toLowerCase().includes(query.toLowerCase()))
			.slice(0, 30);
	}

	async listCommits(repository: string, query: string, options?: SourceReadOptions) {
		if (/^[a-f0-9]{40}$/i.test(query)) {
			const head = await this.findCommit(repository, query, options);
			return head
				? [{ value: head.commit, commit: head.commit, label: head.commit.slice(0, 12) }]
				: [];
		}
		const { base, token } = await this.readContext(repository, options);
		const data = await responseJson(
			await this.client.request(`${base}/commits?per_page=100`, token, { signal: options?.signal }),
			options?.signal,
		);
		if (!Array.isArray(data)) throw new UnavailableError('Invalid GitHub commit response');
		return data
			.map((item) => {
				const commit = stringField(item, 'sha');
				return {
					value: commit,
					commit,
					label: `${commit.slice(0, 12)} ${nestedString(item, 'commit', 'message').split('\n')[0]}`,
				};
			})
			.filter(
				(item) =>
					item.label.toLowerCase().includes(query.toLowerCase()) ||
					item.commit.toLowerCase().startsWith(query.toLowerCase()),
			)
			.slice(0, 30);
	}

	async getPullRequest(
		repository: string,
		number: number,
		options?: SourceReadOptions,
	): Promise<SourcePullRequest> {
		const { owner, repo } = parseRepository(repository);
		const token = await this.client.installationToken(owner, repo, 'preview', options?.signal);
		const data = await responseJson(
			await this.client.request(
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
				token,
				{ signal: options?.signal },
			),
			options?.signal,
		);
		if (!isRecord(data) || !isRecord(data.head))
			throw new UnavailableError('Invalid GitHub pull request response');
		const state = stringField(data, 'state');
		if (state !== 'open' && state !== 'closed')
			throw new UnavailableError('Invalid GitHub pull request state');
		const head = data.head;
		return {
			number,
			state,
			branch: stringField(head, 'ref'),
			commit: stringField(head, 'sha'),
			sameRepository:
				isRecord(head.repo) &&
				stringField(head.repo, 'full_name').toLowerCase() === `${owner}/${repo}`.toLowerCase(),
		};
	}

	async fetchWorkspace(
		repository: string,
		commit: string,
		rootPath: string,
		options?: SourceReadOptions,
	): Promise<SourceWorkspaceFile[]> {
		validateCommit(commit);
		validateRootPath(rootPath);
		const { base, token } = await this.readContext(repository, options);
		const response = await this.client.request(
			`${base}/tarball/${encodeURIComponent(commit)}`,
			token,
			{ signal: options?.signal },
		);
		try {
			const workspace = await collectTarballWorkspace(response, rootPath);
			options?.signal?.throwIfAborted();
			return workspace;
		} catch (error) {
			options?.signal?.throwIfAborted();
			throw error;
		}
	}

	async fetchGitDirectory(
		repository: string,
		commit: string,
		branch: string,
	): Promise<SourceWorkspaceFile[]> {
		validateCommit(commit);
		validateBranch(branch);
		const { owner, repo } = parseRepository(repository);
		return materializeGitDirectory({
			repository,
			owner,
			repo,
			commit,
			branch,
			token: await this.client.installationToken(owner, repo, 'read'),
			fetcher: this.fetcher,
		});
	}

	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { owner, repo } = validateOpenInput(input);
		const { repository, pullRequests } = await this.atStage('installation', () =>
			this.publicationContext(owner, repo),
		);
		const existingRef = await this.atStage('branch', () => repository.getRef(input.headBranch));
		const candidates = await this.atStage('pr', () =>
			pullRequests.listForBranch(input.headBranch, input.baseBranch),
		);
		const treeSha = await this.atStage('push', () =>
			repository.createProposalTree(input, input.baseCommit),
		);
		const existing = await this.atStage('pr', () =>
			pullRequests.matchingProposal(candidates, input.baseCommit, treeSha),
		);
		if (existing) return existing;

		if (existingRef) {
			await this.atStage('branch', () =>
				repository.assertProposalCommit(existingRef, input.baseCommit, treeSha),
			);
			return this.atStage('pr', () => pullRequests.create(input, existingRef));
		}

		const proposedCommit = await this.atStage('push', () =>
			repository.createProposalCommit(
				input.baseCommit,
				treeSha,
				input.title,
				input.body,
				input.coAuthor,
			),
		);
		const createdRef = await this.atStage('branch', () =>
			repository.createRef(input.headBranch, proposedCommit),
		);
		if (createdRef.existed) {
			await this.atStage('branch', () =>
				repository.assertProposalCommit(createdRef.headCommit, input.baseCommit, treeSha),
			);
		}
		return this.atStage('pr', () => pullRequests.create(input, createdRef.headCommit));
	}

	async updateChangeRequest(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { owner, repo } = validateUpdateInput(input);
		const { repository, pullRequests } = await this.atStage('installation', () =>
			this.publicationContext(owner, repo),
		);
		const candidates = await this.atStage('pr', () =>
			pullRequests.listForBranch(input.changeRequest.headBranch, input.baseBranch),
		);
		try {
			this.assertTargetPullRequest(candidates, input);
		} catch (error) {
			throw markSourceControlPublishFailure(error, { provider: 'github', stage: 'pr' });
		}
		const expectedHead = input.changeRequest.headCommit;
		let currentHead = await this.atStage('branch', () =>
			repository.getRef(input.changeRequest.headBranch),
		);
		if (!currentHead) {
			throw markSourceControlPublishFailure(
				new ConflictError('The GitHub pull request branch was deleted; create a new pull request'),
				{ provider: 'github', stage: 'branch', condition: 'branch_deleted' },
			);
		}

		let appendTree: string | undefined;
		try {
			appendTree = await this.atStage('push', () =>
				repository.createProposalTree(input, expectedHead),
			);
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
			return this.atStage('pr', () => pullRequests.updateMetadata(input, recovered.headCommit));
		}

		if (appendTree) {
			const appendCommit = await this.atStage('push', () =>
				repository.createProposalCommit(
					expectedHead,
					appendTree,
					input.title,
					input.body,
					input.coAuthor,
				),
			);
			if (
				await this.atStage('branch', () =>
					repository.updateRef(input.changeRequest.headBranch, appendCommit, false),
				)
			) {
				return this.atStage('pr', () => pullRequests.updateMetadata(input, appendCommit));
			}
			currentHead = await this.atStage('branch', () =>
				repository.getRef(input.changeRequest.headBranch),
			);
			if (currentHead === appendCommit) {
				return this.atStage('pr', () => pullRequests.updateMetadata(input, appendCommit));
			}
			if (currentHead !== expectedHead) {
				throw markSourceControlPublishFailure(
					new ConflictError('The GitHub pull request branch changed while updating'),
					{ provider: 'github', stage: 'branch', condition: 'branch_changed' },
				);
			}
		}

		const replaced = await this.replacePullRequestHead(input, repository, expectedHead);
		return this.atStage('pr', () => pullRequests.updateMetadata(input, replaced.headCommit));
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
			(await this.atStage('branch', () =>
				repository.proposalCommitMatches(currentHead, expectedHead, appendTree),
			))
		) {
			return { ...input.changeRequest, headCommit: currentHead };
		}
		const replacementTree = await this.atStage('push', () =>
			repository.createProposalTree(input, input.baseCommit),
		);
		if (
			await this.atStage('branch', () =>
				repository.proposalCommitMatches(currentHead, input.baseCommit, replacementTree),
			)
		) {
			return { ...input.changeRequest, headCommit: currentHead };
		}
		throw markSourceControlPublishFailure(
			new ConflictError('The GitHub pull request branch changed outside marimohub'),
			{ provider: 'github', stage: 'branch', condition: 'branch_changed' },
		);
	}

	private async replacePullRequestHead(
		input: UpdateChangeRequestInput,
		repository: GitHubRepositoryWriter,
		expectedHead: string,
	): Promise<OpenChangeRequestResult> {
		const replacementTree = await this.atStage('push', () =>
			repository.createProposalTree(input, input.baseCommit),
		);
		const replacementCommit = await this.atStage('push', () =>
			repository.createProposalCommit(
				input.baseCommit,
				replacementTree,
				input.title,
				input.body,
				input.coAuthor,
			),
		);
		try {
			await this.atStage('branch', () =>
				repository.forceUpdateRef(input.changeRequest.headBranch, expectedHead, replacementCommit),
			);
		} catch (error) {
			if (!(error instanceof ConflictError)) throw error;
			throw markSourceControlPublishFailure(error, {
				provider: 'github',
				stage: 'branch',
				condition: 'branch_changed',
			});
		}
		if (
			(await this.atStage('branch', () => repository.getRef(input.changeRequest.headBranch))) !==
			replacementCommit
		) {
			throw markSourceControlPublishFailure(
				new UnavailableError('GitHub did not update the pull request branch'),
				{ provider: 'github', stage: 'branch' },
			);
		}
		return { ...input.changeRequest, headCommit: replacementCommit };
	}
}

import { ConflictError, ProposalRetryRequiredError, UnavailableError } from '@marimo-hub/core';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	UpdateChangeRequestInput,
} from '@marimo-hub/core';
import type { GitHubClient } from './githubClient';
import {
	isRecord,
	nestedString,
	numberField,
	pullRequestUrl,
	responseJson,
	stringField,
} from './githubResponses';
import type { GitHubRepositoryWriter } from './githubRepository';

export type PullRequestCandidate = OpenChangeRequestResult & {
	state: 'open' | 'closed';
};

export class GitHubPullRequests {
	constructor(
		private readonly client: GitHubClient,
		private readonly repository: GitHubRepositoryWriter,
		private readonly owner: string,
		private readonly repo: string,
		private readonly token: string,
	) {}

	async listForBranch(branch: string, baseBranch: string): Promise<PullRequestCandidate[]> {
		const query = new URLSearchParams({
			state: 'all',
			head: `${this.owner}:${branch}`,
			base: baseBranch,
		});
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls?${query}`,
			this.token,
		);
		const pulls: unknown = await responseJson(response);
		if (!Array.isArray(pulls)) throw new UnavailableError('GitHub returned an invalid pull list');
		return pulls
			.map((pull): PullRequestCandidate => {
				const number = numberField(pull, 'number');
				const state = stringField(pull, 'state');
				if (state !== 'open' && state !== 'closed') {
					throw new UnavailableError('GitHub returned an invalid pull request state');
				}
				return {
					number,
					url: pullRequestUrl(pull, this.owner, this.repo, number),
					headBranch: branch,
					headCommit: nestedString(pull, 'head', 'sha'),
					state,
				};
			})
			.sort((left, right) => {
				if (left.state !== right.state) return left.state === 'open' ? -1 : 1;
				return left.number - right.number;
			});
	}

	async matchingProposal(
		pulls: PullRequestCandidate[],
		baseCommit: string,
		treeSha: string,
	): Promise<OpenChangeRequestResult | null> {
		const matches = new Map<string, boolean>();
		for (const pull of pulls) {
			let matchesProposal = matches.get(pull.headCommit);
			if (matchesProposal === undefined) {
				matchesProposal = await this.repository.proposalCommitMatches(
					pull.headCommit,
					baseCommit,
					treeSha,
				);
				matches.set(pull.headCommit, matchesProposal);
			}
			if (matchesProposal) {
				return {
					number: pull.number,
					url: pull.url,
					headBranch: pull.headBranch,
					headCommit: pull.headCommit,
				};
			}
		}
		if (pulls.length > 0) {
			throw new ProposalRetryRequiredError(
				'The GitHub pull requests no longer match the captured proposal; retry with a new idempotency key',
			);
		}
		return null;
	}

	async create(
		input: OpenChangeRequestInput,
		headCommit: string,
	): Promise<OpenChangeRequestResult> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls`,
			this.token,
			{
				method: 'POST',
				body: JSON.stringify({
					title: input.title,
					body: input.body,
					head: input.headBranch,
					base: input.baseBranch,
					draft: input.draft,
				}),
			},
			[422],
		);
		if (response.status === 422) {
			const existing = (await this.listForBranch(input.headBranch, input.baseBranch)).find(
				(pull) => pull.headCommit === headCommit,
			);
			if (existing) {
				return {
					number: existing.number,
					url: existing.url,
					headBranch: existing.headBranch,
					headCommit: existing.headCommit,
				};
			}
			throw new UnavailableError('GitHub rejected the pull request');
		}
		const pull = await responseJson(response);
		const number = numberField(pull, 'number');
		const publishedHead = nestedString(pull, 'head', 'sha');
		if (publishedHead !== headCommit) {
			throw new ConflictError('The GitHub proposal branch changed while publishing; retry');
		}
		return {
			number,
			url: pullRequestUrl(pull, this.owner, this.repo, number),
			headBranch: input.headBranch,
			headCommit: publishedHead,
		};
	}

	async updateMetadata(
		input: UpdateChangeRequestInput,
		headCommit: string,
	): Promise<OpenChangeRequestResult> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls/${input.changeRequest.number}`,
			this.token,
			{
				method: 'PATCH',
				body: JSON.stringify({ title: input.title, body: input.body }),
			},
		);
		const pull = await responseJson(response);
		const number = numberField(pull, 'number');
		const url = pullRequestUrl(pull, this.owner, this.repo, number);
		if (number !== input.changeRequest.number || url !== input.changeRequest.url) {
			throw new UnavailableError('GitHub returned an unexpected updated pull request');
		}
		if (!isRecord(pull) || pull.title !== input.title || pull.body !== input.body) {
			throw new UnavailableError('GitHub returned unexpected updated pull request metadata');
		}
		if (nestedString(pull, 'head', 'sha') !== headCommit) {
			throw new ConflictError('The GitHub pull request branch changed while updating');
		}
		return { ...input.changeRequest, headCommit };
	}
}

import { GitHubPullRequests } from './githubPullRequests';
import { ConflictError, ValidationError } from '@marimo-hub/core/errors';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	SourceControlPublisher,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';
import { GitHubClient } from './githubClient';
import type { GitHubAppPublisherOptions, GitHubAppPublisherRuntime } from './githubClient';
import { GitHubRepositoryWriter } from './githubRepository';
import { GitHubWorkingBranches } from './githubWorkingBranches';
import type { GitHubUserCredential } from './githubSignedCommit';
import { parseRepository, validateOpenInput, validateUpdateInput } from './githubValidation';

export class GitHubUserPublisher implements SourceControlPublisher {
	readonly provider = 'github';
	readonly workingBranches: GitHubWorkingBranches;
	private readonly client: GitHubClient;
	constructor(
		options: GitHubAppPublisherOptions,
		private readonly credential: GitHubUserCredential,
		runtime: GitHubAppPublisherRuntime = {},
	) {
		this.client = new GitHubClient(options, runtime);
		this.workingBranches = new GitHubWorkingBranches(this.client, credential);
	}
	private async prepare(input: OpenChangeRequestInput) {
		validateOpenInput(input);
		if (!input.preparation)
			throw new ValidationError('Personal publication requires a durable checkpoint');
		const { owner, repo } = parseRepository(input.repository, this.client.origin);
		const user = {
			...this.credential,
			token: async () => {
				const token = await this.credential.token();
				await input.preparation!.assertCurrent?.();
				return token;
			},
		};
		const writer = new GitHubRepositoryWriter(this.client, owner, repo, await user.token(), user);
		const tree = await writer.createProposalTree(input, input.baseCommit);
		const commit = await writer.createProposalCommit(
			input.baseCommit,
			tree,
			input.title,
			input.body,
		);
		return {
			writer,
			commit,
			user,
			verification: {
				status: 'verified' as const,
				commit,
				url: `${this.client.origin}/${owner}/${repo}/commit/${commit}`,
			},
		};
	}
	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { writer, commit, user, verification } = await this.prepare(input);
		const ref = await writer.createRef(input.headBranch, commit);
		if (ref.headCommit !== commit)
			throw new ConflictError('The proposal branch does not match the verified captured commit');
		const result = await new GitHubWorkingBranches(this.client, user).openBranchChangeRequest(
			input,
		);
		if (result.headCommit !== commit)
			throw new ConflictError('The proposal branch changed while opening its pull request');
		return { ...result, verification };
	}
	async updateChangeRequest(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { owner, repo } = validateUpdateInput(input, this.client.origin);
		const request = { ...input, headBranch: input.changeRequest.headBranch, draft: true };
		const { writer, commit, user, verification } = await this.prepare(request);
		const branches = new GitHubWorkingBranches(this.client, user);
		const remote = await branches.inspectBranch({
			repository: input.repository,
			branch: request.headBranch,
			changeRequestNumber: input.changeRequest.number,
		});
		if (
			remote.changeRequest?.state !== 'open' ||
			remote.changeRequest.baseBranch !== input.baseBranch
		)
			throw new ConflictError('The proposal pull request is no longer open on its original base');
		if (remote.headCommit !== commit) {
			if (remote.headCommit !== input.changeRequest.headCommit)
				throw new ConflictError('The proposal branch changed');
			await writer.compareAndSwapRef(
				request.headBranch,
				input.changeRequest.headCommit,
				commit,
				true,
			);
		}
		return {
			...(await new GitHubPullRequests(
				this.client,
				writer,
				owner,
				repo,
				await user.token(),
			).updateMetadata(input, commit)),
			verification,
		};
	}
}

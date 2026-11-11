import { ConflictError, UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import type {
	OpenChangeRequestResult,
	WorkingBranchInspection,
	WorkingBranchWriter,
} from '@marimo-hub/core/ports/source-control';
import type { GitHubClient } from './githubClient';
import { GitHubRepositoryWriter } from './githubRepository';
import {
	isRecord,
	nestedString,
	numberField,
	pullRequestUrl,
	responseJson,
	stringField,
} from './githubResponses';
import {
	parseRepository,
	validateBranch,
	validateChanges,
	validateCommitIdentity,
} from './githubValidation';

type Input<M extends keyof WorkingBranchWriter> = Parameters<WorkingBranchWriter[M]>[0];
type Pull = NonNullable<WorkingBranchInspection['changeRequest']> & { headCommit: string };

function workingBranch(branch: string): void {
	validateBranch(branch);
	if (!branch.startsWith('marimohub/')) {
		throw new ValidationError('Working branches must use the marimohub/ namespace');
	}
}

const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function fullCommit(commit: string): string {
	if (!FULL_COMMIT.test(commit)) {
		throw new ValidationError('Working branches require a full commit SHA');
	}
	return commit.toLowerCase();
}

export class GitHubWorkingBranches implements WorkingBranchWriter {
	constructor(private readonly client: GitHubClient) {}

	private async context(coordinate: string, access: 'preview' | 'write' = 'write') {
		const { owner, repo } = parseRepository(coordinate, this.client.origin);
		const token = await this.client.installationToken(owner, repo, access);
		return {
			owner,
			repo,
			token,
			base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
			repository: new GitHubRepositoryWriter(this.client, owner, repo, token),
		};
	}

	async createBranch(input: Input<'createBranch'>): Promise<{ commit: string }> {
		workingBranch(input.branch);
		const fromCommit = fullCommit(input.fromCommit);
		const { repository } = await this.context(input.repository);
		const result = await repository.createRef(input.branch, fromCommit);
		if (result.existed) throw new ConflictError('The working branch already exists');
		if (result.headCommit.toLowerCase() !== fromCommit) {
			throw new UnavailableError('GitHub returned an unexpected working branch commit');
		}
		return { commit: fromCommit };
	}

	async prepareCommit(input: Input<'prepareCommit'>): Promise<{ commit: string }> {
		const parentCommit = fullCommit(input.parentCommit);
		validateChanges(input.changes);
		validateCommitIdentity(input.coAuthor);
		if (!input.message.trim() || input.message.length > 65_536) {
			throw new ValidationError('A working branch commit requires a bounded message');
		}
		const { repository } = await this.context(input.repository);
		const tree = await repository.createProposalTree(input, parentCommit);
		const commit = await repository.createProposalCommit(
			parentCommit,
			tree,
			input.message,
			'',
			input.coAuthor,
		);
		if (!FULL_COMMIT.test(commit)) {
			throw new UnavailableError('GitHub returned an invalid working branch commit');
		}
		return { commit: commit.toLowerCase() };
	}

	async advanceBranch(input: Input<'advanceBranch'>): Promise<{ commit: string }> {
		workingBranch(input.branch);
		const expectedHead = fullCommit(input.expectedHead);
		const commit = fullCommit(input.commit);
		const { repository } = await this.context(input.repository);
		await repository.compareAndSwapRef(input.branch, expectedHead, commit);
		return { commit };
	}

	private parsePull(data: unknown, owner: string, repo: string): Pull {
		const number = numberField(data, 'number');
		if (!isRecord(data) || (data.state !== 'open' && data.state !== 'closed')) {
			throw new UnavailableError('GitHub returned an invalid working branch pull request');
		}
		for (const side of ['head', 'base']) {
			const ref = data[side];
			if (
				!isRecord(ref) ||
				nestedString(ref, 'repo', 'full_name').toLowerCase() !== `${owner}/${repo}`.toLowerCase()
			) {
				throw new ConflictError('The pull request no longer belongs to the working repository');
			}
		}
		return {
			number,
			url: pullRequestUrl(data, owner, repo, number, this.client.origin),
			state: data.merged === true || typeof data.merged_at === 'string' ? 'merged' : data.state,
			headBranch: nestedString(data, 'head', 'ref'),
			baseBranch: nestedString(data, 'base', 'ref'),
			headCommit: nestedString(data, 'head', 'sha'),
		};
	}

	private async findPull(
		ctx: { owner: string; repo: string; base: string; token: string },
		branch: string,
		baseBranch?: string,
	): Promise<Pull | undefined> {
		const query = new URLSearchParams({
			state: 'all',
			head: `${ctx.owner}:${branch}`,
			per_page: '100',
		});
		const data = await responseJson(
			await this.client.request(`${ctx.base}/pulls?${query}`, ctx.token),
		);
		if (!Array.isArray(data) || data.length >= 100) {
			throw new UnavailableError('Could not determine the working branch pull request');
		}
		const pulls = data.map((pull) => this.parsePull(pull, ctx.owner, ctx.repo));
		if (
			pulls.some(
				(pull) =>
					pull.headBranch !== branch ||
					(baseBranch !== undefined && pull.baseBranch !== baseBranch),
			)
		) {
			throw new UnavailableError('GitHub returned an unexpected working branch pull request');
		}
		// A branch can have closed PRs from before the current one was opened.
		return pulls.sort(
			(a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.number - a.number,
		)[0];
	}

	async inspectBranch(input: Input<'inspectBranch'>): Promise<WorkingBranchInspection> {
		workingBranch(input.branch);
		const commit = input.commit === undefined ? undefined : fullCommit(input.commit);
		if (
			input.changeRequestNumber !== undefined &&
			(!Number.isSafeInteger(input.changeRequestNumber) || input.changeRequestNumber <= 0)
		) {
			throw new ValidationError('Invalid working branch pull request number');
		}
		// 'preview' is the read-only contents + pull requests scope.
		const ctx = await this.context(input.repository, 'preview');
		const headCommit = await ctx.repository.getRef(input.branch);
		let containsCommit = Boolean(commit && headCommit?.toLowerCase() === commit);
		if (commit && headCommit && !containsCommit) {
			// Compare immutable SHAs so an external push during inspection cannot change its meaning.
			const comparison = await responseJson(
				await this.client.request(
					`${ctx.base}/compare/${commit}...${headCommit}?per_page=1`,
					ctx.token,
				),
			);
			const status = stringField(comparison, 'status');
			if (!['ahead', 'behind', 'diverged', 'identical'].includes(status)) {
				throw new UnavailableError('GitHub returned an invalid commit comparison');
			}
			containsCommit = status === 'ahead' || status === 'identical';
		}
		let changeRequest: WorkingBranchInspection['changeRequest'];
		if (input.changeRequestNumber !== undefined) {
			const pull = this.parsePull(
				await responseJson(
					await this.client.request(`${ctx.base}/pulls/${input.changeRequestNumber}`, ctx.token),
				),
				ctx.owner,
				ctx.repo,
			);
			if (pull.number !== input.changeRequestNumber || pull.headBranch !== input.branch) {
				throw new ConflictError('The pull request no longer tracks this working branch');
			}
			const { headCommit: _headCommit, ...metadata } = pull;
			changeRequest = metadata;
		} else {
			const pull = await this.findPull(ctx, input.branch);
			if (pull) {
				const { headCommit: _headCommit, ...metadata } = pull;
				changeRequest = metadata;
			}
		}
		return { headCommit, containsCommit, ...(changeRequest ? { changeRequest } : {}) };
	}

	async openBranchChangeRequest(
		input: Input<'openBranchChangeRequest'>,
	): Promise<OpenChangeRequestResult> {
		workingBranch(input.headBranch);
		validateBranch(input.baseBranch);
		if (
			input.headBranch === input.baseBranch ||
			!input.title.trim() ||
			input.title.length > 256 ||
			input.body.length > 65_536 ||
			typeof input.draft !== 'boolean'
		) {
			throw new ValidationError('Invalid working branch pull request metadata');
		}
		const ctx = await this.context(input.repository);
		const findExisting = () => this.findPull(ctx, input.headBranch, input.baseBranch);
		const result = (pull: Pull): OpenChangeRequestResult => ({
			number: pull.number,
			url: pull.url,
			headBranch: pull.headBranch,
			headCommit: pull.headCommit,
		});
		const existing = await findExisting();
		if (existing) return result(existing);
		if (!(await ctx.repository.getRef(input.headBranch))) {
			throw new ConflictError('The working branch was deleted');
		}
		const response = await this.client.request(
			`${ctx.base}/pulls`,
			ctx.token,
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
			const concurrent = await findExisting();
			if (concurrent) return result(concurrent);
			throw new ConflictError(
				'GitHub rejected the pull request; the working branch may have no changes',
			);
		}
		const pull = this.parsePull(await responseJson(response), ctx.owner, ctx.repo);
		if (pull.headBranch !== input.headBranch || pull.baseBranch !== input.baseBranch) {
			throw new UnavailableError('GitHub returned an unexpected working branch pull request');
		}
		return result(pull);
	}
}

import {
	BadRequestError,
	ConflictError,
	NotFoundError,
	ProposalRetryRequiredError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { markSourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	UpdateChangeRequestInput,
	SourceControlReader,
	SourceControlPublisher,
	SourceControlPublishStage,
	SourceReadOptions,
} from '@marimo-hub/core/ports/source-control';
import { materializeGitDirectory } from '@marimo-hub/source-control-git';
import { AzureClient, record, stringField, values } from './client';
import type { AzureDevOpsOptions, AzureDevOpsRuntime } from './client';
import { parseAzureRepository } from './repository';
import type { AzureRepository } from './repository';
import { AzureTrees, sameTree } from './trees';
import type { FileTree } from './trees';
import { validateBranch, normalizeCommit, validatePublication } from './validation';
export { parseAzureRepository, validateOrganization } from './repository';
export type { AzureDevOpsOptions, AzureDevOpsRuntime, AzureCredential } from './client';
export { ClientSecretCredential } from '@azure/identity';

export class AzureDevOpsSourceControl implements SourceControlReader, SourceControlPublisher {
	readonly provider = 'azure-devops';
	private readonly client: AzureClient;
	constructor(options: AzureDevOpsOptions, runtime: AzureDevOpsRuntime = {}) {
		this.client = new AzureClient(options, runtime);
	}
	private repository(value: string): AzureRepository {
		return parseAzureRepository(value, this.client.organization);
	}
	supportsRepository(value: string): boolean {
		try {
			this.repository(value);
			return true;
		} catch {
			return false;
		}
	}
	private async stage<T>(stage: SourceControlPublishStage, action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			const status =
				typeof (error as { providerStatus?: unknown })?.providerStatus === 'number'
					? (error as { providerStatus: number }).providerStatus
					: undefined;
			throw markSourceControlPublishFailure(error, { provider: this.provider, stage, status });
		}
	}
	private async head(
		repo: AzureRepository,
		branch: string,
		options: SourceReadOptions = {},
	): Promise<string | null> {
		validateBranch(branch);
		const refs = values(
			await this.client.json(repo, '/refs', { filter: `heads/${branch}`, $top: '1000' }, options),
		);
		const ref = refs.find((item) => stringField(item, 'name') === `refs/heads/${branch}`);
		if (!ref) return null;
		return normalizeCommit(stringField(ref, 'objectId'));
	}
	async getBranchHead(repository: string, branch: string, options: SourceReadOptions = {}) {
		const commit = await this.head(this.repository(repository), branch, options);
		if (!commit) throw new NotFoundError('Azure DevOps branch was not found');
		return { commit };
	}
	async fetchWorkspace(
		repository: string,
		commit: string,
		rootPath: string,
		options: SourceReadOptions = {},
	) {
		return new AzureTrees(this.client, this.repository(repository)).workspace(
			commit,
			rootPath,
			options,
		);
	}
	async fetchGitDirectory(repository: string, commit: string, branch: string) {
		const normalizedCommit = normalizeCommit(commit);
		validateBranch(branch);
		const repo = this.repository(repository);
		return materializeGitDirectory({
			repository: repo.url,
			remoteUrl: repo.url,
			commit: normalizedCommit,
			branch,
			authorization: await this.client.authorization(),
			fetcher: (url, init) => {
				const target = new URL(url);
				if (
					target.origin !== new URL(repo.url).origin ||
					!target.pathname.startsWith(`${new URL(repo.url).pathname}/`) ||
					target.username ||
					target.password
				)
					throw new BadRequestError('Invalid Azure DevOps Git endpoint');
				return this.client.fetcher(url, {
					...init,
					redirect: 'error',
					signal: AbortSignal.timeout(60_000),
				});
			},
		});
	}
	private branchChanged(deleted = false): Error {
		return markSourceControlPublishFailure(
			new ConflictError(
				deleted
					? 'Azure DevOps proposal branch was deleted; create a new pull request'
					: 'Azure DevOps proposal branch changed outside marimohub',
			),
			{
				provider: this.provider,
				stage: 'branch',
				condition: deleted ? 'branch_deleted' : 'branch_changed',
			},
		);
	}
	private async matches(
		trees: AzureTrees,
		head: string,
		parent: string,
		desired: FileTree,
	): Promise<boolean> {
		return this.stage('push', async () => {
			const commit = await trees.commit(head);
			return (
				Array.isArray(commit.parents) &&
				commit.parents.length === 1 &&
				typeof commit.parents[0] === 'string' &&
				normalizeCommit(commit.parents[0]) === parent &&
				sameTree(await trees.files(head), desired)
			);
		});
	}
	private result(
		repo: AzureRepository,
		pull: unknown,
		branch: string,
		baseBranch: string,
		headCommit: string,
		expectedNumber?: number,
	): OpenChangeRequestResult {
		const value = record(pull);
		const number = value.pullRequestId;
		if (
			!Number.isSafeInteger(number) ||
			typeof number !== 'number' ||
			number <= 0 ||
			(expectedNumber !== undefined && number !== expectedNumber) ||
			value.sourceRefName !== `refs/heads/${branch}` ||
			value.targetRefName !== `refs/heads/${baseBranch}`
		)
			throw new UnavailableError('Azure DevOps returned a different pull request');
		return { number, url: `${repo.url}/pullrequest/${number}`, headBranch: branch, headCommit };
	}
	private async push(
		repo: AzureRepository,
		branch: string,
		parent: string,
		input: OpenChangeRequestInput | UpdateChangeRequestInput,
		changes: unknown[],
	): Promise<string> {
		const trailer = input.coAuthor
			? `Co-authored-by: ${input.coAuthor.name.trim()} <${input.coAuthor.email}>`
			: '';
		const comment = [input.title, input.body, trailer].filter(Boolean).join('\n\n');
		const payload = await this.client.json(
			repo,
			'/pushes',
			{},
			{
				method: 'POST',
				body: JSON.stringify({
					refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: parent }],
					commits: [{ comment, changes }],
				}),
			},
		);
		const commits = record(payload).commits;
		if (!Array.isArray(commits) || commits.length !== 1)
			throw new UnavailableError('Invalid Azure DevOps push result');
		return normalizeCommit(stringField(commits[0], 'commitId'));
	}
	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { branch, baseCommit } = validatePublication(input);
		const repo = this.repository(input.repository);
		const trees = new AzureTrees(this.client, repo);
		const { desired, changes } = await this.stage('push', async () => {
			const base = await trees.files(baseCommit);
			const desired = trees.desired(base, input.changes);
			const changes = await trees.delta(base, desired, input.changes);
			if (changes.length === 0) throw new ConflictError('Proposal contains no changes');
			return { desired, changes };
		});
		let head = await this.stage('branch', () => this.head(repo, branch));
		if (!head) {
			await this.stage('branch', async () => {
				const response = values(
					await this.client.json(
						repo,
						'/refs',
						{},
						{
							method: 'POST',
							body: JSON.stringify([
								{
									name: `refs/heads/${branch}`,
									oldObjectId: '0'.repeat(40),
									newObjectId: baseCommit,
								},
							]),
						},
					),
				);
				if (response.length !== 1 || record(response[0]).success !== true) {
					const status = record(response[0]).updateStatus;
					if (status !== 'staleOldObjectId')
						throw new ConflictError('Azure DevOps could not create the proposal branch');
				}
			});
			head = await this.stage('branch', () => this.head(repo, branch));
		}
		if (!head) throw this.branchChanged(true);
		if (head === baseCommit) {
			head = await this.stage('push', () => this.push(repo, branch, baseCommit, input, changes));
		}
		if (!(await this.matches(trees, head, baseCommit, desired)))
			throw new ProposalRetryRequiredError(
				'The Azure DevOps branch no longer matches the proposal; retry with a new idempotency key',
			);
		const publishedHead = head;
		return this.stage('pr', async () => {
			if ((await this.stage('branch', () => this.head(repo, branch))) !== publishedHead)
				throw this.branchChanged();
			const candidates = values(
				await this.client.json(repo, '/pullrequests', {
					'searchCriteria.sourceRefName': `refs/heads/${branch}`,
					'searchCriteria.targetRefName': `refs/heads/${input.baseBranch}`,
					'searchCriteria.status': 'all',
					$top: '100',
				}),
			);
			if (candidates.length >= 100)
				throw new BadRequestError('Too many pull requests for the proposal branch');
			let closedMatch: OpenChangeRequestResult | undefined;
			for (const candidate of candidates) {
				const existing = this.result(repo, candidate, branch, input.baseBranch, publishedHead);
				const value = record(candidate);
				// Merge metadata can lag an active PR; the live source ref was checked above.
				if (value.status === 'active') return existing;
				const source = value.lastMergeSourceCommit;
				if (
					(value.status === 'completed' || value.status === 'abandoned') &&
					source &&
					normalizeCommit(stringField(source, 'commitId')) === publishedHead
				)
					closedMatch ??= existing;
			}
			if (closedMatch) return closedMatch;
			if (candidates.length > 0)
				throw new ProposalRetryRequiredError(
					'The existing Azure DevOps pull request does not match the proposal; retry with a new idempotency key',
				);
			const pull = await this.client.json(
				repo,
				'/pullrequests',
				{},
				{
					method: 'POST',
					body: JSON.stringify({
						sourceRefName: `refs/heads/${branch}`,
						targetRefName: `refs/heads/${input.baseBranch}`,
						title: input.title,
						description: input.body,
						isDraft: input.draft,
					}),
				},
			);
			return this.result(repo, pull, branch, input.baseBranch, publishedHead);
		});
	}
	async updateChangeRequest(input: UpdateChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { branch, baseCommit } = validatePublication(input);
		const repo = this.repository(input.repository);
		const expected = normalizeCommit(input.changeRequest.headCommit);
		const id = input.changeRequest.number;
		if (
			!Number.isSafeInteger(id) ||
			id <= 0 ||
			input.changeRequest.url !== `${repo.url}/pullrequest/${id}`
		)
			throw new ConflictError('Invalid Azure DevOps pull request identity');
		const pull = await this.stage('pr', () => this.client.json(repo, `/pullrequests/${id}`));
		this.result(repo, pull, branch, input.baseBranch, expected, id);
		if (record(pull).status !== 'active')
			throw new ConflictError('Azure DevOps pull request is closed; create a new pull request');
		const trees = new AzureTrees(this.client, repo);
		const desired = await this.stage('push', async () =>
			trees.desired(await trees.files(baseCommit), input.changes),
		);
		let head = await this.stage('branch', () => this.head(repo, branch));
		if (!head) throw this.branchChanged(true);
		if (head !== expected) {
			if (!(await this.matches(trees, head, expected, desired))) throw this.branchChanged();
		} else {
			const changes = await this.stage('push', async () =>
				trees.delta(await trees.files(expected), desired, input.changes),
			);
			if (changes.length > 0)
				head = await this.stage('push', () => this.push(repo, branch, expected, input, changes));
		}
		const publishedHead = head;
		if (!sameTree(await this.stage('push', () => trees.files(publishedHead)), desired))
			throw this.branchChanged();
		if ((await this.stage('branch', () => this.head(repo, branch))) !== head)
			throw this.branchChanged();
		const updated = await this.stage('pr', () =>
			this.client.json(
				repo,
				`/pullrequests/${id}`,
				{},
				{ method: 'PATCH', body: JSON.stringify({ title: input.title, description: input.body }) },
			),
		);
		return this.result(repo, updated, branch, input.baseBranch, publishedHead, id);
	}
}

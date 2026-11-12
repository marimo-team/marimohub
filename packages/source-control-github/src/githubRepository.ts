import { prepareSignedGitHubCommit } from './githubSignedCommit';
import type { GitHubUserCredential } from './githubSignedCommit';
import type { PreparationCheckpoint } from '@marimo-hub/core/source-control-publication';
import {
	ConflictError,
	ProposalRetryRequiredError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import type { OpenChangeRequestInput } from '@marimo-hub/core/ports/source-control';
import type { GitHubClient } from './githubClient';
import {
	gitTreeEntries,
	isRecord,
	nestedString,
	responseJson,
	stringField,
} from './githubResponses';
import type { GitTreeEntry } from './githubResponses';
import { coAuthorTrailer, refPath } from './githubValidation';

export class GitHubRepositoryWriter {
	private changes?: OpenChangeRequestInput['changes'];
	private checkpoint?: PreparationCheckpoint;
	constructor(
		private readonly client: GitHubClient,
		private readonly owner: string,
		private readonly repo: string,
		private readonly token: string,
		private readonly user?: GitHubUserCredential,
	) {}

	private async authToken(): Promise<string> {
		if (!this.user) return this.token;
		const token = await this.user.token();
		await this.checkpoint?.assertCurrent?.();
		return token;
	}

	async getRef(branch: string): Promise<string | null> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${refPath(branch)}`,
			await this.authToken(),
			{},
			[404],
		);
		return response.status === 404
			? null
			: nestedString(await responseJson(response), 'object', 'sha');
	}

	private async getBaseTreeEntries(baseTree: string): Promise<Map<string, GitTreeEntry>> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(baseTree)}?recursive=1`,
			await this.authToken(),
		);
		return gitTreeEntries(await responseJson(response));
	}

	private async pathExistsAtCommit(path: string, commit: string): Promise<boolean> {
		const query = new URLSearchParams({ ref: commit });
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${refPath(path)}?${query}`,
			await this.authToken(),
			{},
			[404],
		);
		return response.status !== 404;
	}

	async createProposalTree(
		input: Pick<OpenChangeRequestInput, 'changes' | 'preparation'>,
		treeBaseCommit: string,
	): Promise<string> {
		this.changes = input.changes;
		this.checkpoint = input.preparation;
		const commitResponse = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${encodeURIComponent(treeBaseCommit)}`,
			await this.authToken(),
		);
		const baseTree = nestedString(await responseJson(commitResponse), 'tree', 'sha');
		const baseEntries = input.changes.some((change) => change.operation !== 'add')
			? await this.getBaseTreeEntries(baseTree)
			: null;
		await Promise.all(
			input.changes
				.filter((change) => change.operation === 'add')
				.map(async (change) => {
					const exists = baseEntries
						? baseEntries.has(change.path)
						: await this.pathExistsAtCommit(change.path, treeBaseCommit);
					if (exists) {
						throw new ConflictError(`GitHub base tree already contains ${change.path}`);
					}
				}),
		);
		if (
			this.user &&
			input.changes.some(
				(change) =>
					change.operation === 'modify' && baseEntries?.get(change.path)?.mode !== '100644',
			)
		)
			throw new ConflictError(
				'Personal signed commits support changes to regular non-executable files only',
			);
		const tree = await Promise.all(
			input.changes.map(async (change) => {
				const baseEntry = baseEntries?.get(change.path);
				if (change.operation === 'delete') {
					if (!baseEntry) {
						throw new ConflictError(`GitHub base tree is missing ${change.path}`);
					}
					return { path: change.path, ...baseEntry, sha: null };
				}
				if (change.operation === 'modify' && baseEntry?.type !== 'blob') {
					throw new ConflictError(`GitHub base tree has no file at ${change.path}`);
				}
				const blobResponse = await this.client.request(
					`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs`,
					await this.authToken(),
					{
						method: 'POST',
						body: JSON.stringify({
							content: Buffer.from(change.content).toString('base64'),
							encoding: 'base64',
						}),
					},
				);
				return {
					path: change.path,
					mode: baseEntry?.mode ?? '100644',
					type: 'blob' as const,
					sha: stringField(await responseJson(blobResponse), 'sha'),
				};
			}),
		);
		const treeResponse = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees`,
			await this.authToken(),
			{ method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) },
		);
		return stringField(await responseJson(treeResponse), 'sha');
	}

	async createProposalCommit(
		parentCommit: string,
		tree: string,
		title: string,
		body: string,
		coAuthor?: OpenChangeRequestInput['coAuthor'],
	): Promise<string> {
		if (this.user)
			return prepareSignedGitHubCommit({
				client: this.client,
				writer: this,
				owner: this.owner,
				repo: this.repo,
				credential: this.user,
				parent: parentCommit,
				tree,
				message: `${title}\n\n${body}`.trim().replace(/\n+/, '\n\n'),
				changes: this.changes ?? [],
				checkpoint: this.checkpoint,
			});
		const trailer = coAuthorTrailer(coAuthor);
		const message = [`${title}\n\n${body}`.trim(), trailer].filter(Boolean).join('\n\n');
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits`,
			await this.authToken(),
			{
				method: 'POST',
				body: JSON.stringify({
					message,
					tree,
					parents: [parentCommit],
				}),
			},
		);
		return stringField(await responseJson(response), 'sha');
	}

	async createRef(
		branch: string,
		commit: string,
	): Promise<{ headCommit: string; existed: boolean }> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs`,
			await this.authToken(),
			{
				method: 'POST',
				body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit }),
			},
			[422],
		);
		if (response.status === 422) {
			const headCommit = await this.getRef(branch);
			if (!headCommit) throw new UnavailableError('GitHub did not create the proposal branch');
			return { headCommit, existed: true };
		}
		return {
			headCommit: nestedString(await responseJson(response), 'object', 'sha'),
			existed: false,
		};
	}

	async updateRef(branch: string, commit: string, force: boolean): Promise<boolean> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs/heads/${refPath(branch)}`,
			await this.authToken(),
			{ method: 'PATCH', body: JSON.stringify({ sha: commit, force }) },
			[409, 422],
		);
		if (response.status === 409 || response.status === 422) return false;
		if (nestedString(await responseJson(response), 'object', 'sha') !== commit) {
			throw new UnavailableError('GitHub returned an invalid updated branch');
		}
		return true;
	}

	async forceUpdateRef(branch: string, expectedCommit: string, nextCommit: string): Promise<void> {
		return this.compareAndSwapRef(branch, expectedCommit, nextCommit, true);
	}

	async compareAndSwapRef(
		branch: string,
		expectedCommit: string,
		nextCommit: string,
		force = false,
	): Promise<void> {
		const repositoryResponse = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`,
			await this.authToken(),
		);
		const repositoryId = stringField(await responseJson(repositoryResponse), 'node_id');
		const response = await this.client.request('/graphql', await this.authToken(), {
			method: 'POST',
			body: JSON.stringify({
				query:
					'mutation UpdateProposalRef($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
				variables: {
					input: {
						repositoryId,
						refUpdates: [
							{
								name: `refs/heads/${branch}`,
								beforeOid: expectedCommit,
								afterOid: nextCommit,
								force,
							},
						],
					},
				},
			}),
		});
		const payload = await responseJson(response);
		// updateRefs is atomic. Only explicit mutation rejections prove that no ref moved.
		if (
			isRecord(payload) &&
			isRecord(payload.data) &&
			payload.data.updateRefs === null &&
			Array.isArray(payload.errors) &&
			payload.errors.length > 0 &&
			payload.errors.every(
				(error: unknown) =>
					isRecord(error) &&
					(error.type === 'UNPROCESSABLE' ||
						error.type === 'FORBIDDEN' ||
						error.type === 'NOT_FOUND') &&
					Array.isArray(error.path) &&
					error.path.length === 1 &&
					error.path[0] === 'updateRefs',
			)
		) {
			throw new ConflictError('GitHub rejected the branch update');
		}
		if (
			!isRecord(payload) ||
			(Array.isArray(payload.errors) && payload.errors.length > 0) ||
			!isRecord(payload.data) ||
			!isRecord(payload.data.updateRefs)
		) {
			throw new UnavailableError('Could not confirm the GitHub branch update');
		}
	}

	async proposalCommitMatches(
		commitSha: string,
		baseCommit: string,
		treeSha: string,
	): Promise<boolean> {
		const response = await this.client.request(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${encodeURIComponent(commitSha)}`,
			await this.authToken(),
		);
		const commit = await responseJson(response);
		if (!isRecord(commit) || !Array.isArray(commit.parents)) {
			throw new UnavailableError('GitHub returned an invalid proposal commit');
		}
		const parents = commit.parents.map((parent) => stringField(parent, 'sha'));
		const actualTree = nestedString(commit, 'tree', 'sha');
		return parents.length === 1 && parents[0] === baseCommit && actualTree === treeSha;
	}

	async assertProposalCommit(
		commitSha: string,
		baseCommit: string,
		treeSha: string,
	): Promise<void> {
		if (!(await this.proposalCommitMatches(commitSha, baseCommit, treeSha))) {
			throw new ProposalRetryRequiredError(
				'The GitHub proposal branch no longer matches the captured proposal; retry with a new idempotency key',
			);
		}
	}
}

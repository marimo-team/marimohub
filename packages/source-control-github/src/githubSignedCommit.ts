import { logEvent } from '@marimo-hub/core/logs';
import { ConflictError, UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import type {
	PreparationCheckpoint,
	SignedPreparation,
} from '@marimo-hub/core/source-control-publication';
import type { SourceControlChange } from '@marimo-hub/core/ports/source-control';
import type { GitHubClient } from './githubClient';
import type { GitHubRepositoryWriter } from './githubRepository';
import { isRecord, responseJson, stringField } from './githubResponses';

export interface GitHubUserCredential {
	accountId: string;
	token(): Promise<string>;
}
const fields =
	'oid message tree { oid } parents(first: 2) { nodes { oid } } author { user { databaseId } } signature { isValid state wasSignedByGitHub }';
const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function prepareSignedGitHubCommit(input: {
	client: GitHubClient;
	writer: GitHubRepositoryWriter;
	owner: string;
	repo: string;
	credential: GitHubUserCredential;
	parent: string;
	tree: string;
	message: string;
	changes: readonly SourceControlChange[];
	checkpoint?: PreparationCheckpoint;
}): Promise<string> {
	const { client, writer, owner, repo, credential, parent, tree, message, checkpoint } = input;
	if (!checkpoint)
		throw new ValidationError('Personal GitHub commits require a durable preparation checkpoint');
	const request = async (query: string, variables: Record<string, unknown>) => {
		const token = await credential.token();
		await checkpoint.assertCurrent?.();
		const response = await client.request('/graphql', token, {
			method: 'POST',
			body: JSON.stringify({ query, variables }),
		});
		const payload = await responseJson(response);
		if (!isRecord(payload) || payload.errors || !isRecord(payload.data))
			throw new UnavailableError(
				'GitHub signed commit outcome could not be confirmed; retry the operation',
			);
		return payload.data;
	};
	const validate = (value: unknown, expectedOid?: string): string => {
		if (
			!isRecord(value) ||
			typeof value.oid !== 'string' ||
			!fullCommit.test(value.oid) ||
			(expectedOid !== undefined && value.oid !== expectedOid) ||
			!isRecord(value.tree) ||
			value.tree.oid !== tree ||
			value.message !== message ||
			!isRecord(value.parents) ||
			!Array.isArray(value.parents.nodes) ||
			value.parents.nodes.length !== 1 ||
			!isRecord(value.parents.nodes[0]) ||
			value.parents.nodes[0].oid !== parent ||
			!isRecord(value.author) ||
			!isRecord(value.author.user) ||
			String(value.author.user.databaseId) !== credential.accountId ||
			!isRecord(value.signature) ||
			value.signature.isValid !== true ||
			value.signature.state !== 'VALID' ||
			value.signature.wasSignedByGitHub !== true
		) {
			logEvent({
				level: 'warn',
				event: 'source_control.commit_verification_failed',
				provider: 'github',
				repository: `${owner}/${repo}`,
				account_id: credential.accountId,
			});
			throw new ConflictError(
				'GitHub did not produce the expected verified personal commit; the target branch was not updated',
			);
		}
		return stringField(value, 'oid');
	};
	const inspect = async (oid: string) => {
		const data = await request(
			`query SignedCommit($owner: String!, $repo: String!, $oid: String!) { repository(owner: $owner, name: $repo) { object(expression: $oid) { ... on Commit { ${fields} } } } }`,
			{ owner, repo, oid },
		);
		if (!isRecord(data.repository))
			throw new UnavailableError('GitHub signed commit is unavailable');
		return validate(data.repository.object, oid);
	};
	let state = await checkpoint.read();
	if (!state) {
		state = {
			protocol: 'github-graphql-v1',
			branch: `marimohub/preparation/${crypto.randomUUID()}`,
			repository: `${owner}/${repo}`,
			accountId: credential.accountId,
			parent,
			tree,
			message,
			dispatched: false,
		};
		await checkpoint.write(state);
	}
	if (
		state.repository !== `${owner}/${repo}` ||
		state.accountId !== credential.accountId ||
		state.parent !== parent ||
		state.tree !== tree ||
		state.message !== message ||
		!/^marimohub\/preparation\/[a-f0-9-]{36}$/.test(state.branch)
	)
		throw new ConflictError('The signed commit preparation does not match this operation');
	if (state.commit) {
		const commit = await inspect(state.commit);
		if (!state.cleaned && (await cleanupSignedPreparation(writer, state)))
			await checkpoint.write({ ...state, cleaned: true });
		return commit;
	}
	let head = await writer.getRef(state.branch);
	if (!head) {
		if (state.dispatched)
			throw new ConflictError(
				'The signed preparation branch was removed; recover this operation before starting another',
			);
		const created = await writer.createRef(state.branch, parent);
		head = created.headCommit;
	}
	let commit: string;
	if (head !== parent) {
		commit = await inspect(head);
	} else {
		state = { ...state, dispatched: true };
		await checkpoint.write(state);
		const data = await request(
			`mutation SignedCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { ${fields} } } }`,
			{
				input: {
					branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: state.branch },
					expectedHeadOid: parent,
					message: {
						headline: message.split('\n')[0],
						body: message.includes('\n')
							? message.slice(message.indexOf('\n') + 1).replace(/^\n/, '')
							: undefined,
					},
					fileChanges: {
						additions: input.changes
							.filter((change) => change.operation !== 'delete')
							.map((change) => ({
								path: change.path,
								contents: Buffer.from(change.content).toString('base64'),
							})),
						deletions: input.changes
							.filter((change) => change.operation === 'delete')
							.map((change) => ({ path: change.path })),
					},
				},
			},
		);
		if (!isRecord(data.createCommitOnBranch))
			throw new UnavailableError('GitHub signed commit outcome is unknown');
		const candidate = data.createCommitOnBranch.commit;
		if (
			isRecord(candidate) &&
			typeof candidate.oid === 'string' &&
			fullCommit.test(candidate.oid)
		) {
			state = { ...state, ownedHead: candidate.oid };
			await checkpoint.write(state);
		}
		try {
			commit = validate(candidate);
		} catch (error) {
			if (await cleanupSignedPreparation(writer, state))
				await checkpoint.write({ ...state, cleaned: true });
			throw error;
		}
	}
	state = { ...state, commit };
	await checkpoint.write(state);
	if (await cleanupSignedPreparation(writer, state))
		await checkpoint.write({ ...state, cleaned: true });
	return commit;
}

export async function cleanupSignedPreparation(
	writer: GitHubRepositoryWriter,
	state: SignedPreparation,
): Promise<boolean> {
	if (state.cleaned) return true;
	if (!/^marimohub\/preparation\/[a-f0-9-]{36}$/.test(state.branch))
		throw new ValidationError('Invalid preparation branch');
	const expected =
		state.commit ?? state.ownedHead ?? (!state.dispatched ? state.parent : undefined);
	if (!expected) return false;
	try {
		const current = await writer.getRef(state.branch);
		if (!current) return true;
		if (current !== expected) return false;
		await writer.compareAndSwapRef(state.branch, expected, '0'.repeat(40));
		return true;
	} catch {
		return false;
	}
}

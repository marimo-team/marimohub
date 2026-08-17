import { createPrivateKey, createSign } from 'node:crypto';
import {
	ConflictError,
	isSafeWorkspacePath,
	ProposalRetryRequiredError,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core';
import type {
	OpenChangeRequestInput,
	OpenChangeRequestResult,
	SourceControlPublisher,
} from '@marimo-hub/core';

type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppPublisherOptions {
	/** Numeric id shown on the GitHub App settings page. */
	appId: string;
	/** PKCS1/PKCS8 PEM, or a base64 encoding of the PEM. */
	privateKey: string;
}

export interface GitHubAppPublisherRuntime {
	/** Optional fetch implementation for the host runtime. */
	fetcher?: GitHubFetch;
	/** Optional clock, primarily for deterministic tests. */
	now?: () => number;
}

const GITHUB_API_BASE_URL = 'https://api.github.com';

function encodeBase64Url(value: string): string {
	return Buffer.from(value).toString('base64url');
}

function privateKeyPem(value: string): string {
	const trimmed = value.trim();
	return trimmed.includes('BEGIN') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
	if (!isRecord(value) || typeof value[field] !== 'string' || value[field].length === 0) {
		throw new UnavailableError(`GitHub returned an invalid ${field}`);
	}
	return value[field];
}

function numberField(value: unknown, field: string): number {
	if (
		!isRecord(value) ||
		typeof value[field] !== 'number' ||
		!Number.isInteger(value[field]) ||
		value[field] <= 0
	) {
		throw new UnavailableError(`GitHub returned an invalid ${field}`);
	}
	return value[field];
}

function nestedString(value: unknown, parent: string, field: string): string {
	if (!isRecord(value)) throw new UnavailableError('GitHub returned an invalid response');
	return stringField(value[parent], field);
}

function parseRepository(value: unknown): { owner: string; repo: string } {
	if (typeof value !== 'string') throw new ValidationError('GitHub repository must be owner/repo');
	let path = value.trim();
	if (/^https:\/\//i.test(path)) {
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			throw new ValidationError('Invalid GitHub repository URL');
		}
		if (
			url.hostname.toLowerCase() !== 'github.com' ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new ValidationError('GitHub publishing supports github.com repositories only');
		}
		path = url.pathname.replaceAll(/^\/+|\/+$/g, '');
	}
	const parts = path.replace(/\.git$/, '').split('/');
	const [owner, repo] = parts;
	if (
		parts.length !== 2 ||
		!owner ||
		!repo ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
		!/^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/.test(repo)
	) {
		throw new ValidationError('GitHub repository must be owner/repo');
	}
	return { owner, repo };
}

function hasForbiddenGitRefCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x20 || codeUnit === 0x7f || '~^:?*[\\'.includes(value[index] ?? '')) {
			return true;
		}
	}
	return false;
}

function validateBranch(branch: unknown): asserts branch is string {
	if (typeof branch !== 'string') throw new ValidationError('Invalid GitHub branch name');
	const components = branch.split('/');
	if (
		branch.length === 0 ||
		branch === '@' ||
		branch.startsWith('-') ||
		hasForbiddenGitRefCharacter(branch) ||
		branch.startsWith('/') ||
		branch.endsWith('/') ||
		branch.endsWith('.') ||
		branch.includes('..') ||
		branch.includes('//') ||
		branch.includes('@{') ||
		components.some((component) => component.startsWith('.') || component.endsWith('.lock'))
	) {
		throw new ValidationError('Invalid GitHub branch name');
	}
}

function refPath(branch: string): string {
	return branch.split('/').map(encodeURIComponent).join('/');
}

async function json(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new UnavailableError('GitHub returned invalid JSON', { cause: error });
	}
}

function validateChanges(changes: unknown): asserts changes is OpenChangeRequestInput['changes'] {
	if (!Array.isArray(changes) || changes.length === 0)
		throw new ValidationError('A pull request requires at least one change');
	const paths = new Set<string>();
	for (const change of changes) {
		if (!isRecord(change) || typeof change.path !== 'string') {
			throw new ValidationError('Invalid source-control change');
		}
		if (!isSafeWorkspacePath(change.path)) {
			throw new ValidationError(`Invalid repository path: ${change.path}`);
		}
		if (paths.has(change.path)) {
			throw new ValidationError(`Duplicate repository path: ${change.path}`);
		}
		paths.add(change.path);
		if (
			typeof change.operation !== 'string' ||
			!['add', 'modify', 'delete'].includes(change.operation)
		) {
			throw new ValidationError(`Invalid operation for ${change.path}`);
		}
		if (change.operation !== 'delete' && !(change.content instanceof Uint8Array)) {
			throw new ValidationError(`Missing content for ${change.path}`);
		}
	}
}

type GitTreeEntry = {
	mode: '040000' | '100644' | '100755' | '120000' | '160000';
	type: 'blob' | 'commit' | 'tree';
};

type PullRequestCandidate = OpenChangeRequestResult & {
	state: 'open' | 'closed';
};

function gitTreeEntries(value: unknown): Map<string, GitTreeEntry> {
	if (!isRecord(value) || value.truncated !== false || !Array.isArray(value.tree)) {
		throw new UnavailableError('GitHub returned an incomplete base tree');
	}
	const entries = new Map<string, GitTreeEntry>();
	for (const raw of value.tree) {
		if (!isRecord(raw) || typeof raw.path !== 'string') {
			throw new UnavailableError('GitHub returned an invalid base tree entry');
		}
		const mode = raw.mode;
		const type = raw.type;
		const validEntry =
			(type === 'blob' && ['100644', '100755', '120000'].includes(String(mode))) ||
			(type === 'tree' && mode === '040000') ||
			(type === 'commit' && mode === '160000');
		if (!validEntry) {
			throw new UnavailableError('GitHub returned an invalid base tree entry');
		}
		entries.set(raw.path, { mode, type } as GitTreeEntry);
	}
	return entries;
}

function pullRequestUrl(value: unknown, owner: string, repo: string, number: number): string {
	const raw = stringField(value, 'html_url');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnavailableError('GitHub returned an invalid pull request URL');
	}
	const expectedPath = `/${owner}/${repo}/pull/${number}`.toLowerCase();
	if (
		url.protocol !== 'https:' ||
		url.hostname.toLowerCase() !== 'github.com' ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname.toLowerCase() !== expectedPath
	) {
		throw new UnavailableError('GitHub returned an unexpected pull request URL');
	}
	return raw;
}

export class GitHubAppPublisher implements SourceControlPublisher {
	readonly provider = 'github' as const;
	private readonly appId: string;
	private readonly fetcher: GitHubFetch;
	private readonly now: () => number;
	private readonly key: ReturnType<typeof createPrivateKey>;

	constructor(options: GitHubAppPublisherOptions, runtime: GitHubAppPublisherRuntime = {}) {
		if (!/^[1-9]\d*$/.test(options.appId.trim()))
			throw new Error('GitHub App id must be a positive integer');
		if (!options.privateKey.trim()) throw new Error('GitHub App private key is required');
		this.appId = options.appId.trim();
		this.fetcher = runtime.fetcher ?? fetch;
		this.now = runtime.now ?? Date.now;
		this.key = createPrivateKey(privateKeyPem(options.privateKey));
		if (this.key.asymmetricKeyType !== 'rsa') {
			throw new Error('GitHub App private key must be RSA');
		}
	}

	private appJwt(): string {
		const nowSeconds = Math.floor(this.now() / 1000);
		if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
			throw new UnavailableError('GitHub App clock is invalid');
		}
		const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
		const payload = encodeBase64Url(
			JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: this.appId }),
		);
		const unsigned = `${header}.${payload}`;
		const signature = createSign('RSA-SHA256').update(unsigned).end().sign(this.key, 'base64url');
		return `${unsigned}.${signature}`;
	}

	private async request(
		path: string,
		token: string,
		init: RequestInit = {},
		allowedStatuses: readonly number[] = [],
	): Promise<Response> {
		let response: Response;
		try {
			const headers = new Headers(init.headers);
			headers.set('accept', 'application/vnd.github+json');
			headers.set('authorization', `Bearer ${token}`);
			headers.set('content-type', 'application/json');
			headers.set('x-github-api-version', '2022-11-28');
			response = await this.fetcher(`${GITHUB_API_BASE_URL}${path}`, {
				...init,
				headers,
			});
		} catch (error) {
			throw new UnavailableError('GitHub is unavailable', { cause: error });
		}
		if (!response.ok && !allowedStatuses.includes(response.status)) {
			throw new UnavailableError(`GitHub request failed with status ${response.status}`);
		}
		return response;
	}

	private async installationToken(owner: string, repo: string): Promise<string> {
		const installationResponse = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
			this.appJwt(),
			{},
			[404],
		);
		if (installationResponse.status === 404) {
			throw new UnavailableError(`The GitHub App is not installed for ${owner}/${repo}`);
		}
		const installationId = numberField(await json(installationResponse), 'id');
		const tokenResponse = await this.request(
			`/app/installations/${installationId}/access_tokens`,
			this.appJwt(),
			{
				method: 'POST',
				body: JSON.stringify({
					repositories: [repo],
					permissions: { contents: 'write', pull_requests: 'write' },
				}),
			},
		);
		return stringField(await json(tokenResponse), 'token');
	}

	private async getRef(
		owner: string,
		repo: string,
		branch: string,
		token: string,
	): Promise<string | null> {
		const response = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${refPath(branch)}`,
			token,
			{},
			[404],
		);
		return response.status === 404 ? null : nestedString(await json(response), 'object', 'sha');
	}

	private async getBaseTreeEntries(
		owner: string,
		repo: string,
		baseTree: string,
		token: string,
	): Promise<Map<string, GitTreeEntry>> {
		const response = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(baseTree)}?recursive=1`,
			token,
		);
		return gitTreeEntries(await json(response));
	}

	private async pathExistsAtCommit(
		owner: string,
		repo: string,
		path: string,
		commit: string,
		token: string,
	): Promise<boolean> {
		const query = new URLSearchParams({ ref: commit });
		const response = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${refPath(path)}?${query}`,
			token,
			{},
			[404],
		);
		return response.status !== 404;
	}

	private async createProposalTree(
		input: OpenChangeRequestInput,
		owner: string,
		repo: string,
		token: string,
	): Promise<string> {
		const commitResponse = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(input.baseCommit)}`,
			token,
		);
		const baseTree = nestedString(await json(commitResponse), 'tree', 'sha');
		const baseEntries = input.changes.some((change) => change.operation !== 'add')
			? await this.getBaseTreeEntries(owner, repo, baseTree, token)
			: null;
		await Promise.all(
			input.changes
				.filter((change) => change.operation === 'add')
				.map(async (change) => {
					const exists = baseEntries
						? baseEntries.has(change.path)
						: await this.pathExistsAtCommit(owner, repo, change.path, input.baseCommit, token);
					if (exists) {
						throw new ConflictError(`GitHub base tree already contains ${change.path}`);
					}
				}),
		);
		const tree = await Promise.all(
			input.changes.map(async (change) => {
				const baseEntry = baseEntries?.get(change.path);
				if (change.operation === 'delete') {
					if (!baseEntry) {
						throw new UnavailableError(`GitHub base tree is missing ${change.path}`);
					}
					return { path: change.path, ...baseEntry, sha: null };
				}
				if (change.operation === 'modify' && baseEntry?.type !== 'blob') {
					throw new UnavailableError(`GitHub base tree has no file at ${change.path}`);
				}
				const blobResponse = await this.request(
					`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
					token,
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
					sha: stringField(await json(blobResponse), 'sha'),
				};
			}),
		);
		const treeResponse = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
			token,
			{ method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) },
		);
		return stringField(await json(treeResponse), 'sha');
	}

	private async proposalCommitMatches(
		owner: string,
		repo: string,
		commitSha: string,
		baseCommit: string,
		treeSha: string,
		token: string,
	): Promise<boolean> {
		const response = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(commitSha)}`,
			token,
		);
		const commit = await json(response);
		if (!isRecord(commit) || !Array.isArray(commit.parents)) {
			throw new UnavailableError('GitHub returned an invalid proposal commit');
		}
		const parents = commit.parents.map((parent) => stringField(parent, 'sha'));
		const actualTree = nestedString(commit, 'tree', 'sha');
		return parents.length === 1 && parents[0] === baseCommit && actualTree === treeSha;
	}

	private async assertProposalCommit(
		owner: string,
		repo: string,
		commitSha: string,
		baseCommit: string,
		treeSha: string,
		token: string,
	): Promise<void> {
		if (!(await this.proposalCommitMatches(owner, repo, commitSha, baseCommit, treeSha, token))) {
			throw new ProposalRetryRequiredError(
				'The GitHub proposal branch no longer matches the captured proposal; retry with a new idempotency key',
			);
		}
	}

	private async findPullRequests(
		owner: string,
		repo: string,
		branch: string,
		baseBranch: string,
		token: string,
	): Promise<PullRequestCandidate[]> {
		const query = new URLSearchParams({
			state: 'all',
			head: `${owner}:${branch}`,
			base: baseBranch,
		});
		const response = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query}`,
			token,
		);
		const pulls: unknown = await json(response);
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
					url: pullRequestUrl(pull, owner, repo, number),
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

	private async matchingPullRequest(
		pulls: PullRequestCandidate[],
		owner: string,
		repo: string,
		baseCommit: string,
		treeSha: string,
		token: string,
	): Promise<OpenChangeRequestResult | null> {
		const matches = new Map<string, boolean>();
		for (const pull of pulls) {
			let matchesProposal = matches.get(pull.headCommit);
			if (matchesProposal === undefined) {
				matchesProposal = await this.proposalCommitMatches(
					owner,
					repo,
					pull.headCommit,
					baseCommit,
					treeSha,
					token,
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

	async openChangeRequest(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
		const { owner, repo } = parseRepository(input.repository);
		validateBranch(input.baseBranch);
		validateBranch(input.headBranch);
		validateChanges(input.changes);
		if (typeof input.baseCommit !== 'string' || input.baseCommit.length === 0) {
			throw new ValidationError('GitHub base commit is required');
		}
		if (typeof input.title !== 'string' || input.title.trim().length === 0) {
			throw new ValidationError('GitHub pull request title is required');
		}
		if (typeof input.body !== 'string' || typeof input.draft !== 'boolean') {
			throw new ValidationError('Invalid GitHub pull request metadata');
		}
		const token = await this.installationToken(owner, repo);
		const existingRef = await this.getRef(owner, repo, input.headBranch, token);
		const pullRequests = await this.findPullRequests(
			owner,
			repo,
			input.headBranch,
			input.baseBranch,
			token,
		);
		const treeSha = await this.createProposalTree(input, owner, repo, token);
		const existing = await this.matchingPullRequest(
			pullRequests,
			owner,
			repo,
			input.baseCommit,
			treeSha,
			token,
		);
		if (existing) {
			return existing;
		}
		if (existingRef) {
			await this.assertProposalCommit(owner, repo, existingRef, input.baseCommit, treeSha, token);
			return this.createPullRequest(input, owner, repo, token, existingRef);
		}
		const proposedCommitResponse = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
			token,
			{
				method: 'POST',
				body: JSON.stringify({
					message: `${input.title}\n\n${input.body}`.trim(),
					tree: treeSha,
					parents: [input.baseCommit],
				}),
			},
		);
		const proposedCommit = stringField(await json(proposedCommitResponse), 'sha');
		const refResponse = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
			token,
			{
				method: 'POST',
				body: JSON.stringify({ ref: `refs/heads/${input.headBranch}`, sha: proposedCommit }),
			},
			[422],
		);
		const headCommit =
			refResponse.status === 422
				? await this.getRef(owner, repo, input.headBranch, token)
				: nestedString(await json(refResponse), 'object', 'sha');
		if (!headCommit) throw new UnavailableError('GitHub did not create the proposal branch');
		if (refResponse.status === 422) {
			await this.assertProposalCommit(owner, repo, headCommit, input.baseCommit, treeSha, token);
		}
		return this.createPullRequest(input, owner, repo, token, headCommit);
	}

	private async createPullRequest(
		input: OpenChangeRequestInput,
		owner: string,
		repo: string,
		token: string,
		headCommit: string,
	): Promise<OpenChangeRequestResult> {
		const response = await this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
			token,
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
			const existing = (
				await this.findPullRequests(owner, repo, input.headBranch, input.baseBranch, token)
			).find((pull) => pull.headCommit === headCommit);
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
		const pull = await json(response);
		const number = numberField(pull, 'number');
		const publishedHead = nestedString(pull, 'head', 'sha');
		if (publishedHead !== headCommit) {
			throw new ConflictError('The GitHub proposal branch changed while publishing; retry');
		}
		return {
			number,
			url: pullRequestUrl(pull, owner, repo, number),
			headBranch: input.headBranch,
			headCommit: publishedHead,
		};
	}
}

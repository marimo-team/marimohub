import { describe, expect, it, vi } from 'vitest';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	ProposalRetryRequiredError,
	NotFoundError,
} from '@marimo-hub/core/errors';
import { sourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type { OpenChangeRequestInput } from '@marimo-hub/core/ports/source-control';
import { AzureDevOpsSourceControl, parseAzureRepository } from './index';
import { AZURE_DEVOPS_SCOPE, boundedBytes } from './client';
import { FakeAzure, repository } from './testing/fakeAzure';

const bytes = (text: string) => new TextEncoder().encode(text);
function setup() {
	const fake = new FakeAzure();
	const credential = { getToken: vi.fn(async () => ({ token: 'test-token' })) };
	const adapter = new AzureDevOpsSourceControl(
		{ organization: 'acme', credential },
		{ fetcher: fake.fetcher },
	);
	const input: OpenChangeRequestInput = {
		repository,
		baseBranch: 'main',
		baseCommit: fake.base,
		headBranch: 'hub/proposal-1',
		title: 'Update notebook',
		body: 'Description',
		draft: true,
		coAuthor: { name: 'Alice', email: 'alice@example.com' },
		changes: [
			{ path: 'apps/main.py', operation: 'modify', content: bytes('print(2)') },
			{ path: 'data.bin', operation: 'add', content: new Uint8Array([0, 255, 123]) },
		],
	};
	return { fake, adapter, credential, input };
}

describe('Azure DevOps repositories', () => {
	it('keeps project paths and encodes names once', () => {
		expect(parseAzureRepository(repository, 'ACME')).toMatchObject({
			project: 'Project One',
			url: repository,
			apiUrl: 'https://dev.azure.com/acme/Project%20One/_apis/git/repositories/notebooks',
		});
	});
	it.each([
		'http://dev.azure.com/acme/p/_git/r',
		'https://dev.azure.com.evil.test/acme/p/_git/r',
		'https://user:secret@dev.azure.com/acme/p/_git/r',
		'https://dev.azure.com/acme/p/_git/r?x=1',
		'https://dev.azure.com/acme/p/_git/r#x',
		'https://dev.azure.com/acme/p/_git/a%2Fb',
		'https://dev.azure.com/acme/p/_git/%ZZ',
		'https://dev.azure.com/other/p/_git/r',
		'https://server.test/collection/p/_git/r',
	])('rejects unsupported or unsafe URL %s', (value) => {
		expect(() => parseAzureRepository(value, 'acme')).toThrow();
		expect(setup().adapter.supportsRepository(value)).toBe(false);
	});
});

describe('Azure DevOps reader', () => {
	it('pins workspace reads to the resolved commit, scopes the subtree, and skips symlinks', async () => {
		const { fake, adapter, credential } = setup();
		expect(await adapter.getBranchHead(repository, 'main')).toEqual({ commit: fake.base });
		expect(await adapter.fetchWorkspace(repository, fake.base, 'apps')).toEqual([
			{ path: 'main.py', bytes: bytes('print(1)') },
		]);
		expect(
			(await adapter.fetchWorkspace(repository, fake.base, '')).map((file) => file.path),
		).toEqual(['apps/main.py', 'README.md']);
		expect(credential.getToken).toHaveBeenCalledWith(AZURE_DEVOPS_SCOPE, {
			abortSignal: expect.any(AbortSignal),
		});
		for (const [, init] of fake.fetcher.mock.calls) {
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
			expect(init?.redirect).toBe('error');
		}
	});
	it('does not confuse a branch-prefix match with an exact match', async () => {
		const { adapter, fake } = setup();
		fake.refs.delete('refs/heads/main');
		fake.refs.set('refs/heads/main-other', fake.base);
		await expect(adapter.getBranchHead(repository, 'main')).rejects.toBeInstanceOf(NotFoundError);
	});
	it('rejects unsafe paths before issuing requests', async () => {
		const { adapter, fake } = setup();
		await expect(adapter.fetchWorkspace(repository, fake.base, '../apps')).rejects.toBeInstanceOf(
			BadRequestError,
		);
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it('bounds streaming responses without trusting content-length', async () => {
		await expect(boundedBytes(new Response('too many bytes'), 2)).rejects.toBeInstanceOf(
			BadRequestError,
		);
	});
	it('rejects truncated trees', async () => {
		const { adapter, fake } = setup();
		fake.fetcher.mockImplementationOnce(async () =>
			Response.json({ commitId: fake.base, treeId: 'a'.repeat(40) }),
		);
		fake.fetcher.mockImplementationOnce(async () =>
			Response.json({ treeEntries: [], truncated: true }),
		);
		await expect(adapter.fetchWorkspace(repository, fake.base, '')).rejects.toThrow('incomplete');
	});
	it('rejects incorrect blob contents', async () => {
		const { adapter, fake } = setup();
		const original = fake.fetcher.getMockImplementation()!;
		fake.fetcher.mockImplementation((url, init) =>
			url.includes('/blobs/') ? Promise.resolve(new Response('wrong')) : original(url, init),
		);
		await expect(adapter.fetchWorkspace(repository, fake.base, 'apps')).rejects.toThrow(
			'different blob',
		);
	});
	it.each([401, 403])('maps HTTP %s without leaking provider errors', async (status) => {
		const { adapter, fake } = setup();
		fake.fetcher.mockImplementationOnce(async () => new Response('secret details', { status }));
		await expect(adapter.getBranchHead(repository, 'main')).rejects.toBeInstanceOf(ForbiddenError);
	});
	it('fails closed on redirects', async () => {
		const { adapter, fake } = setup();
		fake.fetcher.mockImplementationOnce(
			async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
		);
		await expect(adapter.getBranchHead(repository, 'main')).rejects.toThrow('302');
		expect(fake.fetcher).toHaveBeenCalledTimes(1);
	});
	it('reports credential failures as auth failures', async () => {
		const { adapter, credential, input, fake } = setup();
		credential.getToken.mockRejectedValueOnce(new Error('secret'));
		const error = await adapter.openChangeRequest(input).catch((error: unknown) => error);
		expect(sourceControlPublishFailure(error)).toMatchObject({
			stage: 'auth',
			provider: 'azure-devops',
		});
		expect(String(error)).not.toContain('secret');
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
});

describe('Azure DevOps publishing', () => {
	it('creates a draft PR with binary content and co-author attribution without changing the base branch', async () => {
		const { adapter, fake, input } = setup();
		const result = await adapter.openChangeRequest(input);
		expect(result).toMatchObject({
			number: 1,
			url: `${repository}/pullrequest/1`,
			headBranch: input.headBranch,
		});
		expect(fake.refs.get('refs/heads/main')).toBe(fake.base);
		expect(fake.pulls[0]).toMatchObject({
			isDraft: true,
			sourceRefName: 'refs/heads/hub/proposal-1',
			targetRefName: 'refs/heads/main',
		});
		expect(fake.commits.get(result.headCommit)!.files.get('data.bin')!.bytes).toEqual(
			Buffer.from([0, 255, 123]),
		);
		expect(fake.messages[0]).toContain('Co-authored-by: Alice <alice@example.com>');
	});
	it.each(['failPrOnce', 'failPushResponseOnce'] as const)(
		'recovers after %s without duplicate commits or PRs',
		async (failure) => {
			const { adapter, fake, input } = setup();
			fake[failure] = true;
			await expect(adapter.openChangeRequest(input)).rejects.toThrow('unavailable');
			const result = await adapter.openChangeRequest(input);
			expect(await adapter.openChangeRequest(input)).toEqual(result);
			expect(fake.messages).toHaveLength(1);
			expect(fake.pulls).toHaveLength(1);
		},
	);
	it('refuses to reuse a proposal branch containing unrelated changes', async () => {
		const { adapter, fake, input } = setup();
		const foreignFiles = new Map(fake.commits.get(fake.base)!.files);
		foreignFiles.set('foreign.py', { bytes: bytes('foreign changes'), mode: '100644' });
		const foreign = fake.commit(foreignFiles, [fake.base]);
		fake.refs.set(`refs/heads/${input.headBranch}`, foreign);
		await expect(adapter.openChangeRequest(input)).rejects.toBeInstanceOf(
			ProposalRetryRequiredError,
		);
		expect(fake.pulls).toHaveLength(0);
		expect(fake.messages).toHaveLength(0);
	});
	it('appends an update and reverts changes omitted from the new proposal', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		const updated = await adapter.updateChangeRequest({
			...input,
			changeRequest: first,
			changes: [{ path: 'README.md', operation: 'delete' }],
		});
		const commit = fake.commits.get(updated.headCommit)!;
		expect(commit.parents).toEqual([first.headCommit]);
		expect(commit.files.has('data.bin')).toBe(false);
		expect(commit.files.has('README.md')).toBe(false);
		expect(new TextDecoder().decode(commit.files.get('apps/main.py')!.bytes)).toBe('print(1)');
		expect(fake.pulls).toHaveLength(1);
	});
	it('recovers a lost update response and updates metadata', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		const update = {
			...input,
			title: 'Updated title',
			changeRequest: first,
			changes: [{ path: 'apps/main.py', operation: 'modify' as const, content: bytes('print(3)') }],
		};
		fake.failPushResponseOnce = true;
		await expect(adapter.updateChangeRequest(update)).rejects.toThrow('unavailable');
		const result = await adapter.updateChangeRequest(update);
		expect(fake.messages).toHaveLength(2);
		expect(fake.pulls[0].title).toBe('Updated title');
		expect(await adapter.updateChangeRequest(update)).toEqual(result);
	});
	it('does not create an extra commit for an unchanged proposal', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		expect(await adapter.updateChangeRequest({ ...input, changeRequest: first })).toEqual(first);
		expect(fake.messages).toHaveLength(1);
	});
	it.each(['deleted', 'changed', 'closed', 'race'] as const)(
		'rejects an update when the branch/PR is %s',
		async (state) => {
			const { adapter, fake, input } = setup();
			const first = await adapter.openChangeRequest(input);
			if (state === 'deleted') fake.refs.delete(`refs/heads/${input.headBranch}`);
			if (state === 'changed') fake.refs.set(`refs/heads/${input.headBranch}`, fake.base);
			if (state === 'closed') fake.pulls[0].status = 'completed';
			if (state === 'race') fake.racePush = true;
			await expect(
				adapter.updateChangeRequest({
					...input,
					changeRequest: first,
					changes: [{ path: 'README.md', operation: 'delete' }],
				}),
			).rejects.toBeInstanceOf(ConflictError);
			expect(fake.messages).toHaveLength(1);
		},
	);
	it('rejects writes to the tracked base branch', async () => {
		const { adapter, fake, input } = setup();
		await expect(adapter.openChangeRequest({ ...input, headBranch: 'main' })).rejects.toThrow(
			'differ',
		);
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it('rejects symlink edits', async () => {
		const { adapter, input } = setup();
		await expect(
			adapter.openChangeRequest({
				...input,
				changes: [{ path: 'link', operation: 'modify', content: bytes('new') }],
			}),
		).rejects.toThrow('symlinks');
	});
});

describe('Azure DevOps publication failures', () => {
	it.each(['../file.py', '.git/config', '/file.py', 'a//b', 'a\\b', ''])(
		'rejects unsafe proposal path %s before making requests',
		async (path) => {
			const { adapter, fake, input } = setup();
			await expect(
				adapter.openChangeRequest({
					...input,
					changes: [{ path, operation: 'add', content: bytes('new') }],
				}),
			).rejects.toThrow('proposal path');
			expect(fake.fetcher).not.toHaveBeenCalled();
		},
	);
	it.each(['../main', 'branch.lock', 'a@{b', 'a\nb', '-branch', 'a b', 'a//b'])(
		'rejects invalid branch %s before making requests',
		async (headBranch) => {
			const { adapter, fake, input } = setup();
			await expect(adapter.openChangeRequest({ ...input, headBranch })).rejects.toThrow(
				'branch name',
			);
			expect(fake.fetcher).not.toHaveBeenCalled();
		},
	);
	it('rejects duplicate paths before making requests', async () => {
		const { adapter, fake, input } = setup();
		await expect(
			adapter.openChangeRequest({ ...input, changes: [input.changes[0], input.changes[0]] }),
		).rejects.toThrow('duplicate');
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it.each([
		{ name: 'Alice\nCo-authored-by: Mallory', email: 'alice@example.com' },
		{ name: 'Alice', email: 'alice@example.com\nInjected: value' },
		{ name: 'Alice <Mallory>', email: 'alice@example.com' },
	])('rejects commit trailer injection: %j', async (coAuthor) => {
		const { adapter, fake, input } = setup();
		await expect(adapter.openChangeRequest({ ...input, coAuthor })).rejects.toThrow('co-author');
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it.each([
		[{ path: 'README.md', operation: 'add' as const, content: bytes('new') }],
		[{ path: 'missing.py', operation: 'modify' as const, content: bytes('new') }],
		[{ path: 'missing.py', operation: 'delete' as const }],
		[{ path: 'apps', operation: 'add' as const, content: bytes('new') }],
		[{ path: 'README.md/child', operation: 'add' as const, content: bytes('new') }],
	])('rejects changes incompatible with the base tree before writing', async (...changes) => {
		const { adapter, fake, input } = setup();
		await expect(adapter.openChangeRequest({ ...input, changes })).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(
			fake.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
		).toBe(true);
	});
	it('does not push or create a PR for content identical to the base', async () => {
		const { adapter, fake, input } = setup();
		await expect(
			adapter.openChangeRequest({
				...input,
				changes: [{ path: 'apps/main.py', operation: 'modify', content: bytes('print(1)') }],
			}),
		).rejects.toThrow('no changes');
		expect(fake.messages).toHaveLength(0);
		expect(fake.pulls).toHaveLength(0);
		expect(fake.refs.get('refs/heads/main')).toBe(fake.base);
		expect(fake.refs.has(`refs/heads/${input.headBranch}`)).toBe(false);
		expect(fake.fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
	});
	it('stops when Azure denies proposal branch creation', async () => {
		const { adapter, fake, input } = setup();
		const original = fake.fetcher.getMockImplementation()!;
		fake.fetcher.mockImplementation((url, init) =>
			url.includes('/refs?') && init?.method === 'POST'
				? Promise.resolve(
						Response.json({ value: [{ success: false, updateStatus: 'writePermissionRequired' }] }),
					)
				: original(url, init),
		);
		const error = await adapter.openChangeRequest(input).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(ConflictError);
		expect(sourceControlPublishFailure(error)).toMatchObject({ stage: 'branch' });
		expect(fake.refs.has(`refs/heads/${input.headBranch}`)).toBe(false);
		expect(fake.messages).toHaveLength(0);
		expect(fake.pulls).toHaveLength(0);
	});
	it.each(['base', 'foreign'] as const)(
		'handles a concurrent branch creation at %s without overwriting it',
		async (state) => {
			const { adapter, fake, input } = setup();
			const concurrent =
				state === 'base'
					? fake.base
					: fake.commit(new Map(fake.commits.get(fake.base)!.files), [fake.base]);
			const original = fake.fetcher.getMockImplementation()!;
			fake.fetcher.mockImplementation((url, init) => {
				if (url.includes('/refs?') && init?.method === 'POST')
					fake.refs.set(`refs/heads/${input.headBranch}`, concurrent);
				return original(url, init);
			});
			if (state === 'base') {
				await adapter.openChangeRequest(input);
				expect(fake.messages).toHaveLength(1);
				expect(fake.pulls).toHaveLength(1);
			} else {
				await expect(adapter.openChangeRequest(input)).rejects.toBeInstanceOf(
					ProposalRetryRequiredError,
				);
				expect(fake.refs.get(`refs/heads/${input.headBranch}`)).toBe(concurrent);
				expect(fake.messages).toHaveLength(0);
				expect(fake.pulls).toHaveLength(0);
			}
		},
	);
	it('recovers from a malformed push response without duplicating the applied commit', async () => {
		const { adapter, fake, input } = setup();
		const original = fake.fetcher.getMockImplementation()!;
		let corrupt = true;
		fake.fetcher.mockImplementation(async (url, init) => {
			const response = await original(url, init);
			if (url.includes('/pushes?') && corrupt) {
				corrupt = false;
				return Response.json({ commits: [] });
			}
			return response;
		});
		await expect(adapter.openChangeRequest(input)).rejects.toThrow('push result');
		expect(fake.pulls).toHaveLength(0);
		await adapter.openChangeRequest(input);
		expect(fake.messages).toHaveLength(1);
		expect(fake.pulls).toHaveLength(1);
	});
	it.each(['open', 'update'] as const)(
		'detects a branch moved after the %s push, before writing PR metadata',
		async (operation) => {
			const { adapter, fake, input } = setup();
			const first = operation === 'update' ? await adapter.openChangeRequest(input) : undefined;
			const original = fake.fetcher.getMockImplementation()!;
			const foreign = fake.commit(new Map(fake.commits.get(fake.base)!.files), []);
			fake.fetcher.mockImplementation(async (url, init) => {
				const response = await original(url, init);
				if (url.includes('/pushes?')) fake.refs.set(`refs/heads/${input.headBranch}`, foreign);
				return response;
			});
			const request = first
				? adapter.updateChangeRequest({
						...input,
						title: 'Must not be applied',
						changeRequest: first,
						changes: [{ path: 'README.md', operation: 'delete' }],
					})
				: adapter.openChangeRequest(input);
			const error = await request.catch((error: unknown) => error);
			expect(sourceControlPublishFailure(error)).toMatchObject({ condition: 'branch_changed' });
			expect(fake.refs.get(`refs/heads/${input.headBranch}`)).toBe(foreign);
			expect(fake.pulls).toHaveLength(first ? 1 : 0);
			if (first) expect(fake.pulls[0].title).toBe(input.title);
		},
	);
	it.each([{ number: 0 }, { number: 1.5 }, { url: 'https://evil.test/pullrequest/1' }])(
		'rejects an invalid saved PR identity before making requests: %j',
		async (override) => {
			const { adapter, fake, input } = setup();
			const first = await adapter.openChangeRequest(input);
			fake.fetcher.mockClear();
			await expect(
				adapter.updateChangeRequest({ ...input, changeRequest: { ...first, ...override } }),
			).rejects.toThrow('identity');
			expect(fake.fetcher).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ pullRequestId: 0 },
		{ pullRequestId: 2 },
		{ sourceRefName: 'refs/heads/other' },
		{ targetRefName: 'refs/heads/other' },
	])('rejects mismatched PR responses before modifying the branch: %j', async (override) => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		fake.fetcher.mockResolvedValueOnce(Response.json({ ...fake.pulls[0], ...override }));
		await expect(
			adapter.updateChangeRequest({
				...input,
				changeRequest: first,
				changes: [{ path: 'README.md', operation: 'delete' }],
			}),
		).rejects.toThrow('different pull request');
		expect(fake.messages).toHaveLength(1);
		expect(fake.refs.get(`refs/heads/${input.headBranch}`)).toBe(first.headCommit);
	});
	it('does not mistake matching content with the wrong parent for a completed retry', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		const foreign = fake.commit(new Map(fake.commits.get(first.headCommit)!.files), [fake.base]);
		fake.refs.set(`refs/heads/${input.headBranch}`, foreign);
		await expect(
			adapter.updateChangeRequest({ ...input, changeRequest: first }),
		).rejects.toBeInstanceOf(ConflictError);
		expect(fake.refs.get(`refs/heads/${input.headBranch}`)).toBe(foreign);
		expect(fake.messages).toHaveLength(1);
	});
	it('recovers a lost metadata update response without another commit or PR', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		const original = fake.fetcher.getMockImplementation()!;
		let fail = true;
		fake.fetcher.mockImplementation(async (url, init) => {
			const response = await original(url, init);
			if (init?.method === 'PATCH' && fail) {
				fail = false;
				throw new Error('Lost PATCH response');
			}
			return response;
		});
		const update = {
			...input,
			title: 'New title',
			changeRequest: first,
			changes: [{ path: 'README.md', operation: 'delete' as const }],
		};
		await expect(adapter.updateChangeRequest(update)).rejects.toThrow('unavailable');
		const result = await adapter.updateChangeRequest(update);
		expect(result.headCommit).toBe(fake.refs.get(`refs/heads/${input.headBranch}`));
		expect(fake.messages).toHaveLength(2);
		expect(fake.pulls).toHaveLength(1);
		expect(fake.pulls[0].title).toBe('New title');
	});
});

describe('Azure publication retries and errors', () => {
	it.each([undefined, { commitId: 'a'.repeat(40) }])(
		'recovers an active PR with missing or stale merge metadata: %j',
		async (lastMergeSourceCommit) => {
			const { adapter, fake, input } = setup();
			fake.failPrOnce = true;
			await expect(adapter.openChangeRequest(input)).rejects.toThrow('unavailable');
			fake.pulls[0].lastMergeSourceCommit = lastMergeSourceCommit;
			const result = await adapter.openChangeRequest(input);
			expect(result.number).toBe(1);
			expect(fake.messages).toHaveLength(1);
			expect(fake.pulls).toHaveLength(1);
		},
	);
	it('skips older unmatched PRs and recovers a later active candidate', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		fake.pulls.unshift({
			...fake.pulls[0],
			pullRequestId: 99,
			status: 'abandoned',
			lastMergeSourceCommit: { commitId: fake.base },
		});
		expect(await adapter.openChangeRequest(input)).toEqual(first);
		expect(fake.pulls).toHaveLength(2);
		expect(fake.messages).toHaveLength(1);
	});
	it('fails after all closed candidates mismatch without opening a duplicate PR', async () => {
		const { adapter, fake, input } = setup();
		await adapter.openChangeRequest(input);
		fake.pulls[0].status = 'abandoned';
		fake.pulls[0].lastMergeSourceCommit = { commitId: fake.base };
		await expect(adapter.openChangeRequest(input)).rejects.toBeInstanceOf(
			ProposalRetryRequiredError,
		);
		expect(fake.pulls).toHaveLength(1);
	});
	it('filters PR candidates by target as well as source', async () => {
		const { adapter, fake, input } = setup();
		await adapter.openChangeRequest(input);
		fake.pulls[0].targetRefName = 'refs/heads/other';
		const result = await adapter.openChangeRequest(input);
		expect(result.number).toBe(2);
		expect(fake.pulls).toHaveLength(2);
		expect(fake.messages).toHaveLength(1);
	});
	it('trims co-author names when formatting attribution', async () => {
		const { adapter, fake, input } = setup();
		await adapter.openChangeRequest({
			...input,
			coAuthor: { name: '  Alice  ', email: 'alice@example.com' },
		});
		expect(fake.messages[0]).toContain('Co-authored-by: Alice <alice@example.com>');
	});
	it.each([
		{ operation: 'open', endpoint: '/refs?', occurrence: 2, stage: 'branch' },
		{ operation: 'open', endpoint: '/refs?', occurrence: 3, stage: 'branch' },
		{ operation: 'open', endpoint: '/commits/', occurrence: 2, stage: 'push' },
		{ operation: 'update', endpoint: '/refs?', occurrence: 1, stage: 'branch' },
		{ operation: 'update', endpoint: '/refs?', occurrence: 2, stage: 'branch' },
		{ operation: 'update', endpoint: '/commits/', occurrence: 1, stage: 'push' },
		{ operation: 'update', endpoint: '/commits/', occurrence: 2, stage: 'push' },
		{ operation: 'update', endpoint: '/commits/', occurrence: 3, stage: 'push' },
		{ operation: 'update', endpoint: '/blobs/', occurrence: 1, stage: 'push' },
	])(
		'classifies $operation $endpoint read failure $occurrence as $stage',
		async ({ operation, endpoint, occurrence, stage }) => {
			const { adapter, fake, input } = setup();
			const first = operation === 'update' ? await adapter.openChangeRequest(input) : undefined;
			const original = fake.fetcher.getMockImplementation()!;
			let count = 0;
			fake.fetcher.mockImplementation((url, init) => {
				if (!init?.method && url.includes(endpoint) && ++count === occurrence)
					return Promise.reject(new Error('Transport failure'));
				return original(url, init);
			});
			const promise = first
				? adapter.updateChangeRequest({
						...input,
						changeRequest: first,
						changes: [{ path: 'README.md', operation: 'delete' }],
					})
				: adapter.openChangeRequest(input);
			const error = await promise.catch((error: unknown) => error);
			expect(sourceControlPublishFailure(error)).toMatchObject({ provider: 'azure-devops', stage });
		},
	);
});

describe('Azure DevOps commit casing', () => {
	function uppercaseResponses(fake: FakeAzure) {
		const original = fake.fetcher.getMockImplementation()!;
		fake.fetcher.mockImplementation(async (url, init) => {
			const response = await original(url, init);
			if (!response.headers.get('content-type')?.includes('application/json')) return response;
			return new Response(
				JSON.stringify(await response.json(), (_key, value: unknown) =>
					typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toUpperCase() : value,
				),
				{ status: response.status, headers: response.headers },
			);
		});
	}
	it('normalizes uppercase commit, tree, blob, and branch responses for workspace reads', async () => {
		const { adapter, fake } = setup();
		uppercaseResponses(fake);
		expect(await adapter.getBranchHead(repository, 'main')).toEqual({ commit: fake.base });
		expect(await adapter.fetchWorkspace(repository, fake.base.toUpperCase(), 'apps')).toEqual([
			{ path: 'main.py', bytes: bytes('print(1)') },
		]);
	});
	it.each([false, true])(
		'publishes and retries uppercase input commits with uppercase responses=%s',
		async (uppercase) => {
			const { adapter, fake, input } = setup();
			if (uppercase) uppercaseResponses(fake);
			const publication = Object.freeze({ ...input, baseCommit: fake.base.toUpperCase() });
			const first = await adapter.openChangeRequest(publication);
			expect(first.headCommit).toBe(fake.refs.get(`refs/heads/${input.headBranch}`));
			expect(await adapter.openChangeRequest(publication)).toEqual(first);
			const update = Object.freeze({
				...publication,
				changeRequest: Object.freeze({ ...first, headCommit: first.headCommit.toUpperCase() }),
				changes: [{ path: 'README.md', operation: 'delete' as const }],
			});
			const second = await adapter.updateChangeRequest(update);
			expect(second.headCommit).toBe(fake.refs.get(`refs/heads/${input.headBranch}`));
			expect(second.headCommit).not.toBe(first.headCommit);
			expect(await adapter.updateChangeRequest(update)).toEqual(second);
			expect(fake.messages).toHaveLength(2);
			expect(fake.pulls).toHaveLength(1);
			expect(publication.baseCommit).toBe(fake.base.toUpperCase());
			expect(update.changeRequest.headCommit).toBe(first.headCommit.toUpperCase());
		},
	);
	it('recovers a closed PR whose last merge source commit uses uppercase hex', async () => {
		const { adapter, fake, input } = setup();
		const first = await adapter.openChangeRequest(input);
		fake.pulls[0].status = 'completed';
		fake.pulls[0].lastMergeSourceCommit = { commitId: first.headCommit.toUpperCase() };
		expect(await adapter.openChangeRequest(input)).toEqual(first);
		expect(fake.messages).toHaveLength(1);
		expect(fake.pulls).toHaveLength(1);
	});
});

describe('Azure DevOps HTTP publication telemetry', () => {
	it.each([401, 403, 409, 503])('preserves HTTP %s through stage annotation', async (status) => {
		const { adapter, fake, input } = setup();
		fake.fetcher.mockImplementationOnce(async () => new Response('secret details', { status }));
		const error = await adapter.openChangeRequest(input).catch((error: unknown) => error);
		expect(sourceControlPublishFailure(error)).toMatchObject({
			provider: 'azure-devops',
			stage: 'push',
			status,
		});
		expect(String(error)).not.toContain('secret details');
	});
});

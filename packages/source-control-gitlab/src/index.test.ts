import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BadRequestError,
	ConflictError,
	NotFoundError,
	ProposalRetryRequiredError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { sourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type { OpenChangeRequestInput } from '@marimo-hub/core/ports/source-control';
import { GitLabSourceControl } from './index';
import { FakeGitLab, git, repository, token } from './testing/fakeGitLab';

const bytes = (text: string) => new TextEncoder().encode(text);
const fixtures: FakeGitLab[] = [];
afterEach(async () => {
	await Promise.all(
		fixtures.splice(0).map((fake) => rm(fake.dir, { recursive: true, force: true })),
	);
});
async function setup() {
	const fake = await FakeGitLab.create();
	fixtures.push(fake);
	const adapter = new GitLabSourceControl({ token }, { fetcher: fake.fetcher });
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
			{ path: 'README.md', operation: 'delete' },
		],
	};
	return { fake, adapter, input };
}

describe('GitLab reader', { timeout: 30_000 }, () => {
	it('reads a pinned subtree and skips symlinks', async () => {
		const { fake, adapter } = await setup();
		expect(await adapter.getBranchHead(repository, 'main')).toEqual({ commit: fake.base });
		expect(await adapter.fetchWorkspace(repository, fake.base.toUpperCase(), 'apps')).toEqual([
			{ path: 'main.py', bytes: bytes('print(1)') },
		]);
		expect(
			(await adapter.fetchWorkspace(repository, fake.base, '')).map((file) => file.path),
		).toEqual(['README.md', 'apps/main.py']);
		for (const [, init] of fake.fetcher.mock.calls) expect(init?.redirect).toBe('error');
	});
	it('rejects a Git redirect instead of following it', async () => {
		const { fake, adapter } = await setup();
		const real = fake.fetcher.getMockImplementation()!;
		fake.fetcher.mockImplementation((url, init) =>
			url.includes('.git/info/refs')
				? Promise.resolve(
						new Response(null, {
							status: 301,
							headers: { location: 'https://gitlab.com/team/moved.git/info/refs' },
						}),
					)
				: real(url, init),
		);
		await expect(adapter.fetchGitDirectory(repository, fake.base, 'main')).rejects.toBeInstanceOf(
			UnavailableError,
		);
		expect(fake.fetcher.mock.calls.filter(([url]) => url.includes('/moved.git'))).toHaveLength(0);
	});
	it('materializes a pinned Git directory without credentials', async () => {
		const { fake, adapter } = await setup();
		const files = await adapter.fetchGitDirectory(repository, fake.base.toUpperCase(), 'main');
		const config = files.find((file) => file.path === 'config');
		expect(config).toBeDefined();
		expect(new TextDecoder().decode(config!.bytes)).toContain(repository);
		expect(new TextDecoder().decode(config!.bytes)).not.toContain(token);
	});
	it('rejects missing branches and unsafe roots', async () => {
		const { fake, adapter } = await setup();
		await expect(adapter.getBranchHead(repository, 'missing')).rejects.toBeInstanceOf(
			NotFoundError,
		);
		fake.fetcher.mockClear();
		await expect(adapter.fetchWorkspace(repository, fake.base, '../apps')).rejects.toBeInstanceOf(
			BadRequestError,
		);
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it.each([
		{
			path: '../escape',
			mode: '100644',
			type: 'blob',
			error: 'Unsafe GitLab tree path',
		},
		{
			path: '.git/config',
			mode: '100644',
			type: 'blob',
			error: 'Unsafe GitLab tree path',
		},
		{ path: 'apps/main.py', mode: '999999', type: 'blob', error: 'Invalid GitLab tree entry' },
		{ path: 'apps/main.py', mode: '100644', type: 'tree', error: 'Invalid GitLab tree entry' },
	])(
		'rejects unsafe or inconsistent tree entries: $path $mode $type',
		async ({ error, ...entry }) => {
			const { fake, adapter } = await setup();
			const real = fake.fetcher.getMockImplementation()!;
			fake.fetcher.mockImplementation((url, init) =>
				url.includes('/repository/tree?')
					? Promise.resolve(Response.json([{ ...entry, id: 'a'.repeat(40) }]))
					: real(url, init),
			);
			await expect(adapter.fetchWorkspace(repository, fake.base, '')).rejects.toThrow(error);
		},
	);

	it('rejects a blob that does not match its object ID', async () => {
		const { fake, adapter } = await setup();
		const real = fake.fetcher.getMockImplementation()!;
		fake.fetcher.mockImplementation((url, init) =>
			url.endsWith('/raw?') ? Promise.resolve(new Response('wrong')) : real(url, init),
		);
		await expect(adapter.fetchWorkspace(repository, fake.base, 'apps')).rejects.toThrow(
			'different blob',
		);
	});
});

describe('GitLab publisher', { timeout: 30_000 }, () => {
	it('opens a draft MR with binary changes, executable modes, symlinks, and attribution', async () => {
		const { fake, adapter, input } = await setup();
		const result = await adapter.openChangeRequest({
			...input,
			baseCommit: input.baseCommit.toUpperCase(),
		});
		expect(result).toMatchObject({
			number: 1,
			url: `${repository}/-/merge_requests/1`,
			headBranch: input.headBranch,
		});
		expect(fake.head('main')).toBe(fake.base);
		expect(fake.head(input.headBranch)).toBe(result.headCommit);
		expect(git(fake.dir, ['show', `${result.headCommit}:data.bin`])).toEqual(
			Buffer.from([0, 255, 123]),
		);
		expect(git(fake.dir, ['ls-tree', '-r', result.headCommit]).toString()).toContain('100755 blob');
		expect(git(fake.dir, ['show', `${result.headCommit}:link`]).toString()).toBe('README.md');
		expect(git(fake.dir, ['show', '-s', '--format=%B', result.headCommit]).toString()).toContain(
			'Co-authored-by: Alice <alice@example.com>',
		);
		expect(fake.merges[0]).toMatchObject({ title: 'Draft: Update notebook', draft: true });
		expect(await adapter.openChangeRequest(input)).toEqual(result);
		expect(fake.merges).toHaveLength(1);
	});
	it('rejects no-op changes and symlink edits before writing', async () => {
		const { fake, adapter, input } = await setup();
		await expect(
			adapter.openChangeRequest({
				...input,
				changes: [{ path: 'apps/main.py', operation: 'modify', content: bytes('print(1)') }],
			}),
		).rejects.toThrow('no changes');
		await expect(
			adapter.openChangeRequest({ ...input, changes: [{ path: 'link', operation: 'delete' }] }),
		).rejects.toThrow('symlinks');
		expect(
			fake.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
		).toBe(true);
	});

	it('updates against the original base and restores omitted changes', async () => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		const update = {
			...input,
			changeRequest: { ...first, headCommit: first.headCommit.toUpperCase() },
			changes: [{ path: 'apps/main.py', operation: 'modify' as const, content: bytes('print(3)') }],
			title: 'Updated',
		};
		const second = await adapter.updateChangeRequest(update);
		expect(git(fake.dir, ['show', `${second.headCommit}:README.md`]).toString()).toBe('original');
		expect(() => git(fake.dir, ['show', `${second.headCommit}:data.bin`])).toThrow();
		expect(
			git(fake.dir, ['rev-parse', `${second.headCommit}^`])
				.toString()
				.trim(),
		).toBe(first.headCommit);
		expect(fake.merges[0]).toMatchObject({ title: 'Draft: Updated', sha: second.headCommit });
		expect(await adapter.updateChangeRequest(update)).toEqual(second);
		expect(await adapter.updateChangeRequest({ ...update, changeRequest: second })).toEqual(second);
	});
	it.each(['', '/1'])('refreshes MR commits when reading /merge_requests%s', async (suffix) => {
		const { fake, adapter, input } = await setup();
		await adapter.openChangeRequest(input);
		git(fake.dir, ['update-ref', `refs/heads/${input.headBranch}`, fake.base]);
		const query = new URLSearchParams({
			source_branch: input.headBranch,
			target_branch: input.baseBranch,
		});
		const response = await fake.fetcher(
			`https://gitlab.com/api/v4/projects/team%2Fsubgroup%2Fnotebooks/merge_requests${suffix}?${query}`,
			{ headers: { 'PRIVATE-TOKEN': token } },
		);
		const value = await response.json();
		expect(value).toMatchObject(suffix ? { sha: fake.base } : [{ sha: fake.base }]);
	});
	it.each(['closed', 'merged'])('retains the final diff head for a %s MR', async (state) => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		fake.merges[0].state = state;
		git(fake.dir, ['update-ref', `refs/heads/${input.headBranch}`, fake.base]);
		const path = 'https://gitlab.com/api/v4/projects/team%2Fsubgroup%2Fnotebooks/merge_requests';
		for (const method of ['GET', 'PUT']) {
			const response = await fake.fetcher(`${path}/1`, {
				method,
				headers: { 'PRIVATE-TOKEN': token },
				...(method === 'PUT' ? { body: JSON.stringify({ title: 'Updated metadata' }) } : {}),
			});
			expect(await response.json()).toHaveProperty('sha', first.headCommit);
		}
		const query = new URLSearchParams({
			source_branch: input.headBranch,
			target_branch: input.baseBranch,
		});
		const response = await fake.fetcher(`${path}?${query}`, {
			headers: { 'PRIVATE-TOKEN': token },
		});
		expect(await response.json()).toMatchObject([{ sha: first.headCommit }]);
	});
	it.each([false, true])(
		'preserves draft state after an external title change to draft=%s',
		async (draft) => {
			const { fake, adapter, input } = await setup();
			const first = await adapter.openChangeRequest({ ...input, draft: !draft });
			await fake.fetcher(
				'https://gitlab.com/api/v4/projects/team%2Fsubgroup%2Fnotebooks/merge_requests/1',
				{
					method: 'PUT',
					headers: { 'PRIVATE-TOKEN': token },
					body: JSON.stringify({ title: draft ? 'Draft: External title' : 'External title' }),
				},
			);
			expect(fake.merges[0].draft).toBe(draft);
			await adapter.updateChangeRequest({ ...input, changeRequest: first, title: 'Updated title' });
			expect(fake.merges[0]).toMatchObject({
				draft,
				title: draft ? 'Draft: Updated title' : 'Updated title',
			});
		},
	);
	it.each(['lostPush', 'lostMerge'] as const)(
		'recovers after %s without duplicate publication',
		async (failure) => {
			const { fake, adapter, input } = await setup();
			fake[failure] = true;
			await expect(adapter.openChangeRequest(input)).rejects.toThrow();
			const head = fake.head(input.headBranch);
			const result = await adapter.openChangeRequest(input);
			expect(result.headCommit).toBe(head);
			expect(fake.merges).toHaveLength(1);
		},
	);
	it('recovers an update after the push response is lost', async () => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		const update = {
			...input,
			changeRequest: first,
			changes: [{ path: 'apps/main.py', operation: 'modify' as const, content: bytes('print(3)') }],
		};
		fake.lostPush = true;
		await expect(adapter.updateChangeRequest(update)).rejects.toThrow();
		const head = fake.head(input.headBranch);
		expect((await adapter.updateChangeRequest(update)).headCommit).toBe(head);
	});
	it('does not reuse a branch with different contents', async () => {
		const { adapter, input } = await setup();
		await adapter.openChangeRequest(input);
		await expect(adapter.openChangeRequest({ ...input, changes: [] })).rejects.toThrow('requires');
		await expect(
			adapter.openChangeRequest({
				...input,
				changes: [{ path: 'apps/main.py', operation: 'modify', content: bytes('other') }],
			}),
		).rejects.toBeInstanceOf(ProposalRetryRequiredError);
	});
	it.each(['changed', 'deleted'])('rejects a %s proposal branch', async (condition) => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		git(
			fake.dir,
			condition === 'deleted'
				? ['update-ref', '-d', `refs/heads/${input.headBranch}`]
				: ['update-ref', `refs/heads/${input.headBranch}`, fake.base],
		);
		await expect(
			adapter.updateChangeRequest({ ...input, changeRequest: first }),
		).rejects.toBeInstanceOf(ConflictError);
	});
	it.each(['create', 'update'])(
		'fences a race after Git advertisement during %s',
		async (operation) => {
			const { fake, adapter, input } = await setup();
			const first = operation === 'update' ? await adapter.openChangeRequest(input) : undefined;
			fake.beforePush = () => {
				git(fake.dir, ['update-ref', `refs/heads/${input.headBranch}`, fake.base]);
			};
			const action = first
				? adapter.updateChangeRequest({
						...input,
						changeRequest: first,
						changes: [{ path: 'apps/main.py', operation: 'modify', content: bytes('print(3)') }],
					})
				: adapter.openChangeRequest(input);
			await expect(action).rejects.toBeInstanceOf(ConflictError);
			expect(fake.head(input.headBranch)).toBe(fake.base);
			expect(fake.merges).toHaveLength(first ? 1 : 0);
		},
	);
	it('accepts a canonical-case merge request URL for a mixed-case repository URL', async () => {
		const { fake, adapter, input } = await setup();
		const mixed = 'https://gitlab.com/Team/SubGroup/Notebooks';
		const result = await adapter.openChangeRequest({ ...input, repository: mixed });
		expect(fake.merges[0].web_url).toBe(`${repository}/-/merge_requests/1`);
		expect(result.url).toBe(`${mixed}/-/merge_requests/1`);
		const updated = await adapter.updateChangeRequest({
			...input,
			repository: mixed,
			title: 'Retitled',
			changeRequest: result,
		});
		expect(updated.number).toBe(1);
		fake.merges[0].web_url = 'https://gitlab.com/team/other/-/merge_requests/1';
		await expect(
			adapter.updateChangeRequest({ ...input, repository: mixed, changeRequest: result }),
		).rejects.toThrow('different merge request');
	});
	it('rejects closed or foreign merge requests before pushing', async () => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		fake.merges[0].source_project_id = 2;
		await expect(adapter.updateChangeRequest({ ...input, changeRequest: first })).rejects.toThrow(
			'different merge request',
		);
		fake.merges[0].source_project_id = 1;
		fake.merges[0].state = 'closed';
		await expect(adapter.updateChangeRequest({ ...input, changeRequest: first })).rejects.toThrow(
			'closed',
		);
		expect(fake.head(input.headBranch)).toBe(first.headCommit);
	});
	it.each([401, 403, 409, 503])('preserves publication failure status %s', async (status) => {
		const { fake, adapter, input } = await setup();
		fake.fetcher.mockImplementationOnce(async () => new Response('secret error', { status }));
		const error = await adapter.openChangeRequest(input).catch((error: unknown) => error);
		expect(sourceControlPublishFailure(error)).toMatchObject({
			provider: 'gitlab',
			stage: 'push',
			status,
		});
		expect(String(error)).not.toContain('secret error');
	});
	it.each(['branch', 'push', 'pr'] as const)(
		'recovers a %s-stage outage and reports the correct failure stage',
		async (stage) => {
			const { fake, adapter, input } = await setup();
			const real = fake.fetcher.getMockImplementation()!;
			fake.fetcher.mockImplementation((url, init) => {
				const fails =
					stage === 'branch'
						? url.includes('/repository/branches/')
						: stage === 'push'
							? url.endsWith('/git-receive-pack')
							: url.includes('/merge_requests?') && init?.method === 'POST';
				return fails
					? Promise.resolve(new Response('private upstream details', { status: 503 }))
					: real(url, init);
			});
			const error = await adapter.openChangeRequest(input).catch((error: unknown) => error);
			expect(sourceControlPublishFailure(error)).toMatchObject({
				provider: 'gitlab',
				stage,
				status: 503,
			});
			expect(fake.merges).toHaveLength(0);
			const published = stage === 'pr' ? fake.head(input.headBranch) : undefined;
			fake.fetcher.mockImplementation(real);
			const recovered = await adapter.openChangeRequest(input);
			if (published) expect(recovered.headCommit).toBe(published);
			expect(fake.merges).toHaveLength(1);
		},
	);
	it('retries lost MR-update responses without adding another commit', async () => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		const real = fake.fetcher.getMockImplementation()!;
		let loseResponse = true;
		fake.fetcher.mockImplementation(async (url, init) => {
			const response = await real(url, init);
			if (init?.method === 'PUT' && loseResponse) {
				loseResponse = false;
				throw new Error('Lost metadata response');
			}
			return response;
		});
		const { headBranch: _headBranch, draft: _draft, ...proposal } = input;
		const update = {
			...proposal,
			title: 'New title',
			changeRequest: first,
			changes: [{ path: 'apps/main.py', operation: 'modify' as const, content: bytes('print(3)') }],
		};
		await expect(adapter.updateChangeRequest(update)).rejects.toThrow();
		const head = fake.head(input.headBranch);
		expect((await adapter.updateChangeRequest(update)).headCommit).toBe(head);
		expect(fake.merges[0].title).toBe('Draft: New title');
		expect(fake.merges).toHaveLength(1);
	});
	it.each([
		{ number: 0, url: `${repository}/-/merge_requests/0` },
		{ number: 1.5, url: `${repository}/-/merge_requests/1.5` },
		{ number: 1, url: 'https://evil.test/-/merge_requests/1' },
		{ number: 1, url: `${repository}/-/merge_requests/2` },
	])('rejects invalid MR identity before any request: $url', async (identity) => {
		const { fake, adapter, input } = await setup();
		await expect(
			adapter.updateChangeRequest({
				...input,
				changeRequest: { ...identity, headBranch: input.headBranch, headCommit: fake.base },
			}),
		).rejects.toThrow('identity');
		expect(fake.fetcher).not.toHaveBeenCalled();
	});
	it.each(['closed', 'merged'])(
		'reuses a completed %s MR only when its commit matches',
		async (state) => {
			const { fake, adapter, input } = await setup();
			const first = await adapter.openChangeRequest({ ...input, draft: false });
			expect(fake.merges[0].draft).toBe(false);
			fake.merges[0].state = state;
			expect(await adapter.openChangeRequest(input)).toEqual(first);
			fake.merges[0].sha = fake.base;
			await expect(adapter.openChangeRequest(input)).rejects.toBeInstanceOf(
				ProposalRetryRequiredError,
			);
			expect(fake.merges).toHaveLength(1);
		},
	);
	it('rejects externally added history even when the final contents match', async () => {
		const { fake, adapter, input } = await setup();
		const first = await adapter.openChangeRequest(input);
		const tree = git(fake.dir, ['rev-parse', `${first.headCommit}^{tree}`])
			.toString()
			.trim();
		const child = git(fake.dir, [
			'commit-tree',
			tree,
			'-p',
			first.headCommit,
			'-m',
			'External change',
		])
			.toString()
			.trim();
		const head = git(fake.dir, ['commit-tree', tree, '-p', child, '-m', 'Another external change'])
			.toString()
			.trim();
		git(fake.dir, ['update-ref', `refs/heads/${input.headBranch}`, head]);
		await expect(
			adapter.updateChangeRequest({ ...input, changeRequest: first }),
		).rejects.toBeInstanceOf(ConflictError);
		expect(fake.head(input.headBranch)).toBe(head);
	});
});

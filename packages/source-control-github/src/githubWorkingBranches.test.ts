import { describe, expect, it, vi } from 'vitest';
import { ConflictError, UnavailableError } from '@marimo-hub/core/errors';
import { GitHubAppPublisher } from './index';
import { parseApiRequest, response, testPrivateKey } from './testing/fakeGitHub';

const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const later = 'c'.repeat(40);
const branch = 'marimohub/proj-abc/nb-def';
const coordinate = 'owner/repo';
const refInput = { repository: coordinate, branch, expectedHead: base, commit };
const prInput = {
	repository: coordinate,
	headBranch: branch,
	baseBranch: 'main',
	title: 'Notebook',
	body: '',
	draft: true,
};

function pull(overrides: Record<string, unknown> = {}, origin = 'https://github.com') {
	return {
		number: 17,
		html_url: `${origin}/owner/repo/pull/17`,
		state: 'open',
		merged: false,
		head: { ref: branch, sha: commit, repo: { full_name: coordinate } },
		base: { ref: 'main', sha: base, repo: { full_name: coordinate } },
		...overrides,
	};
}

function setup(
	handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
	origin = 'https://github.com',
) {
	const requests: { path: string; init: RequestInit }[] = [];
	const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
		const parsed = parseApiRequest(url, origin);
		if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
		if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'test-token' });
		requests.push({ path: parsed.pathname + parsed.search, init });
		return handler(parsed, init);
	});
	const publisher = new GitHubAppPublisher(
		{ appId: '123', privateKey: testPrivateKey(), url: origin },
		{ fetcher },
	);
	return { writer: publisher.workingBranches, requests, fetcher };
}

describe('GitHub working branches', () => {
	it.each([base, base.toUpperCase()])(
		'creates an absent branch at pinned commit %s',
		async (fromCommit) => {
			const { writer, requests } = setup(() => response({ object: { sha: base } }, 201));
			await expect(
				writer.createBranch({ repository: coordinate, branch, fromCommit }),
			).resolves.toEqual({ commit: base });
			expect(requests).toHaveLength(1);
			expect(requests[0]?.path).toBe('/repos/owner/repo/git/refs');
			expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
				ref: `refs/heads/${branch}`,
				sha: base,
			});
		},
	);

	it('rejects an existing branch even when it points at the requested commit', async () => {
		const { writer } = setup((_url, init) =>
			init.method === 'POST' ? response({}, 422) : response({ object: { sha: base } }),
		);
		await expect(
			writer.createBranch({ repository: coordinate, branch, fromCommit: base }),
		).rejects.toThrow('already exists');
	});

	it.each(['https://github.com', 'https://git.acme.corp'])(
		'uses exact non-force CAS on %s',
		async (origin) => {
			const { writer, requests } = setup(
				(url) =>
					url.pathname === '/graphql'
						? response({ data: { updateRefs: { clientMutationId: null } } })
						: response({ node_id: 'repository-node' }),
				origin,
			);
			await expect(
				writer.advanceBranch({
					...refInput,
					repository: `${origin}/${coordinate}`,
					expectedHead: base.toUpperCase(),
					commit: commit.toUpperCase(),
				}),
			).resolves.toEqual({ commit });
			expect(requests.map((r) => r.path)).toEqual(['/repos/owner/repo', '/graphql']);
			expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
				variables: {
					input: {
						refUpdates: [
							{ name: `refs/heads/${branch}`, beforeOid: base, afterOid: commit, force: false },
						],
					},
				},
			});
		},
	);

	it('does not retry a rejected CAS as a force update', async () => {
		const { writer, requests } = setup((url) =>
			url.pathname === '/graphql'
				? response({ errors: [{ message: 'Reference changed' }] })
				: response({ node_id: 'repository-node' }),
		);
		await expect(writer.advanceBranch(refInput)).rejects.toThrow('Could not confirm');
		expect(requests).toHaveLength(2);
	});

	it.each([
		['UNPROCESSABLE', 'Expected branch to point to the supplied beforeOid'],
		['FORBIDDEN', 'Changes must be made through a pull request'],
		['NOT_FOUND', 'Could not resolve the reference'],
	])('treats an explicit %s mutation rejection as a conflict', async (type, message) => {
		const { writer, requests } = setup((url) =>
			url.pathname === '/graphql'
				? response({
						data: { updateRefs: null },
						errors: [{ type, path: ['updateRefs'], message }],
					})
				: response({ node_id: 'repository-node' }),
		);
		await expect(writer.advanceBranch(refInput)).rejects.toBeInstanceOf(ConflictError);
		expect(requests.map((r) => r.path)).toEqual(['/repos/owner/repo', '/graphql']);
	});
	it.each([
		{ data: { updateRefs: null }, errors: [{ type: 'INTERNAL', path: ['updateRefs'] }] },
		{
			data: { updateRefs: null },
			errors: [
				{ type: 'UNPROCESSABLE', path: ['updateRefs'] },
				{ type: 'INTERNAL', path: ['updateRefs'] },
			],
		},
		{ data: { updateRefs: {} }, errors: [{ type: 'UNPROCESSABLE', path: ['updateRefs'] }] },
		{ errors: [{ type: 'UNPROCESSABLE', path: ['updateRefs'] }] },
		{ data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', path: ['anotherMutation'] }] },
		{ data: { updateRefs: null }, errors: [{ message: 'Reference changed' }] },
		{ data: { updateRefs: null } },
	])('keeps an ambiguous GraphQL response unresolved: %j', async (payload) => {
		const { writer, requests } = setup((url) =>
			url.pathname === '/graphql' ? response(payload) : response({ node_id: 'repository-node' }),
		);
		await expect(writer.advanceBranch(refInput)).rejects.toBeInstanceOf(UnavailableError);
		expect(requests).toHaveLength(2);
	});
	it('reconciles a lost CAS response through immutable ancestry inspection', async () => {
		let mutated = false;
		const { writer, requests } = setup((url) => {
			if (url.pathname === '/graphql') {
				mutated = true;
				throw new Error('Response lost');
			}
			if (url.pathname.includes('/git/ref/heads/'))
				return response({ object: { sha: mutated ? later : base } });
			if (url.pathname.includes('/compare/')) return response({ status: 'ahead' });
			if (url.pathname.endsWith('/pulls')) return response([]);
			return response({ node_id: 'repository-node' });
		});
		await expect(writer.advanceBranch(refInput)).rejects.toThrow('unavailable');
		await expect(writer.inspectBranch({ repository: coordinate, branch, commit })).resolves.toEqual(
			{ headCommit: later, containsCommit: true },
		);
		expect(requests.filter((r) => r.path === '/graphql')).toHaveLength(1);
		expect(requests.map((request) => request.path)).toContain(
			`/repos/owner/repo/compare/${commit}...${later}?per_page=1`,
		);
	});

	it.each(['behind', 'diverged'])(
		'does not confirm a commit when comparison is %s',
		async (status) => {
			const { writer } = setup((url) =>
				url.pathname.includes('/compare/')
					? response({ status })
					: url.pathname.endsWith('/pulls')
						? response([])
						: response({ object: { sha: later } }),
			);
			await expect(
				writer.inspectBranch({ repository: coordinate, branch, commit }),
			).resolves.toEqual({ headCommit: later, containsCommit: false });
		},
	);

	it('reports a missing branch without issuing an ancestry lookup', async () => {
		const { writer, requests } = setup((url) =>
			url.pathname.endsWith('/pulls') ? response([]) : response({}, 404),
		);
		await expect(writer.inspectBranch({ repository: coordinate, branch, commit })).resolves.toEqual(
			{ headCommit: null, containsCommit: false },
		);
		expect(requests.map((request) => request.path)).toEqual([
			`/repos/owner/repo/git/ref/heads/${branch}`,
			`/repos/owner/repo/pulls?state=all&head=owner%3Amarimohub%2Fproj-abc%2Fnb-def&per_page=100`,
		]);
	});

	it('finds the pull request after its head branch is deleted', async () => {
		const { writer } = setup((url) =>
			url.pathname.endsWith('/pulls') ? response([pull({ state: 'closed' })]) : response({}, 404),
		);
		await expect(writer.inspectBranch({ repository: coordinate, branch })).resolves.toMatchObject({
			headCommit: null,
			containsCommit: false,
			changeRequest: { number: 17, headBranch: branch, state: 'closed' },
		});
	});

	it('recognizes an uppercase requested commit without an ancestry lookup', async () => {
		const { writer, requests } = setup((url) =>
			url.pathname.endsWith('/pulls') ? response([]) : response({ object: { sha: base } }),
		);
		await expect(
			writer.inspectBranch({ repository: coordinate, branch, commit: base.toUpperCase() }),
		).resolves.toEqual({ headCommit: base, containsCommit: true });
		expect(requests.some(({ path }) => path.includes('/compare/'))).toBe(false);
	});

	it.each(['invalid-sha', '', 'a'.repeat(39)])(
		'rejects malformed provider commit %j as unavailable',
		async (sha) => {
			const { writer } = setup((url) => {
				if (url.pathname.endsWith(`/git/commits/${base}`))
					return response({ tree: { sha: 'tree-base' } });
				if (url.pathname.includes('/contents/')) return response({}, 404);
				if (url.pathname.endsWith('/git/blobs')) return response({ sha: 'blob-new' }, 201);
				if (url.pathname.endsWith('/git/trees')) return response({ sha: 'tree-new' }, 201);
				return response({ sha }, 201);
			});
			await expect(
				writer.prepareCommit({
					repository: coordinate,
					parentCommit: base,
					message: 'Save',
					changes: [
						{ operation: 'add', path: 'app.py', content: new TextEncoder().encode('print(1)') },
					],
				}),
			).rejects.toBeInstanceOf(UnavailableError);
		},
	);

	it('normalizes commit SHAs and prepares objects without touching a ref', async () => {
		const { writer, requests } = setup((url, init) => {
			if (url.pathname.endsWith(`/git/commits/${base}`))
				return response({ tree: { sha: 'tree-base' } });
			if (url.pathname.includes('/contents/')) return response({}, 404);
			if (url.pathname.endsWith('/git/blobs')) return response({ sha: 'blob-new' }, 201);
			if (url.pathname.endsWith('/git/trees')) return response({ sha: 'tree-new' }, 201);
			if (url.pathname.endsWith('/git/commits')) {
				expect(JSON.parse(String(init.body))).toEqual({
					message: 'Save analysis\n\nCo-authored-by: Ada <ada@example.com>',
					tree: 'tree-new',
					parents: [base],
				});
				return response({ sha: commit.toUpperCase() }, 201);
			}
			throw new Error(`Unexpected request ${url}`);
		});
		await expect(
			writer.prepareCommit({
				repository: coordinate,
				parentCommit: base.toUpperCase(),
				message: 'Save analysis',
				coAuthor: { name: 'Ada', email: 'ada@example.com' },
				changes: [
					{ operation: 'add', path: 'apps/new.py', content: new TextEncoder().encode('print(1)') },
				],
			}),
		).resolves.toEqual({ commit });
		expect(requests.some((r) => r.path.includes('/git/ref') || r.path === '/graphql')).toBe(false);
	});

	it('finds a PR after its create response was lost without opening another', async () => {
		let created = false;
		const { writer, requests } = setup((url, init) => {
			if (url.pathname.includes('/git/ref/heads/')) return response({ object: { sha: commit } });
			if (init.method === 'POST') {
				created = true;
				throw new Error('Response lost');
			}
			return response(created ? [pull()] : []);
		});
		await expect(writer.openBranchChangeRequest(prInput)).rejects.toThrow('unavailable');
		await expect(writer.openBranchChangeRequest(prInput)).resolves.toEqual({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: branch,
			headCommit: commit,
		});
		expect(requests.filter((r) => r.init.method === 'POST')).toHaveLength(1);
	});

	it('reuses a concurrently created PR after a validation conflict', async () => {
		let listed = false;
		const { writer } = setup((url, init) => {
			if (url.pathname.includes('/git/ref/heads/')) return response({ object: { sha: commit } });
			if (init.method === 'POST') return response({}, 422);
			const result = listed ? [pull()] : [];
			listed = true;
			return response(result);
		});
		await expect(writer.openBranchChangeRequest(prInput)).resolves.toMatchObject({ number: 17 });
	});

	it.each([
		['open', { state: 'open' }],
		['closed', { state: 'closed' }],
		['merged', { state: 'closed', merged: true }],
	] as const)('reports %s lifecycle without mutating the PR', async (state, overrides) => {
		const { writer, requests } = setup((url) =>
			url.pathname.includes('/pulls/')
				? response(pull(overrides))
				: response({ object: { sha: commit } }),
		);
		await expect(
			writer.inspectBranch({ repository: coordinate, branch, changeRequestNumber: 17 }),
		).resolves.toMatchObject({
			changeRequest: { state, number: 17, headBranch: branch, baseBranch: 'main' },
		});
		expect(requests.every((r) => !r.init.method || r.init.method === 'GET')).toBe(true);
	});

	it.each([
		{ state: 'closed', baseBranch: 'main', overrides: { state: 'closed' } },
		{
			state: 'merged',
			baseBranch: 'main',
			overrides: { state: 'closed', merged_at: '2026-11-10T00:00:00Z' },
		},
		{
			state: 'open',
			baseBranch: 'retargeted',
			overrides: { base: { ref: 'retargeted', repo: { full_name: coordinate } } },
		},
	])(
		'discovers $state PR lifecycle without a stored number',
		async ({ state, baseBranch, overrides }) => {
			const { writer, requests } = setup((url) =>
				url.pathname.endsWith('/pulls')
					? response([
							pull({ number: 18, html_url: 'https://github.com/owner/repo/pull/18' }),
							pull(overrides),
						])
					: response({ object: { sha: commit } }),
			);
			expect(await writer.inspectBranch({ repository: coordinate, branch })).toMatchObject({
				changeRequest: { number: 17, state, baseBranch },
			});
			const listing = new URL(`https://api.github.com${requests.at(-1)!.path}`);
			expect(listing.searchParams.get('state')).toBe('all');
			expect(listing.searchParams.get('head')).toBe(`owner:${branch}`);
			expect(listing.searchParams.has('base')).toBe(false);
			expect(
				requests.every((request) => !request.init.method || request.init.method === 'GET'),
			).toBe(true);
		},
	);

	it('fails closed when the bounded PR listing may be incomplete', async () => {
		const { writer } = setup((url) =>
			url.pathname.endsWith('/pulls')
				? response(Array.from({ length: 100 }, () => pull()))
				: response({ object: { sha: commit } }),
		);
		await expect(writer.inspectBranch({ repository: coordinate, branch })).rejects.toThrow(
			'Could not determine',
		);
	});

	it('rejects PRs moved to a different head branch', async () => {
		const { writer } = setup((url) =>
			url.pathname.includes('/pulls/')
				? response(pull({ head: { ref: 'other', sha: commit, repo: { full_name: coordinate } } }))
				: response({ object: { sha: commit } }),
		);
		await expect(
			writer.inspectBranch({ repository: coordinate, branch, changeRequestNumber: 17 }),
		).rejects.toThrow('no longer tracks');
	});

	it('rejects writes outside the namespace and abbreviated commits before accessing GitHub', async () => {
		const { writer, fetcher } = setup(() => response({}));
		await expect(
			writer.createBranch({ repository: coordinate, branch: 'main', fromCommit: base }),
		).rejects.toThrow('namespace');
		await expect(writer.advanceBranch({ ...refInput, expectedHead: 'abcdef1' })).rejects.toThrow(
			'full commit',
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

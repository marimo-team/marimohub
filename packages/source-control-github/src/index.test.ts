import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubAppPublisher } from './index';

const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs8', format: 'pem' })
	.toString();

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function publisher(
	fetcher: (url: string, init?: RequestInit) => Promise<Response>,
	now?: () => number,
) {
	return new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher, now });
}

const input = {
	repository: 'owner/repo',
	baseBranch: 'main',
	baseCommit: 'base-sha',
	headBranch: 'marimohub/nb-abc/prop-def',
	title: 'Update dashboard',
	body: 'Created by marimohub',
	draft: true,
	changes: [
		{
			path: 'apps/dashboard.py',
			operation: 'modify' as const,
			content: new TextEncoder().encode('print("after")'),
		},
	],
};

function proposalTreeResponse(parsed: URL, proposalHeads: readonly string[] = []): Response | null {
	if (parsed.pathname.endsWith('/pulls')) return response([]);
	if (parsed.pathname.endsWith('/git/commits/base-sha')) {
		return response({ tree: { sha: 'base-tree' } });
	}
	if (proposalHeads.some((sha) => parsed.pathname.endsWith(`/git/commits/${sha}`))) {
		return response({ tree: { sha: 'tree-sha' }, parents: [{ sha: 'base-sha' }] });
	}
	if (parsed.pathname.endsWith('/git/trees/base-tree')) {
		return response({
			sha: 'base-tree',
			tree: [
				{
					path: 'apps/dashboard.py',
					mode: '100644',
					type: 'blob',
					sha: 'old-blob-sha',
				},
			],
			truncated: false,
		});
	}
	if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'blob-sha' }, 201);
	if (parsed.pathname.endsWith('/git/trees')) return response({ sha: 'tree-sha' }, 201);
	return null;
}

describe('GitHubAppPublisher', () => {
	it('preserves executable mode while creating a draft pull request', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens'))
				return response({ token: 'installation-token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') return response([]);
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				expect(parsed.searchParams.get('recursive')).toBe('1');
				return response({
					sha: 'base-tree',
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100755',
							type: 'blob',
							sha: 'old-blob-sha',
						},
					],
					truncated: false,
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'blob-sha' }, 201);
			if (parsed.pathname.endsWith('/git/trees')) return response({ sha: 'tree-sha' }, 201);
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				return response({ sha: 'head-sha' }, 201);
			}
			if (parsed.pathname.endsWith('/git/refs')) {
				return response({ object: { sha: 'head-sha' } }, 201);
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'POST') {
				return response(
					{
						number: 17,
						html_url: 'https://github.com/owner/repo/pull/17',
						head: { sha: 'head-sha' },
					},
					201,
				);
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});
		const publisher = new GitHubAppPublisher(
			{
				appId: '123',
				privateKey: PRIVATE_KEY,
			},
			{
				fetcher,
				now: () => 1_700_000_000_000,
			},
		);

		await expect(publisher.openChangeRequest(input)).resolves.toEqual({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: input.headBranch,
			headCommit: 'head-sha',
		});

		const tokenCall = fetcher.mock.calls.find(([url]) => url.endsWith('/access_tokens'));
		expect(JSON.parse(String(tokenCall?.[1]?.body))).toEqual({
			repositories: ['repo'],
			permissions: { contents: 'write', pull_requests: 'write' },
		});
		const treeCall = fetcher.mock.calls.find(([url]) => url.endsWith('/git/trees'));
		expect(JSON.parse(String(treeCall?.[1]?.body))).toEqual({
			base_tree: 'base-tree',
			tree: [{ path: 'apps/dashboard.py', mode: '100755', type: 'blob', sha: 'blob-sha' }],
		});
		const pullCall = fetcher.mock.calls.find(
			([url, request]) => url.endsWith('/pulls') && request?.method === 'POST',
		);
		expect(JSON.parse(String(pullCall?.[1]?.body))).toEqual({
			title: 'Update dashboard',
			body: 'Created by marimohub',
			head: input.headBranch,
			base: 'main',
			draft: true,
		});
	});

	it('rejects a created pull request whose head moved before GitHub responded', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				return response({ sha: 'head-sha' }, 201);
			}
			if (parsed.pathname.endsWith('/git/refs')) {
				return response({ object: { sha: 'head-sha' } }, 201);
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'POST') {
				return response(
					{
						number: 17,
						html_url: 'https://github.com/owner/repo/pull/17',
						head: { sha: 'moved-head' },
					},
					201,
				);
			}
			const proposalResponse = proposalTreeResponse(parsed);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toMatchObject({
			code: 'CONFLICT',
		});
	});

	it.each([
		['a truncated base tree', { tree: [], truncated: true }, 'incomplete base tree'],
		['a missing modified file', { tree: [], truncated: false }, 'no file'],
		[
			'an invalid mode and type pair',
			{
				tree: [{ path: 'apps/dashboard.py', mode: '040000', type: 'blob' }],
				truncated: false,
			},
			'invalid base tree entry',
		],
	])('rejects %s before creating blobs', async (_label, baseTreePayload, message) => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/pulls')) return response([]);
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) return response(baseTreePayload);
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow(message);
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/blobs'))).toBe(false);
	});

	it('returns a closed pull request after verifying its proposal commit', async () => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				expect(parsed.searchParams.get('state')).toBe('all');
				return response([
					{
						number: 17,
						html_url: 'https://github.com/owner/repo/pull/17',
						head: { sha: 'existing-sha' },
						state: 'closed',
					},
				]);
			}
			const proposalResponse = proposalTreeResponse(parsed, ['existing-sha']);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});
		const publisher = new GitHubAppPublisher(
			{
				appId: '123',
				privateKey: PRIVATE_KEY,
			},
			{
				fetcher,
			},
		);

		await expect(publisher.openChangeRequest(input)).resolves.toMatchObject({
			number: 17,
			headCommit: 'existing-sha',
		});
		expect(fetcher).toHaveBeenCalledTimes(9);
	});

	it('recovers a merged pull request after GitHub deletes its head branch', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/pulls')) {
				expect(parsed.searchParams.get('state')).toBe('all');
				return response([
					{
						number: 21,
						html_url: 'https://github.com/owner/repo/pull/21',
						head: { sha: 'deleted-head-sha' },
						state: 'closed',
						merged_at: '2026-08-17T12:00:00Z',
					},
				]);
			}
			const proposalResponse = proposalTreeResponse(parsed, ['deleted-head-sha']);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).resolves.toMatchObject({
			number: 21,
			headCommit: 'deleted-head-sha',
		});
		expect(
			fetcher.mock.calls.some(
				([url, init]) => new URL(url).pathname.endsWith('/git/commits') && init?.method === 'POST',
			),
		).toBe(false);
		expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/git/refs'))).toBe(
			false,
		);
		expect(
			fetcher.mock.calls.some(
				([url, init]) => new URL(url).pathname.endsWith('/pulls') && init?.method === 'POST',
			),
		).toBe(false);
	});

	it('rejects a deleted-branch pull request whose recorded tree differs from the proposal', async () => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 21,
						html_url: 'https://github.com/owner/repo/pull/21',
						head: { sha: 'different-head-sha' },
						state: 'closed',
					},
				]);
			}
			if (parsed.pathname.endsWith('/git/commits/different-head-sha')) {
				return response({ tree: { sha: 'different-tree' }, parents: [{ sha: 'base-sha' }] });
			}
			const proposalResponse = proposalTreeResponse(parsed);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toMatchObject({
			code: 'PROPOSAL_RETRY_REQUIRED',
		});
		expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/git/refs'))).toBe(
			false,
		);
	});

	it.each([
		['a different parent', { tree: { sha: 'tree-sha' }, parents: [{ sha: 'other-base' }] }],
		['a different tree', { tree: { sha: 'other-tree' }, parents: [{ sha: 'base-sha' }] }],
		[
			'multiple parents',
			{
				tree: { sha: 'tree-sha' },
				parents: [{ sha: 'base-sha' }, { sha: 'merge-parent' }],
			},
		],
	])('rejects an existing proposal branch with %s', async (_label, commit) => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') return response([]);
			if (parsed.pathname.endsWith('/git/commits/existing-sha')) return response(commit);
			const proposalResponse = proposalTreeResponse(parsed);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toMatchObject({
			code: 'PROPOSAL_RETRY_REQUIRED',
		});
		expect(
			fetcher.mock.calls.some(
				([url, init]) => new URL(url).pathname.endsWith('/pulls') && init?.method === 'POST',
			),
		).toBe(false);
	});

	it.each([
		{},
		{ tree: { sha: 'tree-sha' } },
		{ tree: { sha: 'tree-sha' }, parents: [{}] },
		{ tree: {}, parents: [{ sha: 'base-sha' }] },
	])('rejects malformed existing proposal commit payload %j', async (commit) => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') return response([]);
			if (parsed.pathname.endsWith('/git/commits/existing-sha')) return response(commit);
			const proposalResponse = proposalTreeResponse(parsed);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
		});
	});

	it('rejects a non-GitHub repository before making a request', async () => {
		const fetcher = vi.fn();
		const publisher = new GitHubAppPublisher(
			{
				appId: '123',
				privateKey: PRIVATE_KEY,
			},
			{
				fetcher,
			},
		);

		await expect(
			publisher.openChangeRequest({ ...input, repository: 'https://gitlab.com/owner/repo' }),
		).rejects.toThrow('github.com');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects unsafe change paths before requesting a token', async () => {
		const fetcher = vi.fn();
		const publisher = new GitHubAppPublisher(
			{
				appId: '123',
				privateKey: PRIVATE_KEY,
			},
			{
				fetcher,
			},
		);

		await expect(
			publisher.openChangeRequest({
				...input,
				changes: [{ path: '../secrets', operation: 'delete' }],
			}),
		).rejects.toThrow('Invalid repository path');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects a non-numeric app id at construction', () => {
		expect(() => new GitHubAppPublisher({ appId: 'not-an-id', privateKey: PRIVATE_KEY })).toThrow(
			'must be a positive integer',
		);
	});

	it('rejects path-like repository owners before making a request', async () => {
		const fetcher = vi.fn();
		const publisher = new GitHubAppPublisher(
			{ appId: '123', privateKey: PRIVATE_KEY },
			{ fetcher },
		);

		await expect(publisher.openChangeRequest({ ...input, repository: '../repo' })).rejects.toThrow(
			'owner/repo',
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects a non-RSA private key at construction', () => {
		const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString();
		expect(() => new GitHubAppPublisher({ appId: '123', privateKey: ecKey })).toThrow(
			'must be RSA',
		);
	});

	it.each([
		'https://gitlab.com/owner/repo',
		'http://github.com/owner/repo',
		'https://user@github.com/owner/repo',
		'https://github.com:444/owner/repo',
		'https://github.com/owner/repo?tab=readme',
		'https://github.com/owner/repo#readme',
		'owner/repo/extra',
		'owner-/repo',
		'owner/.',
		'/repo',
	])('rejects unsafe repository coordinate %s before network access', async (repository) => {
		const fetcher = vi.fn();
		await expect(publisher(fetcher).openChangeRequest({ ...input, repository })).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		'',
		'-main',
		'/main',
		'main/',
		'feature//one',
		'feature/../main',
		'.hidden/main',
		'feature.lock',
		'feature.',
		'@',
		'feature@{one}',
		'feature one',
		'feature~one',
		'feature^one',
		'feature:one',
		'feature?one',
		'feature*one',
		'feature[one',
		'feature\\one',
	])('rejects invalid branch name %j before requesting a token', async (branch) => {
		const fetcher = vi.fn();
		await expect(
			publisher(fetcher).openChangeRequest({ ...input, headBranch: branch }),
		).rejects.toThrow('Invalid GitHub branch name');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(['feature+one', 'release@2026', 'topic#1', 'δοκιμή', 'a'.repeat(256)])(
		'accepts valid Git branch name %j',
		async (branch) => {
			const fetcher = vi.fn(async () => response({}, 404));
			await expect(
				publisher(fetcher).openChangeRequest({ ...input, baseBranch: branch }),
			).rejects.toThrow('not installed');
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);

	it.each([
		['no changes', []],
		[
			'duplicate paths',
			[...input.changes, { path: input.changes[0].path, operation: 'delete' as const }],
		],
		['an absolute path', [{ path: '/dashboard.py', operation: 'delete' as const }]],
		['a traversal path', [{ path: 'apps/../secret', operation: 'delete' as const }]],
		['a backslash path', [{ path: 'apps\\secret', operation: 'delete' as const }]],
	])('rejects %s before requesting a token', async (_label, changes) => {
		const fetcher = vi.fn();
		await expect(publisher(fetcher).openChangeRequest({ ...input, changes })).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects a runtime-invalid change operation before network access', async () => {
		const fetcher = vi.fn();
		const changes = [
			{ path: 'dashboard.py', operation: 'rename', content: new Uint8Array([1]) },
		] as unknown as typeof input.changes;
		await expect(publisher(fetcher).openChangeRequest({ ...input, changes })).rejects.toThrow(
			'Invalid operation',
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects missing runtime content before network access', async () => {
		const fetcher = vi.fn();
		const changes = [
			{ path: 'dashboard.py', operation: 'modify' },
		] as unknown as typeof input.changes;
		await expect(publisher(fetcher).openChangeRequest({ ...input, changes })).rejects.toThrow(
			'Missing content',
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		['a non-string repository', { repository: 123 }],
		['a non-string branch', { baseBranch: null }],
		['an empty base commit', { baseCommit: '' }],
		['a blank title', { title: '   ' }],
		['a non-string body', { body: null }],
		['a non-boolean draft flag', { draft: 'yes' }],
		['a null change', { changes: [null] }],
	])('rejects runtime-invalid request field: %s', async (_label, override) => {
		const fetcher = vi.fn();
		const request = { ...input, ...override } as unknown as typeof input;
		await expect(publisher(fetcher).openChangeRequest(request)).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('accepts an HTTPS repository URL with a .git suffix', async () => {
		const fetcher = vi.fn(async (url: string) => {
			expect(new URL(url).pathname).toBe('/repos/owner/repo/installation');
			return response({}, 404);
		});
		await expect(
			publisher(fetcher).openChangeRequest({
				...input,
				repository: 'HTTPS://github.com/owner/repo.git/',
			}),
		).rejects.toThrow('not installed');
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('reports an app installation miss without trying to mint a token', async () => {
		const fetcher = vi.fn(async () => response({ message: 'secret details' }, 404));
		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow(
			'The GitHub App is not installed for owner/repo',
		);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('does not expose a GitHub error response body', async () => {
		const fetcher = vi.fn(async () => response({ message: 'sensitive upstream detail' }, 500));
		let thrown: unknown;
		try {
			await publisher(fetcher).openChangeRequest(input);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe('GitHub request failed with status 500');
		expect((thrown as Error).message).not.toContain('sensitive');
	});

	it('maps a network exception to a provider availability error', async () => {
		const fetcher = vi.fn(async () => {
			throw new Error('socket included a credential');
		});
		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow(
			'GitHub is unavailable',
		);
	});

	it('rejects invalid JSON from GitHub', async () => {
		const fetcher = vi.fn(async () => new Response('<html>oops</html>'));
		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow(
			'GitHub returned invalid JSON',
		);
	});

	it.each([
		['a missing installation id', {}],
		['a string installation id', { id: '42' }],
		['a zero installation id', { id: 0 }],
	])('rejects %s returned by GitHub', async (_label, installation) => {
		const fetcher = vi.fn(async () => response(installation));
		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow('invalid id');
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it.each([{}, { token: '' }, { token: 123 }])(
		'rejects invalid installation token payload %j',
		async (tokenPayload) => {
			const fetcher = vi.fn(async (url: string) =>
				url.endsWith('/installation') ? response({ id: 42 }) : response(tokenPayload),
			);
			await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow('invalid token');
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);

	it('rejects an invalid injected clock before network access', async () => {
		const fetcher = vi.fn();
		await expect(publisher(fetcher, () => Number.NaN).openChangeRequest(input)).rejects.toThrow(
			'clock is invalid',
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('rejects a malformed pull list instead of creating a duplicate pull request', async () => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls')) return response({ number: 17 });
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});
		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow('invalid pull list');
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it.each([
		'https://github.com:444/owner/repo/pull/17',
		'https://github.com/owner/repo/pull/17?token=oops',
		'https://github.com/other/repo/pull/17',
		'https://gitlab.com/owner/repo/pull/17',
	])('rejects unexpected existing pull request URL %s', async (htmlUrl) => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([{ number: 17, html_url: htmlUrl, head: { sha: 'existing-sha' } }]);
			}
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});
		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toThrow(
			'unexpected pull request URL',
		);
	});

	it('rejects zero as an app id', () => {
		expect(() => new GitHubAppPublisher({ appId: '0', privateKey: PRIVATE_KEY })).toThrow(
			'positive integer',
		);
	});

	it('accepts a base64-encoded RSA private key', () => {
		expect(
			() =>
				new GitHubAppPublisher({
					appId: '123',
					privateKey: Buffer.from(PRIVATE_KEY).toString('base64'),
				}),
		).not.toThrow();
	});

	it('creates a pull request when a proposal branch exists without one', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls') && (init?.method ?? 'GET') === 'GET') {
				return response([]);
			}
			if (parsed.pathname.endsWith('/pulls') && init?.method === 'POST') {
				return response(
					{
						number: 17,
						html_url: 'https://github.com/owner/repo/pull/17',
						head: { sha: 'existing-sha' },
					},
					201,
				);
			}
			const proposalResponse = proposalTreeResponse(parsed, ['existing-sha']);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).resolves.toMatchObject({
			number: 17,
			headCommit: 'existing-sha',
		});
		expect(fetcher).toHaveBeenCalledTimes(10);
	});

	it('recovers when another request creates the branch first', async () => {
		let refReads = 0;
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				refReads++;
				return refReads === 1 ? response({}, 404) : response({ object: { sha: 'raced-head-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') return response([]);
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					sha: 'base-tree',
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'old-blob-sha',
						},
					],
					truncated: false,
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'blob-sha' }, 201);
			if (parsed.pathname.endsWith('/git/trees')) return response({ sha: 'tree-sha' }, 201);
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				return response({ sha: 'our-head-sha' }, 201);
			}
			if (parsed.pathname.endsWith('/git/refs')) return response({ message: 'exists' }, 422);
			if (parsed.pathname.endsWith('/git/commits/raced-head-sha')) {
				return response({ tree: { sha: 'tree-sha' }, parents: [{ sha: 'base-sha' }] });
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'POST') {
				return response(
					{
						number: 18,
						html_url: 'https://github.com/owner/repo/pull/18',
						head: { sha: 'raced-head-sha' },
					},
					201,
				);
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).resolves.toMatchObject({
			number: 18,
			headCommit: 'raced-head-sha',
		});
		expect(refReads).toBe(2);
	});

	it('rejects a mismatched proposal branch that wins the create-ref race', async () => {
		let refReads = 0;
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				refReads++;
				return refReads === 1 ? response({}, 404) : response({ object: { sha: 'attacker-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') return response([]);
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'old-blob-sha',
						},
					],
					truncated: false,
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'blob-sha' }, 201);
			if (parsed.pathname.endsWith('/git/trees')) return response({ sha: 'tree-sha' }, 201);
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				return response({ sha: 'our-head-sha' }, 201);
			}
			if (parsed.pathname.endsWith('/git/refs')) return response({ message: 'exists' }, 422);
			if (parsed.pathname.endsWith('/git/commits/attacker-sha')) {
				return response({ tree: { sha: 'attacker-tree' }, parents: [{ sha: 'base-sha' }] });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).rejects.toMatchObject({
			code: 'PROPOSAL_RETRY_REQUIRED',
		});
		expect(refReads).toBe(2);
		expect(
			fetcher.mock.calls.some(
				([url, init]) => new URL(url).pathname.endsWith('/pulls') && init?.method === 'POST',
			),
		).toBe(false);
	});

	it('recovers when another request creates and closes the pull request first', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'existing-head' } });
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') {
				expect(parsed.searchParams.get('state')).toBe('all');
				const pullPosts = fetcher.mock.calls.filter(
					([calledUrl, calledInit]) =>
						new URL(calledUrl).pathname.endsWith('/pulls') && calledInit?.method === 'POST',
				);
				return pullPosts.length === 0
					? response([])
					: response([
							{
								number: 19,
								html_url: 'https://github.com/owner/repo/pull/19',
								head: { sha: 'existing-head' },
								state: 'closed',
							},
						]);
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'POST') {
				return response({ message: 'already exists' }, 422);
			}
			const proposalResponse = proposalTreeResponse(parsed, ['existing-head']);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).resolves.toMatchObject({
			number: 19,
			headCommit: 'existing-head',
		});
		expect(fetcher).toHaveBeenCalledTimes(11);
	});

	it('renders delete changes as null tree entries without creating blobs', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/pulls') && method === 'GET') return response([]);
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					sha: 'base-tree',
					tree: [
						{
							path: 'apps/old.py',
							mode: '100755',
							type: 'blob',
							sha: 'old-blob-sha',
						},
					],
					truncated: false,
				});
			}
			if (parsed.pathname.endsWith('/git/trees')) return response({ sha: 'tree-sha' }, 201);
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				return response({ sha: 'head-sha' }, 201);
			}
			if (parsed.pathname.endsWith('/git/refs')) {
				return response({ object: { sha: 'head-sha' } }, 201);
			}
			if (parsed.pathname.endsWith('/pulls') && method === 'POST') {
				return response(
					{
						number: 20,
						html_url: 'https://github.com/owner/repo/pull/20',
						head: { sha: 'head-sha' },
					},
					201,
				);
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});
		await publisher(fetcher).openChangeRequest({
			...input,
			changes: [{ path: 'apps/old.py', operation: 'delete' }],
		});
		const treeCall = fetcher.mock.calls.find(([url]) => url.endsWith('/git/trees'));
		expect(JSON.parse(String(treeCall?.[1]?.body))).toEqual({
			base_tree: 'base-tree',
			tree: [{ path: 'apps/old.py', mode: '100755', type: 'blob', sha: null }],
		});
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/blobs'))).toBe(false);
	});
});

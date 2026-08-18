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
	coAuthor: { name: 'Ada Lovelace', email: 'ada@example.com' },
	changes: [
		{
			path: 'apps/dashboard.py',
			operation: 'modify' as const,
			content: new TextEncoder().encode('print("after")'),
		},
	],
};

const updateInput = {
	repository: input.repository,
	baseBranch: input.baseBranch,
	baseCommit: input.baseCommit,
	changeRequest: {
		number: 17,
		url: 'https://github.com/owner/repo/pull/17',
		headBranch: input.headBranch,
		headCommit: 'existing-head',
	},
	title: 'Update dashboard again',
	body: 'A later notebook proposal',
	coAuthor: input.coAuthor,
	changes: input.changes,
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

function pullRequestMetadataResponse(
	parsed: URL,
	init: RequestInit | undefined,
	headCommit: string,
): Response | null {
	if (
		parsed.pathname !== `/repos/owner/repo/pulls/${updateInput.changeRequest.number}` ||
		init?.method !== 'PATCH'
	) {
		return null;
	}
	expect(JSON.parse(String(init.body))).toEqual({
		title: updateInput.title,
		body: updateInput.body,
	});
	return response({
		number: updateInput.changeRequest.number,
		html_url: updateInput.changeRequest.url,
		title: updateInput.title,
		body: updateInput.body,
		head: { sha: headCommit },
	});
}

describe('GitHubAppPublisher', () => {
	it('appends a commit to an existing open pull request', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			const metadataResponse = pullRequestMetadataResponse(parsed, init, 'appended-head');
			if (metadataResponse) return metadataResponse;
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'existing-head' },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: 'existing-head' } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'existing-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/existing-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'old-blob',
						},
					],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				return response({ sha: 'append-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				expect(JSON.parse(String(init?.body))).toEqual({
					message:
						'Update dashboard again\n\nA later notebook proposal\n\nCo-authored-by: Ada Lovelace <ada@example.com>',
					tree: 'append-tree',
					parents: ['existing-head'],
				});
				return response({ sha: 'appended-head' }, 201);
			}
			if (parsed.pathname.includes('/git/refs/heads/') && method === 'PATCH') {
				const body = JSON.parse(String(init?.body));
				expect(body).toEqual({ sha: 'appended-head', force: false });
				return response({ object: { sha: 'appended-head' } });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).resolves.toEqual({
			...updateInput.changeRequest,
			headCommit: 'appended-head',
		});
		expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/graphql'))).toBe(false);
	});

	it('retries the metadata patch without creating another commit', async () => {
		let ref = 'existing-head';
		let commitCount = 0;
		let metadataPatchCount = 0;
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (
				parsed.pathname === `/repos/owner/repo/pulls/${updateInput.changeRequest.number}` &&
				method === 'PATCH'
			) {
				metadataPatchCount += 1;
				expect(JSON.parse(String(init?.body))).toEqual({
					title: updateInput.title,
					body: updateInput.body,
				});
				return metadataPatchCount === 1
					? response({ message: 'temporarily unavailable' }, 503)
					: response({
							number: updateInput.changeRequest.number,
							html_url: updateInput.changeRequest.url,
							title: updateInput.title,
							body: updateInput.body,
							head: { sha: 'appended-head' },
						});
			}
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: ref },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: ref } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'existing-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/existing-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'old-blob',
						},
					],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				return response({ sha: 'append-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				commitCount += 1;
				return response({ sha: 'appended-head' }, 201);
			}
			if (parsed.pathname.includes('/git/refs/heads/') && method === 'PATCH') {
				ref = 'appended-head';
				return response({ object: { sha: ref } });
			}
			if (parsed.pathname.endsWith('/git/commits/appended-head')) {
				return response({ tree: { sha: 'append-tree' }, parents: [{ sha: 'existing-head' }] });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		const github = publisher(fetcher);
		await expect(github.updateChangeRequest(updateInput)).rejects.toThrow(
			'GitHub request failed with status 503',
		);
		await expect(github.updateChangeRequest(updateInput)).resolves.toEqual({
			...updateInput.changeRequest,
			headCommit: 'appended-head',
		});
		expect(commitCount).toBe(1);
		expect(metadataPatchCount).toBe(2);
	});

	it('force-replaces an owned branch when its current tree cannot accept the update', async () => {
		let ref = 'existing-head';
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			const metadataResponse = pullRequestMetadataResponse(parsed, init, 'replacement-head');
			if (metadataResponse) return metadataResponse;
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: ref },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: ref } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'incompatible-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/incompatible-tree')) {
				return response({ truncated: false, tree: [] });
			}
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'base-blob',
						},
					],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				return response({ sha: 'replacement-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				expect(JSON.parse(String(init?.body))).toMatchObject({ parents: ['base-sha'] });
				return response({ sha: 'replacement-head' }, 201);
			}
			if (parsed.pathname === '/repos/owner/repo') return response({ node_id: 'repo-node' });
			if (parsed.pathname === '/graphql') {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					variables: {
						input: {
							repositoryId: 'repo-node',
							refUpdates: [
								{
									name: `refs/heads/${updateInput.changeRequest.headBranch}`,
									beforeOid: 'existing-head',
									afterOid: 'replacement-head',
									force: true,
								},
							],
						},
					},
				});
				ref = 'replacement-head';
				return response({ data: { updateRefs: { clientMutationId: null } } });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).resolves.toEqual({
			...updateInput.changeRequest,
			headCommit: 'replacement-head',
		});
	});

	it('does not report success when the conditional force update loses its race', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'existing-head' },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: 'existing-head' } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'incompatible-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/incompatible-tree')) {
				return response({ truncated: false, tree: [] });
			}
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'base-blob',
						},
					],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				return response({ sha: 'replacement-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				return response({ sha: 'replacement-head' }, 201);
			}
			if (parsed.pathname === '/repos/owner/repo') return response({ node_id: 'repo-node' });
			if (parsed.pathname === '/graphql') {
				return response({
					data: { updateRefs: null },
					errors: [{ message: 'beforeOid does not match' }],
				});
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).rejects.toThrow(
			'branch changed while updating',
		);
	});

	it('recovers an appended update after its publication record failed', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			const metadataResponse = pullRequestMetadataResponse(parsed, init, 'appended-head');
			if (metadataResponse) return metadataResponse;
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'appended-head' },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: 'appended-head' } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'existing-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/existing-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'old-blob',
						},
					],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				return response({ sha: 'append-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits/appended-head')) {
				return response({ tree: { sha: 'append-tree' }, parents: [{ sha: 'existing-head' }] });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).resolves.toEqual({
			...updateInput.changeRequest,
			headCommit: 'appended-head',
		});
		expect(
			fetcher.mock.calls.some(
				([url, init]) => String(url).includes('/git/refs/heads/') && init?.method === 'PATCH',
			),
		).toBe(false);
	});

	it('falls back to a conditional force update when GitHub rejects the fast-forward', async () => {
		let ref = 'existing-head';
		let treeCount = 0;
		let commitCount = 0;
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			const metadataResponse = pullRequestMetadataResponse(parsed, init, 'replacement-head');
			if (metadataResponse) return metadataResponse;
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: ref },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: ref } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'existing-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/existing-tree')) {
				return response({
					truncated: false,
					tree: [{ path: 'apps/dashboard.py', mode: '100755', type: 'blob', sha: 'old-blob' }],
				});
			}
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					truncated: false,
					tree: [{ path: 'apps/dashboard.py', mode: '100755', type: 'blob', sha: 'base-blob' }],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				treeCount += 1;
				expect(JSON.parse(String(init?.body))).toMatchObject({
					tree: [{ path: 'apps/dashboard.py', mode: '100755' }],
				});
				return response({ sha: treeCount === 1 ? 'append-tree' : 'replacement-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits') && method === 'POST') {
				commitCount += 1;
				return response({ sha: commitCount === 1 ? 'append-head' : 'replacement-head' }, 201);
			}
			if (parsed.pathname.includes('/git/refs/heads/') && method === 'PATCH') {
				expect(JSON.parse(String(init?.body))).toEqual({ sha: 'append-head', force: false });
				return response({ message: 'Update is not a fast forward' }, 422);
			}
			if (parsed.pathname === '/repos/owner/repo') return response({ node_id: 'repo-node' });
			if (parsed.pathname === '/graphql') {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					variables: {
						input: {
							refUpdates: [
								{
									beforeOid: 'existing-head',
									afterOid: 'replacement-head',
									force: true,
								},
							],
						},
					},
				});
				ref = 'replacement-head';
				return response({ data: { updateRefs: { clientMutationId: null } } });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).resolves.toEqual({
			...updateInput.changeRequest,
			headCommit: 'replacement-head',
		});
		expect(treeCount).toBe(2);
		expect(commitCount).toBe(2);
	});

	it('recovers a completed force replacement without moving the branch again', async () => {
		let treeCount = 0;
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			const metadataResponse = pullRequestMetadataResponse(parsed, init, 'replacement-head');
			if (metadataResponse) return metadataResponse;
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'replacement-head' },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: 'replacement-head' } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'existing-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/existing-tree')) {
				return response({
					truncated: false,
					tree: [{ path: 'apps/dashboard.py', mode: '100644', type: 'blob', sha: 'old-blob' }],
				});
			}
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					truncated: false,
					tree: [{ path: 'apps/dashboard.py', mode: '100644', type: 'blob', sha: 'base-blob' }],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				treeCount += 1;
				return response({ sha: treeCount === 1 ? 'append-tree' : 'replacement-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits/replacement-head')) {
				return response({ tree: { sha: 'replacement-tree' }, parents: [{ sha: 'base-sha' }] });
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).resolves.toEqual({
			...updateInput.changeRequest,
			headCommit: 'replacement-head',
		});
		expect(treeCount).toBe(2);
		expect(
			fetcher.mock.calls.some(
				([url, init]) =>
					String(url).endsWith('/graphql') ||
					(String(url).includes('/git/refs/heads/') && init?.method === 'PATCH'),
			),
		).toBe(false);
	});

	it('rejects an update when the pull request branch moved outside marimohub', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const method = init?.method ?? 'GET';
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'external-head' },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/') && method === 'GET') {
				return response({ object: { sha: 'external-head' } });
			}
			if (parsed.pathname.endsWith('/git/commits/existing-head')) {
				return response({ tree: { sha: 'existing-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/existing-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'old-blob',
						},
					],
				});
			}
			if (parsed.pathname.endsWith('/git/blobs')) return response({ sha: 'new-blob' }, 201);
			if (parsed.pathname.endsWith('/git/trees') && method === 'POST') {
				return response({ sha: 'append-tree' }, 201);
			}
			if (parsed.pathname.endsWith('/git/commits/external-head')) {
				return response({ tree: { sha: 'external-tree' }, parents: [{ sha: 'other-parent' }] });
			}
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/git/trees/base-tree')) {
				return response({
					truncated: false,
					tree: [
						{
							path: 'apps/dashboard.py',
							mode: '100644',
							type: 'blob',
							sha: 'base-blob',
						},
					],
				});
			}
			throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).rejects.toThrow(
			'changed outside marimohub',
		);
		expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/graphql'))).toBe(false);
	});

	it('requires a new pull request after the target pull request was closed', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'closed',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'existing-head' },
					},
				]);
			}
			throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).rejects.toThrow(
			'pull request is closed; create a new pull request',
		);
		expect(fetcher.mock.calls.some(([url]) => String(url).includes('/git/ref/heads/'))).toBe(false);
	});

	it('requires a new pull request after the target branch was deleted', async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) {
				return response({ token: 'installation-token' });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						state: 'open',
						html_url: updateInput.changeRequest.url,
						head: { sha: 'existing-head' },
					},
				]);
			}
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).updateChangeRequest(updateInput)).rejects.toThrow(
			'pull request branch was deleted; create a new pull request',
		);
		expect(fetcher.mock.calls.some(([url]) => String(url).includes('/git/commits/'))).toBe(false);
	});

	it.each([
		['number', 18, 'https://github.com/owner/repo/pull/18', updateInput.changeRequest.url],
		['URL', 17, updateInput.changeRequest.url, 'https://github.com/owner/repo/pull/18'],
	])(
		'rejects a target with a mismatched pull-request %s',
		async (_field, number, url, storedUrl) => {
			const fetcher = vi.fn(async (requestUrl: string) => {
				const parsed = new URL(requestUrl);
				if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
				if (parsed.pathname.endsWith('/access_tokens')) {
					return response({ token: 'installation-token' });
				}
				if (parsed.pathname.endsWith('/pulls')) {
					return response([
						{
							number,
							state: 'open',
							html_url: url,
							head: { sha: 'existing-head' },
						},
					]);
				}
				throw new Error(`unexpected request: ${parsed.pathname}`);
			});

			await expect(
				publisher(fetcher).updateChangeRequest({
					...updateInput,
					changeRequest: { ...updateInput.changeRequest, url: storedUrl },
				}),
			).rejects.toThrow('pull request no longer matches the published proposal');
		},
	);

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
		const commitCall = fetcher.mock.calls.find(
			([url, request]) => url.endsWith('/git/commits') && request?.method === 'POST',
		);
		expect(JSON.parse(String(commitCall?.[1]?.body))).toEqual({
			message:
				'Update dashboard\n\nCreated by marimohub\n\nCo-authored-by: Ada Lovelace <ada@example.com>',
			tree: 'tree-sha',
			parents: ['base-sha'],
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

	it('rejects an add change when the path exists at the base commit', async () => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) return response({}, 404);
			if (parsed.pathname.endsWith('/pulls')) return response([]);
			if (parsed.pathname.endsWith('/git/commits/base-sha')) {
				return response({ tree: { sha: 'base-tree' } });
			}
			if (parsed.pathname.endsWith('/contents/apps/new.py')) {
				expect(parsed.searchParams.get('ref')).toBe('base-sha');
				return response({ type: 'file', sha: 'existing-blob' });
			}
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});

		await expect(
			publisher(fetcher).openChangeRequest({
				...input,
				changes: [
					{
						path: 'apps/new.py',
						operation: 'add',
						content: new TextEncoder().encode('print("new")'),
					},
				],
			}),
		).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/blobs'))).toBe(false);
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/trees'))).toBe(false);
	});

	it('creates an add change when the path is absent from the base commit', async () => {
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
			if (parsed.pathname.endsWith('/contents/apps/new.py')) return response({}, 404);
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

		await expect(
			publisher(fetcher).openChangeRequest({
				...input,
				changes: [
					{
						path: 'apps/new.py',
						operation: 'add',
						content: new TextEncoder().encode('print("new")'),
					},
				],
			}),
		).resolves.toMatchObject({ number: 17, headCommit: 'head-sha' });
		const treeCall = fetcher.mock.calls.find(([url]) => url.endsWith('/git/trees'));
		expect(JSON.parse(String(treeCall?.[1]?.body))).toEqual({
			base_tree: 'base-tree',
			tree: [{ path: 'apps/new.py', mode: '100644', type: 'blob', sha: 'blob-sha' }],
		});
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

	it('prefers an open pull request when multiple commits match the proposal', async () => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'open-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						html_url: 'https://github.com/owner/repo/pull/17',
						head: { sha: 'closed-sha' },
						state: 'closed',
					},
					{
						number: 19,
						html_url: 'https://github.com/owner/repo/pull/19',
						head: { sha: 'open-sha' },
						state: 'open',
					},
				]);
			}
			const proposalResponse = proposalTreeResponse(parsed, ['open-sha', 'closed-sha']);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).resolves.toMatchObject({
			number: 19,
			headCommit: 'open-sha',
		});
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/commits/closed-sha'))).toBe(false);
	});

	it('skips a mismatched open pull request for a matching closed pull request', async () => {
		const fetcher = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/installation')) return response({ id: 42 });
			if (parsed.pathname.endsWith('/access_tokens')) return response({ token: 'token' });
			if (parsed.pathname.includes('/git/ref/heads/')) {
				return response({ object: { sha: 'open-sha' } });
			}
			if (parsed.pathname.endsWith('/pulls')) {
				return response([
					{
						number: 17,
						html_url: 'https://github.com/owner/repo/pull/17',
						head: { sha: 'closed-sha' },
						state: 'closed',
					},
					{
						number: 19,
						html_url: 'https://github.com/owner/repo/pull/19',
						head: { sha: 'open-sha' },
						state: 'open',
					},
				]);
			}
			if (parsed.pathname.endsWith('/git/commits/open-sha')) {
				return response({ tree: { sha: 'different-tree' }, parents: [{ sha: 'base-sha' }] });
			}
			const proposalResponse = proposalTreeResponse(parsed, ['closed-sha']);
			if (proposalResponse) return proposalResponse;
			throw new Error(`unexpected request: ${parsed.pathname}`);
		});

		await expect(publisher(fetcher).openChangeRequest(input)).resolves.toMatchObject({
			number: 17,
			headCommit: 'closed-sha',
		});
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/commits/open-sha'))).toBe(true);
		expect(fetcher.mock.calls.some(([url]) => url.endsWith('/git/commits/closed-sha'))).toBe(true);
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

	it.each([
		['repository', { ...updateInput, repository: 'https://gitlab.com/owner/repo' }],
		['base branch', { ...updateInput, baseBranch: 'feature@{bad}' }],
		[
			'head branch',
			{
				...updateInput,
				changeRequest: { ...updateInput.changeRequest, headBranch: '../main' },
			},
		],
		[
			'change path',
			{
				...updateInput,
				changes: [{ path: '../secrets', operation: 'delete' as const }],
			},
		],
		['title', { ...updateInput, title: '   ' }],
	])('rejects an invalid update %s before network access', async (_field, invalidInput) => {
		const fetcher = vi.fn();
		await expect(publisher(fetcher).updateChangeRequest(invalidInput)).rejects.toThrow();
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

	it.each([
		['a null identity', null],
		['a blank name', { name: '', email: 'ada@example.com' }],
		['a padded name', { name: ' Ada ', email: 'ada@example.com' }],
		['a newline in the name', { name: 'Ada\nCo-authored-by: Mallory', email: 'ada@example.com' }],
		['a NUL in the name', { name: 'Ada\0Mallory', email: 'ada@example.com' }],
		['angle brackets in the name', { name: 'Ada <admin>', email: 'ada@example.com' }],
		['a missing email domain', { name: 'Ada', email: 'ada@' }],
		['multiple email separators', { name: 'Ada', email: 'ada@example.com@evil.test' }],
		['whitespace in the email', { name: 'Ada', email: 'ada @example.com' }],
		['a newline in the email', { name: 'Ada', email: 'ada@example.com\nMallory' }],
		['a NUL in the email', { name: 'Ada', email: 'ada\0@example.com' }],
		['angle brackets in the email', { name: 'Ada', email: 'ada<admin>@example.com' }],
	] as const)(
		'rejects an invalid commit co-author with %s before network access',
		async (_label, coAuthor) => {
			const fetcher = vi.fn();
			const request = { ...input, coAuthor } as unknown as typeof input;
			await expect(publisher(fetcher).openChangeRequest(request)).rejects.toThrow(
				'Invalid source-control commit co-author',
			);
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

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
				return response([
					{
						number: 17,
						html_url: htmlUrl,
						head: { sha: 'existing-sha' },
						state: 'open',
					},
				]);
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

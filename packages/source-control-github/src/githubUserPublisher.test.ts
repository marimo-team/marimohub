import { describe, expect, it, vi } from 'vitest';
import type { SignedPreparation } from '@marimo-hub/core/source-control-publication';
import { GitHubUserPublisher } from './githubUserPublisher';
import { testPrivateKey } from './testing/fakeGitHub';
const parent = 'a'.repeat(40),
	tree = 'b'.repeat(40),
	commit = 'c'.repeat(40),
	foreign = 'd'.repeat(40);
const branch = 'marimohub/test/proposal';
function fixture(options: { valid?: boolean; existing?: string; mode?: string } = {}) {
	let preparation: SignedPreparation | undefined;
	const refs = new Map<string, string>();
	if (options.existing) refs.set(branch, options.existing);
	const writes: string[] = [];
	let signed = false;
	let pullCreated = Boolean(options.existing);
	const pull = () => ({
		number: 1,
		html_url: 'https://github.com/owner/repo/pull/1',
		state: 'open',
		head: { ref: branch, sha: refs.get(branch), repo: { full_name: 'owner/repo' } },
		base: { ref: 'main', repo: { full_name: 'owner/repo' } },
	});
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
		if (init?.method && init.method !== 'GET') writes.push(`${path}:${JSON.stringify(body)}`);
		if (path === '/graphql') {
			if (String(body.query).includes('SignedCommit')) {
				signed = true;
				const value = {
					oid: commit,
					message: 'Title\n\nBody',
					tree: { oid: tree },
					parents: { nodes: [{ oid: parent }] },
					author: { user: { databaseId: 123 } },
					signature: { isValid: options.valid !== false, state: 'VALID', wasSignedByGitHub: true },
				};
				if (body.input) throw new Error('unexpected');
				if (String(body.query).includes('mutation'))
					refs.set(body.variables.input.branch.branchName, commit);
				return Response.json({
					data: String(body.query).includes('mutation')
						? { createCommitOnBranch: { commit: value } }
						: { repository: { object: value } },
				});
			}
			const update = body.variables.input.refUpdates[0];
			const name = update.name.replace('refs/heads/', '');
			if (refs.get(name) !== update.beforeOid) throw new Error('moved');
			if (update.afterOid === '0'.repeat(40)) refs.delete(name);
			else {
				expect(signed).toBe(true);
				refs.set(name, update.afterOid);
			}
			return Response.json({ data: { updateRefs: { clientMutationId: null } } });
		}
		if (path.endsWith(`/git/commits/${parent}`))
			return Response.json({ tree: { sha: 'base-tree' } });
		if (path.endsWith('/git/trees/base-tree'))
			return Response.json({
				tree: [{ path: 'a.py', mode: options.mode ?? '100644', type: 'blob', sha: 'blob' }],
				truncated: false,
			});
		if (path.endsWith('/git/blobs')) return Response.json({ sha: 'blob-new' });
		if (path.endsWith('/git/trees')) return Response.json({ sha: tree });
		if (path.endsWith('/git/refs')) {
			const name = String(body.ref).replace('refs/heads/', '');
			if (refs.has(name)) return new Response('', { status: 422 });
			if (name === branch) expect(signed).toBe(true);
			refs.set(name, body.sha);
			return Response.json({ object: { sha: body.sha } });
		}
		if (path.includes('/git/ref/heads/')) {
			const name = decodeURIComponent(path.split('/git/ref/heads/')[1]);
			return refs.has(name)
				? Response.json({ object: { sha: refs.get(name) } })
				: new Response('', { status: 404 });
		}
		if (path.endsWith('/pulls/1'))
			return Response.json({ ...pull(), title: body.title, body: body.body });
		if (path.endsWith('/pulls')) {
			if (init?.method === 'POST') {
				pullCreated = true;
				return Response.json(pull());
			}
			return Response.json(pullCreated ? [pull()] : []);
		}
		if (path === '/repos/owner/repo') return Response.json({ node_id: 'repository-id' });
		throw new Error(`Unexpected ${path}`);
	});
	const user = { accountId: '123', token: vi.fn(async () => 'user-token') };
	const publisher = new GitHubUserPublisher({ appId: '123', privateKey: testPrivateKey() }, user, {
		fetcher,
	});
	const input = {
		repository: 'owner/repo',
		baseBranch: 'main',
		baseCommit: parent,
		headBranch: branch,
		title: 'Title',
		body: 'Body',
		draft: true,
		changes: [
			{ operation: 'modify' as const, path: 'a.py', content: new TextEncoder().encode('hello') },
		],
		preparation: {
			read: async () => preparation,
			write: async (state: SignedPreparation) => {
				preparation = state;
			},
		},
	};
	return { publisher, input, refs, writes, fetcher, user };
}
describe('personal GitHub publisher', () => {
	it.each(['blob', 'signing', 'target', 'pull request'] as const)(
		'fails closed on permission loss during %s',
		async (stage) => {
			const f = fixture();
			const fetcher = f.fetcher.getMockImplementation()!;
			let denied = false;
			f.fetcher.mockImplementation(async (url, init) => {
				const path = new URL(url).pathname;
				const body = String(init?.body);
				const deny =
					stage === 'blob'
						? path.endsWith('/git/blobs')
						: stage === 'signing'
							? body.includes('mutation SignedCommit')
							: stage === 'target'
								? path.endsWith('/git/refs') && body.includes(`refs/heads/${branch}`)
								: path.endsWith('/pulls') && init?.method === 'POST';
				if (deny) {
					denied = true;
					return new Response('SECRET_PROVIDER_ERROR', { status: 403 });
				}
				return fetcher(url, init);
			});
			const result = f.publisher.openChangeRequest(f.input);
			await expect(result).rejects.toThrow();
			expect(String(await result.catch((error: unknown) => error))).not.toContain('SECRET');
			expect(denied).toBe(true);
			expect(f.refs.get(branch)).toBe(stage === 'pull request' ? commit : undefined);
			expect(f.writes.some((write) => write.startsWith('/repos/owner/repo/pulls:'))).toBe(false);
			expect(
				f.fetcher.mock.calls.every(
					([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer user-token',
				),
			).toBe(true);
		},
	);

	it.each(['target', 'pull request'] as const)(
		'reconciles a lost %s response without creating another commit or PR',
		async (stage) => {
			const f = fixture();
			const fetcher = f.fetcher.getMockImplementation()!;
			let lost = false;
			f.fetcher.mockImplementation(async (url, init) => {
				const response = await fetcher(url, init);
				const path = new URL(url).pathname;
				if (
					!lost &&
					(stage === 'target'
						? path.endsWith('/git/refs') && String(init?.body).includes(`refs/heads/${branch}`)
						: path.endsWith('/pulls') && init?.method === 'POST')
				) {
					lost = true;
					throw new Error('lost response');
				}
				return response;
			});
			await expect(f.publisher.openChangeRequest(f.input)).rejects.toThrow();
			expect(lost).toBe(true);
			expect(await f.publisher.openChangeRequest(f.input)).toMatchObject({
				headCommit: commit,
				verification: { status: 'verified', commit },
			});
			expect(
				f.fetcher.mock.calls.filter(([, init]) =>
					String(init?.body).includes('mutation SignedCommit'),
				),
			).toHaveLength(1);
			expect(f.writes.filter((write) => write.startsWith('/repos/owner/repo/pulls:'))).toHaveLength(
				1,
			);
		},
	);

	it('stops target publication when authorization is revoked after signing', async () => {
		const f = fixture();
		let authorized = true;
		const fetcher = f.fetcher.getMockImplementation()!;
		f.fetcher.mockImplementation(async (url, init) => {
			const result = await fetcher(url, init);
			if (String(init?.body).includes('mutation SignedCommit')) authorized = false;
			return result;
		});
		await expect(
			f.publisher.openChangeRequest({
				...f.input,
				preparation: {
					...f.input.preparation,
					assertCurrent: async () => {
						if (!authorized) throw new Error('role revoked');
					},
				},
			}),
		).rejects.toThrow('role revoked');
		expect(f.refs.has(branch)).toBe(false);
		expect(f.writes.some((write) => write.startsWith('/repos/owner/repo/pulls:'))).toBe(false);
	});

	it('opens a PR only after the exact personal commit is verified', async () => {
		const f = fixture();
		expect(await f.publisher.openChangeRequest(f.input)).toMatchObject({ headCommit: commit });
		expect(f.refs.get(branch)).toBe(commit);
		expect(
			f.fetcher.mock.calls.every(
				([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer user-token',
			),
		).toBe(true);
	});
	it('never mutates the target branch or PR after failed verification', async () => {
		const f = fixture({ valid: false });
		await expect(f.publisher.openChangeRequest(f.input)).rejects.toThrow('expected verified');
		expect(f.refs.has(branch)).toBe(false);
		expect(
			f.writes.some(
				(w) =>
					w.includes('"ref":"refs/heads/marimohub/test/proposal"') ||
					w.startsWith('/repos/owner/repo/pulls:'),
			),
		).toBe(false);
	});
	it('rejects an existing unsigned matching-content branch/PR instead of tree-only recovery', async () => {
		const f = fixture({ existing: foreign });
		await expect(f.publisher.openChangeRequest(f.input)).rejects.toThrow('does not match');
		expect(f.refs.get(branch)).toBe(foreign);
		expect(f.writes.some((w) => w.startsWith('/repos/owner/repo/pulls:'))).toBe(false);
	});
	it('rejects unsupported executable modes before writing blobs', async () => {
		const f = fixture({ mode: '100755' });
		await expect(f.publisher.openChangeRequest(f.input)).rejects.toThrow('non-executable');
		expect(f.writes).toEqual([]);
	});
	it('uses exact expected-head CAS for an existing PR update', async () => {
		const f = fixture({ existing: foreign });
		const { headBranch: _branch, draft: _draft, ...input } = f.input;
		expect(
			await f.publisher.updateChangeRequest({
				...input,
				changeRequest: {
					number: 1,
					url: 'https://github.com/owner/repo/pull/1',
					headBranch: branch,
					headCommit: foreign,
				},
			}),
		).toMatchObject({ headCommit: commit });
		expect(
			f.writes.some(
				(w) => w.includes(`"beforeOid":"${foreign}"`) && w.includes(`"afterOid":"${commit}"`),
			),
		).toBe(true);
	});
});

it('rechecks authorization after credential resolution and before signing mutations', async () => {
	const f = fixture();
	const assertCurrent = vi.fn(async () => {
		throw new Error('role revoked');
	});
	await expect(
		f.publisher.openChangeRequest({
			...f.input,
			preparation: { ...f.input.preparation, assertCurrent },
		}),
	).rejects.toThrow('role revoked');
	expect(f.writes).toEqual([]);
	await expect(
		f.publisher.workingBranches.prepareCommit({
			repository: 'owner/repo',
			parentCommit: parent,
			message: 'Title\n\nBody',
			changes: f.input.changes,
			preparation: { ...f.input.preparation, assertCurrent },
		}),
	).rejects.toThrow('role revoked');
	expect(f.writes).toEqual([]);
});

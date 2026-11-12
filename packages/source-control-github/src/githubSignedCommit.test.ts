import { describe, expect, it, vi } from 'vitest';
import type { SignedPreparation } from '@marimo-hub/core/source-control-publication';
import { GitHubClient } from './githubClient';
import { prepareSignedGitHubCommit, cleanupSignedPreparation } from './githubSignedCommit';
import type { GitHubRepositoryWriter } from './githubRepository';
import { testPrivateKey } from './testing/fakeGitHub';

const parent = 'a'.repeat(40),
	tree = 'b'.repeat(40),
	commit = 'c'.repeat(40);
function fixture() {
	let state: SignedPreparation | undefined;
	let head: string | null = null;
	const verified = {
		oid: commit,
		message: 'Change\n\nDetails',
		tree: { oid: tree },
		parents: { nodes: [{ oid: parent }] },
		author: { user: { databaseId: 123 } },
		signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true },
	};
	const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as {
			query: string;
			variables: { input: Record<string, unknown> };
		};
		if (body.query.includes('mutation')) {
			head = commit;
			return Response.json({ data: { createCommitOnBranch: { commit: verified } } });
		}
		return Response.json({ data: { repository: { object: verified } } });
	});
	const client = new GitHubClient({ appId: '123', privateKey: testPrivateKey() }, { fetcher });
	const writer = {
		getRef: vi.fn(async () => head),
		createRef: vi.fn(async (_branch: string, sha: string) => {
			head = sha;
			return { headCommit: sha, existed: false };
		}),
		compareAndSwapRef: vi.fn(async (_branch: string, expected: string, next: string) => {
			if (head !== expected) throw new Error('moved');
			head = next === '0'.repeat(40) ? null : next;
		}),
	};
	const input = {
		client,
		writer: writer as unknown as GitHubRepositoryWriter,
		owner: 'owner',
		repo: 'repo',
		credential: { accountId: '123', token: vi.fn(async () => 'user-secret') },
		parent,
		tree,
		message: verified.message,
		changes: [
			{ path: 'a.py', operation: 'modify' as const, content: new TextEncoder().encode('print(1)') },
			{ path: 'old.py', operation: 'delete' as const },
		],
		checkpoint: {
			read: async () => state,
			write: async (value: SignedPreparation) => {
				state = value;
			},
		},
	};
	return {
		input,
		writer,
		fetcher,
		verified,
		state: () => state!,
		setHead: (value: string | null) => {
			head = value;
		},
	};
}
describe('signed GitHub preparation', () => {
	it.each(['main', 'a'.repeat(41), 'g'.repeat(40)])(
		'rejects a malformed verified commit OID: %s',
		async (oid) => {
			const f = fixture();
			f.verified.oid = oid;
			await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('expected verified');
			expect(f.state().commit).toBeUndefined();
			expect(f.writer.compareAndSwapRef).not.toHaveBeenCalled();
		},
	);

	it('requires a verification lookup to return the pinned SHA, even for an otherwise matching commit', async () => {
		const f = fixture();
		await prepareSignedGitHubCommit(f.input);
		f.verified.oid = 'd'.repeat(40);
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('expected verified');
		expect(f.state().commit).toBe(commit);
	});

	it.each(['initial', 'dispatch'] as const)(
		'does not dispatch a commit when the %s checkpoint fails',
		async (stage) => {
			const f = fixture();
			const write = f.input.checkpoint.write;
			const spy = vi.spyOn(f.input.checkpoint, 'write');
			if (stage === 'dispatch') spy.mockImplementationOnce(write);
			spy.mockRejectedValueOnce(new Error('storage unavailable'));
			await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('storage unavailable');
			expect(f.fetcher).not.toHaveBeenCalled();
			expect(f.writer.createRef).toHaveBeenCalledTimes(stage === 'initial' ? 0 : 1);
			expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
			expect(f.writer.createRef).toHaveBeenCalledOnce();
		},
	);

	it('keeps the checked SHA when a verification lookup fails and never creates another commit', async () => {
		const f = fixture();
		await prepareSignedGitHubCommit(f.input);
		f.fetcher.mockRejectedValueOnce(new Error('lookup unavailable'));
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('unavailable');
		expect(f.state().commit).toBe(commit);
		expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
		const mutations = f.fetcher.mock.calls.filter(([, init]) =>
			String(init?.body).includes('mutation SignedCommit'),
		);
		expect(mutations).toHaveLength(1);
	});

	it('does not recreate a missing preparation ref after an uncertain dispatch', async () => {
		const f = fixture();
		f.fetcher.mockRejectedValueOnce(new Error('response lost'));
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow();
		f.setHead(null);
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('branch was removed');
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(f.writer.createRef).toHaveBeenCalledOnce();
	});

	it('preserves a ref moved between the cleanup read and conditional delete', async () => {
		const f = fixture();
		const remove = f.writer.compareAndSwapRef.getMockImplementation()!;
		f.writer.compareAndSwapRef.mockImplementationOnce(async (...args) => {
			f.setHead('d'.repeat(40));
			return remove(...args);
		});
		expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
		expect(f.state().cleaned).not.toBe(true);
		expect(await f.writer.getRef()).toBe('d'.repeat(40));
	});

	it('encodes binary bytes without text conversion', async () => {
		const f = fixture();
		const bytes = new Uint8Array([0, 255, 128, 13, 10]);
		f.input.changes = [{ operation: 'modify', path: 'a.py', content: bytes }];
		await prepareSignedGitHubCommit(f.input);
		const body = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)) as {
			variables: { input: { fileChanges: { additions: { contents: string }[] } } };
		};
		expect(
			new Uint8Array(Buffer.from(body.variables.input.fileChanges.additions[0].contents, 'base64')),
		).toEqual(bytes);
	});

	it('uses personal GraphQL credentials and a durable temporary ref before conditional cleanup', async () => {
		const f = fixture();
		expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
		expect(f.state()).toMatchObject({
			repository: 'owner/repo',
			accountId: '123',
			commit,
			cleaned: true,
		});
		const [url, init] = f.fetcher.mock.calls[0];
		expect(url).toBe('https://api.github.com/graphql');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-secret');
		const body = JSON.parse(String(init?.body)) as {
			query: string;
			variables: { input: Record<string, unknown> };
		};
		expect(body.variables.input).toMatchObject({
			expectedHeadOid: parent,
			branch: { repositoryNameWithOwner: 'owner/repo', branchName: f.state().branch },
			message: { headline: 'Change', body: 'Details' },
			fileChanges: {
				additions: [{ path: 'a.py', contents: Buffer.from('print(1)').toString('base64') }],
				deletions: [{ path: 'old.py' }],
			},
		});
		expect(body.variables.input).not.toHaveProperty('author');
		expect(f.writer.compareAndSwapRef).toHaveBeenCalledWith(
			f.state().branch,
			commit,
			'0'.repeat(40),
		);
	});
	it.each(['unsigned', 'invalid', 'foreign signer', 'wrong author', 'tree', 'parent', 'message'])(
		'fails closed for %s and cleans its owned result',
		async (fault) => {
			const f = fixture();
			if (fault === 'unsigned') f.verified.signature.wasSignedByGitHub = false;
			if (fault === 'invalid') f.verified.signature.isValid = false;
			if (fault === 'foreign signer') f.verified.signature.state = 'UNKNOWN_KEY';
			if (fault === 'wrong author') f.verified.author.user.databaseId = 999;
			if (fault === 'tree') f.verified.tree.oid = 'd'.repeat(40);
			if (fault === 'parent') f.verified.parents.nodes[0].oid = 'd'.repeat(40);
			if (fault === 'message') f.verified.message = 'foreign';
			await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('expected verified');
			expect(f.state().commit).toBeUndefined();
			expect(f.state().cleaned).toBe(true);
		},
	);
	it('reconciles an uncertain dispatch by verification without creating another commit', async () => {
		const f = fixture();
		f.fetcher.mockImplementationOnce(async () => {
			f.setHead(commit);
			throw new Error('lost response secret');
		});
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow();
		expect(f.state().dispatched).toBe(true);
		expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
		expect(f.fetcher).toHaveBeenCalledTimes(2);
	});
	it('rechecks recorded commits and retries cleanup without deleting a moved ref', async () => {
		const f = fixture();
		f.writer.compareAndSwapRef.mockRejectedValueOnce(new Error('timeout'));
		await prepareSignedGitHubCommit(f.input);
		expect(f.state().cleaned).toBeUndefined();
		f.setHead('d'.repeat(40));
		expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
		expect(f.writer.compareAndSwapRef).toHaveBeenCalledTimes(1);
		f.setHead(commit);
		expect(await prepareSignedGitHubCommit(f.input)).toBe(commit);
		expect(f.state().cleaned).toBe(true);
		f.verified.signature.isValid = false;
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('expected verified');
	});
	it('refuses mismatched account/repository checkpoints and unknown cleanup heads', async () => {
		const f = fixture();
		await prepareSignedGitHubCommit(f.input);
		f.input.credential.accountId = '999';
		await expect(prepareSignedGitHubCommit(f.input)).rejects.toThrow('does not match');
		expect(
			await cleanupSignedPreparation(f.input.writer, {
				...f.state(),
				cleaned: false,
				commit: undefined,
				ownedHead: undefined,
			}),
		).toBe(false);
	});
});

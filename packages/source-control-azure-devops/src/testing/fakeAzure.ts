import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { blobId } from '@marimo-hub/source-control-git/file-tree';

interface File {
	bytes: Uint8Array;
	mode: string;
}
interface Commit {
	treeId: string;
	files: Map<string, File>;
	parents: string[];
}
interface Pull {
	pullRequestId: number;
	sourceRefName: string;
	targetRefName: string;
	status: string;
	title: string;
	description: string;
	isDraft: boolean;
	lastMergeSourceCommit?: { commitId: string };
}
interface PushBody {
	refUpdates: { name: string; oldObjectId: string; newObjectId?: string }[];
	commits: {
		comment: string;
		changes: { changeType: string; item: { path: string }; newContent?: { content: string } }[];
	}[];
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
export const repository = 'https://dev.azure.com/acme/Project%20One/_git/notebooks';

export class FakeAzure {
	readonly commits = new Map<string, Commit>();
	readonly refs = new Map<string, string>();
	readonly pulls: Pull[] = [];
	readonly messages: string[] = [];
	failPrOnce = false;
	failPushResponseOnce = false;
	racePush = false;
	readonly base: string;
	constructor() {
		this.base = this.commit(
			new Map([
				['apps/main.py', { bytes: new TextEncoder().encode('print(1)'), mode: '100644' }],
				['README.md', { bytes: new TextEncoder().encode('hello'), mode: '100644' }],
				['link', { bytes: new TextEncoder().encode('README.md'), mode: '120000' }],
			]),
			[],
		);
		this.refs.set('refs/heads/main', this.base);
	}
	commit(files: Map<string, File>, parents: string[]): string {
		const treeId = createHash('sha1')
			.update(
				JSON.stringify([...files].map(([path, file]) => [path, file.mode, blobId(file.bytes)])),
			)
			.digest('hex');
		const id = createHash('sha1')
			.update(`${treeId}:${parents.join(',')}:${this.commits.size}`)
			.digest('hex');
		this.commits.set(id, { treeId, files, parents });
		return id;
	}
	readonly fetcher = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input);
		if (
			url.origin !== 'https://dev.azure.com' ||
			!url.pathname.startsWith('/acme/Project%20One/_apis/git/repositories/notebooks/')
		)
			throw new Error('Unexpected URL');
		const path = url.pathname.split('/notebooks')[1];
		const method = init?.method ?? 'GET';
		if (url.searchParams.get('api-version') !== '7.1') throw new Error('Missing API version');
		if (path === '/refs' && method === 'GET')
			return json({
				value: [...this.refs]
					.filter(([name]) => name.slice(5).startsWith(url.searchParams.get('filter') ?? ''))
					.map(([name, objectId]) => ({ name, objectId })),
			});
		if (path === '/refs' && method === 'POST') {
			const updates = JSON.parse(String(init?.body)) as PushBody['refUpdates'];
			return json({
				value: updates.map((update) => {
					const old = this.refs.get(update.name) ?? '0'.repeat(40);
					if (old !== update.oldObjectId)
						return { success: false, updateStatus: 'staleOldObjectId' };
					this.refs.set(update.name, update.newObjectId!);
					return { success: true, updateStatus: 'succeeded' };
				}),
			});
		}
		if (path.startsWith('/commits/') && method === 'GET') {
			const id = path.slice('/commits/'.length);
			const commit = this.commits.get(id);
			return commit
				? json({ commitId: id, treeId: commit.treeId, parents: commit.parents })
				: json({}, 404);
		}
		if (path.startsWith('/trees/') && method === 'GET') {
			const commit = [...this.commits.values()].find(
				(c) => c.treeId === path.slice('/trees/'.length),
			);
			if (!commit) return json({}, 404);
			return json({
				treeEntries: [...commit.files].map(([relativePath, file]) => ({
					relativePath,
					mode: file.mode,
					objectId: blobId(file.bytes),
					gitObjectType: file.mode === '160000' ? 'commit' : 'blob',
					size: file.bytes.byteLength,
				})),
			});
		}
		if (path.startsWith('/blobs/') && method === 'GET') {
			const file = [...this.commits.values()]
				.flatMap((commit) => [...commit.files.values()])
				.find((item) => blobId(item.bytes) === path.slice('/blobs/'.length));
			return file ? new Response(Buffer.from(file.bytes)) : json({}, 404);
		}
		if (path === '/pushes' && method === 'POST') {
			const body = JSON.parse(String(init?.body)) as PushBody;
			const ref = body.refUpdates[0];
			if (this.racePush || this.refs.get(ref.name) !== ref.oldObjectId) return json({}, 409);
			const files = new Map(this.commits.get(ref.oldObjectId)!.files);
			for (const change of body.commits[0].changes) {
				const file = change.item.path.slice(1);
				if (change.changeType === 'delete') files.delete(file);
				else {
					if (change.changeType === 'add' && files.has(file))
						throw new Error('Add of existing file');
					if (change.changeType === 'edit' && !files.has(file))
						throw new Error('Edit of missing file');
					files.set(file, {
						bytes: Buffer.from(change.newContent!.content, 'base64'),
						mode: files.get(file)?.mode ?? '100644',
					});
				}
			}
			const id = this.commit(files, [ref.oldObjectId]);
			this.refs.set(ref.name, id);
			this.messages.push(body.commits[0].comment);
			if (this.failPushResponseOnce) {
				this.failPushResponseOnce = false;
				throw new Error('Lost push response');
			}
			return json({ commits: [{ commitId: id }] });
		}
		if (path === '/pullrequests' && method === 'GET')
			return json({
				value: this.pulls.filter(
					(pull) =>
						pull.sourceRefName === url.searchParams.get('searchCriteria.sourceRefName') &&
						pull.targetRefName === url.searchParams.get('searchCriteria.targetRefName'),
				),
			});
		if (path === '/pullrequests' && method === 'POST') {
			const input = JSON.parse(String(init?.body)) as Omit<Pull, 'pullRequestId' | 'status'>;
			const pull: Pull = { ...input, pullRequestId: this.pulls.length + 1, status: 'active' };
			this.pulls.push(pull);
			if (this.failPrOnce) {
				this.failPrOnce = false;
				throw new Error('Lost PR response');
			}
			return json(pull);
		}
		if (path.startsWith('/pullrequests/') && (method === 'GET' || method === 'PATCH')) {
			const pull = this.pulls.find((item) => item.pullRequestId === Number(path.split('/').at(-1)));
			if (!pull) return json({}, 404);
			if (method === 'PATCH') Object.assign(pull, JSON.parse(String(init?.body)));
			return json(pull);
		}
		throw new Error(`Unexpected request ${method} ${path}`);
	});
}

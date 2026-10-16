import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
	gitBytes as git,
	smartHttpResponse,
} from '@marimo-hub/source-control-git/testing/fake-git-server';
import { record, stringField } from '../client';

export { git };
export const repository = 'https://gitlab.com/team/subgroup/notebooks';
export const token = 'test-token';

export class FakeGitLab {
	readonly merges: Record<string, unknown>[] = [];
	readonly base: string;
	lostPush = false;
	lostMerge = false;
	beforePush?: () => void;
	constructor(readonly dir: string) {
		this.base = git(dir, ['rev-parse', 'HEAD']).toString().trim();
	}
	static async create() {
		const dir = await mkdtemp(join(tmpdir(), 'gitlab-source-'));
		git(dir, ['init', '-b', 'main']);
		await mkdir(join(dir, 'apps'));
		await writeFile(join(dir, 'apps/main.py'), 'print(1)');
		await chmod(join(dir, 'apps/main.py'), 0o755);
		await writeFile(join(dir, 'README.md'), 'original');
		await symlink('README.md', join(dir, 'link'));
		git(dir, ['add', '.']);
		git(dir, ['commit', '-m', 'Initial']);
		return new FakeGitLab(dir);
	}
	head(branch: string): string {
		return git(this.dir, ['rev-parse', `refs/heads/${branch}`])
			.toString()
			.trim();
	}
	private refreshMerge(mr: Record<string, unknown>): Record<string, unknown> {
		// Closed and merged requests retain their final diff head.
		if (mr.state !== 'opened') return mr;
		try {
			mr.sha = this.head(stringField(mr, 'source_branch'));
		} catch {
			// GitLab retains the last commit when the source branch is deleted.
		}
		return mr;
	}
	readonly fetcher = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(input);
		const method = init.method ?? 'GET';
		if (url.origin !== 'https://gitlab.com') throw new Error('Unexpected host');
		const headers = new Headers(init.headers);
		// GitLab resolves namespace paths case-insensitively.
		if (url.pathname.toLowerCase().startsWith('/team/subgroup/notebooks.git/')) {
			if (
				headers.get('authorization') !==
				`Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`
			)
				throw new Error('Missing Git credentials');
			const push = method === 'POST' && url.pathname.endsWith('/git-receive-pack');
			if (push) this.beforePush?.();
			const response = await smartHttpResponse(this.dir, input, init, [
				'git-upload-pack',
				'git-receive-pack',
			]);
			if (push) {
				this.merges.forEach((mr) => this.refreshMerge(mr));
				if (this.lostPush) {
					this.lostPush = false;
					throw new Error('Lost push response');
				}
			}
			return response;
		}
		if (
			headers.get('PRIVATE-TOKEN') !== token ||
			!url.pathname.toLowerCase().startsWith('/api/v4/projects/team%2fsubgroup%2fnotebooks/')
		)
			throw new Error('Unexpected API request');
		const path = url.pathname.split('/notebooks/').at(-1) ?? '';
		const route = url.pathname.slice('/api/v4/projects/team%2Fsubgroup%2Fnotebooks'.length);
		if (method === 'GET' && route.startsWith('/repository/branches/')) {
			const name = decodeURIComponent(route.slice('/repository/branches/'.length));
			try {
				return Response.json({ name, commit: { id: this.head(name) } });
			} catch {
				return Response.json({}, { status: 404 });
			}
		}
		if (method === 'GET' && route.startsWith('/repository/commits/')) {
			const sha = route.slice('/repository/commits/'.length);
			try {
				const body = git(this.dir, ['cat-file', 'commit', sha]).toString();
				return Response.json({
					id: sha,
					parent_ids: [...body.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]),
				});
			} catch {
				return Response.json({}, { status: 404 });
			}
		}
		if (method === 'GET' && route === '/repository/tree') {
			const entries = git(this.dir, ['ls-tree', '-rtz', url.searchParams.get('ref')!])
				.toString()
				.split('\0')
				.filter(Boolean)
				.map((line) => {
					const tab = line.indexOf('\t');
					const [mode, type, id] = line.slice(0, tab).split(' ');
					return { mode, type, id, path: line.slice(tab + 1) };
				});
			const page = Number(url.searchParams.get('page'));
			const perPage = Number(url.searchParams.get('per_page'));
			return Response.json(entries.slice((page - 1) * perPage, page * perPage), {
				headers: { 'x-next-page': page * perPage < entries.length ? String(page + 1) : '' },
			});
		}
		if (method === 'GET' && /^\/repository\/blobs\/[0-9a-f]+\/raw$/.test(route))
			return new Response(new Uint8Array(git(this.dir, ['cat-file', 'blob', route.split('/')[3]])));
		if (route === '/merge_requests' && method === 'GET')
			return Response.json(
				this.merges
					.filter(
						(mr) =>
							mr.source_branch === url.searchParams.get('source_branch') &&
							mr.target_branch === url.searchParams.get('target_branch'),
					)
					.map((mr) => this.refreshMerge(mr)),
				{ headers: { 'x-next-page': '' } },
			);
		if (route === '/merge_requests' && method === 'POST') {
			const value = record(JSON.parse(String(init.body)));
			const iid = this.merges.length + 1;
			const mr = {
				...value,
				iid,
				state: 'opened',
				source_project_id: 1,
				target_project_id: 1,
				web_url: `${repository}/-/merge_requests/${iid}`,
				draft: stringField(value, 'title').startsWith('Draft: '),
				sha: this.head(stringField(value, 'source_branch')),
			};
			this.merges.push(mr);
			if (this.lostMerge) {
				this.lostMerge = false;
				throw new Error('Lost MR response');
			}
			return Response.json(mr);
		}
		if (/^\/merge_requests\/\d+$/.test(route) && ['GET', 'PUT'].includes(method)) {
			const mr = this.merges.find((item) => item.iid === Number(route.split('/').at(-1)));
			if (!mr) return Response.json({}, { status: 404 });
			if (method === 'PUT') {
				Object.assign(mr, JSON.parse(String(init.body)));
				mr.draft = stringField(mr, 'title').startsWith('Draft: ');
			}
			return Response.json(this.refreshMerge(mr));
		}
		throw new Error(`Unexpected ${method} ${path}`);
	});
}

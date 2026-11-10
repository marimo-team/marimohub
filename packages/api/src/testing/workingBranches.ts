import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { onTestFinished, vi } from 'vitest';
import { ConflictError, createSandboxId, execResult } from '@marimo-hub/core';
import type {
	WorkingBranchInspection,
	SourceControlReader,
	WorkingBranchWriter,
} from '@marimo-hub/core/ports/source-control';
import type { NotebookId } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFsSandbox } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, stubSourceControl } from './index';

export async function workingBranchFixture() {
	const bucket = await createInitializedBucket();
	const workdir = mkdtempSync(join(tmpdir(), 'working-branch-api-'));
	onTestFinished(() => rmSync(workdir, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', workdir, ...args]);
	git('init', '-q');
	git('config', 'core.fsmonitor', 'false');
	writeFileSync(join(workdir, 'app.py'), 'base');
	git('add', 'app.py');
	let head: string | null = null;
	let revision = 0;
	let changeRequest: WorkingBranchInspection['changeRequest'];
	const bytes = (text: string) => new TextEncoder().encode(text);
	const snapshots = new Map([['base', new Map([['app.py', bytes('base')]])]]);
	const writer: WorkingBranchWriter = {
		createBranch: vi.fn<WorkingBranchWriter['createBranch']>(async ({ fromCommit }) => {
			if (head) throw new ConflictError('exists');
			head = fromCommit;
			return { commit: fromCommit };
		}),
		prepareCommit: vi.fn(async ({ parentCommit, changes }) => {
			const tree = new Map(snapshots.get(parentCommit));
			for (const change of changes) {
				if (change.operation === 'delete') tree.delete(change.path);
				else tree.set(change.path, change.content);
			}
			const commit = `save-${++revision}`;
			snapshots.set(commit, tree);
			return { commit };
		}),
		advanceBranch: vi.fn(async ({ expectedHead, commit }) => {
			if (head !== expectedHead) throw new ConflictError('moved');
			head = commit;
			return { commit };
		}),
		inspectBranch: vi.fn(async ({ commit }) => ({
			headCommit: head,
			containsCommit: head === commit,
			changeRequest,
		})),
		openBranchChangeRequest: vi.fn(async ({ headBranch, baseBranch }) => {
			changeRequest = {
				number: 42,
				url: 'https://github.com/owner/repo/pull/42',
				state: 'open',
				headBranch,
				baseBranch,
			};
			return { number: 42, url: changeRequest.url, headBranch, headCommit: head! };
		}),
	};
	const reader: SourceControlReader = {
		provider: 'github',
		supportsRepository: () => true,
		getBranchHead: async () => ({ commit: 'base' }),
		fetchWorkspace: vi.fn(async (_repo, commit) =>
			[...snapshots.get(commit)!].map(([path, bytes]) => ({ path, bytes })),
		),
		fetchGitDirectory: async () => [{ path: 'HEAD', bytes: bytes('ref: refs/heads/main\n') }],
	};
	const sourceControl = {
		...stubSourceControl({
			reader,
			publisher: { provider: 'github', workingBranches: writer, openChangeRequest: vi.fn() },
		}),
		workingBranchesEnabled: true,
		workingBranchProviders: () => ['github'],
	};
	const instance = makeFsSandbox().instance;
	instance.exec = async (command) => {
		const result = spawnSync('/bin/sh', ['-c', command], {
			encoding: 'utf8',
			timeout: 5000,
			maxBuffer: 20 * 1024 * 1024,
		});
		return execResult(result.status === 0, result.stdout ?? '', result.stderr ?? '');
	};
	const api = createTestApi({
		bucket,
		compute: fakeComputeFrom(instance),
		deps: {
			sourceControl,
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir,
				persistWorkspace: 'source',
			},
		},
	});
	const project = await api.deps.services.projects.createProject(
		{ name: 'P', description: '' },
		ACTOR,
	);
	async function session(nid: NotebookId) {
		const detail = await api.deps.services.notebooks.getNotebook(project.id, nid);
		const created = await api.deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: nid,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: detail.source.current_version_id!,
		});
		await api.deps.services.sessions.setRunning(
			project.id,
			created.session_id,
			'https://kernel.test',
		);
		await api.deps.services.sessions.claimEditor(project.id, nid, created.session_id, 'shared');
		return created.session_id;
	}
	return {
		...api,
		project,
		writer,
		reader,
		sourceControl,
		snapshots,
		session,
		edit: (text: string) => writeFileSync(join(workdir, 'app.py'), text),
		setHead: (commit: string) => {
			head = commit;
		},
		createBody: {
			title: 'Working notebook',
			description: '',
			repo: 'owner/repo',
			entry_notebook: 'app.py',
			fork: { base_branch: 'main' },
		},
	};
}

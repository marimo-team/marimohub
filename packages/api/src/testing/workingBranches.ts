import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, onTestFinished, vi } from 'vitest';
import { ConflictError, NotFoundError, createSandboxId } from '@marimo-hub/core';
import type {
	WorkingBranchInspection,
	SourceControlReader,
	WorkingBranchWriter,
} from '@marimo-hub/core/ports/source-control';
import type { NotebookId } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFsSandbox } from '@marimo-hub/core/testing';
import { createGitRepoTemplate, execInLocalShell } from '@marimo-hub/core/testing/git-repo';
import { createInitializedBucket, createTestApi, stubSourceControl } from './index';

const template = createGitRepoTemplate((repo, git) => {
	writeFileSync(join(repo, 'app.py'), 'base');
	git('add', 'app.py');
}, 'working-branch-api-');
afterAll(() => template.dispose());

export async function workingBranchFixture() {
	const bucket = await createInitializedBucket();
	const workdir = template.instantiate();
	onTestFinished(() => rmSync(workdir, { recursive: true, force: true }));
	const heads = new Map([['main', 'base']]);
	let lastCreatedBranch: string | undefined;
	let revision = 0;
	const changeRequests = new Map<string, WorkingBranchInspection['changeRequest']>();
	const bytes = (text: string) => new TextEncoder().encode(text);
	const snapshots = new Map([['base', new Map([['app.py', bytes('base')]])]]);
	const writer: WorkingBranchWriter = {
		createBranch: vi.fn<WorkingBranchWriter['createBranch']>(async ({ branch, fromCommit }) => {
			if (heads.has(branch)) throw new ConflictError('exists');
			heads.set(branch, fromCommit);
			lastCreatedBranch = branch;
			return { commit: fromCommit };
		}),
		prepareCommit: vi.fn(async ({ parentCommit, changes }) => {
			const parent = snapshots.get(parentCommit);
			if (!parent) throw new NotFoundError(`Unknown parent commit: ${parentCommit}`);
			const tree = new Map(parent);
			for (const change of changes) {
				if (change.operation === 'delete') tree.delete(change.path);
				else tree.set(change.path, change.content);
			}
			const commit = `save-${++revision}`;
			snapshots.set(commit, tree);
			return { commit };
		}),
		advanceBranch: vi.fn(async ({ branch, expectedHead, commit }) => {
			if (heads.get(branch) !== expectedHead) throw new ConflictError('moved');
			heads.set(branch, commit);
			return { commit };
		}),
		inspectBranch: vi.fn(async ({ branch, commit }) => ({
			headCommit: heads.get(branch) ?? null,
			containsCommit: commit !== undefined && heads.get(branch) === commit,
			changeRequest: changeRequests.get(branch),
		})),
		openBranchChangeRequest: vi.fn(async ({ headBranch, baseBranch }) => {
			const changeRequest = {
				number: 42,
				url: 'https://github.com/owner/repo/pull/42',
				state: 'open' as const,
				headBranch,
				baseBranch,
			};
			changeRequests.set(headBranch, changeRequest);
			return { number: 42, url: changeRequest.url, headBranch, headCommit: heads.get(headBranch)! };
		}),
	};
	const reader: SourceControlReader = {
		provider: 'github',
		supportsRepository: () => true,
		getBranchHead: async (_repo, branch) => {
			const commit = heads.get(branch);
			if (!commit) throw new NotFoundError(`Unknown branch: ${branch}`);
			return { commit };
		},
		fetchWorkspace: vi.fn(async (_repo, commit, rootPath) => {
			const snapshot = snapshots.get(commit);
			if (!snapshot) throw new NotFoundError(`Unknown commit: ${commit}`);
			const prefix = rootPath ? `${rootPath.replace(/\/+$/, '')}/` : '';
			return [...snapshot]
				.filter(([path]) => path.startsWith(prefix))
				.map(([path, bytes]) => ({ path: path.slice(prefix.length), bytes }));
		}),
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
	instance.exec = (command) => execInLocalShell(command, { timeout: 5000 });
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
		setHead: (commit: string, branch = lastCreatedBranch) => {
			if (!branch) throw new Error('Create a working branch before moving its head');
			heads.set(branch, commit);
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

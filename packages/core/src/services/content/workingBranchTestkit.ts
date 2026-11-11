// Shared by the WorkingBranchService suites. Not imported by production code.
import { vi } from 'vitest';
import { ACTOR, setupTestEnv } from '../../testing';
import { createSandboxId } from '../../ids';
import type { NotebookId, ProjectId, SessionId } from '../../ids';
import type {
	SourceControlReader,
	SourceControlRegistry,
	WorkingBranchWriter,
} from '../../ports/sourceControl';
import { ConflictError } from '../../errors';
import { WorkingBranchService } from './WorkingBranchService';

export const encode = (text: string) => new TextEncoder().encode(text);

export const WORKING_BRANCH_CREATE_INPUT = {
	title: 'Dashboard',
	description: '',
	repo: 'owner/repo',
	base_branch: 'main',
	entry_notebook: 'dashboard.py',
};

export interface WorkingBranchHarness {
	env: Awaited<ReturnType<typeof setupTestEnv>>;
	service: WorkingBranchService;
	writer: WorkingBranchWriter;
	reader: SourceControlReader;
	registry: SourceControlRegistry;
	pid: ProjectId;
	nid: NotebookId;
	sid: SessionId;
	/** The fake remote branch tip; tests move it to simulate external pushes and deletions. */
	head: string | null;
	/** Fake remote trees by commit; `base` holds the fork point. */
	snapshots: Map<string, Map<string, Uint8Array>>;
}

/**
 * A project with one working-branch notebook, a running editor session, and an
 * in-memory source-control provider whose branch tip and trees the test controls.
 */
export async function setupWorkingBranchHarness(): Promise<WorkingBranchHarness> {
	const env = await setupTestEnv();
	const pid = (await env.projects.createProject({ name: 'P', description: '' }, ACTOR)).id;
	let revision = 0;
	const remote = {
		head: null as string | null,
		snapshots: new Map([
			[
				'base',
				new Map([
					['dashboard.py', encode('base')],
					['.gitignore', encode('*.ignored\n')],
				]),
			],
		]),
	};
	const writer: WorkingBranchWriter = {
		createBranch: vi.fn<WorkingBranchWriter['createBranch']>(async ({ fromCommit }) => {
			if (remote.head) throw new ConflictError('exists');
			remote.head = fromCommit;
			return { commit: fromCommit };
		}),
		prepareCommit: vi.fn(async ({ parentCommit, changes }) => {
			const parent = remote.snapshots.get(parentCommit);
			if (!parent) throw new Error(`unknown parent commit ${parentCommit}`);
			const tree = new Map(parent);
			for (const change of changes) {
				if (change.operation === 'delete') tree.delete(change.path);
				else tree.set(change.path, change.content);
			}
			const commit = `save-${++revision}`;
			remote.snapshots.set(commit, tree);
			return { commit };
		}),
		advanceBranch: vi.fn(async ({ expectedHead, commit }) => {
			if (remote.head !== expectedHead) throw new ConflictError('moved');
			remote.head = commit;
			return { commit };
		}),
		inspectBranch: vi.fn(async ({ commit }) => ({
			headCommit: remote.head,
			containsCommit: remote.head === commit,
		})),
		openBranchChangeRequest: vi.fn(),
	};
	const reader: SourceControlReader = {
		provider: 'github',
		supportsRepository: () => true,
		getBranchHead: async () => ({ commit: 'base' }),
		fetchWorkspace: vi.fn(async (_repo, commit) =>
			[...remote.snapshots.get(commit)!].map(([path, bytes]) => ({ path, bytes })),
		),
		fetchGitDirectory: vi.fn(async () => [
			{ path: 'HEAD', bytes: encode('ref: refs/heads/main\n') },
		]),
	};
	const registry: SourceControlRegistry = {
		workingBranchesEnabled: true,
		getReader: () => reader,
		getPublisher: () => ({
			provider: 'github',
			workingBranches: writer,
			openChangeRequest: vi.fn(),
		}),
		publisherProviders: () => ['github'],
		readerProviders: () => ['github'],
		pullSourceProviders: () => ['github'],
	};
	const service = new WorkingBranchService({ ...env, sourceControl: registry });
	const notebook = await service.create(pid, ACTOR, 'create', WORKING_BRANCH_CREATE_INPUT);
	const nid = notebook.meta.id;
	const session = await env.sessions.createSession({
		project_id: pid,
		notebook_id: nid,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
		source_version_id: notebook.source.current_version_id!,
	});
	await env.sessions.setRunning(pid, session.session_id, 'https://kernel.test');
	await env.sessions.claimEditor(pid, nid, session.session_id, 'shared');
	return {
		env,
		service,
		writer,
		reader,
		registry,
		pid,
		nid,
		sid: session.session_id,
		snapshots: remote.snapshots,
		get head() {
			return remote.head;
		},
		set head(commit) {
			remote.head = commit;
		},
	};
}

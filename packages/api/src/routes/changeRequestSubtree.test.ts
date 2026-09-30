import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandboxId } from '@marimo-hub/core';
import type {
	NotebookId,
	ProjectId,
	SessionId,
	SourceControlPublisher,
	SourceControlReader,
} from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeGitWorkingTreeSandbox } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk, stubSourceControl } from '../testing';

const encode = (value: string) => new TextEncoder().encode(value);
const COMMIT = 'abc123'.padEnd(40, '0');
const HEAD = 'fedcba9876543210';

/** A sandbox whose Git answers come from a subtree checkout rooted below the workdir. */
function makeSubtreeGitSandbox(root: string) {
	return makeGitWorkingTreeSandbox({
		root,
		files: { 'dashboard.py': 'print("after")' },
		baseCommitOutput: `${COMMIT}\n`,
		diff: [['M', 'dashboard.py']],
	});
}

describe('change requests from a subtree pull source', () => {
	let setup: Awaited<ReturnType<typeof createTestApi>>;
	let projectId: ProjectId;
	let notebookId: NotebookId;
	let sessionId: SessionId;
	let exec: ReturnType<typeof makeSubtreeGitSandbox>['exec'];
	let openChangeRequest: ReturnType<typeof vi.fn<SourceControlPublisher['openChangeRequest']>>;

	beforeEach(async () => {
		const bucket = await createInitializedBucket();
		const sandbox = makeSubtreeGitSandbox('/workspace/python');
		exec = sandbox.exec;
		openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>(async (input) => ({
			number: 1,
			url: 'https://github.com/owner/repo/pull/1',
			headBranch: input.headBranch,
			headCommit: 'created-1',
		}));
		const publisher: SourceControlPublisher = { provider: 'github', openChangeRequest };
		const reader: SourceControlReader = {
			provider: 'github',
			supportsRepository: () => true,
			getBranchHead: async () => ({ commit: HEAD }),
			fetchWorkspace: async () => [{ path: 'dashboard.py', bytes: encode('print(1)') }],
			fetchGitDirectory: async () => [{ path: 'HEAD', bytes: encode('HEAD') }],
		};
		setup = createTestApi({
			bucket,
			compute: fakeComputeFrom(sandbox.instance),
			deps: { sourceControl: stubSourceControl({ publisher, reader }) },
		});
		const project = await setup.deps.services.projects.createProject(
			{ name: 'Dashboards', description: 'd' },
			ACTOR,
		);
		projectId = project.id;
		const created = await setup.deps.services.notebooks.synced.create(
			projectId,
			{
				title: 'Revenue dashboard',
				description: 'from git',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'python',
				entry_notebook: 'dashboard.py',
				sync_mode: 'pull',
			},
			ACTOR,
		);
		notebookId = created.meta.id;
		await setup.deps.services.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'python',
			commit: COMMIT,
			files: [{ path: 'dashboard.py', bytes: encode('print("before")') }],
			git_files: [{ path: 'HEAD', bytes: encode('ref: refs/heads/main\n') }],
		});
		const detail = await setup.deps.services.notebooks.getNotebook(projectId, notebookId);
		if (detail.source.type !== 'git' || !detail.source.current_version_id) {
			throw new Error('Expected a synced source');
		}
		const session = await setup.deps.services.sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: detail.source.current_version_id,
		});
		sessionId = session.session_id;
		await setup.deps.services.sessions.setRunning(projectId, sessionId, 'https://sandbox.example');
	});

	function openRequest() {
		return setup.request(
			'POST',
			`/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}/change-requests`,
			{},
			{ 'Idempotency-Key': `open-${Math.random()}` },
		);
	}

	function gitCommands() {
		return exec.mock.calls.map(([command]) => command).filter((c) => c.includes('git -c'));
	}

	it('captures from the subtree with the repository root trusted and publishes repo-relative paths', async () => {
		await expectOk(await openRequest(), 201);

		expect(exec).toHaveBeenCalledWith(expect.stringContaining("cd '/workspace' && test -e .git"));
		const commands = gitCommands();
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			expect(command).toContain("cd '/workspace/python' && git -c 'safe.directory=/workspace'");
		}
		// Without --relative, git would report python/dashboard.py and publishing would double-prefix it.
		expect(commands.find((c) => c.includes('diff --name-status'))).toContain('--relative');
		expect(openChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				baseCommit: COMMIT,
				changes: [expect.objectContaining({ path: 'python/dashboard.py', operation: 'modify' })],
			}),
		);
	});

	it('keeps a running session on its provisioned subtree after a pending root path edit', async () => {
		await expectOk(
			await setup.request('PATCH', `/projects/${projectId}/notebooks/${notebookId}/source`, {
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'elsewhere',
				entry_notebook: 'dashboard.py',
			}),
		);
		const staged = await expectOk<{ source: { root_path: string; pending_config?: unknown } }>(
			await setup.request('GET', `/projects/${projectId}/notebooks/${notebookId}`),
		);
		expect(staged.source).toMatchObject({
			root_path: 'python',
			pending_config: { root_path: 'elsewhere' },
		});

		await expectOk(await openRequest(), 201);

		for (const command of gitCommands()) {
			expect(command).toContain("cd '/workspace/python' && git -c 'safe.directory=/workspace'");
			expect(command).not.toContain('elsewhere');
		}
		expect(openChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [expect.objectContaining({ path: 'python/dashboard.py' })],
			}),
		);
	});
});

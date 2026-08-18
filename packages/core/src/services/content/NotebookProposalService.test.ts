import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_BYTES } from '../../constants';
import { createNotebookId, createProjectId, createProposalId, createVersionId } from '../../ids';
import type { NotebookId, ProjectId, ProposalId, UserId, VersionId } from '../../ids';
import { paths } from '../../paths';
import type { Bucket, BucketPutOptions } from '../../ports/bucket';
import { execResult, listFilesFailure, readFileFailure } from '../../ports/sandbox';
import type { OpenChangeRequestResult, SourceControlPublisher } from '../../ports/sourceControl';
import type { SandboxInstance } from '../../ports/sandbox';
import type { Session } from '../../schema';
import { ACTOR, makeFsSandbox, makeSession, setupTestEnv, uid } from '../../testing';
import {
	DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS,
	DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS,
	NotebookProposalService,
} from './NotebookProposalService';
import { MAX_VERSIONS } from './NotebookService';

const encode = (value: string) => new TextEncoder().encode(value);
const GIT_COMMIT = 'a'.repeat(40);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
const LARGE_CONTENT_TEST_TIMEOUT_MS = 15_000;

interface GitSandboxOptions {
	files: Record<string, string | Uint8Array>;
	diff?: readonly (readonly [status: string, path: string])[];
	untracked?: readonly string[];
	diffOutput?: string;
	untrackedOutput?: string;
	gitAvailable?: boolean;
	baseCommitAvailable?: boolean;
	baseCommitOutput?: string;
	diffFails?: boolean;
	sizes?: Record<string, number>;
}

function makeGitSandbox(options: GitSandboxOptions) {
	const sandbox = makeFsSandbox({ files: options.files, sizes: options.sizes });
	const exec = vi.fn<SandboxInstance['exec']>(async (command) => {
		if (command.includes('test -e .git')) {
			return options.gitAvailable === false
				? execResult(false, '', 'not a repository')
				: execResult(true, 'git-working-tree', '');
		}
		if (command.includes('git rev-parse --verify')) {
			return options.baseCommitAvailable === false
				? execResult(false, '', 'unknown revision')
				: execResult(true, options.baseCommitOutput ?? `${GIT_COMMIT}\n`, '');
		}
		if (command.includes('git diff --name-status')) {
			const output =
				options.diffOutput ??
				(options.diff ?? [])
					.flatMap(([status, path]) => [status, path])
					.map((field) => `${field}\0`)
					.join('');
			return options.diffFails
				? execResult(false, '', 'diff failed')
				: execResult(true, output, '');
		}
		if (command.includes('git ls-files --others')) {
			return execResult(
				true,
				options.untrackedOutput ?? (options.untracked ?? []).map((path) => `${path}\0`).join(''),
				'',
			);
		}
		return sandbox.instance.exec(command);
	});
	return { ...sandbox, instance: { ...sandbox.instance, exec }, exec };
}

describe('NotebookProposalService', () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let projectId: ProjectId;
	let notebookId: NotebookId;
	let versionId: VersionId;
	let session: Session;

	beforeEach(async () => {
		env = await setupTestEnv();
		const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		projectId = project.id;
		const created = await env.notebooks.synced.create(
			projectId,
			{
				title: 'Synced',
				description: 'from git',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			},
			ACTOR,
		);
		notebookId = created.meta.id;
		await env.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			commit: 'abc123',
			files: [{ path: 'dashboard.py', bytes: encode('print("before")') }],
		});
		const detail = await env.notebooks.getNotebook(projectId, notebookId);
		if (detail.source.type !== 'git' || !detail.source.current_version_id) {
			throw new Error('expected synced source');
		}
		versionId = detail.source.current_version_id;
		session = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			source_version_id: versionId,
		});
	});

	function capture(
		sandbox: SandboxInstance,
		overrides: Partial<{
			proposalId: ProposalId;
			session: Session;
			author: UserId;
			targetProposalId: ProposalId;
		}> = {},
	) {
		return env.proposals.captureProposal({
			projectId,
			notebookId,
			session: overrides.session ?? session,
			sandbox,
			workdir: '/workspace',
			author: overrides.author ?? ACTOR,
			proposalId: overrides.proposalId,
			targetProposalId: overrides.targetProposalId,
		});
	}

	function proxyBucket(
		put: (
			key: string,
			value: string | Uint8Array,
			options?: BucketPutOptions,
		) => ReturnType<Bucket['put']>,
		deleteObject: Bucket['delete'] = (key) => env.bucket.delete(key),
		getObject: Bucket['get'] = (key) => env.bucket.get(key),
	): Bucket {
		return {
			get: getObject,
			head: (key) => env.bucket.head(key),
			put,
			delete: deleteObject,
			list: (options) => env.bucket.list(options),
		};
	}

	function captureWith(
		service: NotebookProposalService,
		sandbox: SandboxInstance,
		proposalId: ProposalId,
	) {
		return service.captureProposal({
			projectId,
			notebookId,
			proposalId,
			session,
			sandbox,
			workdir: '/workspace',
			author: ACTOR,
		});
	}

	it('captures the changed entry notebook with its immutable git provenance', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } });
		const proposal = await capture(instance);

		expect(proposal).toMatchObject({
			notebook_id: notebookId,
			base_version_id: versionId,
			capture_strategy: 'entry-notebook',
			source: {
				provider: 'github',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
				commit: 'abc123',
			},
			changes: [{ path: 'dashboard.py', operation: 'modify', size_bytes: 14 }],
		});
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposal.proposal_id)).publication,
		).toEqual(expect.objectContaining({ state: 'pending' }));
	});

	it('reads proposal manifests written before capture strategies were recorded', async () => {
		const proposal = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } }).instance,
		);
		const proposalPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(proposal.proposal_id).meta;
		const stored = await (await env.bucket.get(proposalPath))?.json<Record<string, unknown>>();
		if (!stored) throw new Error('expected proposal');
		delete stored.capture_strategy;
		await env.bucket.put(proposalPath, JSON.stringify(stored));

		await expect(
			env.proposals.getProposal(projectId, notebookId, proposal.proposal_id),
		).resolves.toMatchObject({ proposal: { capture_strategy: 'entry-notebook' } });
	});

	it('captures tracked and untracked Git working-tree changes together', async () => {
		const base = paths.project(projectId).notebook(notebookId).version(versionId);
		await env.bucket.put(base.workspaceFile('old.txt'), 'old');
		const { instance, exec } = makeGitSandbox({
			files: {
				'dashboard.py': 'print("after")',
				'new.txt': 'new file',
			},
			diff: [
				['M', 'dashboard.py'],
				['D', 'old.txt'],
			],
			untracked: ['new.txt'],
		});

		const proposal = await capture(instance);

		expect(proposal.capture_strategy).toBe('git-working-tree');
		expect(proposal.changes).toEqual([
			expect.objectContaining({ path: 'dashboard.py', operation: 'modify' }),
			expect.objectContaining({ path: 'new.txt', operation: 'add' }),
			{ path: 'old.txt', operation: 'delete' },
		]);
		expect(exec).toHaveBeenCalledWith(expect.stringContaining('--exclude-standard'));
		const proposalPaths = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(proposal.proposal_id);
		expect(await (await env.bucket.get(proposalPaths.change(0)))?.text()).toBe('print("after")');
		expect(await (await env.bucket.get(proposalPaths.change(1)))?.text()).toBe('new file');
		expect(await env.bucket.head(proposalPaths.change(2))).toBeNull();

		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: `marimohub/${notebookId}/${proposal.proposal_id}`,
			headCommit: 'published-head',
		}));
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: proposal.proposal_id,
			publisher: { provider: 'github', openChangeRequest },
			title: 'Workspace update',
			body: '',
		});
		expect(openChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [
					expect.objectContaining({ path: 'apps/dashboard.py', operation: 'modify' }),
					expect.objectContaining({ path: 'apps/new.txt', operation: 'add' }),
					{ path: 'apps/old.txt', operation: 'delete' },
				],
			}),
		);
	});

	it('excludes runtime and cache files from Git capture', async () => {
		const ignored = [
			'__marimo__/state.json',
			'.venv/lib/python.py',
			'pkg/__pycache__/module.pyc',
			'node_modules/pkg/index.js',
			'.DS_Store',
		];
		const { instance, calls, exec } = makeGitSandbox({
			files: Object.fromEntries([...ignored.map((path) => [path, 'runtime']), ['new.txt', 'keep']]),
			untracked: [...ignored, 'new.txt'],
		});

		const proposal = await capture(instance);

		expect(proposal.changes).toEqual([
			expect.objectContaining({ path: 'new.txt', operation: 'add' }),
		]);
		expect(calls.readFile).toHaveLength(0);
		const commands = exec.mock.calls.map(([command]) => command).join('\n');
		expect(commands).toContain(':(exclude,glob)**/__marimo__/**');
		expect(commands).toContain(':(exclude,glob)**/.venv/**');
		expect(commands).toContain("base64 < '/workspace/new.txt'");
		for (const path of ignored) expect(commands).not.toContain(`base64 < '/workspace/${path}'`);
	});

	it('captures binary Git files byte for byte', async () => {
		const bytes = Uint8Array.from([0, 255, 128, 10, 13, 1]);
		const { instance } = makeGitSandbox({
			files: { 'asset.bin': bytes },
			untracked: ['asset.bin'],
		});

		const proposal = await capture(instance);
		const stored = await (
			await env.bucket.get(
				paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
			)
		)?.bytes();

		expect(stored).toEqual(bytes);
	});

	it('falls back to entry-notebook capture when Git cannot resolve the pinned commit', async () => {
		const { instance, exec } = makeGitSandbox({
			files: { 'dashboard.py': 'print("after")' },
			gitAvailable: false,
		});

		await expect(capture(instance)).resolves.toMatchObject({
			capture_strategy: 'entry-notebook',
			changes: [expect.objectContaining({ path: 'dashboard.py' })],
		});
		expect(exec).toHaveBeenCalledOnce();
	});

	it('does not silently fall back after selecting Git capture', async () => {
		const { instance } = makeGitSandbox({
			files: { 'dashboard.py': 'print("after")' },
			diffFails: true,
		});

		await expect(capture(instance)).rejects.toThrow('Could not inspect the Git working tree');
	});

	it('does not silently fall back when the pinned commit is absent from a Git working tree', async () => {
		const { instance, calls } = makeGitSandbox({
			files: { 'dashboard.py': 'print("after")' },
			baseCommitAvailable: false,
		});

		await expect(capture(instance)).rejects.toThrow('does not contain the pinned source commit');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects an invalid commit returned by Git', async () => {
		const { instance, calls } = makeGitSandbox({
			files: { 'dashboard.py': 'print("after")' },
			baseCommitOutput: 'not-a-commit\n',
		});

		await expect(capture(instance)).rejects.toThrow('invalid pinned source commit');
		expect(calls.readFile).toHaveLength(0);
	});

	it('supports a delete-only Git proposal and an empty payload marker', async () => {
		const base = paths.project(projectId).notebook(notebookId).version(versionId);
		await env.bucket.put(base.workspaceFile('old.txt'), 'old');
		const { instance } = makeGitSandbox({
			files: { 'dashboard.py': 'print("before")' },
			diff: [['D', 'old.txt']],
		});

		const proposal = await capture(instance);
		const marker = await (
			await env.bucket.get(paths.proposalPayloadMarker(projectId, notebookId, proposal.proposal_id))
		)?.json<{ change_indexes: number[] }>();

		expect(proposal.changes).toEqual([{ path: 'old.txt', operation: 'delete' }]);
		expect(marker?.change_indexes).toEqual([]);
	});

	it('ignores a mode-only tracked change whose bytes match the synced version', async () => {
		const { instance, calls } = makeGitSandbox({
			files: { 'dashboard.py': 'print("before")' },
			diff: [['M', 'dashboard.py']],
		});

		await expect(capture(instance)).rejects.toThrow('no changes');
		expect(calls.readFile).toHaveLength(0);
		expect(calls.exec).toEqual(["base64 < '/workspace/dashboard.py'"]);
	});

	it('treats a tracked deletion recreated as untracked content as a modification', async () => {
		const { instance } = makeGitSandbox({
			files: { 'dashboard.py': 'print("recreated")' },
			diff: [['D', 'dashboard.py']],
			untracked: ['dashboard.py'],
		});

		await expect(capture(instance)).resolves.toMatchObject({
			changes: [expect.objectContaining({ path: 'dashboard.py', operation: 'modify' })],
		});
	});

	it.each([
		['an unsafe path', { diff: [['M', '../secret.txt']] }, 'Invalid Git change path'],
		[
			'a control character in a path',
			{ untracked: ['line\nbreak.txt'] },
			'Invalid Git change path',
		],
		['an unsupported type change', { diff: [['T', 'dashboard.py']] }, 'is not supported'],
		['a truncated diff record', { diffOutput: 'M\0dashboard.py' }, 'malformed diff output'],
		[
			'a truncated untracked record',
			{ untrackedOutput: 'new.txt' },
			'malformed untracked-file output',
		],
	] as const)('rejects %s from Git', async (_label, options, message) => {
		const { instance } = makeGitSandbox({
			files: { 'dashboard.py': 'changed', 'new.txt': 'new' },
			...options,
		});
		await expect(capture(instance)).rejects.toThrow(message);
	});

	it('rejects a tracked modification outside the immutable synced source version', async () => {
		const { instance, calls } = makeGitSandbox({
			files: { 'dashboard.py': 'print("before")', 'unknown.txt': 'changed' },
			diff: [['M', 'unknown.txt']],
		});

		await expect(capture(instance)).rejects.toThrow('missing from the synced source version');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects changed symlinks without reading through them', async () => {
		const sandbox = makeGitSandbox({
			files: { 'dashboard.py': 'print("before")', 'link.txt': 'target bytes' },
			untracked: ['link.txt'],
		});
		const listFiles = vi.fn<SandboxInstance['listFiles']>(async (path, options) => {
			const result = await sandbox.instance.listFiles(path, options);
			if (!result.success) return result;
			return {
				...result,
				files: result.files.map((file) =>
					file.name === 'link.txt' ? { ...file, type: 'symlink' as const } : file,
				),
			};
		});

		await expect(capture({ ...sandbox.instance, listFiles })).rejects.toThrow('not a regular file');
		expect(sandbox.calls.readFile).toHaveLength(0);
	});

	it('rejects changed files beneath symlinked directories without reading through them', async () => {
		const sandbox = makeGitSandbox({
			files: { 'linked/new.txt': 'outside bytes' },
			untracked: ['linked/new.txt'],
		});
		const listFiles = vi.fn<SandboxInstance['listFiles']>(async (path, options) => {
			if (path !== '/workspace') return sandbox.instance.listFiles(path, options);
			return {
				success: true,
				files: [
					{
						name: 'linked',
						absolutePath: '/workspace/linked',
						relativePath: 'linked',
						type: 'symlink',
						size: 0,
					},
				],
			};
		});

		await expect(capture({ ...sandbox.instance, listFiles })).rejects.toThrow(
			'has a non-directory parent',
		);
		expect(sandbox.exec).not.toHaveBeenCalledWith(expect.stringContaining('base64 <'));
	});

	it('captures changed files beneath inspected directories', async () => {
		const sandbox = makeGitSandbox({
			files: { 'nested/new.txt': 'new bytes' },
			untracked: ['nested/new.txt'],
		});
		const listFiles = vi.fn<SandboxInstance['listFiles']>(async (path, options) => {
			if (path !== '/workspace') return sandbox.instance.listFiles(path, options);
			return {
				success: true,
				files: [
					{
						name: 'nested',
						absolutePath: '/workspace/nested',
						relativePath: 'nested',
						type: 'directory',
						size: 0,
					},
				],
			};
		});

		await expect(capture({ ...sandbox.instance, listFiles })).resolves.toMatchObject({
			changes: [expect.objectContaining({ path: 'nested/new.txt', operation: 'add' })],
		});
		expect(sandbox.exec).toHaveBeenCalledWith("base64 < '/workspace/nested/new.txt'");
	});

	it('bounds the number of Git changes before reading their content', async () => {
		const untracked = Array.from({ length: 1_001 }, (_, index) => `generated/${index}.txt`);
		const { instance, calls } = makeGitSandbox({ files: {}, untracked });

		await expect(capture(instance)).rejects.toThrow('1000-change limit');
		expect(calls.readFile).toHaveLength(0);
	});

	it(
		'bounds the combined content size across Git changes',
		async () => {
			const halfPlusOne = Math.floor(MAX_REQUEST_BYTES / 2) + 1;
			const { instance } = makeGitSandbox({
				files: {
					'one.bin': new Uint8Array(halfPlusOne),
					'two.bin': new Uint8Array(halfPlusOne),
				},
				untracked: ['one.bin', 'two.bin'],
			});

			await expect(capture(instance)).rejects.toThrow(
				`Proposal changes exceed the ${MAX_REQUEST_BYTES}-byte limit`,
			);
		},
		LARGE_CONTENT_TEST_TIMEOUT_MS,
	);

	it(
		'enforces the byte limit after reading Git content',
		async () => {
			const { instance } = makeGitSandbox({
				files: { 'oversized.bin': new Uint8Array(MAX_REQUEST_BYTES + 1) },
				untracked: ['oversized.bin'],
				sizes: { 'oversized.bin': 1 },
			});

			await expect(capture(instance)).rejects.toThrow(
				`exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
			);
		},
		LARGE_CONTENT_TEST_TIMEOUT_MS,
	);

	it('inspects the entry notebook through its parent directory', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } });
		const listFiles = vi.fn<SandboxInstance['listFiles']>(async (path, options) => {
			if (path !== '/workspace') return { success: true, files: [] };
			const result = await instance.listFiles(path, options);
			if (!result.success) return result;
			return {
				success: true,
				files: result.files.map((file) => ({
					...file,
					absolutePath: `/provider-specific-root/${file.name}`,
				})),
			};
		});

		await expect(capture({ ...instance, listFiles })).resolves.toMatchObject({
			base_version_id: versionId,
		});
		expect(listFiles).toHaveBeenCalledExactlyOnceWith('/workspace', { includeHidden: true });
	});

	it('does not create a proposal for unchanged content', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("before")' } });
		await expect(capture(instance)).rejects.toThrow('no changes');
	});

	it('enforces the byte limit after reading content from the sandbox', async () => {
		const { instance } = makeFsSandbox({
			files: { 'dashboard.py': new Uint8Array(MAX_REQUEST_BYTES + 1) },
			sizes: { 'dashboard.py': 1 },
		});
		await expect(capture(instance)).rejects.toThrow(`exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
	});

	it('publishes a repo-relative change and returns the stored PR on retry', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } });
		const proposal = await capture(instance);
		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: `marimohub/${notebookId}/${proposal.proposal_id}`,
			headCommit: 'def456',
		}));
		const publisher: SourceControlPublisher = { provider: 'github', openChangeRequest };
		const input = {
			projectId,
			notebookId,
			proposalId: proposal.proposal_id as ProposalId,
			publisher,
			title: 'Update dashboard',
			body: 'Created by marimohub',
		};

		const first = await env.proposals.publishChangeRequest(input);
		const { publisher: _publisher, ...retryInput } = input;
		const second = await env.proposals.publishChangeRequest(retryInput);
		const reusable = await env.proposals.getReusableProposal(
			projectId,
			notebookId,
			proposal.proposal_id,
		);

		expect(second).toEqual(first);
		expect(reusable?.proposal).toEqual(proposal);
		expect(reusable?.publication.state).toBe('published');
		expect(openChangeRequest).toHaveBeenCalledOnce();
		expect(openChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				repository: 'owner/repo',
				baseBranch: 'main',
				baseCommit: 'abc123',
				draft: true,
				changes: [expect.objectContaining({ path: 'apps/dashboard.py', operation: 'modify' })],
			}),
		);
	});

	it('publishes a new proposal to an existing change request', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch,
			headCommit: 'first-head',
		}));
		const updateChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch,
			headCommit: 'second-head',
		}));
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest,
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});

		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		const result = await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: update.proposal_id,
			publisher,
			title: 'Second update',
			body: '',
		});

		expect(update.target_proposal_id).toBe(initial.proposal_id);
		expect(result).toMatchObject({ number: 17, headBranch, headCommit: 'second-head' });
		expect(openChangeRequest).toHaveBeenCalledOnce();
		expect(updateChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				baseCommit: 'abc123',
				changeRequest: expect.objectContaining({
					number: 17,
					headBranch,
					headCommit: 'first-head',
				}),
				changes: [expect.objectContaining({ path: 'apps/dashboard.py' })],
			}),
		);
	});

	it('does not silently open a new change request when updates are unsupported', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch,
			headCommit: 'first-head',
		}));
		const publisher: SourceControlPublisher = { provider: 'github', openChangeRequest };
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);

		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				publisher,
				title: 'Second update',
				body: '',
			}),
		).rejects.toThrow('Updating change requests is not configured');
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('rejects an update whose target proposal is still pending', async () => {
		const target = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: target.proposal_id },
		);
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(),
			updateChangeRequest: vi.fn(),
		};

		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				publisher,
				title: 'Second update',
				body: '',
			}),
		).rejects.toThrow('target proposal has no published change request');
		expect(publisher.openChangeRequest).not.toHaveBeenCalled();
		expect(publisher.updateChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects a provider update that substitutes another change request', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'first-head',
			})),
			updateChangeRequest: vi.fn(async () => ({
				number: 18,
				url: 'https://github.com/owner/repo/pull/18',
				headBranch,
				headCommit: 'second-head',
			})),
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);

		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				publisher,
				title: 'Second update',
				body: '',
			}),
		).rejects.toThrow('provider returned an invalid change request');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, update.proposal_id)).publication
				.state,
		).toBe('pending');
	});

	it('keeps the target proposal immutable across capture retries', async () => {
		const proposalId = createProposalId();
		const firstTarget = createProposalId();
		const sandbox = makeFsSandbox({ files: { 'dashboard.py': 'print("after")' } }).instance;
		await capture(sandbox, { proposalId, targetProposalId: firstTarget });

		await expect(
			capture(sandbox, { proposalId, targetProposalId: createProposalId() }),
		).rejects.toThrow('different source revision');
		const stored = await env.proposals.getProposal(projectId, notebookId, proposalId);
		expect(stored.proposal.target_proposal_id).toBe(firstTarget);
	});

	it('chains updates through the latest published proposal and replays without a publisher', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		let updateCount = 0;
		const updateChangeRequest = vi.fn<NonNullable<SourceControlPublisher['updateChangeRequest']>>(
			async (input) => ({
				...input.changeRequest,
				headCommit: `updated-head-${++updateCount}`,
			}),
		);
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const firstUpdate = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		const firstResult = await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: firstUpdate.proposal_id,
			publisher,
			title: 'Second update',
			body: '',
		});
		const replay = await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: firstUpdate.proposal_id,
			title: 'Ignored on replay',
			body: 'Ignored on replay',
		});
		const secondUpdate = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("third")' } }).instance,
			{ targetProposalId: firstUpdate.proposal_id },
		);
		const secondResult = await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: secondUpdate.proposal_id,
			publisher,
			title: 'Third update',
			body: '',
		});
		const staleReplay = await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: firstUpdate.proposal_id,
			title: 'Ignored stale replay',
			body: 'Ignored stale replay',
		});
		const updateFromRoot = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("fourth")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: updateFromRoot.proposal_id,
			publisher,
			title: 'Fourth update',
			body: '',
		});

		expect(replay).toEqual(firstResult);
		expect(staleReplay).toEqual(firstResult);
		expect(secondResult.headCommit).toBe('updated-head-2');
		expect(updateChangeRequest).toHaveBeenCalledTimes(3);
		expect(updateChangeRequest.mock.calls[1]?.[0].changeRequest).toMatchObject({
			number: 17,
			headBranch,
			headCommit: 'updated-head-1',
		});
		expect(updateChangeRequest.mock.calls[2]?.[0].changeRequest).toMatchObject({
			number: 17,
			headBranch,
			headCommit: 'updated-head-2',
		});
		expect(
			(await env.proposals.getProposal(projectId, notebookId, initial.proposal_id)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'updated-head-3' } });
	});

	it('repairs a legacy update chain whose root publication has a stale head', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		let updateCount = 0;
		const updateChangeRequest = vi.fn<NonNullable<SourceControlPublisher['updateChangeRequest']>>(
			async (input) => ({
				...input.changeRequest,
				headCommit: `updated-head-${++updateCount}`,
			}),
		);
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const rootPublicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(initial.proposal_id).publication;
		const initialPublication = await env.bucket.get(rootPublicationPath);
		if (!initialPublication) throw new Error('expected root publication');
		const initialPublicationBody = await initialPublication.text();

		const legacyUpdate = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: legacyUpdate.proposal_id,
			publisher,
			title: 'Second update',
			body: '',
		});
		await env.bucket.put(rootPublicationPath, initialPublicationBody);

		const nextUpdate = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("third")' } }).instance,
			{ targetProposalId: legacyUpdate.proposal_id },
		);
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: nextUpdate.proposal_id,
			publisher,
			title: 'Third update',
			body: '',
		});
		const updateFromRoot = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("fourth")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: updateFromRoot.proposal_id,
			publisher,
			title: 'Fourth update',
			body: '',
		});

		expect(updateChangeRequest).toHaveBeenCalledTimes(3);
		expect(updateChangeRequest.mock.calls[1]?.[0].changeRequest.headCommit).toBe('updated-head-1');
		expect(updateChangeRequest.mock.calls[2]?.[0].changeRequest.headCommit).toBe('updated-head-2');
	});

	it('repairs the shared head on replay after its publication write fails', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const updateChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch,
			headCommit: 'updated-head',
		}));
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		const rootPublicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(initial.proposal_id).publication;
		let failRootWrite = true;
		const service = new NotebookProposalService(
			proxyBucket(async (key, value, options) => {
				if (key === rootPublicationPath && options?.onlyIfEtagMatches && failRootWrite) {
					failRootWrite = false;
					throw new Error('temporary root publication failure');
				}
				return env.bucket.put(key, value, options);
			}),
		);

		await expect(
			service.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				publisher,
				title: 'Second update',
				body: '',
			}),
		).rejects.toThrow('temporary root publication failure');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, update.proposal_id)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'updated-head' } });

		await expect(
			service.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				title: 'Ignored on replay',
				body: '',
			}),
		).resolves.toMatchObject({ headCommit: 'updated-head' });
		expect(updateChangeRequest).toHaveBeenCalledOnce();
		expect(
			(await env.proposals.getProposal(projectId, notebookId, initial.proposal_id)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'updated-head' } });
	});

	it('does not advance the shared head before the update publication is durable', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const updateChangeRequest = vi.fn(async (input) => ({
			...input.changeRequest,
			headCommit: 'updated-head',
		}));
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		const updatePublicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(update.proposal_id).publication;
		let failUpdatePublication = true;
		const service = new NotebookProposalService(
			proxyBucket(async (key, value, options) => {
				if (key === updatePublicationPath && options?.onlyIfEtagMatches && failUpdatePublication) {
					failUpdatePublication = false;
					throw new Error('temporary update publication failure');
				}
				return env.bucket.put(key, value, options);
			}),
		);
		const publishInput = {
			projectId,
			notebookId,
			proposalId: update.proposal_id,
			publisher,
			title: 'Second update',
			body: '',
		};

		await expect(service.publishChangeRequest(publishInput)).rejects.toThrow(
			'temporary update publication failure',
		);
		expect(
			(await env.proposals.getProposal(projectId, notebookId, initial.proposal_id)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'initial-head' } });

		await expect(service.publishChangeRequest(publishInput)).resolves.toMatchObject({
			headCommit: 'updated-head',
		});
		expect(updateChangeRequest).toHaveBeenCalledTimes(2);
		expect(updateChangeRequest.mock.calls[1]?.[0].changeRequest.headCommit).toBe('initial-head');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, initial.proposal_id)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'updated-head' } });
	});

	it('advances the shared head with the publication CAS winner during concurrent updates', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const firstProviderResult = deferred<OpenChangeRequestResult>();
		const secondProviderResult = deferred<OpenChangeRequestResult>();
		let providerCalls = 0;
		const updateChangeRequest = vi.fn(() =>
			++providerCalls === 1 ? firstProviderResult.promise : secondProviderResult.promise,
		);
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		const proposalPaths = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(update.proposal_id);
		const rootPublicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(initial.proposal_id).publication;
		const rootReadBlocked = deferred<void>();
		const releaseRootRead = deferred<void>();
		let updatePublicationStored = false;
		let blockedRootRead = false;
		const service = new NotebookProposalService(
			proxyBucket(
				async (key, value, options) => {
					const stored = await env.bucket.put(key, value, options);
					if (key === proposalPaths.publication && options?.onlyIfEtagMatches) {
						updatePublicationStored = true;
					}
					return stored;
				},
				(key) => env.bucket.delete(key),
				async (key) => {
					if (key === rootPublicationPath && updatePublicationStored && !blockedRootRead) {
						blockedRootRead = true;
						rootReadBlocked.resolve();
						await releaseRootRead.promise;
					}
					return env.bucket.get(key);
				},
			),
		);
		const publishInput = {
			projectId,
			notebookId,
			proposalId: update.proposal_id,
			publisher,
			title: 'Second update',
			body: '',
		};
		const first = service.publishChangeRequest(publishInput);
		const second = service.publishChangeRequest(publishInput);
		await vi.waitFor(() => expect(updateChangeRequest).toHaveBeenCalledTimes(2));

		firstProviderResult.resolve({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch,
			headCommit: 'cas-winner-head',
		});
		await rootReadBlocked.promise;
		secondProviderResult.resolve({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch,
			headCommit: 'racing-local-head',
		});
		const secondResult = await second;
		releaseRootRead.resolve();
		const firstResult = await first;

		expect(firstResult.headCommit).toBe('cas-winner-head');
		expect(secondResult.headCommit).toBe('cas-winner-head');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, initial.proposal_id)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'cas-winner-head' } });
	});

	it('returns a published update when best-effort target repair cannot read the target', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'updated-head',
			})),
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: initial.proposal_id },
		);
		const published = await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: update.proposal_id,
			publisher,
			title: 'Second update',
			body: '',
		});
		const targetMetaPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(initial.proposal_id).meta;
		const replayService = new NotebookProposalService(
			proxyBucket(
				(key, value, options) => env.bucket.put(key, value, options),
				(key) => env.bucket.delete(key),
				async (key) => {
					if (key === targetMetaPath) throw new Error('temporary target read failure');
					return env.bucket.get(key);
				},
			),
		);

		await expect(
			replayService.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				title: 'Ignored on replay',
				body: '',
			}),
		).resolves.toEqual(published);
	});

	it('rejects a missing update target before calling the provider', async () => {
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ targetProposalId: createProposalId() },
		);
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(),
			updateChangeRequest: vi.fn(),
		};

		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				publisher,
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('not found');
		expect(publisher.openChangeRequest).not.toHaveBeenCalled();
		expect(publisher.updateChangeRequest).not.toHaveBeenCalled();
	});

	it('rejects an update captured from a different session than its target', async () => {
		const initial = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("first")' } }).instance,
		);
		const headBranch = `marimohub/${notebookId}/${initial.proposal_id}`;
		const updateChangeRequest = vi.fn<NonNullable<SourceControlPublisher['updateChangeRequest']>>();
		const publisher: SourceControlPublisher = {
			provider: 'github',
			openChangeRequest: vi.fn(async () => ({
				number: 17,
				url: 'https://github.com/owner/repo/pull/17',
				headBranch,
				headCommit: 'initial-head',
			})),
			updateChangeRequest,
		};
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId: initial.proposal_id,
			publisher,
			title: 'Initial update',
			body: '',
		});
		const otherSession = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			source_version_id: versionId,
		});
		const update = await capture(
			makeFsSandbox({ files: { 'dashboard.py': 'print("second")' } }).instance,
			{ session: otherSession, targetProposalId: initial.proposal_id },
		);

		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: update.proposal_id,
				publisher,
				title: 'Second update',
				body: '',
			}),
		).rejects.toThrow('target proposal belongs to a different change request');
		expect(updateChangeRequest).not.toHaveBeenCalled();
	});

	it.each([
		['another project', () => ({ project_id: createProjectId() })],
		['another notebook', () => ({ notebook_id: createNotebookId() })],
		['a stopped session', () => ({ status: 'terminated' as const })],
		['an app session', () => ({ mode: 'app' as const })],
		['an ephemeral session', () => ({ ephemeral: true })],
	])('rejects %s before inspecting the sandbox', async (_label, sessionOverrides) => {
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await expect(
			capture(instance, { session: { ...session, ...sessionOverrides() } }),
		).rejects.toThrow('running persistent editor session');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects a session without a source version', async () => {
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await expect(
			capture(instance, { session: { ...session, source_version_id: undefined } }),
		).rejects.toThrow('no synced source revision');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects a source version that does not exist', async () => {
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await expect(
			capture(instance, {
				session: { ...session, source_version_id: createVersionId() },
			}),
		).rejects.toThrow('not found');
		expect(calls.readFile).toHaveLength(0);
	});

	it('maps a sandbox listing failure to a safe conflict', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const sandbox = { ...instance, listFiles: async () => listFilesFailure('BACKEND_ERROR') };
		await expect(capture(sandbox)).rejects.toThrow('Could not inspect');
	});

	it('rejects a missing entry notebook', async () => {
		const { instance } = makeFsSandbox({ files: { 'other.py': 'changed' } });
		await expect(capture(instance)).rejects.toThrow('missing from the session');
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
		'rejects invalid listed file size %s',
		async (size) => {
			const { instance, calls } = makeFsSandbox({
				files: { 'dashboard.py': 'changed' },
				sizes: { 'dashboard.py': size },
			});
			await expect(capture(instance)).rejects.toThrow('invalid file metadata');
			expect(calls.readFile).toHaveLength(0);
		},
	);

	it('rejects an oversized listing without buffering the file', async () => {
		const { instance, calls } = makeFsSandbox({
			files: { 'dashboard.py': 'changed' },
			sizes: { 'dashboard.py': MAX_REQUEST_BYTES + 1 },
		});
		await expect(capture(instance)).rejects.toThrow('exceeds');
		expect(calls.readFile).toHaveLength(0);
	});

	it('maps a sandbox read failure to a safe conflict', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const sandbox = { ...instance, readFile: async () => readFileFailure('BACKEND_ERROR') };
		await expect(capture(sandbox)).rejects.toThrow('Could not read');
	});

	it.each([
		['an unknown encoding', { content: 'changed', encoding: 'utf-16' }],
		['invalid base64', { content: '%not-base64%', encoding: 'base64' }],
	])('rejects %s returned by the sandbox', async (_label, readResult) => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const sandbox: SandboxInstance = {
			...instance,
			readFile: async () =>
				({ success: true, ...readResult }) as Awaited<ReturnType<SandboxInstance['readFile']>>,
		};
		await expect(capture(sandbox)).rejects.toThrow(/invalid (encoding|base64 content)/);
	});

	it('returns an existing proposal without touching the sandbox', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const first = await capture(instance, { proposalId });
		const unreachable: SandboxInstance = {
			...instance,
			listFiles: async () => {
				throw new Error('must not list');
			},
		};
		await expect(capture(unreachable, { proposalId })).resolves.toEqual(first);
	});

	it('concurrent first-use captures reuse immutable objects without cleanup', async () => {
		const proposalId = createProposalId();
		const puts: { key: string; options?: BucketPutOptions }[] = [];
		const deleteObject = vi.fn<Bucket['delete']>((key) => env.bucket.delete(key));
		const bucket = proxyBucket(async (key, value, options) => {
			puts.push({ key, options });
			return env.bucket.put(key, value, options);
		}, deleteObject);
		const service = new NotebookProposalService(bucket);
		const first = makeFsSandbox({ files: { 'dashboard.py': 'concurrent change' } }).instance;
		const second = makeFsSandbox({ files: { 'dashboard.py': 'concurrent change' } }).instance;

		const [left, right] = await Promise.all([
			captureWith(service, first, proposalId),
			captureWith(service, second, proposalId),
		]);

		expect(right).toEqual(left);
		expect(puts.filter(({ key }) => key.includes(`/proposals/${proposalId}/`))).not.toHaveLength(0);
		expect(
			puts
				.filter(({ key }) => key.includes(`/proposals/${proposalId}/`))
				.every(({ options }) => options?.onlyIfNotExists === true),
		).toBe(true);
		const markerPuts = puts.filter(
			({ key }) => key === paths.proposalPayloadMarker(projectId, notebookId, proposalId),
		);
		expect(markerPuts).not.toHaveLength(0);
		expect(markerPuts.every(({ options }) => options?.onlyIfNotExists === true)).toBe(true);
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it('never resets a publication completed during a capture retry', async () => {
		const proposalId = createProposalId();
		const sandbox = makeFsSandbox({ files: { 'dashboard.py': 'published change' } }).instance;
		const proposal = await capture(sandbox, { proposalId });
		const openChangeRequest = vi.fn(async () => ({
			number: 17,
			url: 'https://github.com/owner/repo/pull/17',
			headBranch: `marimohub/${notebookId}/${proposalId}`,
			headCommit: 'published-head',
		}));
		await env.proposals.publishChangeRequest({
			projectId,
			notebookId,
			proposalId,
			publisher: { provider: 'github', openChangeRequest },
			title: 'Update',
			body: '',
		});

		const publicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(proposalId).publication;
		let hidePublishedStateOnce = true;
		const bucket = proxyBucket(
			(key, value, options) => env.bucket.put(key, value, options),
			(key) => env.bucket.delete(key),
			async (key) => {
				if (key === publicationPath && hidePublishedStateOnce) {
					hidePublishedStateOnce = false;
					return null;
				}
				return env.bucket.get(key);
			},
		);

		await expect(
			captureWith(new NotebookProposalService(bucket), sandbox, proposalId),
		).resolves.toEqual(proposal);
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposalId)).publication,
		).toMatchObject({ state: 'published', change_request: { head_commit: 'published-head' } });
		expect(openChangeRequest).toHaveBeenCalledOnce();
	});

	it('repairs an interrupted capture without deleting its immutable manifest', async () => {
		const proposalId = createProposalId();
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		let failContentWrite = true;
		const deleteObject = vi.fn<Bucket['delete']>((key) => env.bucket.delete(key));
		const bucket = proxyBucket(async (key, value, options) => {
			if (key === proposalPaths.change(0) && failContentWrite) {
				failContentWrite = false;
				throw new Error('temporary storage failure');
			}
			return env.bucket.put(key, value, options);
		}, deleteObject);
		const service = new NotebookProposalService(bucket);
		const sandbox = makeFsSandbox({ files: { 'dashboard.py': 'repairable change' } }).instance;

		await expect(captureWith(service, sandbox, proposalId)).rejects.toThrow(
			'temporary storage failure',
		);
		expect(await env.bucket.head(proposalPaths.meta)).not.toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).toBeNull();
		expect(deleteObject).not.toHaveBeenCalled();

		await expect(captureWith(service, sandbox, proposalId)).resolves.toMatchObject({
			proposal_id: proposalId,
		});
		expect(await env.bucket.head(proposalPaths.change(0))).not.toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).not.toBeNull();
	});

	it('repairs a partially written multi-file capture by content hash', async () => {
		const proposalId = createProposalId();
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		let failSecondContentWrite = true;
		const deleteObject = vi.fn<Bucket['delete']>((key) => env.bucket.delete(key));
		const bucket = proxyBucket(async (key, value, options) => {
			if (key === proposalPaths.change(1) && failSecondContentWrite) {
				failSecondContentWrite = false;
				throw new Error('temporary second-file failure');
			}
			return env.bucket.put(key, value, options);
		}, deleteObject);
		const service = new NotebookProposalService(bucket);
		const sandbox = makeGitSandbox({
			files: { 'first.txt': 'first', 'second.txt': 'second' },
			untracked: ['first.txt', 'second.txt'],
		}).instance;

		await expect(captureWith(service, sandbox, proposalId)).rejects.toThrow(
			'temporary second-file failure',
		);
		await expect(captureWith(service, sandbox, proposalId)).resolves.toMatchObject({
			proposal_id: proposalId,
			changes: [
				expect.objectContaining({ path: 'first.txt' }),
				expect.objectContaining({ path: 'second.txt' }),
			],
		});
		expect(await (await env.bucket.get(proposalPaths.change(0)))?.text()).toBe('first');
		expect(await (await env.bucket.get(proposalPaths.change(1)))?.text()).toBe('second');
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it('does not overwrite an interrupted capture with different session content', async () => {
		const proposalId = createProposalId();
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		let failContentWrite = true;
		const bucket = proxyBucket(async (key, value, options) => {
			if (key === proposalPaths.change(0) && failContentWrite) {
				failContentWrite = false;
				throw new Error('temporary storage failure');
			}
			return env.bucket.put(key, value, options);
		});
		const service = new NotebookProposalService(bucket);
		const original = makeFsSandbox({ files: { 'dashboard.py': 'first change' } }).instance;
		const different = makeFsSandbox({ files: { 'dashboard.py': 'second change' } }).instance;

		await expect(captureWith(service, original, proposalId)).rejects.toThrow();
		const manifestBefore = await (await env.bucket.get(proposalPaths.meta))?.text();
		await expect(captureWith(service, different, proposalId)).rejects.toThrow(
			'already capturing different workspace content',
		);
		expect(await (await env.bucket.get(proposalPaths.meta))?.text()).toBe(manifestBefore);
		expect(await env.bucket.head(proposalPaths.change(0))).toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).toBeNull();
	});

	it('rejects reuse of a proposal id by another author', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await capture(instance, { proposalId });
		await expect(capture(instance, { proposalId, author: uid('another-author') })).rejects.toThrow(
			'different proposal',
		);
	});

	it('rejects reuse of a proposal id for another source revision', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		await capture(instance, { proposalId });
		await expect(
			capture(instance, {
				proposalId,
				session: { ...session, source_version_id: createVersionId() },
			}),
		).rejects.toThrow('different source revision');
	});

	it('reports a missing proposal consistently', async () => {
		await expect(
			env.proposals.getProposal(projectId, notebookId, createProposalId()),
		).rejects.toThrow('not found');
	});

	it('reuses only proposals whose captured payload is complete', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance, { proposalId });
		const changePath = paths.project(projectId).notebook(notebookId).proposal(proposalId).change(0);

		const reusable = await env.proposals.getReusableProposal(projectId, notebookId, proposalId);
		expect(reusable?.proposal).toEqual(proposal);
		expect(reusable?.publication.state).toBe('pending');
		await env.bucket.delete(changePath);
		await expect(
			env.proposals.getReusableProposal(projectId, notebookId, proposalId),
		).resolves.toBeUndefined();
	});

	it('resolves repository coordinates for a version written before git_source was stored', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await env.bucket.put(versionPath, JSON.stringify(legacyVersion));
		const legacySource = {
			provider: 'github',
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
			commit: 'abc123',
		};

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId, legacySource),
		).resolves.toEqual(legacySource);
	});

	it('explains how to recover when a legacy version has no repository provenance', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await env.bucket.put(versionPath, JSON.stringify(legacyVersion));

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId),
		).rejects.toThrow('restart from the latest synced version');
	});

	it('rejects legacy repository coordinates for a different commit', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const { git_source: _gitSource, ...legacyVersion } =
			await object.json<Record<string, unknown>>();
		await env.bucket.put(versionPath, JSON.stringify(legacyVersion));

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId, {
				provider: 'github',
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
				commit: 'different-commit',
			}),
		).rejects.toThrow('missing repository coordinates');
	});

	it('rejects outbound publishing when the synced repository provider is unknown', async () => {
		const versionPath = paths.project(projectId).notebook(notebookId).version(versionId).meta;
		const object = await env.bucket.get(versionPath);
		if (!object) throw new Error('expected version');
		const version = await object.json<Record<string, unknown>>();
		version.git_source = {
			provider: null,
			repo: 'https://code.example.org/team/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
			commit: 'abc123',
		};
		await env.bucket.put(versionPath, JSON.stringify(version));
		const { instance, calls } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });

		await expect(capture(instance)).rejects.toThrow('no recognized source-control provider');
		expect(calls.readFile).toHaveLength(0);
	});

	it('rejects a publisher for a different provider before reading change bytes', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		const publisher: SourceControlPublisher = {
			provider: 'gitlab',
			openChangeRequest: vi.fn(),
		};
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher,
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('No publisher');
		expect(publisher.openChangeRequest).not.toHaveBeenCalled();
	});

	it('does not call the provider when proposal content is missing', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		await env.bucket.delete(
			paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
		);
		const openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>();
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: { provider: 'github', openChangeRequest },
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('change 0 not found');
		expect(openChangeRequest).not.toHaveBeenCalled();

		await expect(capture(instance, { proposalId: proposal.proposal_id })).resolves.toEqual(
			proposal,
		);
		expect(
			await env.bucket.head(
				paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
			),
		).not.toBeNull();
	});

	it('retains a synced source revision referenced by a persistent session', async () => {
		const liveSession = await env.sessions.createSession({
			project_id: projectId,
			notebook_id: notebookId,
			user_id: ACTOR,
			source_version_id: versionId,
		});
		for (let i = 0; i <= MAX_VERSIONS; i++) {
			await env.notebooks.synced.sync(projectId, notebookId, {
				repo: 'owner/repo',
				branch: 'main',
				root_path: 'apps',
				commit: `later-${i}`,
				files: [{ path: 'dashboard.py', bytes: encode(`print(${i})`) }],
			});
		}

		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId),
		).resolves.toMatchObject({ commit: 'abc123', provider: 'github' });
		await env.sessions.markFailed(projectId, liveSession.session_id);
		await env.notebooks.synced.sync(projectId, notebookId, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			commit: 'after-session',
			files: [{ path: 'dashboard.py', bytes: encode('print("done")') }],
		});
		await expect(
			env.proposals.resolveSourceRevision(projectId, notebookId, versionId),
		).rejects.toThrow('not found');
	});

	it('does not publish corrupted proposal content', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		await env.bucket.put(
			paths.project(projectId).notebook(notebookId).proposal(proposal.proposal_id).change(0),
			'corrupted',
		);
		const openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>();
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: { provider: 'github', openChangeRequest },
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('integrity check');
		expect(openChangeRequest).not.toHaveBeenCalled();
	});

	it.each([
		['a non-positive number', { number: 0 }],
		['an insecure URL', { url: 'http://github.com/owner/repo/pull/1' }],
		['an empty commit', { headCommit: '' }],
		['a different branch', { headBranch: 'someone/else' }],
	])('does not persist %s returned by a provider', async (_label, invalid) => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		const expectedBranch = `marimohub/${notebookId}/${proposal.proposal_id}`;
		const result = {
			number: 1,
			url: 'https://github.com/owner/repo/pull/1',
			headBranch: expectedBranch,
			headCommit: 'head-sha',
			...invalid,
		} as OpenChangeRequestResult;
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: { provider: 'github', openChangeRequest: async () => result },
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('invalid change request');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposal.proposal_id)).publication,
		).toMatchObject({ state: 'pending' });
	});

	it('leaves the proposal pending when the provider is unavailable', async () => {
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'changed' } });
		const proposal = await capture(instance);
		await expect(
			env.proposals.publishChangeRequest({
				projectId,
				notebookId,
				proposalId: proposal.proposal_id,
				publisher: {
					provider: 'github',
					openChangeRequest: async () => {
						throw new Error('provider secret');
					},
				},
				title: 'Update',
				body: '',
			}),
		).rejects.toThrow('provider secret');
		expect(
			(await env.proposals.getProposal(projectId, notebookId, proposal.proposal_id)).publication,
		).toMatchObject({ state: 'pending' });
	});

	it('prunes expired change bytes but retains proposal audit metadata', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'retained metadata' } });
		const proposal = await capture(instance, { proposalId });
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		const markerPath = paths.proposalPayloadMarker(projectId, notebookId, proposalId);
		const expiresAt = Date.parse(proposal.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS;
		const sweepAt = expiresAt + DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;

		expect(await env.proposals.pruneExpiredPayloads({ nowMs: sweepAt - 1 })).toBe(0);
		expect(await env.bucket.head(proposalPaths.change(0))).not.toBeNull();

		const originalList = env.bucket.list.bind(env.bucket);
		env.bucket.list = (options) => originalList({ ...options, limit: 1 });
		try {
			expect(await env.proposals.pruneExpiredPayloads({ nowMs: sweepAt })).toBe(1);
		} finally {
			env.bucket.list = originalList;
		}
		expect(await env.bucket.head(proposalPaths.change(0))).toBeNull();
		expect(await env.bucket.head(markerPath)).toBeNull();
		expect(await env.bucket.head(proposalPaths.meta)).not.toBeNull();
		expect(await env.bucket.head(proposalPaths.publication)).not.toBeNull();
	});

	it('prunes every retained payload in a multi-file proposal', async () => {
		const proposalId = createProposalId();
		const proposal = await capture(
			makeGitSandbox({
				files: { 'first.txt': 'first', 'second.txt': 'second' },
				untracked: ['first.txt', 'second.txt'],
			}).instance,
			{ proposalId },
		);
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		const markerPath = paths.proposalPayloadMarker(projectId, notebookId, proposalId);
		const sweepAt =
			Date.parse(proposal.created_at) +
			DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS +
			DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;

		expect(await env.proposals.pruneExpiredPayloads({ nowMs: sweepAt })).toBe(1);
		expect(await env.bucket.head(proposalPaths.change(0))).toBeNull();
		expect(await env.bucket.head(proposalPaths.change(1))).toBeNull();
		expect(await env.bucket.head(markerPath)).toBeNull();
	});

	it('skips malformed retention markers without blocking valid payload pruning', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'expires' } });
		const proposal = await capture(instance, { proposalId });
		const invalidMarker = `${paths.proposalPayloadMarkersPrefix}invalid.json`;
		await env.bucket.put(invalidMarker, '{not json');

		const now =
			Date.parse(proposal.created_at) +
			DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS +
			DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;
		expect(await env.proposals.pruneExpiredPayloads({ nowMs: now })).toBe(1);
		expect(await env.bucket.head(invalidMarker)).not.toBeNull();
	});

	it('keeps the retention marker when deleting proposal content fails', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'retry cleanup' } });
		const proposal = await capture(instance, { proposalId });
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		const markerPath = paths.proposalPayloadMarker(projectId, notebookId, proposalId);
		const bucket = proxyBucket(
			(key, value, options) => env.bucket.put(key, value, options),
			async (key) => {
				if (
					(typeof key === 'string' && key === proposalPaths.change(0)) ||
					(Array.isArray(key) && key.includes(proposalPaths.change(0)))
				) {
					throw new Error('temporary delete failure');
				}
				return env.bucket.delete(key);
			},
		);
		const service = new NotebookProposalService(bucket);
		const now =
			Date.parse(proposal.created_at) +
			DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS +
			DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;

		expect(await service.pruneExpiredPayloads({ nowMs: now })).toBe(0);
		expect(await env.bucket.head(proposalPaths.change(0))).not.toBeNull();
		expect(await env.bucket.head(markerPath)).not.toBeNull();
	});

	it('rejects expired proposal payloads before inspecting the sandbox or calling a provider', async () => {
		const proposalId = createProposalId();
		const { instance } = makeFsSandbox({ files: { 'dashboard.py': 'expires' } });
		const proposal = await capture(instance, { proposalId });
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse(proposal.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS);
		try {
			await expect(
				env.proposals.getReusableProposal(projectId, notebookId, proposalId),
			).rejects.toMatchObject({
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: expect.stringContaining('retry with a new idempotency key'),
			});
			const unreachable = makeFsSandbox({ files: { 'dashboard.py': 'unused' } });
			await expect(capture(unreachable.instance, { proposalId })).rejects.toMatchObject({
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: expect.stringContaining('retry with a new idempotency key'),
			});
			expect(unreachable.calls.readFile).toHaveLength(0);

			const openChangeRequest = vi.fn<SourceControlPublisher['openChangeRequest']>();
			await expect(
				env.proposals.publishChangeRequest({
					projectId,
					notebookId,
					proposalId,
					publisher: { provider: 'github', openChangeRequest },
					title: 'Update',
					body: '',
				}),
			).rejects.toMatchObject({
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: expect.stringContaining('payload expired'),
			});
			expect(openChangeRequest).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a non-finite maintenance clock without scanning storage', async () => {
		const list = vi.spyOn(env.bucket, 'list');
		await expect(env.proposals.pruneExpiredPayloads({ nowMs: Number.NaN })).rejects.toThrow(
			'nowMs must be finite',
		);
		expect(list).not.toHaveBeenCalled();
	});
});

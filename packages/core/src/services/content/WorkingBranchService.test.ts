import { MAX_REQUEST_BYTES, MAX_WORKSPACE_FILES, MAX_WORKSPACE_BYTES } from '../../constants';
import { paths } from '../../paths';
import { workspaceManifest } from './workspaceManifest';
import { proposalSha256 } from './proposalUtils';
import { captureWorkingBranchChanges } from './proposalCapture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	unlinkSync,
	symlinkSync,
	mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import { ACTOR, makeFsSandbox, setupTestEnv, uid } from '../../testing';
import { createSandboxId, createVersionId } from '../../ids';
import type { NotebookId, ProjectId, SessionId } from '../../ids';
import type {
	SourceControlReader,
	SourceControlRegistry,
	WorkingBranchWriter,
} from '../../ports/sourceControl';
import { execResult } from '../../ports/sandbox';
import { ConflictError } from '../../errors';
import { WorkingBranchService } from './WorkingBranchService';
import {
	workingBranchPaths,
	WorkingBranchStore,
	WorkingBranchSaveSchema,
	WorkingBranchRecordSchema,
} from './workingBranchRecords';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('WorkingBranchService', { timeout: 60_000 }, () => {
	let env: Awaited<ReturnType<typeof setupTestEnv>>;
	let service: WorkingBranchService;
	let writer: WorkingBranchWriter;
	let reader: SourceControlReader;
	let registry: SourceControlRegistry;
	let pid: ProjectId;
	let nid: NotebookId;
	let sid: SessionId;
	let workdir: string;
	let head: string | null;
	let revision: number;
	let snapshots: Map<string, Map<string, Uint8Array>>;
	const encode = (text: string) => new TextEncoder().encode(text);
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', workdir, ...args], {
			encoding: 'utf8',
		}).trim();
	const createInput = {
		title: 'Dashboard',
		description: '',
		repo: 'owner/repo',
		base_branch: 'main',
		entry_notebook: 'dashboard.py',
	};

	beforeEach(async () => {
		env = await setupTestEnv();
		pid = (await env.projects.createProject({ name: 'P', description: '' }, ACTOR)).id;
		workdir = mkdtempSync(join(tmpdir(), 'working-branch-'));
		git('init', '-q');
		git('config', 'core.fsmonitor', 'false');
		git('config', 'user.email', 'test@example.com');
		git('config', 'user.name', 'Test');
		writeFileSync(join(workdir, 'dashboard.py'), 'base');
		writeFileSync(join(workdir, '.gitignore'), '*.ignored\n');
		git('add', '.');
		git('commit', '-qm', 'base');
		head = null;
		revision = 0;
		snapshots = new Map([
			[
				'base',
				new Map([
					['dashboard.py', encode('base')],
					['.gitignore', encode('*.ignored\n')],
				]),
			],
		]);
		writer = {
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
			})),
			openBranchChangeRequest: vi.fn(),
		};
		reader = {
			provider: 'github',
			supportsRepository: () => true,
			getBranchHead: async () => ({ commit: 'base' }),
			fetchWorkspace: vi.fn(async (_repo, commit) =>
				[...snapshots.get(commit)!].map(([path, bytes]) => ({ path, bytes })),
			),
			fetchGitDirectory: vi.fn(async () => [
				{ path: 'HEAD', bytes: encode('ref: refs/heads/main\n') },
			]),
		};
		registry = {
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
		service = new WorkingBranchService({ ...env, sourceControl: registry });
		const notebook = await service.create(pid, ACTOR, 'create', createInput);
		nid = notebook.meta.id;
		const session = await env.sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: notebook.source.current_version_id!,
		});
		sid = session.session_id;
		await env.sessions.setRunning(pid, sid, 'https://kernel.test');
		await env.sessions.claimEditor(pid, nid, sid, 'shared');
	}, 30_000);
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(workdir, { recursive: true, force: true });
	});
	function sandbox() {
		const instance = makeFsSandbox().instance;
		instance.exec = async (command) => {
			const result = spawnSync('/bin/sh', ['-c', command], {
				encoding: 'utf8',
				timeout: 20_000,
				maxBuffer: 20 * 1024 * 1024,
			});
			return execResult(result.status === 0, result.stdout ?? '', result.stderr ?? '');
		};
		return instance;
	}
	function save(key: string, message?: string, getSandbox = sandbox) {
		return service.save({
			projectId: pid,
			notebookId: nid,
			sessionId: sid,
			actor: ACTOR,
			idempotencyKey: key,
			message,
			workdir,
			getSandbox,
		});
	}

	it('replays creation without another branch or catalog entry', async () => {
		const replay = await service.create(pid, ACTOR, 'create', createInput);
		expect(replay.meta.id).toBe(nid);
		expect(writer.createBranch).toHaveBeenCalledTimes(1);
		await expect(
			service.create(pid, ACTOR, 'create', { ...createInput, title: 'Different' }),
		).rejects.toThrow('different notebook settings');
	});
	it(
		'saves additions repeatedly without importing commits or modifying the live index',
		{ timeout: 60_000 },
		async () => {
			const originalIndex = readFileSync(join(workdir, '.git/index'));
			const originalHead = git('rev-parse', 'HEAD');
			writeFileSync(join(workdir, 'new.py'), 'first');
			const first = await save('one');
			expect(first.state).toBe('complete');
			expect(first.changes).toEqual([
				expect.objectContaining({ path: 'new.py', operation: 'add' }),
			]);
			writeFileSync(join(workdir, 'new.py'), 'second');
			const second = await save('two');
			expect(second.state).toBe('complete');
			expect(second.base_commit).toBe(first.commit);
			expect(second.changes).toEqual([
				expect.objectContaining({ path: 'new.py', operation: 'modify' }),
			]);
			unlinkSync(join(workdir, 'new.py'));
			expect((await save('three')).changes).toEqual([{ path: 'new.py', operation: 'delete' }]);
			expect(readFileSync(join(workdir, '.git/index'))).toEqual(originalIndex);
			expect(git('rev-parse', 'HEAD')).toBe(originalHead);
			expect((await save('four')).state).toBe('no_changes');
		},
	);
	it('hashes a folder in one batch and reads only changed payloads', async () => {
		const session = await env.sessions.getSession(pid, sid);
		const base = paths.project(pid).notebook(nid).version(session.source_version_id!);
		const files = new Map(snapshots.get('base'));
		for (let i = 0; i < 100; i++) {
			const path = `unchanged-${i}.txt`;
			const content = encode(`baseline ${i}`);
			files.set(path, content);
			writeFileSync(join(workdir, path), content);
			await env.bucket.put(base.workspaceFile(path), content);
		}
		await env.bucket.put(base.workspaceManifest, JSON.stringify(await workspaceManifest(files)));
		const instance = sandbox();
		const exec = vi.spyOn(instance, 'exec');
		const get = vi.spyOn(env.bucket, 'get');
		const capture = () =>
			captureWorkingBranchChanges(
				env.bucket,
				instance,
				{ workdir, gitRoot: workdir, rootPath: '' },
				base,
			);
		expect((await capture()).changes).toEqual([]);
		expect(exec.mock.calls.filter(([command]) => command.includes('hashlib.sha256'))).toHaveLength(
			1,
		);
		expect(exec.mock.calls.filter(([command]) => command.includes('allow-missing'))).toHaveLength(
			0,
		);
		expect(get.mock.calls.filter(([key]) => key.startsWith(base.workspacePrefix))).toHaveLength(0);
		exec.mockClear();
		writeFileSync(join(workdir, 'dashboard.py'), 'edited');
		expect((await capture()).changes.map(({ change }) => change.path)).toEqual(['dashboard.py']);
		expect(exec.mock.calls.filter(([command]) => command.includes('allow-missing'))).toHaveLength(
			1,
		);
		expect(get.mock.calls.filter(([key]) => key.startsWith(base.workspacePrefix))).toHaveLength(0);
	});
	it('captures quoted Unicode paths, binary bytes, and empty files', async () => {
		const path = "notes 'quoted' café $value.txt";
		const bytes = new Uint8Array([0, 255, 13, 10]);
		writeFileSync(join(workdir, path), bytes);
		writeFileSync(join(workdir, 'empty.txt'), '');
		const saved = await save('unusual-files');
		expect(saved.state).toBe('complete');
		expect(snapshots.get(saved.commit!)!.get(path)).toEqual(bytes);
		expect(snapshots.get(saved.commit!)!.get('empty.txt')).toEqual(new Uint8Array());
		expect((await save('unusual-unchanged')).state).toBe('no_changes');
	});
	it('compares legacy baselines without a digest manifest', async () => {
		const session = await env.sessions.getSession(pid, sid);
		const base = paths.project(pid).notebook(nid).version(session.source_version_id!);
		await env.bucket.delete(base.workspaceManifest);
		const get = vi.spyOn(env.bucket, 'get');
		expect((await save('legacy-manifest')).state).toBe('no_changes');
		expect(get.mock.calls.filter(([key]) => key.startsWith(base.workspacePrefix))).toHaveLength(2);
	});
	it('rejects files that change between hashing and payload capture, then admits a fresh save', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'first edit');
		const instance = sandbox();
		const exec = instance.exec.bind(instance);
		instance.exec = async (...args) => {
			if (args[0].includes('allow-missing'))
				writeFileSync(join(workdir, 'dashboard.py'), 'second edit');
			return exec(...args);
		};
		await expect(save('unstable', undefined, () => instance)).rejects.toThrow(
			'changed during capture',
		);
		expect(writer.prepareCommit).not.toHaveBeenCalled();
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		expect((await save('stable')).state).toBe('complete');
	});
	it('releases admission when a bounded hash pass times out', async () => {
		const instance = sandbox();
		const exec = instance.exec.bind(instance);
		instance.exec = async (command, options) => {
			if (command.includes('hashlib.sha256')) {
				expect(options?.timeout).toBe(60_000);
				return execResult(false, '', 'command timed out');
			}
			return exec(command, options);
		};
		await expect(save('hash-timeout', undefined, () => instance)).rejects.toThrow('timed out');
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('rejects a mismatched digest response before reading payloads', async () => {
		const instance = sandbox();
		const exec = instance.exec.bind(instance);
		instance.exec = async (...args) => {
			const result = await exec(...args);
			if (args[0].includes('hashlib.sha256')) result.stdout = '[]';
			return result;
		};
		await expect(save('bad-digest', undefined, () => instance)).rejects.toThrow('digest paths');
		expect(writer.prepareCommit).not.toHaveBeenCalled();
	});
	it('loads the retry receipt once under the lease and does not fabricate missing operations', async () => {
		const saved = await save('already-saved');
		const getSave = vi.spyOn(service, 'getSave');
		await service.resume(pid, nid, saved.id, ACTOR, { workdir, getSandbox: sandbox });
		expect(getSave).toHaveBeenCalledTimes(1);
		expect(getSave).toHaveBeenCalledWith(pid, nid, saved.id);
		await expect(
			service.resume(pid, nid, 'a'.repeat(64), ACTOR, { workdir, getSandbox: sandbox }),
		).rejects.toThrow('not found');
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
	});
	it('saves a small edit alongside an unchanged asset above the change-size limit', async () => {
		const asset = new Uint8Array(MAX_REQUEST_BYTES + 1);
		const session = await env.sessions.getSession(pid, sid);
		await env.bucket.put(
			paths
				.project(pid)
				.notebook(nid)
				.version(session.source_version_id!)
				.workspaceFile('asset.bin'),
			asset,
		);
		snapshots.get('base')!.set('asset.bin', asset);
		writeFileSync(join(workdir, 'asset.bin'), asset);
		writeFileSync(join(workdir, 'dashboard.py'), 'small edit');
		const saved = await save('small');
		expect(saved.state).toBe('complete');
		expect(saved.changes.map((change) => change.path)).toEqual(['dashboard.py']);
		const changed = new Uint8Array(asset);
		changed[0] = 1;
		writeFileSync(join(workdir, 'asset.bin'), changed);
		await expect(save('oversized-change')).rejects.toThrow('content limit');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('rejects a 1001-file result, retains recovery, and admits a corrected save at the limit', async () => {
		const session = await env.sessions.getSession(pid, sid);
		const base = paths.project(pid).notebook(nid).version(session.source_version_id!);
		const tree = snapshots.get('base')!;
		for (let i = tree.size; i < MAX_WORKSPACE_FILES; i++) {
			const path = `file-${i}.txt`;
			tree.set(path, encode('base'));
			await env.bucket.put(base.workspaceFile(path), 'base');
		}
		const live = new Map(tree);
		live.set('extra.txt', encode('extra'));
		const virtualSandbox = () => {
			const instance = makeFsSandbox().instance;
			instance.exec = async (command) => {
				if (command.includes('printf git-working-tree'))
					return execResult(true, 'git-working-tree', '');
				if (command.includes('ls-files'))
					return execResult(true, `${[...live.keys()].join('\0')}\0`, '');
				if (command.includes('hashlib.sha256')) {
					const paths = JSON.parse(/'(\[.*\])' \d+$/.exec(command)![1]) as string[];
					return execResult(
						true,
						JSON.stringify(
							await Promise.all(
								paths.map(async (path) => {
									const bytes = live.get(path);
									return bytes
										? { path, size_bytes: bytes.byteLength, sha256: await proposalSha256(bytes) }
										: { path, missing: true };
								}),
							),
						),
						'',
					);
				}
				const path = /'([^']+)' \d+ allow-missing$/.exec(command)![1];
				const bytes = live.get(path);
				return execResult(true, bytes ? Buffer.from(bytes).toString('base64') : '-', '');
			};
			return instance;
		};
		const rejected = await save('too-many', undefined, virtualSandbox);
		expect(rejected.state).toBe('conflict');
		expect(rejected.error).toContain('import limits');
		expect(writer.prepareCommit).not.toHaveBeenCalled();
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		expect(unzipSync(await service.recovery(pid, nid, rejected.id))['files/extra.txt']).toEqual(
			encode('extra'),
		);
		live.delete('file-2.txt');
		const corrected = await save('corrected', undefined, virtualSandbox);
		expect(corrected.state).toBe('complete');
		expect(snapshots.get(corrected.commit!)!.size).toBe(MAX_WORKSPACE_FILES);
	});
	it('tallies workspace size once while checking the remote before and after preparation', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'edit');
		const session = await env.sessions.getSession(pid, sid);
		const prefix = paths
			.project(pid)
			.notebook(nid)
			.version(session.source_version_id!).workspacePrefix;
		const list = vi.spyOn(env.bucket, 'list');
		vi.mocked(writer.inspectBranch).mockClear();
		expect((await save('single-tally')).state).toBe('complete');
		// Capture enumerates the baseline once; preparation tallies the resulting tree once.
		expect(list.mock.calls.filter(([options]) => options?.prefix === prefix)).toHaveLength(2);
		expect(writer.inspectBranch).toHaveBeenCalledTimes(2);
	});
	it('rejects a remote change during preparation before dispatching', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'edit');
		const prepare = vi.mocked(writer.prepareCommit).getMockImplementation()!;
		vi.mocked(writer.prepareCommit).mockImplementationOnce(async (input) => {
			const prepared = await prepare(input);
			head = 'external';
			return prepared;
		});
		const saved = await save('moved-during-prepare');
		expect(saved.state).toBe('conflict');
		expect(saved.error).toContain('BRANCH_MOVED');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('rejects aggregate workspace bytes above the import limit', async () => {
		writeFileSync(join(workdir, 'extra.txt'), 'x');
		const list = env.bucket.list.bind(env.bucket);
		const session = await env.sessions.getSession(pid, sid);
		const prefix = paths
			.project(pid)
			.notebook(nid)
			.version(session.source_version_id!).workspacePrefix;
		let workspaceLists = 0;
		vi.spyOn(env.bucket, 'list').mockImplementation(async (options) => {
			const result = await list(options);
			if (options?.prefix === prefix && ++workspaceLists > 1)
				result.objects = [
					...result.objects,
					...Array.from({ length: 4 }, (_, i) => ({
						...result.objects[0],
						key: `${prefix}asset-${i}.bin`,
						size: MAX_WORKSPACE_BYTES / 4,
					})),
				];
			return result;
		});
		const rejected = await save('too-large');
		expect(rejected.state).toBe('conflict');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
	});
	it('releases admission after a definite provider rejection', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'edit');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(
			new ConflictError('Branch rule rejected update'),
		);
		const rejected = await save('rejected');
		expect(rejected.state).toBe('conflict');
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		expect((await save('retry-new')).state).toBe('complete');
	});
	it('preserves edits during publication for the next capture', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
			writeFileSync(join(workdir, 'dashboard.py'), 'later');
			head = commit;
			return { commit };
		});
		const first = await save('one');
		expect(new TextDecoder().decode(snapshots.get(first.commit!)!.get('dashboard.py'))).toBe(
			'captured',
		);
		const second = await save('two');
		expect(new TextDecoder().decode(snapshots.get(second.commit!)!.get('dashboard.py'))).toBe(
			'later',
		);
	});
	it('includes local commits and staged edits while ignoring generated files', async () => {
		writeFileSync(join(workdir, 'committed.py'), 'local');
		git('add', 'committed.py');
		git('commit', '-qm', 'local');
		writeFileSync(join(workdir, 'staged.py'), 'staged');
		git('add', 'staged.py');
		writeFileSync(join(workdir, 'skip.ignored'), 'ignored');
		const index = readFileSync(join(workdir, '.git/index'));
		const saved = await save('one');
		expect(saved.changes.map((change) => change.path)).toEqual(['committed.py', 'staged.py']);
		expect(readFileSync(join(workdir, '.git/index'))).toEqual(index);
	});
	it('reconciles a lost ref-update response without another commit or capture', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		vi.mocked(writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
			head = commit;
			throw new Error('lost response');
		});
		const pending = await save('one');
		expect(pending.state).toBe('ref_dispatched');
		writeFileSync(join(workdir, 'dashboard.py'), 'unsaved later');
		const done = await save('one');
		expect(done.state).toBe('complete');
		expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		expect(new TextDecoder().decode(snapshots.get(done.commit!)!.get('dashboard.py'))).toBe(
			'saved',
		);
	});
	it('does not replay against a different head or permit a second save', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('unknown'));
		expect((await save('one')).state).toBe('ref_dispatched');
		head = 'external';
		expect((await save('one')).state).toBe('ref_dispatched');
		await expect(save('two')).rejects.toThrow('Another save');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('retries an unapplied dispatch with exactly the captured commit and expected head', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('request lost'));
		const pending = await save('retry-cas');
		writeFileSync(join(workdir, 'dashboard.py'), 'later');
		const done = await save('retry-cas');
		expect(done.state).toBe('complete');
		expect(done.commit).toBe(pending.commit);
		expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
		expect(vi.mocked(writer.advanceBranch).mock.calls[1]).toEqual(
			vi.mocked(writer.advanceBranch).mock.calls[0],
		);
		expect((await save('after-retry')).state).toBe('complete');
	});
	it('keeps the original dispatch fenced if its retry is rejected', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.advanceBranch)
			.mockRejectedValueOnce(new Error('request lost'))
			.mockRejectedValueOnce(new ConflictError('rule rejected retry'));
		const pending = await save('retry-rejected');
		expect((await save('retry-rejected')).state).toBe('ref_dispatched');
		await expect(save('new-save')).rejects.toThrow('Another save');
		head = pending.commit!;
		expect((await save('retry-rejected')).state).toBe('complete');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(2);
	});
	it.each(['deleted', 'closed'] as const)(
		'does not replay a dispatch after the branch is %s',
		async (ended) => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('request lost'));
			await save('ended-retry');
			vi.mocked(writer.inspectBranch).mockResolvedValueOnce({
				headCommit: ended === 'deleted' ? null : 'base',
				containsCommit: false,
				...(ended === 'closed'
					? {
							changeRequest: {
								number: 1,
								url: 'https://github.com/owner/repo/pull/1',
								state: 'closed' as const,
								headBranch: 'working',
								baseBranch: 'main',
							},
						}
					: {}),
			});
			expect((await save('ended-retry')).state).toBe('ref_dispatched');
			expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).ended_reason).toBe(
				ended === 'deleted' ? 'branch_deleted' : 'pr_closed',
			);
			expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		},
	);
	it('rechecks authorization before retrying a conditional update', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('request lost'));
		const pending = await save('revoked-retry');
		await expect(
			service.resume(pid, nid, pending.id, ACTOR, {
				workdir,
				getSandbox: sandbox,
				authorize: async () => {
					throw new Error('revoked');
				},
			}),
		).rejects.toThrow('revoked');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('completes hub sync after a failure using the original saved content', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(
			new Error('provider temporarily unavailable'),
		);
		const pending = await save('one');
		expect(pending.state).toBe('remote_committed');
		writeFileSync(join(workdir, 'dashboard.py'), 'later');
		expect((await save('one')).state).toBe('complete');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('retains a conflicted capture for export and never overwrites the branch', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'recover me');
		head = 'external';
		const failed = await save('one');
		expect(failed.state).toBe('conflict');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		const recovered = unzipSync(await service.recovery(pid, nid, failed.id));
		expect(new TextDecoder().decode(recovered['files/dashboard.py'])).toBe('recover me');
	});
	it('prevents source retargeting and preserves launch provenance', async () => {
		const before = await env.sessions.getSession(pid, sid);
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		const saved = await save('one');
		const after = await env.sessions.getSession(pid, sid);
		expect(after.source_version_id).toBe(before.source_version_id);
		expect(after.working_branch_version_id).toBe(saved.version_id);
		await expect(
			env.notebooks.synced.updateSource(
				pid,
				nid,
				{ repo: 'owner/repo', branch: 'main', root_path: '', entry_notebook: 'dashboard.py' },
				ACTOR,
			),
		).rejects.toThrow('cannot change');
	});
	it('retains the branch tombstone on deletion and denies further saves', async () => {
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
		await expect(save('one')).rejects.toThrow();
		expect(head).toBe('base');
	});
	it('publishes deletion before a failed branch retirement and repairs retirement on retry', async () => {
		const retire = vi.spyOn(WorkingBranchStore.prototype, 'retire');
		retire.mockRejectedValueOnce(new Error('storage unavailable'));
		await expect(env.notebooks.deleteNotebook(pid, nid, ACTOR)).rejects.toThrow(
			'storage unavailable',
		);
		const snapshot = await env.catalog.getCurrentSnapshot();
		expect(snapshot.projects.find((project) => project.id === pid)).toMatchObject({
			notebook_count: 0,
			notebooks: [{ id: nid, status: 'deleted' }],
		});
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
		retire.mockRestore();
	});
	it('expires completed payloads while retaining replay receipts', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		const saved = await save('one');
		await service.pruneExpiredPayloads(Date.now() + 2 * 86400_000);
		expect(await env.bucket.get(workingBranchPaths(pid, nid).capture(saved.id))).toBeNull();
		expect((await save('one')).state).toBe('complete');
	});
	it('recovers branch creation after a lost response with pinned identity', async () => {
		head = null;
		vi.mocked(writer.createBranch).mockImplementationOnce(async ({ fromCommit }) => {
			head = fromCommit;
			throw new Error('lost');
		});
		await expect(service.create(pid, ACTOR, 'new-creation', createInput)).rejects.toThrow('lost');
		const recovered = await service.create(pid, ACTOR, 'new-creation', createInput);
		expect(recovered.source).toMatchObject({
			commit: 'base',
			working_branch: { fork_commit: 'base' },
		});
		expect(writer.createBranch).toHaveBeenCalledTimes(2);
	});
	it('retries an unapplied branch creation at its pinned identity and commit', async () => {
		head = null;
		vi.mocked(writer.createBranch).mockRejectedValueOnce(new Error('request lost'));
		await expect(service.create(pid, ACTOR, 'unapplied', createInput)).rejects.toThrow(
			'request lost',
		);
		vi.spyOn(reader, 'getBranchHead').mockResolvedValue({ commit: 'new-base' });
		const created = await service.create(pid, ACTOR, 'unapplied', createInput);
		expect(created.source).toMatchObject({ commit: 'base' });
		expect(vi.mocked(writer.createBranch).mock.calls[2]).toEqual(
			vi.mocked(writer.createBranch).mock.calls[1],
		);
	});
	it('does not adopt an advanced ref while recovering branch creation', async () => {
		head = null;
		vi.mocked(writer.createBranch).mockRejectedValueOnce(new Error('request lost'));
		await expect(service.create(pid, ACTOR, 'advanced-create', createInput)).rejects.toThrow();
		head = 'external';
		await expect(service.create(pid, ACTOR, 'advanced-create', createInput)).rejects.toThrow(
			'pinned fork',
		);
		expect(writer.createBranch).toHaveBeenCalledTimes(2);
	});
	it('releases admission after capture fails, even if that session stops', async () => {
		symlinkSync(join(workdir, 'dashboard.py'), join(workdir, 'link.py'));
		await expect(save('failed-capture')).rejects.toThrow('securely read');
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		await env.sessions.beginTerminating(pid, sid);
		await env.sessions.markTerminated(pid, sid);
		await env.sessions.releaseEditorFor(await env.sessions.getSession(pid, sid));
		unlinkSync(join(workdir, 'link.py'));
		const detail = await env.notebooks.getNotebook(pid, nid);
		const next = await env.sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: detail.source.current_version_id!,
		});
		sid = next.session_id;
		await env.sessions.setRunning(pid, sid, 'https://kernel.test');
		await env.sessions.claimEditor(pid, nid, sid, 'shared');
		writeFileSync(join(workdir, 'dashboard.py'), 'next session');
		expect((await save('new-session')).state).toBe('complete');
	});
	it('renews the lease throughout a capture lasting longer than two minutes', async () => {
		for (let i = 0; i < 6; i++) writeFileSync(join(workdir, `slow-${i}.py`), 'changed');
		let now = Date.now();
		const start = now;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const instance = sandbox();
		const exec = instance.exec.bind(instance);
		instance.exec = async (...args) => {
			const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
			expect(record.lease!.until).toBeGreaterThan(now);
			const result = await exec(...args);
			now += 40_000;
			return result;
		};
		expect((await save('slow-capture', undefined, () => instance)).state).toBe('complete');
		expect(now - start).toBeGreaterThan(120_000);
	});
	it('stops capture when another worker takes the lease', async () => {
		let now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const instance = sandbox();
		const exec = instance.exec.bind(instance);
		let taken = false;
		instance.exec = async (...args) => {
			const result = await exec(...args);
			if (!taken && args[0].includes('hashlib.sha256')) {
				taken = true;
				now += 120_001;
				await new WorkingBranchStore(env.bucket).update(pid, nid, (record) => ({
					...record,
					lease: { owner: 'new-worker', until: now + 120_000 },
				}));
			}
			return result;
		};
		await expect(save('stale-capture', undefined, () => instance)).rejects.toThrow(
			'lost its claim',
		);
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).lease?.owner).toBe(
			'new-worker',
		);
		expect(writer.prepareCommit).not.toHaveBeenCalled();
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('caches and coalesces status reads, invalidates after saves, and refreshes after expiry', async () => {
		vi.mocked(writer.inspectBranch).mockClear();
		await Promise.all(Array.from({ length: 5 }, () => service.status(pid, nid)));
		expect(writer.inspectBranch).toHaveBeenCalledTimes(1);
		const put = vi.spyOn(env.bucket, 'put');
		await new WorkingBranchService({ ...env, sourceControl: registry }).status(pid, nid);
		expect(put).not.toHaveBeenCalled();
		expect(writer.inspectBranch).toHaveBeenCalledTimes(1);
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
		await service.status(pid, nid);
		expect(writer.inspectBranch).toHaveBeenCalledTimes(2);
		vi.mocked(Date.now).mockRestore();
		writeFileSync(join(workdir, 'dashboard.py'), 'new');
		const saved = await save('invalidate-status');
		expect((await service.status(pid, nid)).remote_commit).toBe(saved.commit);
	});
	it('rejects unexplained preexisting refs even at the fork commit', async () => {
		await expect(service.create(pid, ACTOR, 'other-creation', createInput)).rejects.toThrow(
			'cannot be adopted',
		);
		expect(writer.createBranch).toHaveBeenCalledTimes(1);
	});
	it('never reads symlink payloads', async () => {
		symlinkSync(join(workdir, 'dashboard.py'), join(workdir, 'link.py'));
		await expect(save('symlink')).rejects.toThrow('securely read');
		expect(writer.prepareCommit).not.toHaveBeenCalled();
	});
	it('rejects a changed request under the same save key', async () => {
		await save('one', 'Original');
		await expect(save('one', 'Changed')).rejects.toThrow('different save');
	});
	it('refuses captures from stopped sessions', async () => {
		await env.sessions.beginTerminating(pid, sid);
		await expect(save('stopped')).rejects.toThrow('running persistent editor');
	});
	it('resumes after the sandbox disappears and after losing the original request key', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('outage'));
		const pending = await save('one');
		await env.sessions.beginTerminating(pid, sid);
		await env.sessions.markTerminated(pid, sid);
		const getSandbox = vi.fn(() => {
			throw new Error('must not access sandbox');
		});
		const result = await service.resume(pid, nid, pending.id, ACTOR, { workdir, getSandbox });
		expect(result.state).toBe('complete');
		expect(getSandbox).not.toHaveBeenCalled();
	});
	it('blocks manual sync while a remote save is unresolved', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('unknown'));
		await save('one');
		const { source } = await env.notebooks.getNotebook(pid, nid);
		if (source.type !== 'git') throw new Error('expected git source');
		await expect(
			env.notebooks.synced.sync(pid, nid, {
				repo: source.repo,
				branch: source.branch,
				root_path: '',
				commit: 'external',
				files: [{ path: 'dashboard.py', bytes: encode('external') }],
				git_files: [{ path: 'HEAD', bytes: encode('external') }],
			}),
		).rejects.toThrow('pending working branch save');
	});
	it('repairs a missed branch claim release on completed replay', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'saved');
		const saved = await save('one');
		await new WorkingBranchStore(env.bucket).update(pid, nid, (record) => ({
			...record,
			active_save: saved.id,
		}));
		await save('one');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
	});
	it('captures only the configured subtree and compares against its stored baseline', async () => {
		head = null;
		const created = await service.create(pid, ACTOR, 'subtree', {
			...createInput,
			root_path: 'apps',
		});
		const session = await env.sessions.createSession({
			project_id: pid,
			notebook_id: created.meta.id,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: created.source.current_version_id!,
		});
		await env.sessions.setRunning(pid, session.session_id, 'https://kernel.test');
		await env.sessions.claimEditor(pid, created.meta.id, session.session_id, 'shared');
		mkdirSync(join(workdir, 'apps'));
		writeFileSync(join(workdir, 'apps/dashboard.py'), 'subtree');
		writeFileSync(join(workdir, 'outside.py'), 'not saved');
		await service.save({
			projectId: pid,
			notebookId: created.meta.id,
			sessionId: session.session_id,
			actor: ACTOR,
			idempotencyKey: 'subtree-save',
			workdir,
			getSandbox: sandbox,
		});
		expect(
			vi.mocked(writer.prepareCommit).mock.calls[0][0].changes.map((change) => change.path),
		).toEqual(['apps/.gitignore', 'apps/dashboard.py']);
	});
	it('retains entrypoint deletion for recovery without publishing it', async () => {
		unlinkSync(join(workdir, 'dashboard.py'));
		const result = await save('deleted-entry');
		expect(result.state).toBe('conflict');
		expect(result.error).toContain('entry file cannot be deleted');
		expect(writer.prepareCommit).not.toHaveBeenCalled();
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('expires abandoned captures and releases their admission', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider unavailable'));
		await expect(save('abandoned')).rejects.toThrow('provider unavailable');
		const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
		expect(await service.pruneExpiredPayloads(Date.now() + 26 * 3600_000)).toBe(1);
		expect((await service.getSave(pid, nid, record.active_save!)).state).toBe('expired');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
	});
	it('keeps unresolved remote operations beyond normal retention', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('response lost'));
		const result = await save('unresolved');
		expect(await service.pruneExpiredPayloads(Date.now() + 26 * 3600_000)).toBe(0);
		expect((await service.getSave(pid, nid, result.id)).state).toBe('ref_dispatched');
		expect(await service.recovery(pid, nid, result.id)).toBeInstanceOf(Uint8Array);
	});
	it('rechecks authorization before publishing captured source', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		const authorize = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('access revoked'));
		await expect(
			service.save({
				projectId: pid,
				notebookId: nid,
				sessionId: sid,
				actor: ACTOR,
				idempotencyKey: 'revoked',
				workdir,
				getSandbox: sandbox,
				authorize,
			}),
		).rejects.toThrow('access revoked');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('blocks publication and manual sync until creation completes', async () => {
		const store = new WorkingBranchStore(env.bucket);
		await store.update(pid, nid, (record) => ({ ...record, state: 'branch_created' }));
		writeFileSync(join(workdir, 'dashboard.py'), 'pending creation');
		await expect(save('too-early')).rejects.toThrow('creation needs completion');
		const detail = await env.notebooks.getNotebook(pid, nid);
		if (detail.source.type !== 'git') throw new Error('git source required');
		await expect(
			env.notebooks.synced.sync(
				pid,
				nid,
				{
					...detail.source,
					commit: 'external',
					files: [{ path: 'dashboard.py', bytes: encode('outside') }],
					git_files: [{ path: 'HEAD', bytes: encode('head') }],
				},
				ACTOR,
			),
		).rejects.toThrow('creation needs completion');
		const recovered = await service.create(pid, ACTOR, 'create', createInput);
		expect(recovered.source).toMatchObject({ commit: 'base' });
		expect((await save('after-create')).state).toBe('complete');
	});
	it('retains a deleted-branch fence after the ref reappears', async () => {
		head = null;
		expect((await service.status(pid, nid)).ended_reason).toBe('branch_deleted');
		head = 'base';
		writeFileSync(join(workdir, 'dashboard.py'), 'after deletion');
		expect((await save('deleted-branch')).state).toBe('conflict');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		await expect(service.openChangeRequest(pid, nid, ACTOR, {})).rejects.toThrow(
			'publication ended',
		);
	});
	it('retains a closed-PR fence after the PR is reopened', async () => {
		vi.mocked(writer.inspectBranch).mockResolvedValueOnce({
			headCommit: 'base',
			containsCommit: false,
			changeRequest: {
				number: 1,
				url: 'https://github.com/owner/repo/pull/1',
				state: 'closed',
				headBranch: 'working',
				baseBranch: 'main',
			},
		});
		expect((await service.status(pid, nid)).ended_reason).toBe('pr_closed');
		writeFileSync(join(workdir, 'dashboard.py'), 'after closing');
		expect((await save('closed-pr')).state).toBe('conflict');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('rejects a symlink ancestor of the configured subtree', async () => {
		head = null;
		const created = await service.create(pid, ACTOR, 'nested-subtree', {
			...createInput,
			root_path: 'apps/nested',
		});
		const session = await env.sessions.createSession({
			project_id: pid,
			notebook_id: created.meta.id,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: created.source.current_version_id!,
		});
		await env.sessions.setRunning(pid, session.session_id, 'https://kernel.test');
		await env.sessions.claimEditor(pid, created.meta.id, session.session_id, 'shared');
		const outside = mkdtempSync(join(tmpdir(), 'branch-outside-'));
		try {
			execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q', outside]);
			mkdirSync(join(outside, 'nested'));
			writeFileSync(join(outside, 'nested/dashboard.py'), 'private outside content');
			symlinkSync(outside, join(workdir, 'apps'));
			await expect(
				service.save({
					projectId: pid,
					notebookId: created.meta.id,
					sessionId: session.session_id,
					actor: ACTOR,
					idempotencyKey: 'escaped',
					workdir,
					getSandbox: sandbox,
				}),
			).rejects.toThrow('securely read');
			expect(writer.prepareCommit).not.toHaveBeenCalled();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
	it('bounds deletion-only captures', async () => {
		const base = paths.project(pid).notebook(nid).version(createVersionId());
		await Promise.all(
			Array.from({ length: 1001 }, (_, i) =>
				env.bucket.put(base.workspaceFile(`file-${i}.py`), 'base'),
			),
		);
		const fake = makeFsSandbox().instance;
		fake.exec = async (command) =>
			execResult(
				true,
				command.includes('printf git-working-tree')
					? 'git-working-tree'
					: command.includes('ls-files')
						? ''
						: JSON.stringify(
								(JSON.parse(/'(\[.*\])' \d+$/.exec(command)![1]) as string[]).map((path) => ({
									path,
									missing: true,
								})),
							),
				'',
			);
		await expect(
			captureWorkingBranchChanges(
				env.bucket,
				fake,
				{ workdir, gitRoot: workdir, rootPath: '' },
				base,
			),
		).rejects.toThrow('file limit');
	});
	it('cleans an abandoned capture after notebook deletion', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider unavailable'));
		await expect(save('abandoned')).rejects.toThrow();
		const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
		await env.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect(await service.pruneExpiredPayloads(Date.now() + 26 * 3600_000)).toBe(1);
		expect((await service.getSave(pid, nid, record.active_save!)).state).toBe('expired');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
	});
	it('serializes manual sync with branch publication', async () => {
		const detail = await env.notebooks.getNotebook(pid, nid);
		if (detail.source.type !== 'git') throw new Error('git source required');
		const input = {
			...detail.source,
			commit: 'base',
			files: [{ path: 'dashboard.py', bytes: encode('base') }],
			git_files: [{ path: 'HEAD', bytes: encode('head') }],
		};
		await new WorkingBranchStore(env.bucket).withLease(pid, nid, async () => {
			await expect(env.notebooks.synced.sync(pid, nid, input, ACTOR)).rejects.toThrow(
				'in progress',
			);
		});
	});
	it('releases admission after a known commit-preparation conflict', async () => {
		writeFileSync(join(workdir, 'dashboard.py'), 'captured');
		vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new ConflictError('base tree changed'));
		const receipt = await save('tree-conflict');
		expect(receipt.state).toBe('conflict');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		expect(await service.recovery(pid, nid, receipt.id)).toBeInstanceOf(Uint8Array);
	});
	it('retires project branch claims and cannot recreate them after project deletion', async () => {
		await env.projects.deleteProject(pid, ACTOR);
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
		await expect(save('after-project-delete')).rejects.toThrow('Project not found');
		await expect(service.create(pid, ACTOR, 'create', createInput)).rejects.toThrow(
			'Project not found',
		);
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		await env.projects.hardDeleteProject(pid);
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
	});

	describe('failure injection', () => {
		function failReceipt(state: string, afterWrite = false) {
			const put = env.bucket.put.bind(env.bucket);
			let failed = false;
			return vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
				if (
					!failed &&
					key.endsWith('/receipt.json') &&
					typeof value === 'string' &&
					WorkingBranchSaveSchema.parse(JSON.parse(value)).state === state
				) {
					failed = true;
					if (afterWrite) await put(key, value, options);
					throw new Error('receipt storage unavailable');
				}
				return put(key, value, options);
			});
		}

		it('resumes a prepared commit without listing its baseline again', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'edit');
			failReceipt('commit_prepared', true);
			await expect(save('prepared-once')).rejects.toThrow('receipt storage unavailable');
			const pending = (await service.status(pid, nid)).last_save!;
			expect(pending.state).toBe('commit_prepared');
			const prefix = paths
				.project(pid)
				.notebook(nid)
				.version(pending.base_version_id).workspacePrefix;
			const list = vi.spyOn(env.bucket, 'list');
			vi.mocked(writer.inspectBranch).mockClear();
			expect(
				(await service.resume(pid, nid, pending.id, ACTOR, { workdir, getSandbox: sandbox })).state,
			).toBe('complete');
			expect(list.mock.calls.filter(([options]) => options?.prefix === prefix)).toHaveLength(0);
			expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
			expect(writer.inspectBranch).toHaveBeenCalledTimes(1);
		});
		it.each([false, true])(
			'keeps status usable when the first receipt write fails (persisted: %s)',
			async (persisted) => {
				failReceipt('claimed', persisted);
				await expect(save('failed-claim')).rejects.toThrow('receipt storage unavailable');
				expect(await service.status(pid, nid)).toMatchObject({
					active_save: undefined,
					last_save: undefined,
				});
				expect((await save('new-attempt')).state).toBe('no_changes');
				expect(writer.advanceBranch).not.toHaveBeenCalled();
			},
		);

		it.each([false, true])(
			'recovers a failed admission update (persisted: %s)',
			async (persisted) => {
				writeFileSync(join(workdir, 'dashboard.py'), 'captured');
				const put = env.bucket.put.bind(env.bucket);
				let failed = false;
				vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
					if (
						!failed &&
						key === workingBranchPaths(pid, nid).head &&
						typeof value === 'string' &&
						WorkingBranchRecordSchema.parse(JSON.parse(value)).active_save
					) {
						failed = true;
						if (persisted) await put(key, value, options);
						throw new Error('admission response lost');
					}
					return put(key, value, options);
				});
				await expect(save('admission')).rejects.toThrow('admission response lost');
				const status = await service.status(pid, nid);
				if (persisted) {
					expect(status.last_save?.state).toBe('claimed');
					expect(
						(
							await service.resume(pid, nid, status.active_save!, ACTOR, {
								workdir,
								getSandbox: sandbox,
							})
						).state,
					).toBe('complete');
				} else {
					expect(status.active_save).toBeUndefined();
					expect((await save('admission')).state).toBe('complete');
				}
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
			},
		);

		it('retires an abandoned empty claim before admitting a new save', async () => {
			const put = env.bucket.put.bind(env.bucket);
			let failed = false;
			const fault = vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
				const result = await put(key, value, options);
				if (
					!failed &&
					key === workingBranchPaths(pid, nid).head &&
					typeof value === 'string' &&
					WorkingBranchRecordSchema.parse(JSON.parse(value)).active_save
				) {
					failed = true;
					throw new Error('crash before capture');
				}
				return result;
			});
			await expect(save('abandoned')).rejects.toThrow('crash before capture');
			fault.mockRestore();
			const abandoned = (await service.status(pid, nid)).active_save!;
			expect((await save('replacement')).state).toBe('no_changes');
			expect((await service.getSave(pid, nid, abandoned)).state).toBe('conflict');
		});
		it('imports the exact saved commit after a lost response and a later external push', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			vi.mocked(writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
				head = 'external-descendant';
				vi.mocked(writer.inspectBranch).mockImplementation(async (input) => ({
					headCommit: head,
					containsCommit: input.commit === commit,
				}));
				throw new Error('response lost');
			});
			const pending = await save('ancestry');
			expect(pending.state).toBe('ref_dispatched');
			const result = await save('ancestry');
			expect(result.state).toBe('complete');
			expect((await env.notebooks.getNotebook(pid, nid)).source).toMatchObject({
				commit: result.commit,
			});
			expect(head).toBe('external-descendant');
			writeFileSync(join(workdir, 'dashboard.py'), 'next edits');
			expect((await save('after-external')).state).toBe('conflict');
			expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		});

		it.each(['merged', 'retargeted'] as const)(
			'fences publication after a PR is %s',
			async (lifecycle) => {
				vi.mocked(writer.inspectBranch).mockResolvedValue({
					headCommit: 'base',
					containsCommit: false,
					changeRequest: {
						number: 1,
						url: 'https://github.com/owner/repo/pull/1',
						headBranch: 'working',
						state: lifecycle === 'merged' ? 'merged' : 'open',
						baseBranch: lifecycle === 'retargeted' ? 'other' : 'main',
					},
				});
				writeFileSync(join(workdir, 'dashboard.py'), 'captured');
				expect((await save('ended')).state).toBe('conflict');
				expect((await service.status(pid, nid)).ended_reason).toBe(`pr_${lifecycle}`);
				await expect(service.openChangeRequest(pid, nid, ACTOR, {})).rejects.toThrow(
					'publication ended',
				);
				expect(writer.advanceBranch).not.toHaveBeenCalled();
				expect(writer.openBranchChangeRequest).not.toHaveBeenCalled();
			},
		);

		it.each([false, true])(
			'resumes a failed prepared receipt write (persisted: %s)',
			async (persisted) => {
				writeFileSync(join(workdir, 'dashboard.py'), 'captured');
				failReceipt('commit_prepared', persisted);
				await expect(save('prepared')).rejects.toThrow('receipt storage unavailable');
				writeFileSync(join(workdir, 'dashboard.py'), 'later edits');
				const result = await save('prepared');
				expect(result.state).toBe('complete');
				expect(writer.prepareCommit).toHaveBeenCalledTimes(persisted ? 1 : 2);
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
				expect(new TextDecoder().decode(snapshots.get(result.commit!)!.get('dashboard.py'))).toBe(
					'captured',
				);
			},
		);

		it.each([false, true])(
			'handles a failed dispatch receipt write without blind replay (persisted: %s)',
			async (persisted) => {
				writeFileSync(join(workdir, 'dashboard.py'), 'captured');
				failReceipt('ref_dispatched', persisted);
				await expect(save('dispatch')).rejects.toThrow('receipt storage unavailable');
				const result = await save('dispatch');
				expect(result.state).toBe('complete');
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
				expect(await service.recovery(pid, nid, result.id)).toBeInstanceOf(Uint8Array);
			},
		);

		it.each([false, true])(
			'reconciles a commit when its receipt write fails (persisted: %s)',
			async (persisted) => {
				writeFileSync(join(workdir, 'dashboard.py'), 'captured');
				failReceipt('remote_committed', persisted);
				await expect(save('remote')).rejects.toThrow('receipt storage unavailable');
				writeFileSync(join(workdir, 'dashboard.py'), 'later edits');
				expect((await save('remote')).state).toBe('complete');
				expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
				expect(readFileSync(join(workdir, 'dashboard.py'), 'utf8')).toBe('later edits');
			},
		);

		it('reuses a capture whose storage response was lost', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			const put = env.bucket.put.bind(env.bucket);
			const fault = vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
				const result = await put(key, value, options);
				if (key.endsWith('/capture.json')) throw new Error('capture response lost');
				return result;
			});
			await expect(save('capture')).rejects.toThrow('capture response lost');
			fault.mockRestore();
			await expect(save('competing')).rejects.toThrow('Another save');
			writeFileSync(join(workdir, 'dashboard.py'), 'later edits');
			const result = await save('capture');
			expect(result.state).toBe('complete');
			expect(new TextDecoder().decode(snapshots.get(result.commit!)!.get('dashboard.py'))).toBe(
				'captured',
			);
		});

		it('retries a lost session acknowledgment without another commit or version', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			const acknowledge = env.sessions.acknowledgeWorkingBranchSave.bind(env.sessions);
			vi.spyOn(env.sessions, 'acknowledgeWorkingBranchSave').mockImplementationOnce(
				async (...args) => {
					await acknowledge(...args);
					throw new Error('acknowledgment response lost');
				},
			);
			await expect(save('ack')).rejects.toThrow('acknowledgment response lost');
			const before = await env.notebooks.getNotebook(pid, nid);
			const result = await save('ack');
			expect(result.state).toBe('complete');
			expect(result.version_id).toBe(before.source.current_version_id);
			expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
			writeFileSync(join(workdir, 'dashboard.py'), 'next save');
			expect((await save('next')).base_commit).toBe(result.commit);
		});

		it.each(['corrupt', 'missing'])(
			'rejects a %s capture without publishing or recapturing',
			async (failure) => {
				writeFileSync(join(workdir, 'dashboard.py'), 'captured');
				vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider offline'));
				await expect(save('payload')).rejects.toThrow('provider offline');
				const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
				const key = workingBranchPaths(pid, nid).capture(record.active_save!);
				if (failure === 'missing') await env.bucket.delete(key);
				else {
					const payload = await (await env.bucket.get(key))!.json<{ content?: string }[]>();
					payload[0].content = btoa('tampered');
					await env.bucket.put(key, JSON.stringify(payload));
				}
				writeFileSync(join(workdir, 'dashboard.py'), 'later edits');
				await expect(save('payload')).rejects.toThrow(
					failure === 'missing' ? 'unavailable' : 'integrity',
				);
				expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
				expect(writer.advanceBranch).not.toHaveBeenCalled();
			},
		);

		it('rejects overlapping saves while commit preparation is in flight', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			const entered = deferred<void>();
			const release = deferred<void>();
			const prepare = vi.mocked(writer.prepareCommit).getMockImplementation()!;
			vi.mocked(writer.prepareCommit).mockImplementationOnce(async (input) => {
				entered.resolve();
				await release.promise;
				return prepare(input);
			});
			const first = save('first');
			try {
				await entered.promise;
				await expect(save('second')).rejects.toThrow('in progress');
			} finally {
				release.resolve();
			}
			expect((await first).state).toBe('complete');
			expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		});

		it('fences a stale worker after an expired lease is taken over', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			const entered = deferred<void>();
			const release = deferred<void>();
			const prepare = vi.mocked(writer.prepareCommit).getMockImplementation()!;
			vi.mocked(writer.prepareCommit).mockImplementationOnce(async (input) => {
				entered.resolve();
				await release.promise;
				return prepare(input);
			});
			const stale = save('same').catch((error: unknown) => error);
			try {
				await entered.promise;
				await new WorkingBranchStore(env.bucket).update(pid, nid, (record) => ({
					...record,
					lease: { ...record.lease!, until: 0 },
				}));
				const winner = await save('same');
				expect(winner.state).toBe('complete');
				release.resolve();
				expect(await stale).toBeInstanceOf(ConflictError);
				expect((await service.getSave(pid, nid, winner.id)).commit).toBe(winner.commit);
				expect(head).toBe(winner.commit);
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
			} finally {
				release.resolve();
			}
		});

		it('does not publish when the notebook is deleted during preparation', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			vi.mocked(writer.prepareCommit).mockImplementationOnce(async () => {
				await env.notebooks.deleteNotebook(pid, nid, ACTOR);
				return { commit: 'prepared-before-delete' };
			});
			await expect(save('delete-race')).rejects.toThrow('lost its claim');
			expect(writer.advanceBranch).not.toHaveBeenCalled();
			expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
		});

		it('denies retry by a different author without accessing the sandbox or provider', async () => {
			writeFileSync(join(workdir, 'dashboard.py'), 'captured');
			vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider offline'));
			await expect(save('private-retry')).rejects.toThrow('provider offline');
			const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
			const getSandbox = vi.fn(sandbox);
			await expect(
				service.resume(pid, nid, record.active_save!, uid('other-user'), { workdir, getSandbox }),
			).rejects.toThrow('Only the save author');
			expect(getSandbox).not.toHaveBeenCalled();
			expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
			expect(writer.advanceBranch).not.toHaveBeenCalled();
		});
	});
});

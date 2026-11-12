import {
	MAX_REQUEST_BYTES,
	MAX_WORKSPACE_FILES,
	MAX_WORKSPACE_BYTES,
	MAX_WORKSPACE_FILE_BYTES,
} from '../../constants';
import { paths } from '../../paths';
import { workspaceManifest } from './workspaceManifest';
import { captureWorkingBranchChanges } from './proposalCapture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { ACTOR, makeGitWorkingTreeSandbox, uid } from '../../testing';
import type { GitWorkingTreeSandboxOptions } from '../../testing';
import { createVersionId } from '../../ids';
import type { NotebookId, ProjectId, SessionId } from '../../ids';
import type {
	SourceControlReader,
	SourceControlRegistry,
	WorkingBranchWriter,
} from '../../ports/sourceControl';
import { execResult } from '../../ports/sandbox';
import type { SandboxInstance } from '../../ports/sandbox';
import { ConflictError, ForbiddenError, ValidationError } from '../../errors';
import { WorkingBranchService } from './WorkingBranchService';
import {
	workingBranchPaths,
	WORKING_BRANCH_CLEANUP_KEY,
	WORKING_BRANCH_DISPATCH_BOUND_MS,
	WorkingBranchStore,
	WorkingBranchSaveSchema,
	WorkingBranchRecordSchema,
} from './workingBranchRecords';
import {
	encode,
	setupWorkingBranchHarness,
	WORKING_BRANCH_CREATE_INPUT as createInput,
} from './workingBranchTestkit';
import type { WorkingBranchHarness } from './workingBranchTestkit';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

// Service semantics only: the sandbox is the in-memory Git working-tree fake.
// Real checkouts, symlinks, and the Python read scripts are covered by
// WorkingBranchService.git.test.ts.
describe('WorkingBranchService', { timeout: 60_000 }, () => {
	let h: WorkingBranchHarness;
	let env: WorkingBranchHarness['env'];
	let service: WorkingBranchService;
	let writer: WorkingBranchWriter;
	let reader: SourceControlReader;
	let registry: SourceControlRegistry;
	let pid: ProjectId;
	let nid: NotebookId;
	let sid: SessionId;
	let snapshots: Map<string, Map<string, Uint8Array>>;
	/** The live working tree the fake sandbox serves, keyed by path under `workdir`. */
	let tree: Map<string, Uint8Array>;
	const workdir = '/workspace';

	beforeEach(async () => {
		h = await setupWorkingBranchHarness();
		({ env, service, writer, reader, registry, pid, nid, sid, snapshots } = h);
		tree = new Map(snapshots.get('base'));
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it('pins the personal save actor before preparation and preserves it after a mode change', async () => {
		const actor = {
			kind: 'user' as const,
			verification: 'required' as const,
			userId: ACTOR,
			connectionId: 'original',
			generation: 'generation',
			accountId: '123',
		};
		registry.publicationActor = vi.fn(async () => actor);
		const getPublisher = vi.spyOn(registry, 'getPublisher');
		vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider unavailable'));
		write('dashboard.py', 'personal changes');
		await expect(save('personal-retry')).rejects.toThrow('provider unavailable');
		const pending = await service.status(pid, nid);
		expect(pending.last_save?.publication_actor).toEqual(actor);
		registry.publicationActor = vi.fn(async () => ({
			kind: 'app' as const,
			verification: 'unchecked' as const,
		}));
		await save('personal-retry');
		expect(
			getPublisher.mock.calls.some(
				(call) => call[2]?.kind === 'user' && call[2].connectionId === 'original',
			),
		).toBe(true);
	});

	it('prevents a different user from finishing an unconfirmed personal PR dispatch', async () => {
		const store = new WorkingBranchStore(env.bucket);
		const record = await store.read(pid, nid);
		await env.bucket.put(
			workingBranchPaths(pid, nid).head,
			JSON.stringify({
				...record,
				change_request_actor: {
					kind: 'user',
					verification: 'required',
					userId: ACTOR,
					connectionId: 'original',
					generation: 'generation',
					accountId: '123',
				},
			}),
		);
		await expect(service.openChangeRequest(pid, nid, uid('user-other'), {})).rejects.toThrow(
			'original author',
		);
		expect(writer.openBranchChangeRequest).not.toHaveBeenCalled();
	});

	function write(path: string, content: string | Uint8Array) {
		tree.set(path, typeof content === 'string' ? encode(content) : content);
	}
	function sandbox(options: Partial<GitWorkingTreeSandboxOptions> = {}): SandboxInstance {
		return makeGitWorkingTreeSandbox({ root: workdir, files: tree, ...options }).instance;
	}
	function save(key: string, message?: string, getSandbox = () => sandbox()) {
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

	it('validates the working source only at admission, dispatch, and sync', async () => {
		write('dashboard.py', 'edit');
		const get = vi.spyOn(env.bucket, 'get');
		expect((await save('source-reads')).state).toBe('complete');
		const reads = (key: string) => get.mock.calls.filter(([read]) => read === key).length;
		expect(reads(paths.project(pid).meta)).toBe(3);
	});
	it('includes the effective co-author in the idempotency fingerprint', async () => {
		const input = {
			projectId: pid,
			notebookId: nid,
			sessionId: sid,
			actor: ACTOR,
			idempotencyKey: 'co-author',
			workdir,
			getSandbox: () => sandbox(),
			coAuthor: { name: 'Editor', email: 'editor@example.com' },
		};
		const saved = await service.save(input);
		expect(
			await service.save({ ...input, coAuthor: { email: 'editor@example.com', name: 'Editor' } }),
		).toEqual(saved);
		await expect(
			service.save({ ...input, coAuthor: { ...input.coAuthor, name: 'Other' } }),
		).rejects.toThrow('different save');
		await expect(service.save({ ...input, coAuthor: undefined })).rejects.toThrow('different save');
	});
	it('returns activated metadata when the same commit is synced again', async () => {
		const detail = await env.notebooks.getNotebook(pid, nid);
		if (detail.source.type !== 'git') throw new Error('git source required');
		await env.bucket.put(
			paths.project(pid).notebook(nid).meta,
			JSON.stringify({ ...detail.meta, status: 'draft' }),
		);
		const result = await env.notebooks.synced.sync(
			pid,
			nid,
			{
				...detail.source,
				commit: 'base',
				files: [{ path: 'dashboard.py', bytes: encode('base') }],
				git_files: [{ path: 'HEAD', bytes: encode('head') }],
			},
			ACTOR,
		);
		expect(result.meta.status).toBe('active');
		expect(result.versionId).toBeNull();
		expect((await env.notebooks.getNotebook(pid, nid)).meta.status).toBe('active');
	});
	it('reports an oversized file as validation failure and releases the save slot', async () => {
		write('oversized.bin', 'stub');
		const failure = save('oversized', undefined, () =>
			sandbox({ sizes: { 'oversized.bin': MAX_WORKSPACE_FILE_BYTES + 1 } }),
		);
		await expect(failure).rejects.toBeInstanceOf(ValidationError);
		await expect(failure).rejects.toThrow(
			`oversized.bin exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit`,
		);
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
		expect(writer.prepareCommit).not.toHaveBeenCalled();
	});
	it('reconciles a confirmed personal save after personal publishing configuration is removed', async () => {
		registry.publicationActor = async () => ({
			kind: 'user',
			verification: 'required',
			userId: ACTOR,
			connectionId: 'original',
			generation: 'generation',
			accountId: '123',
		});
		write('dashboard.py', 'saved remotely');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('provider unavailable'));
		const pending = await save('personal-confirmed');
		expect(pending.state).toBe('remote_committed');
		const getPublisher = registry.getPublisher.bind(registry);
		registry.getPublisher = (provider, project, actor) => {
			if (actor?.kind === 'user') throw new Error('personal setup removed');
			return getPublisher(provider, project, actor);
		};
		expect((await save('personal-confirmed')).state).toBe('complete');
		expect(writer.advanceBranch).toHaveBeenCalledOnce();
	});
	it('finishes with recoverable conflict when the hub advances after a remote commit', async () => {
		write('dashboard.py', 'saved remotely');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('provider unavailable'));
		const pending = await save('advanced');
		expect(pending.state).toBe('remote_committed');
		const detail = await env.notebooks.getNotebook(pid, nid);
		const advanced = { ...detail.source, commit: 'newer', current_version_id: createVersionId() };
		await env.bucket.put(paths.project(pid).notebook(nid).source, JSON.stringify(advanced));
		const result = await save('advanced');
		expect(result).toMatchObject({ state: 'conflict', commit: pending.commit });
		expect(result.error).toContain('hub source advanced');
		expect(result.error).not.toContain('Retry this operation');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
		expect((await env.notebooks.getNotebook(pid, nid)).source).toEqual(advanced);
		expect(await save('advanced')).toEqual(result);
		expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		const recovered = unzipSync(await service.recovery(pid, nid, result.id));
		expect(new TextDecoder().decode(recovered['files/dashboard.py'])).toBe('saved remotely');
	});
	it.each([false, true])(
		'logs release failure without replacing callback outcome (throws=%s)',
		async (throws) => {
			const store = new WorkingBranchStore(env.bucket);
			const put = env.bucket.put.bind(env.bucket);
			const key = workingBranchPaths(pid, nid).head;
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(env.bucket, 'put').mockImplementation(async (target, body, options) => {
				if (
					target === key &&
					typeof body === 'string' &&
					!WorkingBranchRecordSchema.parse(JSON.parse(body)).lease
				)
					throw new Error('release unavailable');
				return put(target, body, options);
			});
			const result = store.withLease(pid, nid, async () => {
				if (throws) throw new Error('original callback failure');
				return 'saved';
			});
			if (throws) await expect(result).rejects.toThrow('original callback failure');
			else await expect(result).resolves.toBe('saved');
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('working_branch.lease_release_failed'),
			);
			expect((await store.read(pid, nid)).lease).toBeDefined();
		},
	);
	it('advances cleanup past malformed receipts and prunes later captures', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider unavailable'));
		await expect(save('cleanup')).rejects.toThrow('provider unavailable');
		const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
		for (let i = 0; i < 100; i++)
			await env.bucket.put(
				`_system/working-branches/notebooks/000/${String(i).padStart(3, '0')}/receipt.json`,
				'{}',
			);
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const now = Date.now() + 26 * 3600_000;
		expect(await service.pruneExpiredPayloads(now)).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('working_branch.cleanup_failed'));
		expect(await (await env.bucket.get(WORKING_BRANCH_CLEANUP_KEY))!.json()).toHaveProperty(
			'cursor',
		);
		expect(await service.pruneExpiredPayloads(now)).toBe(1);
		expect((await service.getSave(pid, nid, record.active_save!)).state).toBe('expired');
		expect(
			await env.bucket.head(workingBranchPaths(pid, nid).capture(record.active_save!)),
		).toBeNull();
	});
	it('does not rewrite the cleanup cursor when one page covers every record', async () => {
		const put = vi.spyOn(env.bucket, 'put');
		expect(await service.pruneExpiredPayloads(Date.now() + 26 * 3600_000)).toBe(0);
		expect(put).not.toHaveBeenCalled();
		expect(await env.bucket.get(WORKING_BRANCH_CLEANUP_KEY)).toBeNull();
	});
	it('rejects malformed record IDs and timestamps before expiry decisions', async () => {
		const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
		const receipt = await save('schema');
		expect(WorkingBranchRecordSchema.safeParse({ ...record, id: 'bad-id' }).success).toBe(false);
		for (const field of ['created_at', 'checked_at'])
			expect(WorkingBranchRecordSchema.safeParse({ ...record, [field]: 'invalid' }).success).toBe(
				false,
			);
		for (const field of ['created_at', 'expires_at'])
			expect(WorkingBranchSaveSchema.safeParse({ ...receipt, [field]: 'invalid' }).success).toBe(
				false,
			);
	});

	it('replays creation without another branch or catalog entry', async () => {
		const replay = await service.create(pid, ACTOR, 'create', createInput);
		expect(replay.meta.id).toBe(nid);
		expect(writer.createBranch).toHaveBeenCalledTimes(1);
		await expect(
			service.create(pid, ACTOR, 'create', { ...createInput, title: 'Different' }),
		).rejects.toThrow('different notebook settings');
	});
	it('hashes a folder in one batch and reads only changed payloads', async () => {
		const session = await env.sessions.getSession(pid, sid);
		const base = paths.project(pid).notebook(nid).version(session.source_version_id!);
		const files = new Map(snapshots.get('base'));
		for (let i = 0; i < 100; i++) {
			const path = `unchanged-${i}.txt`;
			const content = encode(`baseline ${i}`);
			files.set(path, content);
			write(path, content);
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
		write('dashboard.py', 'edited');
		expect((await capture()).changes.map(({ change }) => change.path)).toEqual(['dashboard.py']);
		expect(exec.mock.calls.filter(([command]) => command.includes('allow-missing'))).toHaveLength(
			1,
		);
		expect(get.mock.calls.filter(([key]) => key.startsWith(base.workspacePrefix))).toHaveLength(0);
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
		write('dashboard.py', 'first edit');
		const instance = sandbox();
		const exec = instance.exec.bind(instance);
		instance.exec = async (...args) => {
			if (args[0].includes('allow-missing')) write('dashboard.py', 'second edit');
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
		await service.resume(pid, nid, saved.id, ACTOR, { workdir, getSandbox: () => sandbox() });
		expect(getSave).toHaveBeenCalledTimes(1);
		expect(getSave).toHaveBeenCalledWith(pid, nid, saved.id);
		await expect(
			service.resume(pid, nid, 'a'.repeat(64), ACTOR, { workdir, getSandbox: () => sandbox() }),
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
		write('asset.bin', asset);
		write('dashboard.py', 'small edit');
		const saved = await save('small');
		expect(saved.state).toBe('complete');
		expect(saved.changes.map((change) => change.path)).toEqual(['dashboard.py']);
		const changed = new Uint8Array(asset);
		changed[0] = 1;
		write('asset.bin', changed);
		await expect(save('oversized-change')).rejects.toThrow('content limit');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('rejects a 1001-file result, retains recovery, and admits a corrected save at the limit', async () => {
		const session = await env.sessions.getSession(pid, sid);
		const base = paths.project(pid).notebook(nid).version(session.source_version_id!);
		const remoteTree = snapshots.get('base')!;
		for (let i = remoteTree.size; i < MAX_WORKSPACE_FILES; i++) {
			const path = `file-${i}.txt`;
			remoteTree.set(path, encode('base'));
			await env.bucket.put(base.workspaceFile(path), 'base');
		}
		tree = new Map(remoteTree);
		write('extra.txt', 'extra');
		const rejected = await save('too-many');
		expect(rejected.state).toBe('conflict');
		expect(rejected.error).toContain('import limits');
		expect(writer.prepareCommit).not.toHaveBeenCalled();
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		expect(unzipSync(await service.recovery(pid, nid, rejected.id))['files/extra.txt']).toEqual(
			encode('extra'),
		);
		tree.delete('file-2.txt');
		const corrected = await save('corrected');
		expect(corrected.state).toBe('complete');
		expect(snapshots.get(corrected.commit!)!.size).toBe(MAX_WORKSPACE_FILES);
	});
	it('tallies workspace size once while checking the remote before and after preparation', async () => {
		write('dashboard.py', 'edit');
		const session = await env.sessions.getSession(pid, sid);
		const prefix = paths
			.project(pid)
			.notebook(nid)
			.version(session.source_version_id!).workspacePrefix;
		const list = vi.spyOn(env.bucket, 'list');
		vi.mocked(writer.inspectBranch).mockClear();
		expect((await save('single-tally')).state).toBe('complete');
		// Preparation reuses the baseline sizes that capture enumerated.
		expect(list.mock.calls.filter(([options]) => options?.prefix === prefix)).toHaveLength(1);
		expect(writer.inspectBranch).toHaveBeenCalledTimes(2);
	});
	it('rejects a remote change during preparation before dispatching', async () => {
		write('dashboard.py', 'edit');
		const prepare = vi.mocked(writer.prepareCommit).getMockImplementation()!;
		vi.mocked(writer.prepareCommit).mockImplementationOnce(async (input) => {
			const prepared = await prepare(input);
			h.head = 'external';
			return prepared;
		});
		const saved = await save('moved-during-prepare');
		expect(saved.state).toBe('conflict');
		expect(saved.error).toContain('BRANCH_MOVED');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('rejects aggregate workspace bytes above the import limit', async () => {
		write('extra.txt', 'x');
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
		// Stop after capture so the resumed preparation tallies a fresh baseline listing.
		const put = env.bucket.put.bind(env.bucket);
		vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
			const written = await put(key, value, options);
			if (key.endsWith('/receipt.json') && String(value).includes('"state":"captured"'))
				throw new Error('receipt response lost');
			return written;
		});
		await expect(save('too-large')).rejects.toThrow('receipt response lost');
		vi.mocked(env.bucket.put).mockImplementation(put);
		const pending = (await service.status(pid, nid)).last_save!;
		const rejected = await service.resume(pid, nid, pending.id, ACTOR, {
			workdir,
			getSandbox: () => sandbox(),
		});
		expect(rejected).toMatchObject({ state: 'conflict', error: expect.stringContaining('limits') });
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
	});
	it('releases admission after a definite provider rejection', async () => {
		write('dashboard.py', 'edit');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(
			new ConflictError('Branch rule rejected update'),
		);
		const rejected = await save('rejected');
		expect(rejected.state).toBe('conflict');
		expect((await service.status(pid, nid)).active_save).toBeUndefined();
		expect((await save('retry-new')).state).toBe('complete');
	});
	it('preserves edits during publication for the next capture', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
			write('dashboard.py', 'later');
			h.head = commit;
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
	it('reconciles a lost ref-update response without another commit or capture', async () => {
		write('dashboard.py', 'saved');
		vi.mocked(writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
			h.head = commit;
			throw new Error('lost response');
		});
		const pending = await save('one');
		expect(pending.state).toBe('ref_dispatched');
		write('dashboard.py', 'unsaved later');
		const done = await save('one');
		expect(done.state).toBe('complete');
		expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		expect(new TextDecoder().decode(snapshots.get(done.commit!)!.get('dashboard.py'))).toBe(
			'saved',
		);
	});
	function afterDispatch(receipt: { dispatched_at?: string }, elapsed: number) {
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.dispatched_at!) + elapsed);
	}
	it('does not replay against a different head or permit a second save', async () => {
		write('dashboard.py', 'saved');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('unknown'));
		expect((await save('one')).state).toBe('ref_dispatched');
		h.head = 'external';
		expect((await save('one')).state).toBe('ref_dispatched');
		await expect(save('two')).rejects.toThrow('Another save');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('finishes a dispatch as a conflict once the branch moved past the bound', async () => {
		write('dashboard.py', 'saved');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('unknown'));
		const pending = await save('one');
		expect(pending.dispatched_at).toBeDefined();
		h.head = 'external';
		afterDispatch(pending, WORKING_BRANCH_DISPATCH_BOUND_MS - 1);
		expect((await save('one')).state).toBe('ref_dispatched');
		afterDispatch(pending, WORKING_BRANCH_DISPATCH_BOUND_MS);
		const ended = await save('one');
		expect(ended).toMatchObject({ state: 'conflict', commit: pending.commit });
		expect(ended.error).toContain('moved without the saved commit');
		vi.mocked(Date.now).mockRestore();
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
		expect(await service.recovery(pid, nid, ended.id)).toBeInstanceOf(Uint8Array);
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		expect((await save('two')).state).toBe('conflict');
	});
	it('finishes a repeatedly rejected retry as a conflict only past the bound', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch)
			.mockRejectedValueOnce(new Error('request lost'))
			.mockRejectedValue(new ConflictError('rule rejected retry'));
		const pending = await save('rejected');
		afterDispatch(pending, WORKING_BRANCH_DISPATCH_BOUND_MS - 1);
		const fenced = await save('rejected');
		expect(fenced.state).toBe('ref_dispatched');
		expect(fenced.dispatched_at).toBe(pending.dispatched_at);
		afterDispatch(pending, WORKING_BRANCH_DISPATCH_BOUND_MS);
		const ended = await save('rejected');
		expect(ended.state).toBe('conflict');
		expect(ended.error).toContain('Remote update rejected');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(3);
		vi.mocked(Date.now).mockRestore();
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
	});
	it('restarts the bound when a retry outcome is unknown', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch)
			.mockRejectedValueOnce(new Error('request lost'))
			.mockRejectedValueOnce(new Error('request lost again'))
			.mockRejectedValueOnce(new ConflictError('rule rejected retry'));
		const pending = await save('unknown-retry');
		afterDispatch(pending, WORKING_BRANCH_DISPATCH_BOUND_MS);
		const retried = await save('unknown-retry');
		expect(retried.state).toBe('ref_dispatched');
		expect(Date.parse(retried.dispatched_at!)).toBe(
			Date.parse(pending.dispatched_at!) + WORKING_BRANCH_DISPATCH_BOUND_MS,
		);
		expect((await save('unknown-retry')).state).toBe('ref_dispatched');
	});
	it('retries an unapplied dispatch with exactly the captured commit and expected head', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('request lost'));
		const pending = await save('retry-cas');
		write('dashboard.py', 'later');
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
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch)
			.mockRejectedValueOnce(new Error('request lost'))
			.mockRejectedValueOnce(new ConflictError('rule rejected retry'));
		const pending = await save('retry-rejected');
		expect((await save('retry-rejected')).state).toBe('ref_dispatched');
		await expect(save('new-save')).rejects.toThrow('Another save');
		h.head = pending.commit!;
		expect((await save('retry-rejected')).state).toBe('complete');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(2);
	});
	it.each(['deleted', 'closed'] as const)(
		'does not replay a dispatch after the branch is %s',
		async (ended) => {
			write('dashboard.py', 'captured');
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
			const fenced = await save('ended-retry');
			expect(fenced.state).toBe('ref_dispatched');
			expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).ended_reason).toBe(
				ended === 'deleted' ? 'branch_deleted' : 'pr_closed',
			);
			afterDispatch(fenced, WORKING_BRANCH_DISPATCH_BOUND_MS);
			const finished = await save('ended-retry');
			expect(finished.state).toBe('conflict');
			expect(finished.error).toContain('publication ended');
			expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
		},
	);
	it('rechecks authorization before retrying a conditional update', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('request lost'));
		const pending = await save('revoked-retry');
		await expect(
			service.resume(pid, nid, pending.id, ACTOR, {
				workdir,
				getSandbox: () => sandbox(),
				authorize: async () => {
					throw new Error('revoked');
				},
			}),
		).rejects.toThrow('revoked');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('completes hub sync after a failure using the original saved content', async () => {
		write('dashboard.py', 'saved');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(
			new Error('provider temporarily unavailable'),
		);
		const pending = await save('one');
		expect(pending.state).toBe('remote_committed');
		write('dashboard.py', 'later');
		expect((await save('one')).state).toBe('complete');
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('ends a save whose commit the hub deterministically cannot import', async () => {
		write('dashboard.py', 'saved');
		vi.spyOn(env.notebooks.synced, 'sync').mockRejectedValueOnce(
			new ValidationError('Git directory exceeds limits'),
		);
		const ended = await save('invalid');
		expect(ended.state).toBe('conflict');
		expect(ended.error).toContain('Committed remotely');
		expect(ended.error).toContain('Sync now');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
		expect(h.head).toBe(ended.commit);
	});
	it('keeps a committed save pending when the caller is not authorized to import it', async () => {
		write('dashboard.py', 'saved');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('outage'));
		const pending = await save('authorized');
		expect(pending.state).toBe('remote_committed');
		await expect(
			service.resume(pid, nid, pending.id, ACTOR, {
				workdir,
				getSandbox: () => sandbox(),
				authorize: async () => {
					throw new ForbiddenError('revoked');
				},
			}),
		).rejects.toThrow('revoked');
		expect((await service.getSave(pid, nid, pending.id)).state).toBe('remote_committed');
	});
	it('lets another editor finish a save after its commit is public', async () => {
		write('dashboard.py', 'saved');
		vi.mocked(reader.fetchWorkspace).mockRejectedValueOnce(new Error('outage'));
		const pending = await save('handoff');
		expect(pending.state).toBe('remote_committed');
		const other = uid('other-user');
		expect(service.canResume(pending, other)).toBe(true);
		expect(service.canResume({ ...pending, state: 'hub_synced' }, other)).toBe(true);
		for (const state of [
			'ref_dispatched',
			'complete',
			'conflict',
			'expired',
			'no_changes',
		] as const)
			expect(service.canResume({ ...pending, state }, other)).toBe(false);
		expect(service.canResume({ ...pending, state: 'conflict' }, pending.author)).toBe(true);
		const getSandbox = vi.fn(() => sandbox());
		const done = await service.resume(pid, nid, pending.id, other, { workdir, getSandbox });
		expect(done.state).toBe('complete');
		expect(getSandbox).not.toHaveBeenCalled();
		expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
	});
	it('retains a conflicted capture for export and never overwrites the branch', async () => {
		write('dashboard.py', 'recover me');
		h.head = 'external';
		const failed = await save('one');
		expect(failed.state).toBe('conflict');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
		const recovered = unzipSync(await service.recovery(pid, nid, failed.id));
		expect(new TextDecoder().decode(recovered['files/dashboard.py'])).toBe('recover me');
	});
	it('prevents source retargeting and preserves launch provenance', async () => {
		const before = await env.sessions.getSession(pid, sid);
		write('dashboard.py', 'saved');
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
		expect(h.head).toBe('base');
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
		write('dashboard.py', 'saved');
		const saved = await save('one');
		await service.pruneExpiredPayloads(Date.now() + 2 * 86400_000);
		expect(await env.bucket.get(workingBranchPaths(pid, nid).capture(saved.id))).toBeNull();
		expect((await save('one')).state).toBe('complete');
	});
	it('recovers branch creation after a lost response with pinned identity', async () => {
		h.head = null;
		vi.mocked(writer.createBranch).mockImplementationOnce(async ({ fromCommit }) => {
			h.head = fromCommit;
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
		h.head = null;
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
		h.head = null;
		vi.mocked(writer.createBranch).mockRejectedValueOnce(new Error('request lost'));
		await expect(service.create(pid, ACTOR, 'advanced-create', createInput)).rejects.toThrow();
		h.head = 'external';
		await expect(service.create(pid, ACTOR, 'advanced-create', createInput)).rejects.toThrow(
			'pinned fork',
		);
		expect(writer.createBranch).toHaveBeenCalledTimes(2);
	});
	it('renews the lease throughout a capture lasting longer than two minutes', async () => {
		for (let i = 0; i < 6; i++) write(`slow-${i}.py`, 'changed');
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
		write('dashboard.py', 'new');
		const saved = await save('invalidate-status');
		expect((await service.status(pid, nid)).remote_commit).toBe(saved.commit);
	});
	it('rejects unexplained preexisting refs even at the fork commit', async () => {
		await expect(service.create(pid, ACTOR, 'other-creation', createInput)).rejects.toThrow(
			'cannot be adopted',
		);
		expect(writer.createBranch).toHaveBeenCalledTimes(1);
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
		write('dashboard.py', 'saved');
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
		write('dashboard.py', 'saved');
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
		write('dashboard.py', 'saved');
		const saved = await save('one');
		await new WorkingBranchStore(env.bucket).update(pid, nid, (record) => ({
			...record,
			active_save: saved.id,
		}));
		await save('one');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
	});
	it('expires abandoned captures and releases their admission', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider unavailable'));
		await expect(save('abandoned')).rejects.toThrow('provider unavailable');
		const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
		expect(await service.pruneExpiredPayloads(Date.now() + 26 * 3600_000)).toBe(1);
		expect((await service.getSave(pid, nid, record.active_save!)).state).toBe('expired');
		expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).active_save).toBeUndefined();
	});
	it('keeps unresolved remote operations beyond normal retention', async () => {
		write('dashboard.py', 'captured');
		vi.mocked(writer.advanceBranch).mockRejectedValueOnce(new Error('response lost'));
		const result = await save('unresolved');
		expect(await service.pruneExpiredPayloads(Date.now() + 26 * 3600_000)).toBe(0);
		expect((await service.getSave(pid, nid, result.id)).state).toBe('ref_dispatched');
		expect(await service.recovery(pid, nid, result.id)).toBeInstanceOf(Uint8Array);
	});
	it('rechecks authorization before publishing captured source', async () => {
		write('dashboard.py', 'captured');
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
				getSandbox: () => sandbox(),
				authorize,
			}),
		).rejects.toThrow('access revoked');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('blocks publication and manual sync until creation completes', async () => {
		const store = new WorkingBranchStore(env.bucket);
		await store.update(pid, nid, (record) => ({ ...record, state: 'branch_created' }));
		write('dashboard.py', 'pending creation');
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
		h.head = null;
		expect((await service.status(pid, nid)).ended_reason).toBe('branch_deleted');
		h.head = 'base';
		write('dashboard.py', 'after deletion');
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
		write('dashboard.py', 'after closing');
		expect((await save('closed-pr')).state).toBe('conflict');
		expect(writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('bounds deletion-only captures', async () => {
		const base = paths.project(pid).notebook(nid).version(createVersionId());
		await Promise.all(
			Array.from({ length: 1001 }, (_, i) =>
				env.bucket.put(base.workspaceFile(`file-${i}.py`), 'base'),
			),
		);
		await expect(
			captureWorkingBranchChanges(
				env.bucket,
				sandbox({ files: new Map() }),
				{ workdir, gitRoot: workdir, rootPath: '' },
				base,
			),
		).rejects.toThrow('file limit');
	});
	it('cleans an abandoned capture after notebook deletion', async () => {
		write('dashboard.py', 'captured');
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
		write('dashboard.py', 'captured');
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
			write('dashboard.py', 'edit');
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
				(
					await service.resume(pid, nid, pending.id, ACTOR, {
						workdir,
						getSandbox: () => sandbox(),
					})
				).state,
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
				write('dashboard.py', 'captured');
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
								getSandbox: () => sandbox(),
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
			write('dashboard.py', 'captured');
			vi.mocked(writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
				h.head = 'external-descendant';
				vi.mocked(writer.inspectBranch).mockImplementation(async (input) => ({
					headCommit: h.head,
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
			expect(h.head).toBe('external-descendant');
			write('dashboard.py', 'next edits');
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
				write('dashboard.py', 'captured');
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
				write('dashboard.py', 'captured');
				failReceipt('commit_prepared', persisted);
				await expect(save('prepared')).rejects.toThrow('receipt storage unavailable');
				write('dashboard.py', 'later edits');
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
				write('dashboard.py', 'captured');
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
				write('dashboard.py', 'captured');
				failReceipt('remote_committed', persisted);
				await expect(save('remote')).rejects.toThrow('receipt storage unavailable');
				write('dashboard.py', 'later edits');
				expect((await save('remote')).state).toBe('complete');
				expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
				expect(new TextDecoder().decode(tree.get('dashboard.py'))).toBe('later edits');
			},
		);

		it('reuses a capture whose storage response was lost', async () => {
			write('dashboard.py', 'captured');
			const put = env.bucket.put.bind(env.bucket);
			const fault = vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
				const result = await put(key, value, options);
				if (key.endsWith('/capture.json')) throw new Error('capture response lost');
				return result;
			});
			await expect(save('capture')).rejects.toThrow('capture response lost');
			fault.mockRestore();
			await expect(save('competing')).rejects.toThrow('Another save');
			write('dashboard.py', 'later edits');
			const result = await save('capture');
			expect(result.state).toBe('complete');
			expect(new TextDecoder().decode(snapshots.get(result.commit!)!.get('dashboard.py'))).toBe(
				'captured',
			);
		});

		it('retries a lost session acknowledgment without another commit or version', async () => {
			write('dashboard.py', 'captured');
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
			write('dashboard.py', 'next save');
			expect((await save('next')).base_commit).toBe(result.commit);
		});

		it.each(['corrupt', 'missing'])(
			'rejects a %s capture without publishing or recapturing',
			async (failure) => {
				write('dashboard.py', 'captured');
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
				write('dashboard.py', 'later edits');
				await expect(save('payload')).rejects.toThrow(
					failure === 'missing' ? 'unavailable' : 'integrity',
				);
				expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
				expect(writer.advanceBranch).not.toHaveBeenCalled();
			},
		);

		it('rejects overlapping saves while commit preparation is in flight', async () => {
			write('dashboard.py', 'captured');
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
			write('dashboard.py', 'captured');
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
				expect(h.head).toBe(winner.commit);
				expect(writer.advanceBranch).toHaveBeenCalledTimes(1);
			} finally {
				release.resolve();
			}
		});

		it('does not publish when the notebook is deleted during preparation', async () => {
			write('dashboard.py', 'captured');
			vi.mocked(writer.prepareCommit).mockImplementationOnce(async () => {
				await env.notebooks.deleteNotebook(pid, nid, ACTOR);
				return { commit: 'prepared-before-delete' };
			});
			await expect(save('delete-race')).rejects.toThrow('lost its claim');
			expect(writer.advanceBranch).not.toHaveBeenCalled();
			expect((await new WorkingBranchStore(env.bucket).read(pid, nid)).state).toBe('deleted');
		});

		it('denies retry by a different author without accessing the sandbox or provider', async () => {
			write('dashboard.py', 'captured');
			vi.mocked(writer.prepareCommit).mockRejectedValueOnce(new Error('provider offline'));
			await expect(save('private-retry')).rejects.toThrow('provider offline');
			const record = await new WorkingBranchStore(env.bucket).read(pid, nid);
			const getSandbox = vi.fn(() => sandbox());
			await expect(
				service.resume(pid, nid, record.active_save!, uid('other-user'), { workdir, getSandbox }),
			).rejects.toThrow('Only the save author');
			expect(getSandbox).not.toHaveBeenCalled();
			expect(writer.prepareCommit).toHaveBeenCalledTimes(1);
			expect(writer.advanceBranch).not.toHaveBeenCalled();
		});
	});
});

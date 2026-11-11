// Working-branch saves against a real Git checkout and the real O_NOFOLLOW
// Python scripts. Service semantics that need no filesystem live in
// WorkingBranchService.test.ts on the in-memory sandbox.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ACTOR, makeFsSandbox } from '../../testing';
import { createGitRepoTemplate, execInLocalShell, gitInRepo } from '../../testing/gitRepoTemplate';
import { createSandboxId } from '../../ids';
import { setupWorkingBranchHarness, WORKING_BRANCH_CREATE_INPUT } from './workingBranchTestkit';
import type { WorkingBranchHarness } from './workingBranchTestkit';

const template = createGitRepoTemplate((repo, git) => {
	writeFileSync(join(repo, 'dashboard.py'), 'base');
	writeFileSync(join(repo, '.gitignore'), '*.ignored\n');
	git('add', '.');
	git('commit', '-qm', 'base');
}, 'working-branch-');

describe('WorkingBranchService on a Git checkout', { timeout: 60_000 }, () => {
	let h: WorkingBranchHarness;
	let workdir: string;
	const git = (...args: string[]) => gitInRepo(workdir, ...args);

	beforeEach(async () => {
		h = await setupWorkingBranchHarness();
		workdir = template.instantiate();
	}, 30_000);
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(workdir, { recursive: true, force: true });
	});
	afterAll(() => template.dispose());
	function sandbox() {
		const instance = makeFsSandbox().instance;
		instance.exec = (command, options) => execInLocalShell(command, options);
		return instance;
	}
	function save(key: string) {
		return h.service.save({
			projectId: h.pid,
			notebookId: h.nid,
			sessionId: h.sid,
			actor: ACTOR,
			idempotencyKey: key,
			workdir,
			getSandbox: sandbox,
		});
	}

	it('saves additions repeatedly without importing commits or modifying the live index', async () => {
		const originalIndex = readFileSync(join(workdir, '.git/index'));
		const originalHead = git('rev-parse', 'HEAD');
		writeFileSync(join(workdir, 'new.py'), 'first');
		const first = await save('one');
		expect(first.state).toBe('complete');
		expect(first.changes).toEqual([expect.objectContaining({ path: 'new.py', operation: 'add' })]);
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
	});
	it('captures quoted Unicode paths, binary bytes, and empty files', async () => {
		const path = "notes 'quoted' café $value.txt";
		const bytes = new Uint8Array([0, 255, 13, 10]);
		writeFileSync(join(workdir, path), bytes);
		writeFileSync(join(workdir, 'empty.txt'), '');
		const saved = await save('unusual-files');
		expect(saved.state).toBe('complete');
		expect(h.snapshots.get(saved.commit!)!.get(path)).toEqual(bytes);
		expect(h.snapshots.get(saved.commit!)!.get('empty.txt')).toEqual(new Uint8Array());
		expect((await save('unusual-unchanged')).state).toBe('no_changes');
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
	it('retains entrypoint deletion for recovery without publishing it', async () => {
		unlinkSync(join(workdir, 'dashboard.py'));
		const result = await save('deleted-entry');
		expect(result.state).toBe('conflict');
		expect(result.error).toContain('entry file cannot be deleted');
		expect(h.writer.prepareCommit).not.toHaveBeenCalled();
		expect(h.writer.advanceBranch).not.toHaveBeenCalled();
	});
	it('never reads symlink payloads', async () => {
		symlinkSync(join(workdir, 'dashboard.py'), join(workdir, 'link.py'));
		await expect(save('symlink')).rejects.toThrow('securely read');
		expect(h.writer.prepareCommit).not.toHaveBeenCalled();
	});
	it('releases admission after capture fails, even if that session stops', async () => {
		const { env, pid, nid } = h;
		symlinkSync(join(workdir, 'dashboard.py'), join(workdir, 'link.py'));
		await expect(save('failed-capture')).rejects.toThrow('securely read');
		expect((await h.service.status(pid, nid)).active_save).toBeUndefined();
		await env.sessions.beginTerminating(pid, h.sid);
		await env.sessions.markTerminated(pid, h.sid);
		await env.sessions.releaseEditorFor(await env.sessions.getSession(pid, h.sid));
		unlinkSync(join(workdir, 'link.py'));
		const detail = await env.notebooks.getNotebook(pid, nid);
		const next = await env.sessions.createSession({
			project_id: pid,
			notebook_id: nid,
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
			source_version_id: detail.source.current_version_id!,
		});
		h.sid = next.session_id;
		await env.sessions.setRunning(pid, h.sid, 'https://kernel.test');
		await env.sessions.claimEditor(pid, nid, h.sid, 'shared');
		writeFileSync(join(workdir, 'dashboard.py'), 'next session');
		expect((await save('new-session')).state).toBe('complete');
	});

	describe('subtree pull sources', () => {
		async function createSubtreeNotebook(key: string, rootPath: string) {
			const { env, pid, service } = h;
			h.head = null;
			const created = await service.create(pid, ACTOR, key, {
				...WORKING_BRANCH_CREATE_INPUT,
				root_path: rootPath,
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
			return (key: string) =>
				service.save({
					projectId: pid,
					notebookId: created.meta.id,
					sessionId: session.session_id,
					actor: ACTOR,
					idempotencyKey: key,
					workdir,
					getSandbox: sandbox,
				});
		}

		it('captures only the configured subtree and compares against its stored baseline', async () => {
			const save = await createSubtreeNotebook('subtree', 'apps');
			mkdirSync(join(workdir, 'apps'));
			writeFileSync(join(workdir, 'apps/dashboard.py'), 'subtree');
			writeFileSync(join(workdir, 'outside.py'), 'not saved');
			await save('subtree-save');
			expect(
				vi.mocked(h.writer.prepareCommit).mock.calls[0][0].changes.map((change) => change.path),
			).toEqual(['apps/.gitignore', 'apps/dashboard.py']);
		});
		it('rejects a symlink ancestor of the configured subtree', async () => {
			const save = await createSubtreeNotebook('nested-subtree', 'apps/nested');
			const outside = mkdtempSync(join(tmpdir(), 'branch-outside-'));
			try {
				gitInRepo(outside, 'init', '-q');
				mkdirSync(join(outside, 'nested'));
				writeFileSync(join(outside, 'nested/dashboard.py'), 'private outside content');
				symlinkSync(outside, join(workdir, 'apps'));
				await expect(save('escaped')).rejects.toThrow('securely read');
				expect(h.writer.prepareCommit).not.toHaveBeenCalled();
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	});
});

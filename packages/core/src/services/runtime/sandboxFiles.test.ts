import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNotebookId, createProjectId } from '../../ids';
import { paths } from '../../paths';
import { MAX_ARTIFACT_BYTES, MAX_WORKSPACE_FILE_BYTES } from '../../constants';
import {
	bytesOfSize,
	makeFakeSandbox,
	makeFsSandbox,
	MemoryBucket,
	RecordingBucket,
} from '../../testing';
import { captureWorkspace, readSessionArtifacts, restoreWorkspace } from './sandboxFiles';

// `makeFsSandbox`'s default root — every test mounts the notebook here.
const MOUNT = '/workspace';

function nbCtx() {
	const projectId = createProjectId();
	const notebookId = createNotebookId();
	const nb = paths.project(projectId).notebook(notebookId);
	return { projectId, notebookId, nb };
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('restoreWorkspace', () => {
	it('creates every parent in ONE mkdir, then restores every workspace key', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		await bucket.put(nb.code, 'import marimo');
		await bucket.put(nb.deps, '[project]\nname = "nb"');
		await bucket.put(nb.workspaceFile('data/cars.csv'), 'a,b\n1,2\n');
		const { instance, fs, calls } = makeFsSandbox();

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		// One exec covers the working dir AND every nested parent (SDK writeFile won't
		// make parents), rather than one mkdir per file.
		const mkdirs = calls.exec.filter((c) => c.startsWith('mkdir -p '));
		expect(mkdirs).toHaveLength(1);
		expect(mkdirs[0]).toContain(`'${MOUNT}'`);
		expect(mkdirs[0]).toContain(`'${MOUNT}/data'`);
		expect(decode(fs.get('notebook.py')!)).toBe('import marimo');
		expect(decode(fs.get('pyproject.toml')!)).toBe('[project]\nname = "nb"');
		expect(decode(fs.get('data/cars.csv')!)).toBe('a,b\n1,2\n');
	});

	it('writes the whole workspace in one batched call', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		await bucket.put(nb.code, 'import marimo');
		await bucket.put(nb.workspaceFile('data/cars.csv'), 'a,b\n1,2\n');
		const { instance, calls } = makeFsSandbox();

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		expect(calls.writeFiles).toHaveLength(1);
		expect(calls.writeFiles[0].map((f) => f.path).sort()).toEqual([
			`${MOUNT}/data/cars.csv`,
			`${MOUNT}/notebook.py`,
		]);
	});

	it('round-trips binary files byte-identically', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		const blob = new Uint8Array([0, 1, 2, 253, 254, 255, 137, 80, 78, 71]);
		await bucket.put(nb.workspaceFile('data/x.parquet'), blob);
		const { instance, fs } = makeFsSandbox();

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		expect(Array.from(fs.get('data/x.parquet')!)).toEqual(Array.from(blob));
	});

	it('sends payloads over the file channel, never inlining them into an exec argv (ARG_MAX-safe)', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		// A blob that would blow past a single shell argument if inlined; it must
		// instead flow through the file-write channel as raw bytes.
		const blob = new Uint8Array(200 * 1024).map((_, i) => i % 256);
		await bucket.put(nb.workspaceFile('data/big.bin'), blob);
		const { instance, fs, calls } = makeFsSandbox();

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		expect(Array.from(fs.get('data/big.bin')!)).toEqual(Array.from(blob));
		// The only exec is the mkdir: no command carries the payload, and nothing is
		// base64-armored through a shell (nor left behind as a temp file).
		expect(calls.exec.every((c) => c.startsWith('mkdir -p ') && c.length < 4096)).toBe(true);
		expect(calls.exec.some((c) => c.includes('base64'))).toBe(false);
		expect([...fs.keys()].some((k) => k.endsWith('.tmp'))).toBe(false);
	});

	it('splits a large workspace into byte-bounded batches (never buffers it all)', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		// 3 x 4MB against an 8MB budget => the whole set can't ride in one call.
		for (const name of ['a.bin', 'b.bin', 'c.bin']) {
			await bucket.put(nb.workspaceFile(name), new Uint8Array(4 * 1024 * 1024));
		}
		const { instance, fs, calls } = makeFsSandbox();

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		expect(calls.writeFiles.length).toBeGreaterThan(1);
		// Every batch stays within budget, and nothing is dropped.
		for (const batch of calls.writeFiles) {
			const bytes = batch.reduce((n, f) => n + (f.content as Uint8Array).length, 0);
			expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
		}
		expect(fs.size).toBe(3);
	});

	it('still creates the working dir when the workspace is empty', async () => {
		const { nb } = nbCtx();
		const { instance, calls } = makeFsSandbox();

		await restoreWorkspace(instance, new MemoryBucket(), nb.workspacePrefix, MOUNT);

		// marimo's cwd must exist even with nothing to restore.
		expect(calls.exec.filter((c) => c.startsWith('mkdir -p '))).toEqual([`mkdir -p '${MOUNT}'`]);
		expect(calls.writeFiles).toHaveLength(0);
	});

	it('writes nothing when the workspace is empty', async () => {
		const { nb } = nbCtx();
		const { instance, fs } = makeFsSandbox();

		await restoreWorkspace(instance, new MemoryBucket(), nb.workspacePrefix, MOUNT);

		expect(fs.size).toBe(0);
	});

	describe('caps', () => {
		let warn: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});
		afterEach(() => {
			warn.mockRestore();
		});

		it('skips an oversized object *before* fetching it (never buffered), restoring the rest', async () => {
			const { nb } = nbCtx();
			const rec = new RecordingBucket(new MemoryBucket());
			await rec.put(nb.workspaceFile('small.txt'), 'ok');
			const bigKey = nb.workspaceFile('huge.bin');
			await rec.put(bigKey, bytesOfSize(MAX_WORKSPACE_FILE_BYTES + 1));
			const { instance, fs } = makeFsSandbox();

			await restoreWorkspace(instance, rec, nb.workspacePrefix, MOUNT);

			// Small file restored; oversized file never written into the sandbox.
			expect(decode(fs.get('small.txt')!)).toBe('ok');
			expect(fs.has('huge.bin')).toBe(false);
			// The oversized object was never `get`-ed, so its bytes never hit memory.
			expect(rec.calls.get).toContain(nb.workspaceFile('small.txt'));
			expect(rec.calls.get).not.toContain(bigKey);
			expect(warn).toHaveBeenCalled();
		});
	});
});

describe('captureWorkspace', () => {
	it('source mode: uploads no runtime files (commitSession owns the source files)', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		const { instance } = makeFsSandbox({
			files: {
				'notebook.py': 'import marimo',
				'pyproject.toml': '[project]',
				'data/cars.csv': 'a,b\n',
			},
		});

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'source');

		// Nothing captured — not even the runtime data.
		expect(await bucket.get(nb.workspaceFile('data/cars.csv'))).toBeNull();
		expect(await bucket.get(nb.code)).toBeNull();
	});

	it('workspace mode: captures runtime files but excludes source + __marimo__', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		const { instance } = makeFsSandbox({
			files: {
				'notebook.py': 'import marimo',
				'pyproject.toml': '[project]',
				'__marimo__/notebook.html': '<html></html>',
				'data/cars.csv': 'a,b\n1,2\n',
				'out.txt': 'hello',
			},
		});

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

		// Runtime files captured.
		expect(decode(await (await bucket.get(nb.workspaceFile('data/cars.csv')))!.bytes())).toBe(
			'a,b\n1,2\n',
		);
		expect(decode(await (await bucket.get(nb.workspaceFile('out.txt')))!.bytes())).toBe('hello');
		// Source + __marimo__ excluded.
		expect(await bucket.get(nb.code)).toBeNull();
		expect(await bucket.get(nb.deps)).toBeNull();
		expect(await bucket.get(nb.workspaceFile('__marimo__/notebook.html'))).toBeNull();
	});

	it('workspace mode: excludes regenerable .venv and __pycache__ (incl. nested) junk', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		const { instance } = makeFsSandbox({
			files: {
				'data/cars.csv': 'a,b\n',
				'.venv/bin/python': 'binary',
				'__pycache__/mod.cpython-312.pyc': 'bytecode',
				'pkg/__pycache__/util.cpython-312.pyc': 'bytecode', // nested, not at root
			},
		});

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

		// Real data captured; venv + bytecode caches (root and nested) skipped.
		expect(await bucket.get(nb.workspaceFile('data/cars.csv'))).not.toBeNull();
		expect(await bucket.get(nb.workspaceFile('.venv/bin/python'))).toBeNull();
		expect(await bucket.get(nb.workspaceFile('__pycache__/mod.cpython-312.pyc'))).toBeNull();
		expect(await bucket.get(nb.workspaceFile('pkg/__pycache__/util.cpython-312.pyc'))).toBeNull();
	});

	it('workspace mode: round-trips binary files byte-identically', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		const blob = new Uint8Array([0, 255, 16, 128, 200, 7]);
		const { instance } = makeFsSandbox({ files: { 'data/x.parquet': blob } });

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

		const stored = await (await bucket.get(nb.workspaceFile('data/x.parquet')))!.bytes();
		expect(Array.from(stored)).toEqual(Array.from(blob));
	});

	it('mirror-deletes stale workspace keys not present in the sandbox (never the source files)', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		// Pre-existing workspace: source files + a stale data file no longer in the sandbox.
		await bucket.put(nb.code, 'import marimo');
		await bucket.put(nb.deps, '[project]');
		await bucket.put(nb.workspaceFile('data/old.csv'), 'stale');
		const { instance } = makeFsSandbox({
			files: {
				'notebook.py': 'import marimo',
				'pyproject.toml': '[project]',
				'data/new.csv': 'fresh',
			},
		});

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

		// Stale data dropped, fresh data captured.
		expect(await bucket.get(nb.workspaceFile('data/old.csv'))).toBeNull();
		expect(decode(await (await bucket.get(nb.workspaceFile('data/new.csv')))!.bytes())).toBe(
			'fresh',
		);
		// Source files were left untouched by the mirror-delete.
		expect(await bucket.get(nb.code)).not.toBeNull();
		expect(await bucket.get(nb.deps)).not.toBeNull();
	});

	it('source mode still mirror-deletes stale runtime data (downgrade from workspace)', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		await bucket.put(nb.code, 'import marimo');
		await bucket.put(nb.workspaceFile('data/cars.csv'), 'data');
		const { instance } = makeFsSandbox({
			files: {
				'notebook.py': 'import marimo',
				'data/cars.csv': 'data',
			},
		});

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'source');

		// Source mode captures nothing, so the previously-captured runtime data is
		// mirror-deleted, while the source file is preserved.
		expect(await bucket.get(nb.workspaceFile('data/cars.csv'))).toBeNull();
		expect(await bucket.get(nb.code)).not.toBeNull();
	});

	describe('caps', () => {
		let warn: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});
		afterEach(() => {
			warn.mockRestore();
		});

		it('skips files past the file-count cap and warns per skip', async () => {
			const { projectId, notebookId } = nbCtx();
			const bucket = new MemoryBucket();
			// One file over the 1000-file cap so exactly one skip+warn is exercised.
			const files: Record<string, string> = {};
			for (let i = 0; i < 1001; i++) files[`f${i}.txt`] = 'x';
			const { instance } = makeFsSandbox({ files });

			await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

			// 1000 captured, 1 skipped with a warning.
			const listed = await bucket.list({
				prefix: paths.project(projectId).notebook(notebookId).workspacePrefix,
			});
			expect(listed.objects).toHaveLength(1000);
			expect(warn).toHaveBeenCalled();
		});

		it('skips a file past the per-file cap *before* reading it, and warns', async () => {
			const { projectId, notebookId, nb } = nbCtx();
			const rec = new RecordingBucket(new MemoryBucket());
			const { instance } = makeFsSandbox({
				files: { 'small.txt': 'ok', 'huge.bin': bytesOfSize(MAX_WORKSPACE_FILE_BYTES + 1) },
			});

			await captureWorkspace(instance, rec, projectId, notebookId, MOUNT, 'workspace');

			expect(await rec.get(nb.workspaceFile('small.txt'))).not.toBeNull();
			expect(await rec.get(nb.workspaceFile('huge.bin'))).toBeNull();
			// Oversized file was never put (so never base64-read into memory either).
			expect(rec.calls.put.map((p) => p.key)).not.toContain(nb.workspaceFile('huge.bin'));
			expect(warn).toHaveBeenCalled();
		});

		it('skips files that would exceed the total-byte cap and warns', async () => {
			const { projectId, notebookId } = nbCtx();
			const bucket = new MemoryBucket();
			// Five files declared at 24 MiB each (under the 25 MiB per-file cap; 5 × 24
			// = 120 MiB > 100 MiB total). The cap keys off the *listed* size, so declare
			// the sizes rather than allocating 120 MiB of payload to base64-round-trip.
			const files: Record<string, Uint8Array> = {};
			const sizes: Record<string, number> = {};
			for (let i = 0; i < 5; i++) {
				files[`f${i}.bin`] = bytesOfSize(1);
				sizes[`f${i}.bin`] = 24 * 1024 * 1024;
			}
			const { instance } = makeFsSandbox({ files, sizes });

			await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

			// 4 files fit (96 MiB); the 5th would cross 100 MiB and is skipped.
			const listed = await bucket.list({
				prefix: paths.project(projectId).notebook(notebookId).workspacePrefix,
			});
			expect(listed.objects).toHaveLength(4);
			expect(warn).toHaveBeenCalled();
		});
	});

	describe('robustness', () => {
		let warn: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});
		afterEach(() => {
			warn.mockRestore();
		});

		it('workspace mode: a failed working-dir listing skips cleanup (never wipes persisted data)', async () => {
			const { projectId, notebookId, nb } = nbCtx();
			const bucket = new MemoryBucket();
			// A file captured by a previous (successful) teardown.
			await bucket.put(nb.workspaceFile('data/keep.csv'), 'precious');
			const { instance: base } = makeFsSandbox({ files: { 'data/keep.csv': 'precious' } });
			const instance = {
				...base,
				listFiles: async () => ({ success: false, files: [] }),
			} as unknown as typeof base;

			await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

			// Listing failed, so the mirror-delete is skipped and the data survives.
			expect(await bucket.get(nb.workspaceFile('data/keep.csv'))).not.toBeNull();
			expect(warn).toHaveBeenCalled();
		});

		it('workspace mode: an unreadable file is skipped, the rest still captured', async () => {
			const { projectId, notebookId, nb } = nbCtx();
			const bucket = new MemoryBucket();
			const { instance: base } = makeFsSandbox({ files: { 'good.txt': 'g', 'bad.txt': 'b' } });
			const instance = {
				...base,
				exec: async (cmd: string) =>
					cmd.startsWith('base64 -w0') && cmd.includes('bad.txt')
						? { success: false, stdout: '', stderr: 'io error' }
						: base.exec(cmd),
			} as unknown as typeof base;

			await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

			expect(decode(await (await bucket.get(nb.workspaceFile('good.txt')))!.bytes())).toBe('g');
			expect(await bucket.get(nb.workspaceFile('bad.txt'))).toBeNull();
			expect(warn).toHaveBeenCalled();
		});
	});
});

describe('readSessionArtifacts', () => {
	it('reads code, deps, and both __marimo__ snapshots when present', async () => {
		const { instance } = makeFakeSandbox({
			files: {
				[`${MOUNT}/notebook.py`]: 'import marimo as mo',
				[`${MOUNT}/pyproject.toml`]: '[project]',
				[`${MOUNT}/__marimo__/notebook.html`]: '<html>output</html>',
				[`${MOUNT}/__marimo__/session/notebook.py.json`]: '{"version":"1"}',
			},
		});

		const artifacts = await readSessionArtifacts(instance, MOUNT);

		expect(artifacts).toEqual({
			code: 'import marimo as mo',
			deps: '[project]',
			html: '<html>output</html>',
			session: '{"version":"1"}',
		});
	});

	it('omits artifacts the sandbox cannot read', async () => {
		const { instance } = makeFakeSandbox({
			files: { [`${MOUNT}/notebook.py`]: 'code only' }, // no deps / html / session
		});

		const artifacts = await readSessionArtifacts(instance, MOUNT);

		expect(artifacts.code).toBe('code only');
		expect(artifacts.deps).toBeUndefined();
		expect(artifacts.html).toBeUndefined();
		expect(artifacts.session).toBeUndefined();
	});

	it('omits an oversized artifact (e.g. HTML) *before* reading it, and warns', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { instance, calls } = makeFsSandbox({
			files: {
				'notebook.py': 'import marimo as mo',
				'__marimo__/notebook.html': bytesOfSize(MAX_ARTIFACT_BYTES + 1),
			},
		});

		const artifacts = await readSessionArtifacts(instance, MOUNT);

		expect(artifacts.code).toBe('import marimo as mo');
		expect(artifacts.html).toBeUndefined();
		// The oversized HTML was never read into memory.
		expect(calls.readFile).toContain(`${MOUNT}/notebook.py`);
		expect(calls.readFile).not.toContain(`${MOUNT}/__marimo__/notebook.html`);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('sandboxFiles security', () => {
	it('restoreWorkspace never writes outside workingDir when a bucket key contains ".."', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		// A poisoned object key (e.g. from a compromised/synced source) that would
		// resolve to a path above the working dir if concatenated naively.
		await bucket.put(`${nb.workspacePrefix}../../etc/pwned.txt`, 'owned');
		await bucket.put(nb.workspaceFile('safe.txt'), 'ok');
		const { instance, calls } = makeFsSandbox();

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		// Every written path MUST stay under the working dir — no `..` escape.
		for (const batch of calls.writeFiles) {
			for (const f of batch) {
				expect(f.path.startsWith(`${MOUNT}/`)).toBe(true);
				expect(f.path).not.toContain('/../');
			}
		}
		// The mkdir prep must likewise not create a directory above the working dir.
		for (const cmd of calls.exec) {
			if (cmd.startsWith('mkdir -p ')) expect(cmd).not.toContain('/../');
		}
	});

	it('captureWorkspace shell-safely handles a filename with shell metacharacters', async () => {
		const { projectId, notebookId, nb } = nbCtx();
		const bucket = new MemoryBucket();
		// `$(id)` would execute if the filename were interpolated unquoted into `sh -lc`.
		const { instance } = makeFsSandbox({ files: { '$(id).csv': 'a,b\n1,2\n' } });

		await captureWorkspace(instance, bucket, projectId, notebookId, MOUNT, 'workspace');

		const stored = await bucket.get(nb.workspaceFile('$(id).csv'));
		expect(decode(await stored!.bytes())).toBe('a,b\n1,2\n');
	});

	it('restoreWorkspace retries a transient writeFiles fault, then succeeds', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		await bucket.put(nb.workspaceFile('a.txt'), 'hi');
		const { instance: base, fs } = makeFsSandbox();
		let attempts = 0;
		const instance = {
			...base,
			writeFiles: async (files: Parameters<typeof base.writeFiles>[0]) => {
				attempts++;
				if (attempts < 2) throw new Error('ECONNRESET');
				return base.writeFiles(files);
			},
		} as unknown as typeof base;

		await restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT);

		expect(attempts).toBe(2);
		expect(decode(fs.get('a.txt')!)).toBe('hi');
	});

	it('restoreWorkspace throws after exhausting write attempts', async () => {
		const { nb } = nbCtx();
		const bucket = new MemoryBucket();
		await bucket.put(nb.workspaceFile('a.txt'), 'hi');
		const { instance: base } = makeFsSandbox();
		const instance = {
			...base,
			writeFiles: async () => {
				throw new Error('ECONNRESET');
			},
		} as unknown as typeof base;

		await expect(restoreWorkspace(instance, bucket, nb.workspacePrefix, MOUNT)).rejects.toThrow(
			'ECONNRESET',
		);
	});
});

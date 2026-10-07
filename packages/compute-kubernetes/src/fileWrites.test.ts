import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	batchFileWrites,
	encodeFileWriteBatch,
	MAX_WRITE_BATCH_BYTES,
	MAX_WRITE_BATCH_FILES,
	WRITE_BATCH_COMMAND,
} from './fileWrites';

describe('batchFileWrites', () => {
	it('bounds file count without dropping or reordering writes', () => {
		const files = Array.from({ length: MAX_WRITE_BATCH_FILES * 2 + 1 }, (_, i) => ({
			path: `/workspace/${i}.py`,
			content: '',
		}));
		const batches = batchFileWrites(files);
		expect(batches.map((batch) => batch.length)).toEqual([
			MAX_WRITE_BATCH_FILES,
			MAX_WRITE_BATCH_FILES,
			1,
		]);
		expect(batches.flat()).toEqual(files);
		expect(batchFileWrites([])).toEqual([]);
	});

	it('bounds encoded bytes including Unicode paths, contents, and frame headers', () => {
		const files = Array.from({ length: 4 }, (_, i) => ({
			path: `/workspace/你好-${i}.txt`,
			content: 'é'.repeat(MAX_WRITE_BATCH_BYTES / 4),
		}));
		const batches = batchFileWrites(files);
		expect(batches).toHaveLength(4);
		for (const batch of batches) {
			expect(encodeFileWriteBatch(batch).byteLength).toBeLessThanOrEqual(MAX_WRITE_BATCH_BYTES);
		}
	});

	it('isolates oversized writes so they can stream without copying into a batch', () => {
		const small = { path: '/small', content: 'one' };
		const large = { path: '/large', content: new Uint8Array(MAX_WRITE_BATCH_BYTES + 1) };
		expect(batchFileWrites([small, large, small])).toEqual([[small], [large], [small]]);
	});

	it('keeps an exact byte limit together and splits one byte over it', () => {
		const first = { path: '/first', content: new Uint8Array(MAX_WRITE_BATCH_BYTES - 100) };
		const last = { path: '/last', content: '' };
		const overhead = encodeFileWriteBatch([first, last]).byteLength - first.content.byteLength;
		first.content = new Uint8Array(MAX_WRITE_BATCH_BYTES - overhead);
		expect(encodeFileWriteBatch([first, last]).byteLength).toBe(MAX_WRITE_BATCH_BYTES);
		expect(batchFileWrites([first, last])).toEqual([[first, last]]);
		last.content = 'x';
		expect(batchFileWrites([first, last])).toEqual([[first], [last]]);
	});
});

describe.skipIf(spawnSync('sh', ['-c', 'python3 -V']).status !== 0)('file batch receiver', () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'mh-k8s-write-'));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});
	function receive(input: Uint8Array, env?: NodeJS.ProcessEnv) {
		return spawnSync('sh', ['-c', WRITE_BATCH_COMMAND], {
			cwd: directory,
			input,
			encoding: 'utf8',
			timeout: 10_000,
			...(env ? { env: { ...process.env, ...env } } : {}),
		});
	}

	it('ignores a workspace json.py in the cwd or on PYTHONPATH', () => {
		const poison = 'raise SystemExit("shadowed stdlib json")\n';
		writeFileSync(join(directory, 'json.py'), poison);
		const files = [
			{ path: join(directory, 'a.txt'), content: 'first' },
			{ path: join(directory, 'nested/b.txt'), content: 'second' },
		];
		const result = receive(encodeFileWriteBatch(files), { PYTHONPATH: directory });
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(readFileSync(files[0].path, 'utf8')).toBe('first');
		expect(readFileSync(files[1].path, 'utf8')).toBe('second');
		expect(readFileSync(join(directory, 'json.py'), 'utf8')).toBe(poison);
	});

	it('writes binary, Unicode, empty files, and shell-sensitive paths verbatim', () => {
		const files = [
			{
				path: join(directory, "nested/你好 ' \n$(touch injected);.bin"),
				content: Uint8Array.from({ length: 200_000 }, (_, i) => i % 256),
			},
			{ path: join(directory, 'text.py'), content: 'print("こんにちは 🌍")\nnull\n' },
			{ path: join(directory, 'empty'), content: '' },
			{ path: 'relative/nested.txt', content: 'relative' },
		];
		const result = receive(encodeFileWriteBatch(files));
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		for (const file of files) {
			const expected =
				typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
			expect(readFileSync(resolve(directory, file.path))).toEqual(Buffer.from(expected));
		}
		expect(existsSync(join(directory, 'injected'))).toBe(false);
	});

	it('truncates existing files while preserving their permissions', () => {
		const path = join(directory, 'existing');
		writeFileSync(path, 'a longer old value');
		chmodSync(path, 0o600);
		const result = receive(encodeFileWriteBatch([{ path, content: 'new' }]));
		expect(result.status).toBe(0);
		expect(readFileSync(path, 'utf8')).toBe('new');
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('writes only the selected bytes of a buffer view', () => {
		const bytes = new Uint8Array([99, 0, 255, 10, 88]);
		const path = join(directory, 'view.bin');
		const result = receive(encodeFileWriteBatch([{ path, content: bytes.subarray(1, 4) }]));
		expect(result.status).toBe(0);
		expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 10]));
	});

	it.each([true, null, '1', 1.5, -1])(
		'rejects invalid length %j before modifying a file',
		(size) => {
			writeFileSync(join(directory, 'existing'), 'preserve');
			const result = receive(Buffer.from(`${JSON.stringify({ path: 'existing', size })}\nnull\n`));
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain('Invalid file length');
			expect(readFileSync(join(directory, 'existing'), 'utf8')).toBe('preserve');
		},
	);

	it.each(['header', 'contents', 'terminal marker'])(
		'rejects a batch truncated during the %s',
		(part) => {
			const input = encodeFileWriteBatch([{ path: join(directory, 'file'), content: 'hello' }]);
			const end = part === 'header' ? 5 : input.length - (part === 'contents' ? 6 : 5);
			const result = receive(input.subarray(0, end));
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain('Incomplete');
		},
	);

	it('rejects data after the terminal marker', () => {
		const trailing = receive(Buffer.from('null\nextra'));
		expect(trailing.status).not.toBe(0);
		expect(trailing.stderr).toContain('Unexpected data');
	});

	it('restores the full batch when retrying a transfer interrupted mid-file', () => {
		const first = { path: join(directory, 'first'), content: 'already complete' };
		const last = {
			path: join(directory, 'last'),
			content: Uint8Array.from({ length: 200_000 }, (_, i) => i % 256),
		};
		const input = encodeFileWriteBatch([first, last]);
		const interrupted = receive(input.subarray(0, input.byteLength - 100_000));
		expect(interrupted.status).not.toBe(0);
		expect(readFileSync(first.path, 'utf8')).toBe(first.content);
		expect(readFileSync(last.path).byteLength).toBeLessThan(last.content.byteLength);
		const retried = receive(input);
		expect(retried.status).toBe(0);
		expect(readFileSync(first.path, 'utf8')).toBe(first.content);
		expect(readFileSync(last.path)).toEqual(Buffer.from(last.content));
	});

	it('propagates filesystem failures', () => {
		writeFileSync(join(directory, 'parent'), 'not a directory');
		const result = receive(encodeFileWriteBatch([{ path: 'parent/child', content: 'value' }]));
		expect(result.status).not.toBe(0);
		expect(existsSync(join(directory, 'parent/child'))).toBe(false);
	});
});

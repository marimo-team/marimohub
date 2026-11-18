import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoundedFile, readBoundedFiles } from './boundedRead';
import { shellQuote } from './shell';

const execute = promisify(execFile);
const directories: string[] = [];
async function fixture() {
	const path = await mkdtemp(join(tmpdir(), 'hub-bounded-batch-'));
	directories.push(path);
	// macOS's /var and /tmp can be symlinks; the reader requires canonical parents.
	return realpath(path);
}
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function run(command: string, options: { timeout: number; maxOutputBytes: number }) {
	try {
		const { stdout, stderr } = await execute('sh', ['-c', command], {
			timeout: options.timeout,
			maxBuffer: options.maxOutputBytes,
		});
		return { success: true, stdout, stderr };
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!('stdout' in error) ||
			!('stderr' in error) ||
			typeof error.stdout !== 'string' ||
			typeof error.stderr !== 'string'
		)
			throw error;
		return {
			success: false,
			stdout: error.stdout,
			stderr: error.stderr,
			error: { code: 'COMMAND_FAILED' as const },
		};
	}
}

describe('batched bounded reads', () => {
	it('reads binary and empty files with exact per-file limits and reports absent files independently', async () => {
		const root = await fixture();
		const paths = [join(root, 'a'), join(root, 'empty'), join(root, 'missing')];
		const bytes = Buffer.from([0, 255, 128, 10]);
		await writeFile(paths[0], bytes);
		await writeFile(paths[1], '');
		const transport = vi.fn(run);
		const results = await readBoundedFiles(
			paths,
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 2000 },
			transport,
		);
		expect(results).toEqual([
			{ success: true, content: bytes.toString('base64'), encoding: 'base64' },
			{ success: true, content: '', encoding: 'base64' },
			{ success: false, content: '', error: { code: 'NOT_FOUND', reason: 'not_found' } },
		]);
		expect(transport).toHaveBeenCalledOnce();
	});
	it('rejects oversized, directory, traversal, symlink, and FIFO paths without masking a good sibling', async () => {
		const root = await fixture();
		await writeFile(join(root, 'large'), '12345');
		await writeFile(join(root, 'good'), 'ok');
		await symlink(join(root, 'good'), join(root, 'link'));
		await symlink(root, join(root, 'linked-parent'));
		await execute('mkfifo', [join(root, 'fifo')]);
		const results = await readBoundedFiles(
			[
				join(root, 'large'),
				root,
				`${root}/../escape`,
				join(root, 'link'),
				join(root, 'fifo'),
				join(root, 'linked-parent', 'good'),
				join(root, 'good'),
			],
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 2000 },
			run,
		);
		expect(
			results.slice(0, 6).map((result) => (result.success ? null : result.error.reason)),
		).toEqual(['size_limit', 'not_regular', 'invalid_path', 'io_error', 'not_regular', 'io_error']);
		expect(results[6]).toMatchObject({ success: true, content: btoa('ok') });
	});
	it.each([
		{ paths: ['/a'], maxBytes: -1, timeoutMs: 100 },
		{ paths: ['/a'], maxBytes: 1, maxTotalBytes: -1, timeoutMs: 100 },
		{ paths: ['/a'], maxBytes: 1, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1, timeoutMs: 100 },
		{ paths: ['/a'], maxBytes: 1, maxTotalBytes: Number.NaN, timeoutMs: 100 },
		{ paths: ['/a'], maxBytes: 1, maxTotalBytes: 1.5, timeoutMs: 100 },
		{ paths: ['/a'], maxBytes: 1, timeoutMs: 0 },
		{ paths: ['/a'], maxBytes: 1, timeoutMs: Infinity },
		{ paths: Array(17).fill('/a'), maxBytes: 1, timeoutMs: 100 },
		{ paths: ['/a', '/b'], maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 100 },
	])('rejects invalid aggregate input before transport: %j', async ({ paths, ...options }) => {
		const transport = vi.fn();
		expect(
			(await readBoundedFiles(paths, { maxTotalBytes: 8, ...options }, transport)).every(
				(result) => !result.success && result.error.reason === 'invalid_options',
			),
		).toBe(true);
		expect(transport).not.toHaveBeenCalled();
	});
	it.each([
		{ stdout: '[]', reason: 'invalid_batch' },
		{ stdout: '[{"content":"eA=="},', reason: 'invalid_batch' },
		{ stdout: '[null,null]', reason: 'invalid_batch' },
		{ stdout: '[{"content":1},{"reason":"not_found"}]', reason: 'invalid_batch' },
		{ stdout: '[{"content":"","extra":true},{"reason":"not_found"}]', reason: 'invalid_batch' },
		{ stdout: '[{"content":"é"},{"reason":"not_found"}]', reason: 'invalid_batch' },
		{ stdout: '[{"content":"eA=="}]', reason: 'invalid_batch' },
		{ stdout: '[{"content":"!!!!"},{"reason":"not_found"}]', reason: 'invalid_base64' },
		{ stdout: '[{"content":"MTIzNDU="},{"reason":"not_found"}]', reason: 'size_limit' },
		{ stdout: '[{"reason":"made_up"},{"reason":"not_found"}]', reason: 'invalid_batch' },
		{ stdout: 'x'.repeat(1000), reason: 'output_limit' },
	])(
		'rejects malformed/oversized transport rather than accepting partial capture: $reason',
		async ({ stdout, reason }) => {
			const results = await readBoundedFiles(
				['/a', '/b'],
				{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 100 },
				async () => ({ success: true, stdout, stderr: '' }),
			);
			expect(results).toEqual(
				Array.from({ length: 2 }, () => ({
					success: false,
					content: '',
					error: { code: 'READ_FAILED', reason },
				})),
			);
		},
	);
	it('does not interpret transport failure diagnostics as absent artifacts', async () => {
		const results = await readBoundedFiles(
			['/a', '/b'],
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 100 },
			async () => ({ success: false, stdout: '', stderr: 'MARIMOHUB_BOUNDED_READ:not_found' }),
		);
		expect(results.every((result) => !result.success && result.error.code === 'READ_FAILED')).toBe(
			true,
		);
	});
	it('keeps the aggregate output limit bounded, including encoding and per-result envelopes', async () => {
		const transport = vi.fn(async () => ({
			success: true,
			stdout: '[{"content":""},{"content":""}]',
			stderr: '',
		}));
		await readBoundedFiles(
			['/a', '/b'],
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 100 },
			transport,
		);
		expect(transport).toHaveBeenCalledWith(expect.any(String), {
			timeout: 100,
			maxOutputBytes: 270,
		});
	});
	it('enforces one aggregate deadline and classifies an expired transport for every path', async () => {
		const transport = vi.fn(async () => {
			throw new Error('command timed out after 100ms');
		});
		const results = await readBoundedFiles(
			['/a', '/b'],
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 100 },
			transport,
		);
		expect(transport).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
			timeout: 100,
			maxOutputBytes: 270,
		});
		expect(results.every((result) => !result.success && result.error.reason === 'timeout')).toBe(
			true,
		);
	});
	it('counts stderr bytes against the aggregate output budget', async () => {
		const results = await readBoundedFiles(
			['/a', '/b'],
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 100 },
			async () => ({
				success: true,
				stdout: '[{"content":""},{"content":""}]',
				stderr: 'é'.repeat(128),
			}),
		);
		expect(
			results.every((result) => !result.success && result.error.reason === 'output_limit'),
		).toBe(true);
	});
	it('enforces the decoded aggregate limit even when every file is within its own cap', async () => {
		const transport = async () => ({
			success: true,
			stdout: '[{"content":"MTIzNA=="},{"content":"MTIzNA=="}]',
			stderr: '',
		});
		const results = await readBoundedFiles(
			['/a', '/b'],
			{ maxBytes: 4, maxTotalBytes: 7, timeoutMs: 100 },
			transport,
		);
		expect(results.every((result) => !result.success && result.error.reason === 'size_limit')).toBe(
			true,
		);
	});

	it('aborts the native batch when files exceed the aggregate cap', async () => {
		const root = await fixture();
		const paths = [join(root, 'a'), join(root, 'b')];
		for (const path of paths) await writeFile(path, '1234');
		const exact = await readBoundedFiles(
			paths,
			{ maxBytes: 4, maxTotalBytes: 8, timeoutMs: 2000 },
			run,
		);
		expect(exact.every((result) => result.success)).toBe(true);
		const over = await readBoundedFiles(
			paths,
			{ maxBytes: 4, maxTotalBytes: 7, timeoutMs: 2000 },
			run,
		);
		expect(over.every((result) => !result.success && result.error.reason === 'size_limit')).toBe(
			true,
		);
	});

	it('limits the wire budget to one artifact even when four maximum-sized files are requested', async () => {
		const maxBytes = 25 * 1024 * 1024;
		const transport = vi.fn(async () => ({
			success: true,
			stdout: JSON.stringify(Array.from({ length: 4 }, () => ({ reason: 'not_found' }))),
			stderr: '',
		}));
		await readBoundedFiles(
			['/a', '/b', '/c', '/d'],
			{ maxBytes, maxTotalBytes: maxBytes, timeoutMs: 1000 },
			transport,
		);
		expect(transport).toHaveBeenCalledWith(expect.any(String), {
			timeout: 1000,
			maxOutputBytes: 4 * Math.ceil(maxBytes / 3) + 4 * 128 + 2,
		});
	});

	it('uses the shared native reader for single-file safety and preserves its error envelope', async () => {
		const root = await fixture();
		const path = join(root, 'source');
		await writeFile(path, 'abcd');
		expect(await readBoundedFile(path, { maxBytes: 4, timeoutMs: 2000 }, run)).toMatchObject({
			success: true,
			content: btoa('abcd'),
		});
		await symlink(path, join(root, 'link'));
		expect(
			await readBoundedFile(join(root, 'link'), { maxBytes: 4, timeoutMs: 2000 }, run),
		).toMatchObject({ success: false, error: { reason: 'io_error' } });
	});

	it('expires the native batch deadline during a slow read without accepting the partial output', async () => {
		const root = await fixture();
		await writeFile(join(root, 'a'), 'a');
		const slowFilesystem = `import os, sys, time
program = sys.argv[1]
sys.argv = sys.argv[1:]
original = os.open
def slow_open(path, *args, **kwargs):
    if path == 'a': time.sleep(1)
    return original(path, *args, **kwargs)
os.open = slow_open
exec(compile(program, '<bounded-read>', 'exec'))`;
		let diagnostic = '';
		const transport = async (
			command: string,
			options: { timeout: number; maxOutputBytes: number },
		) => {
			const result = await run(
				`python3() { shift 2; program=$1; shift; command python3 -I -c ${shellQuote(slowFilesystem)} "$program" "$@"; }; ${command}`,
				{ ...options, timeout: 2000 },
			);
			diagnostic = result.stderr;
			return result;
		};
		const results = await readBoundedFiles(
			[join(root, 'a')],
			{ maxBytes: 4, maxTotalBytes: 4, timeoutMs: 50 },
			transport,
		);
		expect(diagnostic).toContain('MARIMOHUB_BOUNDED_READ:timeout');
		expect(results).toMatchObject([{ success: false, error: { reason: 'timeout' } }]);
	});

	it('handles empty batches without a command', async () => {
		const transport = vi.fn();
		expect(
			await readBoundedFiles([], { maxBytes: 4, maxTotalBytes: 8, timeoutMs: 100 }, transport),
		).toEqual([]);
		expect(transport).not.toHaveBeenCalled();
	});
});

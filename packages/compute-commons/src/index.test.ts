import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import {
	base64Encode,
	buildLaunchCommand,
	buildDirectoryProbeCommand,
	buildFindFilesCommand,
	buildGitCloneCommand,
	classifyListFilesFailure,
	iterableToStream,
	mapWithConcurrency,
	NOT_A_DIRECTORY_EXIT_CODE,
	NOT_A_DIRECTORY_MARKER,
	OutputTail,
	parseFindFilesOutput,
	parseLaunchOutput,
	pollUntilReady,
	portWaitCommand,
	removeUndefined,
	shellQuote,
	withEnvPrefix,
	launchWithProcess,
} from './index';

describe('shellQuote', () => {
	it('wraps a plain value in single quotes', () => {
		expect(shellQuote('hello')).toBe("'hello'");
	});

	it('escapes embedded single quotes injection-safely', () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
	});

	it('neutralizes shell metacharacters by quoting them', () => {
		const quoted = shellQuote('$(rm -rf /); echo `whoami` && x');
		expect(quoted.startsWith("'")).toBe(true);
		expect(quoted.endsWith("'")).toBe(true);
		expect(quoted.slice(1, -1).includes("'")).toBe(false);
	});

	it('handles a value that is only a single quote', () => {
		expect(shellQuote("'")).toBe("''\\'''");
	});
});

describe('buildGitCloneCommand', () => {
	it('clones into the default target with no branch', () => {
		expect(buildGitCloneCommand('https://x/y')).toBe("git clone 'https://x/y' '.'");
	});

	it('includes the branch flag when given', () => {
		expect(buildGitCloneCommand('https://x/y', { branch: 'main', targetDir: 'w' })).toBe(
			"git clone --branch 'main' 'https://x/y' 'w'",
		);
	});

	it('shell-quotes every interpolated argument (injection-safe)', () => {
		const cmd = buildGitCloneCommand('https://x/y; rm -rf /', { targetDir: '$(touch pwn)' });
		expect(cmd).toBe("git clone 'https://x/y; rm -rf /' '$(touch pwn)'");
	});
});

describe('withEnvPrefix', () => {
	it('returns the command unchanged when there are no env vars', () => {
		expect(withEnvPrefix('echo hi', {})).toBe('echo hi');
	});

	it('prefixes shell-quoted exports for each var, preserving the command', () => {
		expect(withEnvPrefix('run', { A: '1', B: '2' })).toBe("export A='1'; export B='2'; run");
	});

	it('shell-quotes env values (injection-safe)', () => {
		expect(withEnvPrefix('run', { TOKEN: "a'b" })).toBe("export TOKEN='a'\\''b'; run");
	});

	it('emits defaults as guarded exports the existing environment wins over', () => {
		expect(withEnvPrefix('run', {}, { A: '1' })).toBe('[ -n "${A:-}" ] || export A=\'1\'; run');
	});

	it('puts forced exports before default guards, so a forced value wins the key', () => {
		expect(withEnvPrefix('run', { A: '1' }, { A: '2', B: '3' })).toBe(
			"export A='1'; [ -n \"${A:-}\" ] || export A='2'; [ -n \"${B:-}\" ] || export B='3'; run",
		);
	});

	it('shell-quotes default values (injection-safe)', () => {
		expect(withEnvPrefix('run', {}, { TOKEN: "a'b" })).toBe(
			"[ -n \"${TOKEN:-}\" ] || export TOKEN='a'\\''b'; run",
		);
	});
});

describe('removeUndefined', () => {
	it('drops undefined values and keeps the rest (including falsy ones)', () => {
		expect(removeUndefined({ a: '1', b: undefined, c: '' })).toEqual({ a: '1', c: '' });
		expect(removeUndefined({})).toEqual({});
	});
});

describe('buildFindFilesCommand', () => {
	it('builds a non-recursive find command by default', () => {
		expect(buildFindFilesCommand('/workspace')).toContain(
			"find '/workspace' -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%p\\0'",
		);
	});

	it('omits maxdepth for recursive listings', () => {
		const command = buildFindFilesCommand('/workspace', { recursive: true });
		expect(command).toContain("find '/workspace' -mindepth 1 -printf '%y\\t%s\\t%p\\0'");
		expect(command).not.toContain('-maxdepth');
	});

	it('quotes the root path', () => {
		expect(buildFindFilesCommand("/work'space")).toContain("'/work'\\''space'");
	});
});

describe('buildDirectoryProbeCommand', () => {
	it('distinguishes directories, files, and missing paths', () => {
		const directory = mkdtempSync(join(tmpdir(), 'marimohub-list-files-'));
		const file = join(directory, 'notebook.py');
		const missing = join(directory, 'missing.py');
		writeFileSync(file, 'print(1)');

		try {
			const directoryResult = spawnSync('sh', ['-c', buildDirectoryProbeCommand(directory)], {
				encoding: 'utf8',
			});
			expect(directoryResult.status).toBe(0);
			expect(directoryResult.stderr).toBe('');

			const fileResult = spawnSync('sh', ['-c', buildDirectoryProbeCommand(file)], {
				encoding: 'utf8',
			});
			expect(fileResult.status).toBe(NOT_A_DIRECTORY_EXIT_CODE);
			expect(fileResult.stderr).toBe(`${NOT_A_DIRECTORY_MARKER}\n`);

			const missingResult = spawnSync('sh', ['-c', buildDirectoryProbeCommand(missing)], {
				encoding: 'utf8',
			});
			expect(missingResult.status).toBe(1);
			expect(missingResult.stderr).toBe('');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('classifyListFilesFailure', () => {
	it('recognizes the non-directory marker on either output stream', () => {
		expect(classifyListFilesFailure({ stdout: NOT_A_DIRECTORY_MARKER, stderr: '' })).toBe(
			'NOT_A_DIRECTORY',
		);
		expect(classifyListFilesFailure({ stdout: '', stderr: NOT_A_DIRECTORY_MARKER })).toBe(
			'NOT_A_DIRECTORY',
		);
	});

	it('otherwise returns the generic list failure', () => {
		expect(classifyListFilesFailure({ stdout: '', stderr: 'not found' })).toBe('LIST_FAILED');
		expect(
			classifyListFilesFailure({
				stdout: '',
				stderr: `find: '/tmp/${NOT_A_DIRECTORY_MARKER}': Permission denied`,
			}),
		).toBe('LIST_FAILED');
	});
});

describe('parseFindFilesOutput', () => {
	const output = [
		'f\t10\t/workspace/a.py',
		'd\t4096\t/workspace/sub',
		'l\t0\t/workspace/link',
		's\t7\t/workspace/socket',
		'f\t5\t/workspace/.hidden',
		'not-enough-columns',
	].join('\0');

	it('maps find rows into file info and filters hidden files by default', () => {
		expect(parseFindFilesOutput(`${output}\0`, '/workspace')).toEqual([
			{
				name: 'a.py',
				absolutePath: '/workspace/a.py',
				relativePath: 'a.py',
				type: 'file',
				size: 10,
			},
			{
				name: 'sub',
				absolutePath: '/workspace/sub',
				relativePath: 'sub',
				type: 'directory',
				size: 4096,
			},
			{
				name: 'link',
				absolutePath: '/workspace/link',
				relativePath: 'link',
				type: 'symlink',
				size: 0,
			},
			{
				name: 'socket',
				absolutePath: '/workspace/socket',
				relativePath: 'socket',
				type: 'other',
				size: 7,
			},
		]);
	});

	it('includes hidden files when requested', () => {
		expect(
			parseFindFilesOutput('f\t5\t/workspace/.hidden\0', '/workspace', { includeHidden: true }),
		).toEqual([
			{
				name: '.hidden',
				absolutePath: '/workspace/.hidden',
				relativePath: '.hidden',
				type: 'file',
				size: 5,
			},
		]);
	});

	it('handles root paths and non-numeric sizes', () => {
		expect(parseFindFilesOutput('f\tNaN\t/tmp/a.py\0', '/')).toEqual([
			{
				name: 'a.py',
				absolutePath: '/tmp/a.py',
				relativePath: 'tmp/a.py',
				type: 'file',
				size: 0,
			},
		]);
	});

	it('preserves tabs and newlines inside file paths', () => {
		const path = '/workspace/has\ttab\nand-newline.py';
		expect(parseFindFilesOutput(`f\t1\t${path}\0`, '/workspace')[0]).toMatchObject({
			name: 'has\ttab\nand-newline.py',
			absolutePath: path,
		});
	});

	it('passes an absolute path outside rootPath through unchanged as relativePath', () => {
		// A row whose path is NOT under rootPath keeps its absolute path as the
		// relativePath (no accidental prefix-stripping of an unrelated dir).
		expect(parseFindFilesOutput('f\t3\t/etc/passwd\0', '/workspace')).toEqual([
			{
				name: 'passwd',
				absolutePath: '/etc/passwd',
				relativePath: '/etc/passwd',
				type: 'file',
				size: 3,
			},
		]);
	});
});

async function* gen(values: string[], opts: { throwAt?: number } = {}) {
	for (let i = 0; i < values.length; i++) {
		if (opts.throwAt === i) throw new Error('stream boom');
		yield values[i];
	}
}

async function readAll(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	return out;
}

describe('portWaitCommand', () => {
	it('loops in-sandbox on a monotonic deadline instead of returning per probe', () => {
		const cmd = portWaitCommand(2718, 30);
		expect(cmd).toContain('connect_ex(("127.0.0.1",2718))');
		expect(cmd).toContain('time.monotonic()+30');
		// Exits 0 the moment the port answers, 1 only on its own deadline.
		expect(cmd).toContain('sys.exit(0)');
		expect(cmd).toContain('sys.exit(1)');
		// Sub-second granularity is the point: a 1s sleep would reintroduce the
		// quantization this replaced.
		expect(cmd).toContain('time.sleep(0.05)');
	});

	it('accepts fractional seconds', () => {
		expect(portWaitCommand(2718, 0.25)).toContain('time.monotonic()+0.25');
	});

	// Wall-clock coverage: the shell/python versions actually available decide
	// whether these run; the deadline math is what they verify.
	const havePython = (() => {
		try {
			return spawnSync('python3', ['-V']).status === 0;
		} catch {
			return false;
		}
	})();

	it.skipIf(!havePython)('honors a sub-second deadline against a closed port', () => {
		const start = Date.now();
		// Port 9 (discard) is closed on loopback; connect is refused instantly.
		const res = spawnSync('sh', ['-c', portWaitCommand(9, 0.5)], { timeout: 10_000 });
		const elapsed = Date.now() - start;
		expect(res.status).toBe(1);
		// Full 500ms honored (a whole-second date loop could exit almost
		// immediately), without ballooning to the next whole second.
		expect(elapsed).toBeGreaterThanOrEqual(450);
		expect(elapsed).toBeLessThan(3000);
	});

	it.skipIf(!havePython)('exits 0 as soon as the port answers', async () => {
		const srv = createServer();
		await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
		const port = (srv.address() as AddressInfo).port;
		try {
			const res = spawnSync('sh', ['-c', portWaitCommand(port, 5)], { timeout: 10_000 });
			expect(res.status).toBe(0);
		} finally {
			srv.close();
		}
	});
});

describe('iterableToStream', () => {
	it('streams every chunk as UTF-8 then closes', async () => {
		const stream = iterableToStream(gen(['foo', 'bar', 'baz']));
		expect(await readAll(stream)).toBe('foobarbaz');
	});

	it('propagates an error from the iterable to the stream consumer', async () => {
		const stream = iterableToStream(gen(['ok', 'never'], { throwAt: 1 }));
		await expect(readAll(stream)).rejects.toThrow('stream boom');
	});

	it('calls the iterator return() on cancel so upstream can clean up', async () => {
		let returned = false;
		const iterable: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ value: 'x', done: false }),
					return: async () => {
						returned = true;
						return { value: undefined, done: true };
					},
				};
			},
		};
		const stream = iterableToStream(iterable);
		const reader = stream.getReader();
		await reader.read();
		await reader.cancel();
		expect(returned).toBe(true);
	});
});

describe('pollUntilReady', () => {
	it('resolves as soon as the probe returns true', async () => {
		let calls = 0;
		await pollUntilReady(
			() => {
				calls += 1;
				return calls >= 3;
			},
			{ intervalMs: 1, timeoutMs: 1000 },
		);
		expect(calls).toBe(3);
	});

	it('awaits async probes', async () => {
		let calls = 0;
		await pollUntilReady(async () => ++calls >= 2, { intervalMs: 1, timeoutMs: 1000 });
		expect(calls).toBe(2);
	});

	it('throws the custom timeout message when the deadline passes', async () => {
		await expect(
			pollUntilReady(() => false, {
				intervalMs: 2,
				timeoutMs: 20,
				timeoutMessage: () => 'port 2718 never opened',
			}),
		).rejects.toThrow('port 2718 never opened');
	});

	it('falls back to a generic timeout message', async () => {
		await expect(pollUntilReady(() => false, { intervalMs: 2, timeoutMs: 15 })).rejects.toThrow(
			/timed out after 15ms/,
		);
	});

	it('awaits an async timeout message (e.g. tailing a log only on failure)', async () => {
		await expect(
			pollUntilReady(() => false, {
				intervalMs: 2,
				timeoutMs: 15,
				timeoutMessage: async () => {
					await new Promise((resolve) => setTimeout(resolve, 1));
					return 'kernel log: boom';
				},
			}),
		).rejects.toThrow('kernel log: boom');
	});

	it('propagates a probe error immediately without retrying', async () => {
		let calls = 0;
		await expect(
			pollUntilReady(
				() => {
					calls += 1;
					throw new Error('process exited');
				},
				{ intervalMs: 1, timeoutMs: 1000 },
			),
		).rejects.toThrow('process exited');
		expect(calls).toBe(1);
	});

	it('throws without ever probing when timeoutMs is 0', async () => {
		let calls = 0;
		await expect(
			pollUntilReady(
				() => {
					calls += 1;
					return true;
				},
				{ timeoutMs: 0 },
			),
		).rejects.toThrow(/timed out after 0ms/);
		expect(calls).toBe(0);
	});
});

describe('mapWithConcurrency', () => {
	it('never runs more than `concurrency` fns in flight', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const items = Array.from({ length: 20 }, (_, i) => i);
		await mapWithConcurrency(items, 3, async (n) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight -= 1;
			return n;
		});
		expect(maxInFlight).toBe(3);
	});

	it('preserves result order despite out-of-order completion', async () => {
		const items = [30, 5, 20, 1];
		const results = await mapWithConcurrency(items, 4, async (ms) => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return ms;
		});
		expect(results).toEqual([30, 5, 20, 1]);
	});

	it('rejects when an item fn rejects', async () => {
		await expect(
			mapWithConcurrency([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error('item boom');
				return n;
			}),
		).rejects.toThrow('item boom');
	});

	it('processes every item even when concurrency is 0 (no silent data loss)', async () => {
		// A misconfigured concurrency of 0 must not silently write nothing — an
		// adapter routing writeFiles through this would drop every file.
		const seen: number[] = [];
		const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
			seen.push(n);
			return n * 2;
		});
		expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
		expect(results).toEqual([2, 4, 6]);
	});
});

describe('launch protocol', () => {
	it('quotes setup and kernel commands as supervisor arguments', () => {
		const built = buildLaunchCommand({
			setup: "printf '%s' setup",
			command: "printf '%s' kernel",
			port: 2718,
			startupTimeout: 120_000,
			nonce: 'abc123',
		});
		expect(built.nonce).toBe('abc123');
		expect(built.command).toContain('python3 -c');
		expect(built.command).toContain("'abc123'");
		expect(built.command).toContain("'2718'");
		expect(built.command.indexOf("'printf '\\''%s'\\'' kernel'")).toBeLessThan(
			built.command.indexOf("'printf '\\''%s'\\'' setup'"),
		);
	});

	it('removes protocol records and returns the terminal outcome', () => {
		const marker = '__MARIMOHUB_LAUNCH_n1__';
		const parsed = parseLaunchOutput(
			{
				stdout: 'setup output\nkernel output\n',
				stderr:
					`${marker}{"event":"setup_complete","setupMs":12,"waitportMs":0}\n` +
					`${marker}{"event":"ready","setupMs":12,"waitportMs":34}\n`,
			},
			'n1',
		);
		expect(parsed).toEqual({
			stdout: 'setup output\nkernel output\n',
			stderr: '',
			outcome: { kind: 'ready', setupMs: 12, waitportMs: 34 },
		});
	});

	it('preserves output before a protocol record in the same fragmented line', () => {
		const marker = '__MARIMOHUB_LAUNCH_n1__';
		const parsed = parseLaunchOutput(
			{
				stdout: '',
				stderr: `setup output${marker}{"event":"ready","setupMs":3,"waitportMs":4}\n`,
			},
			'n1',
		);
		expect(parsed).toEqual({
			stdout: '',
			stderr: 'setup output',
			outcome: { kind: 'ready', setupMs: 3, waitportMs: 4 },
		});
	});

	it('returns a structured transport failure when process start rejects', async () => {
		const result = await launchWithProcess({
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 1000,
			start: async () => {
				throw new Error('stream unavailable');
			},
		});
		expect(result).toEqual({
			success: false,
			reason: 'transport_failure',
			stdout: '',
			stderr: 'stream unavailable',
			timings: { setup: 0, start: expect.any(Number), waitport: 0 },
		});
	});

	it('classifies an expired no-setup launch as a readiness timeout', async () => {
		let now = 0;
		const result = await launchWithProcess({
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 10,
			now: () => now,
			start: async () => ({
				waitForPort: async () => {
					now = 20;
					throw new Error('timed out waiting for port 2718');
				},
				getLogs: async () => ({ stdout: '', stderr: '' }),
			}),
		});
		expect(result).toMatchObject({ success: false, reason: 'readiness_timeout' });
	});

	it('passes an explicit unbounded readiness timeout when startupTimeout is zero', async () => {
		let timeout: number | undefined;
		await launchWithProcess({
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 0,
			start: async () => ({
				waitForPort: async (_port, options) => {
					timeout = options?.timeout;
					throw new Error('test stop');
				},
				getLogs: async () => ({ stdout: '', stderr: '' }),
			}),
		});
		expect(timeout).toBe(Number.POSITIVE_INFINITY);
	});

	it('returns success with the supervisor timings once the port opens', async () => {
		const result = await launchWithProcess({
			setup: 'uv sync',
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 1000,
			start: async (command) => {
				const nonce = command.match(/'([a-f0-9]{32})'/)?.[1];
				if (!nonce) throw new Error('missing launch nonce');
				return {
					waitForPort: async () => {},
					getLogs: async () => ({
						stdout: 'kernel output\n',
						stderr:
							`__MARIMOHUB_LAUNCH_${nonce}__{"event":"setup_complete","setupMs":11,"waitportMs":0}\n` +
							`__MARIMOHUB_LAUNCH_${nonce}__{"event":"ready","setupMs":11,"waitportMs":22}\n`,
					}),
				};
			},
		});
		expect(result).toMatchObject({
			success: true,
			timings: { setup: 11, start: expect.any(Number), waitport: 22 },
		});
	});

	it('maps a getLogs failure after a readiness failure to transport_failure', async () => {
		const result = await launchWithProcess({
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 1000,
			start: async () => ({
				waitForPort: async () => {
					throw new Error('probe lost');
				},
				getLogs: async () => {
					throw new Error('logs unavailable');
				},
			}),
		});
		expect(result).toMatchObject({
			success: false,
			reason: 'transport_failure',
			stdout: '',
			stderr: 'logs unavailable',
		});
	});

	it('maps a getLogs failure after readiness to transport_failure', async () => {
		const result = await launchWithProcess({
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 1000,
			start: async () => ({
				waitForPort: async () => {},
				getLogs: async () => {
					throw new Error('logs unavailable');
				},
			}),
		});
		expect(result).toMatchObject({
			success: false,
			reason: 'transport_failure',
			stderr: 'logs unavailable',
		});
	});

	it('blames an unfinished setup for an expired deadline (setup_timeout)', async () => {
		let now = 0;
		const result = await launchWithProcess({
			setup: 'uv sync',
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 10,
			now: () => now,
			start: async () => ({
				waitForPort: async () => {
					now = 20;
					throw new Error('timed out waiting for port 2718');
				},
				getLogs: async () => ({ stdout: '', stderr: '' }),
			}),
		});
		expect(result).toMatchObject({ success: false, reason: 'setup_timeout' });
		if (result.success) throw new Error('expected a launch failure');
		// An unfinished setup is charged the whole remaining budget.
		expect(result.timings.setup).toBe(10);
	});

	it('classifies an early process exit via the readiness error message as kernel_exit', async () => {
		const result = await launchWithProcess({
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 60_000,
			start: async () => ({
				waitForPort: async () => {
					throw new Error('process exited (code 9) before port 2718 was ready.\nboom');
				},
				getLogs: async () => ({ stdout: '', stderr: 'boom\n' }),
			}),
		});
		expect(result).toMatchObject({ success: false, reason: 'kernel_exit', stderr: 'boom\n' });
	});

	it('preserves a setup failure and its output through the compatibility launcher', async () => {
		const result = await launchWithProcess({
			setup: 'uv sync',
			command: 'marimo edit',
			port: 2718,
			startupTimeout: 1000,
			start: async (command) => {
				const nonce = command.match(/'([a-f0-9]{32})'/)?.[1];
				if (!nonce) throw new Error('missing launch nonce');
				return {
					waitForPort: async () => {
						throw new Error('process exited before port 2718 opened');
					},
					getLogs: async () => ({
						stdout: '',
						stderr:
							'permission denied\n' +
							`__MARIMOHUB_LAUNCH_${nonce}__{"event":"setup_exit","setupMs":19,"waitportMs":0,"exitCode":2}\n`,
					}),
				};
			},
		});
		expect(result).toEqual({
			success: false,
			reason: 'setup_exit',
			exitCode: 2,
			stdout: '',
			stderr: 'permission denied\n',
			timings: { setup: 19, start: expect.any(Number), waitport: 0 },
		});
	});
});

describe('base64Encode', () => {
	it('encodes a payload larger than the 0x8000 chunk boundary', () => {
		const bytes = new Uint8Array(0x8000 * 2 + 123);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
		const decoded = atob(base64Encode(bytes));
		expect(decoded.length).toBe(bytes.length);
		for (let i = 0; i < bytes.length; i++) {
			expect(decoded.charCodeAt(i)).toBe(bytes[i]);
		}
	});

	it('round-trips arbitrary bytes including a NUL and high bytes', () => {
		const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f]);
		expect(base64Encode(bytes)).toBe(btoa('\x00\xff\xfe\x80\x7f'));
	});
});

describe('OutputTail', () => {
	const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

	it('keeps short output verbatim', () => {
		const tail = new OutputTail(16);
		tail.append('abc');
		tail.append('def');
		expect(tail.text).toBe('abcdef');
	});

	it('keeps only the trailing bytes once the cap is exceeded', () => {
		const tail = new OutputTail(8);
		tail.append('0123456789');
		tail.append('abcdef');
		expect(tail.text).toBe('89abcdef');
	});

	it('enforces the byte cap on multibyte output', () => {
		const tail = new OutputTail(4);
		tail.append('€€');
		expect(tail.text).toBe('€');
		expect(utf8Bytes(tail.text)).toBeLessThanOrEqual(4);
	});

	it('trims on a character boundary instead of splitting a multibyte sequence', () => {
		const tail = new OutputTail(8);
		tail.append('a€€€');
		expect(tail.text).toBe('€€');
		expect(utf8Bytes(tail.text)).toBeLessThanOrEqual(8);
	});

	it('stays within the cap across many multibyte appends', () => {
		const tail = new OutputTail(64);
		for (let i = 0; i < 100; i++) tail.append('данные-😀');
		expect(utf8Bytes(tail.text)).toBeLessThanOrEqual(64);
		expect(tail.text.endsWith('данные-😀')).toBe(true);
	});
});

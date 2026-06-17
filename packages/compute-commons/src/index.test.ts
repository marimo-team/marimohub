import { describe, it, expect } from 'vitest';
import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	iterableToStream,
	parseFindFilesOutput,
	pollUntilReady,
	shellQuote,
	withEnvPrefix,
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
});

describe('buildFindFilesCommand', () => {
	it('builds a non-recursive find command by default', () => {
		expect(buildFindFilesCommand('/workspace')).toBe(
			"find '/workspace' -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%p\\n'",
		);
	});

	it('omits maxdepth for recursive listings', () => {
		expect(buildFindFilesCommand('/workspace', { recursive: true })).toBe(
			"find '/workspace' -mindepth 1 -printf '%y\\t%s\\t%p\\n'",
		);
	});

	it('quotes the root path', () => {
		expect(buildFindFilesCommand("/work'space")).toContain("'/work'\\''space'");
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
	].join('\n');

	it('maps find rows into file info and filters hidden files by default', () => {
		expect(parseFindFilesOutput(`${output}\n`, '/workspace')).toEqual([
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
			parseFindFilesOutput('f\t5\t/workspace/.hidden\n', '/workspace', { includeHidden: true }),
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
		expect(parseFindFilesOutput('f\tNaN\t/tmp/a.py\n', '/')).toEqual([
			{
				name: 'a.py',
				absolutePath: '/tmp/a.py',
				relativePath: 'tmp/a.py',
				type: 'file',
				size: 0,
			},
		]);
	});

	it('preserves tabs that appear inside file paths', () => {
		expect(parseFindFilesOutput('f\t1\t/workspace/has\ttab.py\n', '/workspace')[0]).toMatchObject({
			name: 'has\ttab.py',
			absolutePath: '/workspace/has\ttab.py',
		});
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
});

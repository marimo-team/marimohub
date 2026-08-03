import { describe, it, expect } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import { expectListFilesResult } from '@marimo-hub/core/testing';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { DockerCompute, spawnDockerRunner } from './docker';
import {
	containerCliContract,
	createRecordingContainerRunner as fakeRunner,
	defaultContainerCliHandler as defaultHandler,
} from './testing';

/**
 * Hermetic tests for the Docker compute adapter: a fake `DockerRunner` records
 * every `docker` invocation and returns scripted results, so we assert the exact
 * CLI the adapter builds — no daemon, no containers.
 */

const SANDBOX_ID = 'sb-abc' as SandboxId;
const NAME = 'marimohub-sbx-sb-abc';

describe('DockerCompute', () => {
	it('create + ensure: runs the container with name, label, and published port', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const compute = new DockerCompute({ image: 'my-image', bindHost: '127.0.0.1' }, runner);
		const sb = compute.create(SANDBOX_ID);

		await sb.exec('true');

		const runCall = calls.find((c) => c.args[0] === 'run');
		expect(runCall).toBeDefined();
		expect(runCall!.args).toContain('--name');
		expect(runCall!.args).toContain(NAME);
		expect(runCall!.args).toContain('--label');
		expect(runCall!.args).toContain('marimohub.sandbox=sb-abc');
		expect(runCall!.args).toContain('-p');
		expect(runCall!.args).toContain('127.0.0.1::2718');
		expect(runCall!.args).toContain('my-image');
		// exec goes through `sh -lc`
		const execCall = calls.find((c) => c.args[0] === 'exec' && c.args.includes('true'));
		expect(execCall).toBeDefined();
	});

	it('a per-create image override replaces the configured image in docker run', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const compute = new DockerCompute({ image: 'my-image' }, runner);
		await compute.create(SANDBOX_ID, { image: 'override-image' }).exec('true');

		const runCall = calls.find((c) => c.args[0] === 'run');
		expect(runCall!.args).toContain('override-image');
		expect(runCall!.args).not.toContain('my-image');
	});

	it('writeFiles: mkdir -p the parents then pipe content via stdin', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await sb.writeFiles([
			{ path: '/home/appuser/notebooks/notebook.py', content: 'print("hi")\n' },
		]);

		const mkdir = calls.find((c) => c.args.join(' ').includes('mkdir -p'));
		expect(mkdir!.args.join(' ')).toContain('/home/appuser/notebooks');
		const write = calls.find((c) => c.args.includes('-i') && c.args.join(' ').includes('cat >'));
		expect(write).toBeDefined();
		expect(write!.stdin).toBe('print("hi")\n');
		expect(write!.args.join(' ')).toContain("cat > '/home/appuser/notebooks/notebook.py'");
	});

	it('writeFiles throws when mkdir fails', async () => {
		const { runner } = fakeRunner((args) => {
			const base = defaultHandler(args);
			if (base) return base;
			if (args.at(-1)?.includes('mkdir -p')) {
				return { stdout: '', stderr: 'permission denied', exitCode: 1 };
			}
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await expect(sb.writeFiles([{ path: '/root/notebook.py', content: 'x=1' }])).rejects.toThrow(
			/writeFiles mkdir failed.*permission denied/,
		);
	});

	it('writeFiles streams a large payload via stdin, never in the argv (ARG_MAX)', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		const big = new Uint8Array(1024 * 1024).fill(65); // 1 MiB
		await sb.writeFiles([{ path: '/workspace/big.bin', content: big }]);

		const write = calls.find((c) => c.args.includes('-i') && c.args.join(' ').includes('cat >'));
		expect(write).toBeDefined();
		// The bytes ride stdin verbatim…
		expect(write!.stdin).toBe(big);
		// …and the argv is the fixed redirect command with no payload interpolated:
		// the last arg is exactly `cat > <path>` and none of the payload bytes (the
		// repeated 0x41 'A') appear anywhere in the argv.
		expect(write!.args.at(-1)).toBe("cat > '/workspace/big.bin'");
		expect(write!.args.join(' ')).not.toContain('AAAAAAAAAA');
	});

	it('writeFiles shell-quotes a file path containing a single quote', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await sb.writeFiles([{ path: "/workspace/it's a file.py", content: 'x' }]);

		const write = calls.find((c) => c.args.includes('-i') && c.args.join(' ').includes('cat >'));
		expect(write!.args.at(-1)).toBe("cat > '/workspace/it'\\''s a file.py'");
	});

	it('writeFiles throws when the stdin write fails', async () => {
		const { runner } = fakeRunner((args) => {
			const base = defaultHandler(args);
			if (base) return base;
			if (args.includes('-i')) return { stdout: 'disk full', stderr: '', exitCode: 1 };
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await expect(
			sb.writeFiles([{ path: '/workspace/notebook.py', content: 'x=1' }]),
		).rejects.toThrow(/writeFile failed.*disk full/);
	});

	it('readFile returns success:false when cat fails', async () => {
		const { runner } = fakeRunner((args) => {
			const base = defaultHandler(args);
			if (base) return base;
			if (args.at(-1)?.startsWith('cat ')) return { stdout: '', stderr: 'missing', exitCode: 1 };
			return;
		});
		const res = await new DockerCompute({}, runner).create(SANDBOX_ID).readFile('/missing.py');

		expect(res).toEqual({ success: false, content: '' });
	});

	it('execStream exposes stdout as a readable stream', async () => {
		const { runner } = fakeRunner((args) => {
			const base = defaultHandler(args);
			if (base) return base;
			if (args.at(-1) === 'echo stream')
				return { stdout: 'stream output', stderr: '', exitCode: 0 };
			return;
		});
		const stream = await new DockerCompute({}, runner).create(SANDBOX_ID).execStream('echo stream');

		expect(await new Response(stream).text()).toBe('stream output');
	});

	it('prefixes exec commands with accumulated environment variables', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await sb.setEnvVars({ TOKEN: "a'b" });
		await sb.setEnvVars({ MODE: 'prod' });
		await sb.exec('echo "$TOKEN:$MODE"');

		const exec = calls.find((c) => c.args.at(-1)?.includes('echo "$TOKEN:$MODE"'));
		expect(exec?.args.at(-1)).toBe(
			"export TOKEN='a'\\''b'; export MODE='prod'; echo \"$TOKEN:$MODE\"",
		);
	});

	it('applies onlyIfUnset vars as guarded defaults after the forced exports', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await sb.setEnvVars({ MODE: 'prod' });
		await sb.setEnvVars({ CACHE: '/tmp/c' }, { onlyIfUnset: true });
		await sb.exec('echo defaults');

		const exec = calls.find((c) => c.args.at(-1)?.includes('echo defaults'));
		expect(exec?.args.at(-1)).toBe(
			"export MODE='prod'; [ -n \"${CACHE:-}\" ] || export CACHE='/tmp/c'; echo defaults",
		);
	});

	it('exposePort: resolves the OS-assigned host port into an http URL', async () => {
		const { runner } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({ host: 'example.test' }, runner).create(SANDBOX_ID);

		const { url } = await sb.exposePort(2718, { hostname: 'ignored' });
		expect(url).toBe('http://example.test:49153');
	});

	it('exposePort throws when docker port output cannot be parsed', async () => {
		const { runner } = fakeRunner((args) => {
			if (args[0] === 'port') return { stdout: 'not-a-port', stderr: '', exitCode: 0 };
			return defaultHandler(args);
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await expect(sb.exposePort(2718, { hostname: 'ignored' })).rejects.toThrow(
			/could not parse host port/,
		);
	});

	it('exposePort returns non-kernel ports without querying docker port', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({ host: 'example.test' }, runner).create(SANDBOX_ID);

		await expect(sb.exposePort(8888, { hostname: 'ignored' })).resolves.toEqual({
			url: 'http://example.test:8888',
		});
		expect(calls.some((c) => c.args[0] === 'port')).toBe(false);
	});

	it('mountBucket throws so the provisioner falls back to file copy', async () => {
		const { runner } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await expect(
			sb.mountBucket({ bucketName: 'b', endpoint: 'e', mountPath: '/m', prefix: 'p' }),
		).rejects.toThrow();
	});

	it('destroy: docker rm -f the container', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await sb.destroy();
		const rm = calls.find((c) => c.args[0] === 'rm');
		expect(rm!.args).toEqual(['rm', '-f', '-v', NAME]);
	});

	it('destroy is idempotent when called twice (even if the second rm fails)', async () => {
		let rmCount = 0;
		const { runner, calls } = fakeRunner((args) => {
			if (args[0] === 'rm') {
				rmCount++;
				// The second removal fails (container already gone); destroy must swallow it.
				return rmCount >= 2
					? { stdout: '', stderr: 'No such container', exitCode: 1 }
					: { stdout: '', stderr: '', exitCode: 0 };
			}
			return defaultHandler(args);
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await sb.destroy();
		await expect(sb.destroy()).resolves.toBeUndefined();
		expect(calls.filter((c) => c.args[0] === 'rm')).toHaveLength(2);
	});

	it('startProcess throws when the container create (docker run) fails', async () => {
		const { runner } = fakeRunner((args) => {
			if (args[0] === 'inspect') return { stdout: 'false', stderr: '', exitCode: 1 };
			if (args[0] === 'run') return { stdout: '', stderr: 'no such image', exitCode: 125 };
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await expect(sb.startProcess('uv run marimo edit')).rejects.toThrow(
			/docker run failed.*no such image/,
		);
	});

	it('startProcess throws when the detached launch fails', async () => {
		const { runner } = fakeRunner((args) => {
			const base = defaultHandler(args);
			if (base) return base;
			// The `exec -d` detached launch fails; ordinary execs still succeed.
			if (args[0] === 'exec' && args.includes('-d')) {
				return { stdout: '', stderr: 'exec denied', exitCode: 1 };
			}
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await expect(sb.startProcess('uv run marimo edit')).rejects.toThrow(
			/startProcess failed.*exec denied/,
		);
	});

	it('spawnDockerRunner maps a missing docker binary to exitCode 127 with stderr', async () => {
		const runner = spawnDockerRunner('marimohub-no-such-docker-binary-xyz');
		const res = await runner.run(['ps']);
		expect(res.exitCode).toBe(127);
		expect(res.stderr).toBeTruthy();
	});

	it('healthCheck verifies that the Docker daemon is reachable', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);

		await expect(new DockerCompute({}, runner).healthCheck()).resolves.toBeUndefined();
		expect(calls).toContainEqual({ args: ['info'], stdin: undefined });
	});

	it('healthCheck identifies a missing Docker CLI', async () => {
		const { runner } = fakeRunner(() => ({
			stdout: '',
			stderr: 'Error: spawn docker ENOENT',
			exitCode: 127,
		}));

		await expect(new DockerCompute({}, runner).healthCheck()).rejects.toThrow(
			'docker CLI is not installed or is not on PATH',
		);
	});

	it('healthCheck identifies an unreachable Docker daemon', async () => {
		const { runner } = fakeRunner(() => ({
			stdout: '',
			stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
			exitCode: 1,
		}));

		await expect(new DockerCompute({}, runner).healthCheck()).rejects.toThrow(
			'docker is not reachable: Cannot connect to the Docker daemon',
		);
	});

	it('healthCheck distinguishes a non-executable CLI (EACCES) from a missing one', async () => {
		const { runner } = fakeRunner(() => ({
			stdout: '',
			stderr: 'Error: spawn docker EACCES',
			exitCode: 127,
		}));

		await expect(new DockerCompute({}, runner).healthCheck()).rejects.toThrow(
			'docker CLI is not executable (permission denied)',
		);
	});

	it('listActive: parses container names into sandbox ids', async () => {
		const { runner } = fakeRunner((args) => {
			if (args[0] === 'ps')
				return {
					// Two well-formed sandbox ids plus a non-matching container; the last
					// is dropped because its name isn't a `sb-<16 char>` id.
					stdout: 'marimohub-sbx-sb-aaaaaaaaaaaaaaaa\nmarimohub-sbx-sb-bbbbbbbbbbbbbbbb\nother\n',
					stderr: '',
					exitCode: 0,
				};
			return;
		});
		const active = await new DockerCompute({}, runner).listActive();
		expect(active.map((a) => a.id)).toEqual(['sb-aaaaaaaaaaaaaaaa', 'sb-bbbbbbbbbbbbbbbb']);
	});

	it('listActive returns an empty list when docker ps fails', async () => {
		const { runner } = fakeRunner((args) =>
			args[0] === 'ps' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 } : undefined,
		);

		await expect(new DockerCompute({}, runner).listActive()).resolves.toEqual([]);
	});

	it('reuses a running container instead of creating a new one', async () => {
		const { runner, calls } = fakeRunner((args) => {
			if (args[0] === 'inspect') return { stdout: 'true', stderr: '', exitCode: 0 }; // already running
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await sb.exec('true');
		expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined();
	});

	it('removes a stopped container before recreating it', async () => {
		const { runner, calls } = fakeRunner((args) => {
			if (args[0] === 'inspect') return { stdout: 'false', stderr: '', exitCode: 0 };
			if (args[0] === 'port') return { stdout: '0.0.0.0:49153\n', stderr: '', exitCode: 0 };
			return;
		});

		await new DockerCompute({}, runner).create(SANDBOX_ID).exec('true');

		const rm = calls.find((c) => c.args[0] === 'rm' && c.args.includes(NAME));
		expect(rm?.args).toEqual(['rm', '-f', NAME]);
		expect(calls.some((c) => c.args[0] === 'run')).toBe(true);
	});

	it('startProcess launches detached, returns logs, and best-effort kills marimo', async () => {
		const { runner, calls } = fakeRunner((args) => {
			const base = defaultHandler(args);
			if (base) return base;
			const cmd = args.at(-1) ?? '';
			if (cmd.includes('cat /tmp/marimohub-proc')) {
				return { stdout: 'kernel log', stderr: '', exitCode: 0 };
			}
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		const proc = await sb.startProcess('uv run marimo edit app.py', { cwd: '/workspace' });
		const logs = await proc.getLogs();
		await proc.kill();

		expect(proc.command).toBe('uv run marimo edit app.py');
		expect(logs).toEqual({ stdout: 'kernel log', stderr: '' });
		const launch = calls.find((c) => c.args[0] === 'exec' && c.args.includes('-d'))!;
		expect(launch.args.at(-1)).toContain("cd '/workspace' && uv run marimo edit app.py >");
		expect(calls.some((c) => c.args[0] === 'exec' && c.args.includes('pkill'))).toBe(true);
	});

	describe('listFiles()', () => {
		const findOutput = (lines: string[]) => `${lines.join('\n')}\n`;
		const onlyFind =
			(stdout: string, exitCode = 0) =>
			(args: string[]) => {
				const base = defaultHandler(args);
				if (base) return base;
				if (args.join(' ').includes('find')) return { stdout, stderr: '', exitCode };
				return;
			};

		it('parses find output and filters hidden files', async () => {
			const { runner } = fakeRunner(
				onlyFind(
					findOutput([
						'f\t10\t/workspace/a.py',
						'd\t4096\t/workspace/sub',
						'l\t0\t/workspace/link',
						'f\t5\t/workspace/.hidden',
					]),
				),
			);
			const res = await new DockerCompute({}, runner).create(SANDBOX_ID).listFiles('/workspace');
			expectListFilesResult(res, {
				success: true,
				files: [
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
				],
			});
		});

		it('includes hidden files when requested and omits maxdepth for recursive listings', async () => {
			const { runner, calls } = fakeRunner(onlyFind(findOutput(['f\t5\t/workspace/.hidden'])));
			const res = await new DockerCompute({}, runner)
				.create(SANDBOX_ID)
				.listFiles('/workspace', { recursive: true, includeHidden: true });
			expect(res.files.map((f) => f.name)).toEqual(['.hidden']);
			const find = calls.find((c) => c.args.join(' ').includes('find'))!;
			expect(find.args.join(' ')).not.toContain('-maxdepth 1');
		});

		it('returns success:false when find fails', async () => {
			const { runner } = fakeRunner(onlyFind('', 1));
			await expect(
				new DockerCompute({}, runner).create(SANDBOX_ID).listFiles('/workspace'),
			).resolves.toEqual({ success: false, files: [] });
		});
	});

	describe('gitCheckout', () => {
		const isGitExec = (args: string[]) =>
			args[0] === 'exec' && args.some((a) => a.includes('git clone'));

		it('runs a shell-quoted git clone (injection-safe via compute-commons)', async () => {
			const { runner, calls } = fakeRunner(defaultHandler);
			await new DockerCompute({ image: 'i' }, runner)
				.create(SANDBOX_ID)
				.gitCheckout('https://x/y', { branch: 'main', targetDir: 'w' });

			const git = calls.find((c) => isGitExec(c.args));
			expect(git!.args.at(-1)).toBe("git clone --branch 'main' 'https://x/y' 'w'");
		});

		it('throws when the clone fails', async () => {
			const { runner } = fakeRunner((args) => {
				const base = defaultHandler(args);
				if (base) return base;
				if (isGitExec(args)) return { stdout: '', stderr: 'fatal: repo', exitCode: 128 };
				return;
			});
			await expect(
				new DockerCompute({}, runner).create(SANDBOX_ID).gitCheckout('https://x/y'),
			).rejects.toThrow(/git checkout failed: fatal: repo/);
		});
	});
});

computeContract('DockerCompute', () => new DockerCompute({}, fakeRunner(defaultHandler).runner), {
	mountFallsBack: true,
});

containerCliContract(
	'DockerCompute',
	'docker',
	(config, runner) => new DockerCompute(config, runner),
	spawnDockerRunner,
);

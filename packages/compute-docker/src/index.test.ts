import { describe, it, expect } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { DockerCompute } from './index';
import type { DockerRunner, DockerRunResult } from './index';

/**
 * Hermetic tests for the Docker compute adapter: a fake `DockerRunner` records
 * every `docker` invocation and returns scripted results, so we assert the exact
 * CLI the adapter builds — no daemon, no containers.
 */

const SANDBOX_ID = 'sb-abc' as SandboxId;
const NAME = 'marimohub-sbx-sb-abc';

interface Call {
	args: string[];
	stdin?: string;
}

/** Fake runner: matches on a prefix of args, else returns a default ok result. */
function fakeRunner(handler: (args: string[], stdin?: string) => DockerRunResult | undefined): {
	runner: DockerRunner;
	calls: Call[];
} {
	const calls: Call[] = [];
	const runner: DockerRunner = {
		async run(args, options) {
			calls.push({ args, stdin: options?.stdin });
			return handler(args, options?.stdin) ?? { stdout: '', stderr: '', exitCode: 0 };
		},
	};
	return { runner, calls };
}

/** Default handler: container not yet running, `run` succeeds, `port` returns a mapping. */
function defaultHandler(args: string[]): DockerRunResult | undefined {
	if (args[0] === 'inspect') return { stdout: 'false', stderr: '', exitCode: 1 }; // not found
	if (args[0] === 'port') return { stdout: '0.0.0.0:49153\n[::]:49153\n', stderr: '', exitCode: 0 };
	return undefined; // ok
}

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

	it('writeFile: mkdir -p the parent then pipe content via stdin', async () => {
		const { runner, calls } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);

		await sb.writeFile('/home/appuser/notebooks/notebook.py', 'print("hi")\n');

		const mkdir = calls.find((c) => c.args.join(' ').includes('mkdir -p'));
		expect(mkdir!.args.join(' ')).toContain('/home/appuser/notebooks');
		const write = calls.find((c) => c.args.includes('-i') && c.args.join(' ').includes('cat >'));
		expect(write).toBeDefined();
		expect(write!.stdin).toBe('print("hi")\n');
		expect(write!.args.join(' ')).toContain("cat > '/home/appuser/notebooks/notebook.py'");
	});

	it('exposePort: resolves the OS-assigned host port into an http URL', async () => {
		const { runner } = fakeRunner(defaultHandler);
		const sb = new DockerCompute({ host: 'example.test' }, runner).create(SANDBOX_ID);

		const { url } = await sb.exposePort(2718, { hostname: 'ignored' });
		expect(url).toBe('http://example.test:49153');
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

	it('reuses a running container instead of creating a new one', async () => {
		const { runner, calls } = fakeRunner((args) => {
			if (args[0] === 'inspect') return { stdout: 'true', stderr: '', exitCode: 0 }; // already running
			return;
		});
		const sb = new DockerCompute({}, runner).create(SANDBOX_ID);
		await sb.exec('true');
		expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined();
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

import { access, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SandboxId } from '@marimo-hub/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { SandboxInstance } from '@marimo-hub/core/ports';
import { listFilesFailure } from '@marimo-hub/core/ports';
import { expectFileResult } from '@marimo-hub/core/testing';
import {
	computeContract,
	CONTRACT_HIDDEN_FILE,
	CONTRACT_SANDBOX_ID,
	CONTRACT_VISIBLE_FILE,
} from '@marimo-hub/core/testing/compute-contract';
import { LocalCompute, prepareMarimoCommand, rewriteWorkspace } from './index';

const compute = new LocalCompute();
const created: SandboxId[] = [];

function newSandbox() {
	const id = `sb-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
	created.push(id);
	return compute.create(id);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		throw error;
	}
}

async function waitForPid(sandbox: SandboxInstance, path: string): Promise<number> {
	let pid = 0;
	await expect
		.poll(
			async () => {
				const result = await sandbox.readFile(path);
				if (result.success) pid = Number(result.content.trim());
				return pid;
			},
			{ timeout: 5000, interval: 20 },
		)
		.toBeGreaterThan(0);
	return pid;
}

afterEach(async () => {
	for (const id of created.splice(0)) {
		await compute.create(id).destroy();
	}
});

/**
 * A tiny HTTP server that binds whatever `--port` is passed (stands in for the
 * `marimo edit … --port 2718` command, so the adapter's port rewrite applies).
 */
const SERVER_CMD = `node -e "const i=process.argv.indexOf('--port');const p=+process.argv[i+1];require('http').createServer((_,r)=>r.end('ok')).listen(p,'127.0.0.1')" -- --port 2718`;

describe('prepareMarimoCommand (pure)', () => {
	it('passes non-`uv run` commands through untouched', () => {
		expect(prepareMarimoCommand('echo hi', '0.0.0.0')).toBe('echo hi');
	});

	it('injects `--with marimo` into a uv run command', () => {
		expect(prepareMarimoCommand('uv run marimo edit --port 2718', '127.0.0.1')).toBe(
			'uv run --with marimo marimo edit --port 2718',
		);
	});

	it('injects `--with marimo` when setup commands prefix the uv run command', () => {
		const command = 'if test -f pyproject.toml; then uv sync; fi && uv run --no-sync marimo edit';
		expect(prepareMarimoCommand(command, '127.0.0.1')).toBe(
			'if test -f pyproject.toml; then uv sync; fi && uv run --with marimo --no-sync marimo edit',
		);
	});

	it('does not double-inject `--with marimo`', () => {
		const already = 'uv run --with marimo marimo edit';
		expect(prepareMarimoCommand(already, '127.0.0.1')).toBe(already);
	});

	it('appends `--host <bindHost>` in Docker mode (non-loopback bind)', () => {
		expect(prepareMarimoCommand('uv run marimo edit', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit --host 0.0.0.0',
		);
	});

	it('does NOT append `--host` when binding loopback (host mode)', () => {
		expect(prepareMarimoCommand('uv run marimo edit', '127.0.0.1')).toBe(
			'uv run --with marimo marimo edit',
		);
	});

	it('does NOT append `--host` when one is already present', () => {
		expect(prepareMarimoCommand('uv run marimo edit --host 1.2.3.4', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit --host 1.2.3.4',
		);
	});

	it('appends `--host` to the launch segment when setup commands prefix it (Docker mode)', () => {
		const command = 'if test -f pyproject.toml; then uv sync; fi && uv run --no-sync marimo edit';
		expect(prepareMarimoCommand(command, '0.0.0.0')).toBe(
			'if test -f pyproject.toml; then uv sync; fi && uv run --with marimo --no-sync marimo edit --host 0.0.0.0',
		);
	});

	it('appends `--host` to the launch segment, not a trailing command (Docker mode)', () => {
		expect(prepareMarimoCommand('uv run marimo edit && sh notify.sh', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit --host 0.0.0.0 && sh notify.sh',
		);
	});

	it('scopes `--host` detection to the launch segment, ignoring a trailing flag', () => {
		expect(prepareMarimoCommand('uv run marimo edit && tool --host 1.2.3.4', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit --host 0.0.0.0 && tool --host 1.2.3.4',
		);
	});

	it('stops the launch segment at a pipe, not a trailing command (Docker mode)', () => {
		expect(prepareMarimoCommand('uv run marimo edit | tee log', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit --host 0.0.0.0 | tee log',
		);
	});

	it('stops the launch segment at a semicolon, not a trailing command (Docker mode)', () => {
		expect(prepareMarimoCommand('uv run marimo edit; touch done', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit --host 0.0.0.0; touch done',
		);
	});

	it('does not truncate the launch segment at an `&&` inside quotes', () => {
		expect(prepareMarimoCommand('uv run marimo edit -c "a && b"', '0.0.0.0')).toBe(
			'uv run --with marimo marimo edit -c "a && b" --host 0.0.0.0',
		);
	});
});

describe('rewriteWorkspace (pure)', () => {
	it('rewrites every /workspace reference to the sandbox root', () => {
		expect(rewriteWorkspace('cat /workspace/a /workspace/b', '/root')).toBe(
			`cat ${path.join('/root', '/workspace')}/a ${path.join('/root', '/workspace')}/b`,
		);
	});

	it('leaves commands without /workspace untouched', () => {
		expect(rewriteWorkspace('echo hello', '/root')).toBe('echo hello');
	});
});

describe('LocalCompute file ops', () => {
	it('round-trips files under the workspace and maps /workspace paths', async () => {
		const sb = newSandbox();
		const mkdir = await sb.exec('mkdir -p /workspace');
		expect(mkdir.success).toBe(true);

		await sb.writeFiles([{ path: '/workspace/notebook.py', content: 'print(1)' }]);
		const read = await sb.readFile('/workspace/notebook.py');
		expectFileResult(read, { success: true, content: 'print(1)' });

		const list = await sb.listFiles('/workspace');
		expect(list.success).toBe(true);
		expect(list.files.map((f) => f.name)).toContain('notebook.py');
	});

	it('waits for active writes before destroying and rejects later writes', async () => {
		const id = `sb-write-destroy-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		created.push(id);
		const sb = compute.create(id);
		const root = path.join(os.tmpdir(), `marimohub-sandbox-${id}`);
		const writes = Array.from({ length: 100 }, (_, index) => ({
			path: `/workspace/${index}/file.txt`,
			content: 'content',
		}));

		const writing = sb.writeFiles(writes);
		const destroying = sb.destroy();
		await expect(writing).resolves.toBeUndefined();
		await expect(destroying).resolves.toBeUndefined();

		await expect(access(root)).rejects.toThrow();
		await expect(sb.writeFiles([{ path: '/workspace/late.txt', content: 'late' }])).rejects.toThrow(
			/destroyed/,
		);
	});

	it('returns NOT_FOUND reading a missing file', async () => {
		const sb = newSandbox();
		const read = await sb.readFile('/workspace/nope.py');
		expectFileResult(read, { success: false, error: { code: 'NOT_FOUND' } });
	});

	it('rejects mountBucket so the provisioner falls back to copy', async () => {
		const sb = newSandbox();
		await expect(
			sb.mountBucket({ bucketName: 'b', endpoint: 'e', mountPath: '/m', prefix: 'p' }),
		).rejects.toThrow();
	});

	it('hides dotfiles by default and includes them with includeHidden', async () => {
		const sb = newSandbox();
		await sb.writeFiles([{ path: '/workspace/visible.py', content: 'x' }]);
		await sb.writeFiles([{ path: '/workspace/.hidden', content: 'y' }]);

		const def = await sb.listFiles('/workspace');
		expect(def.files.map((f) => f.name)).toContain('visible.py');
		expect(def.files.map((f) => f.name)).not.toContain('.hidden');

		const all = await sb.listFiles('/workspace', { includeHidden: true });
		expect(all.files.map((f) => f.name)).toContain('.hidden');
	});

	it('returns success:false listing a missing directory', async () => {
		const sb = newSandbox();
		expect(await sb.listFiles('/workspace/does-not-exist')).toEqual(listFilesFailure());
	});

	it('gitCheckout throws when the clone fails', async () => {
		const sb = newSandbox();
		// A nonexistent source fails fast (no network); robust even if git is absent
		// (then sh reports command-not-found, still a non-zero exit → same throw).
		await expect(sb.gitCheckout('/nonexistent/repo.git', { targetDir: 'cloned' })).rejects.toThrow(
			/git checkout failed/,
		);
	});
});

describe('LocalCompute env propagation', () => {
	it('setEnvVars are visible to a started process', async () => {
		const sb = newSandbox();
		await sb.setEnvVars({ MH_TEST_VAR: 'hello-env' });

		// A short-lived process that writes its view of the env var to a file.
		const cmd = `node -e "require('fs').writeFileSync('/workspace/env.txt', process.env.MH_TEST_VAR || 'MISSING')"`;
		await sb.startProcess(cmd, { cwd: '/workspace' });

		// The process is detached; poll until it has written the file.
		let content = '';
		for (let i = 0; i < 50; i++) {
			const read = await sb.readFile('/workspace/env.txt');
			if (read.success && read.content) {
				content = read.content;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(content).toBe('hello-env');
	});

	it('onlyIfUnset vars apply when the environment does not define them', async () => {
		const sb = newSandbox();
		await sb.setEnvVars({ MH_TEST_DEFAULT: 'fallback' }, { onlyIfUnset: true });

		const cmd = `node -e "require('fs').writeFileSync('/workspace/env-default.txt', process.env.MH_TEST_DEFAULT || 'MISSING')"`;
		await sb.startProcess(cmd, { cwd: '/workspace' });

		let content = '';
		for (let i = 0; i < 50; i++) {
			const read = await sb.readFile('/workspace/env-default.txt');
			if (read.success && read.content) {
				content = read.content;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(content).toBe('fallback');
	});

	it('onlyIfUnset vars defer to a value the process environment already has', async () => {
		const sb = newSandbox();
		await sb.setEnvVars({ MH_TEST_DEFAULT: 'from-env' });
		await sb.setEnvVars({ MH_TEST_DEFAULT: 'fallback' }, { onlyIfUnset: true });

		const cmd = `node -e "require('fs').writeFileSync('/workspace/env-forced.txt', process.env.MH_TEST_DEFAULT || 'MISSING')"`;
		await sb.startProcess(cmd, { cwd: '/workspace' });

		let content = '';
		for (let i = 0; i < 50; i++) {
			const read = await sb.readFile('/workspace/env-forced.txt');
			if (read.success && read.content) {
				content = read.content;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(content).toBe('from-env');
	});
});

describe('LocalCompute process lifecycle', () => {
	it('maps the logical port to a real free port and serves there', async () => {
		const sb = newSandbox();
		const proc = await sb.startProcess(SERVER_CMD, { cwd: '/workspace' });
		await proc.waitForPort(2718, { timeout: 15_000 });

		const { url } = await sb.exposePort(2718, { hostname: 'ignored' });
		expect(url).toMatch(/^http:\/\/localhost:\d+$/);
		// The exposed port is the real one, not the logical 2718.
		expect(url).not.toContain(':2718');

		const res = await fetch(url);
		expect(await res.text()).toBe('ok');
	});

	it('gives concurrent sandboxes different real ports', async () => {
		const a = newSandbox();
		const b = newSandbox();
		const pa = await a.startProcess(SERVER_CMD, { cwd: '/workspace' });
		const pb = await b.startProcess(SERVER_CMD, { cwd: '/workspace' });
		await pa.waitForPort(2718, { timeout: 15_000 });
		await pb.waitForPort(2718, { timeout: 15_000 });
		const ua = (await a.exposePort(2718, { hostname: '' })).url;
		const ub = (await b.exposePort(2718, { hostname: '' })).url;
		expect(ua).not.toBe(ub);
	});

	it('rejects waitForPort with stderr when the process exits early', async () => {
		const sb = newSandbox();
		const proc = await sb.startProcess(
			'node -e "console.error(\'boom\'); process.exit(1)" -- --port 2718',
		);
		await expect(proc.waitForPort(2718, { timeout: 5_000 })).rejects.toThrow(/boom|exited/);
	});

	it('allocates within a configured port range (Docker mode)', async () => {
		const ranged = new LocalCompute({ ports: { start: 2740, end: 2745 } });
		const id = `sb-range-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		const sb = ranged.create(id);
		try {
			const proc = await sb.startProcess(SERVER_CMD, { cwd: '/workspace' });
			await proc.waitForPort(2718, { timeout: 15_000 });
			const { url } = await sb.exposePort(2718, { hostname: '' });
			const port = Number(new URL(url).port);
			expect(port).toBeGreaterThanOrEqual(2740);
			expect(port).toBeLessThanOrEqual(2745);
		} finally {
			await sb.destroy();
		}
	});
});

describe('LocalCompute security & limits', () => {
	it('writeFiles must not allow path traversal outside the sandbox root', async () => {
		// The sandbox root sits one level under os.tmpdir(), so a single `..` in the
		// write path escapes it (mapPath is a bare path.join with no containment check).
		const rand = Math.random().toString(36).slice(2, 10);
		const escaped = path.join(os.tmpdir(), `mh-traversal-${rand}.txt`);
		const sb = newSandbox();
		try {
			await sb.writeFiles([{ path: `/../mh-traversal-${rand}.txt`, content: 'pwned' }]);
			// Secure behaviour: the traversal must NOT have written outside the root.
			await expect(access(escaped)).rejects.toThrow();
		} finally {
			await rm(escaped, { force: true });
		}
	});

	it('startProcess throws when the configured port range is exhausted', async () => {
		// Occupy a single-port range so allocatePort scans it and finds nothing free.
		const srv = net.createServer();
		const port = await new Promise<number>((resolve) => {
			srv.listen(0, '127.0.0.1', () => {
				const addr = srv.address();
				resolve(typeof addr === 'object' && addr ? addr.port : 0);
			});
		});
		const ranged = new LocalCompute({ ports: { start: port, end: port } });
		const id = `sb-exhaust-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		const sb = ranged.create(id);
		try {
			await expect(sb.startProcess(SERVER_CMD, { cwd: '/workspace' })).rejects.toThrow(
				/no free port/,
			);
		} finally {
			await sb.destroy();
			// close() is fire-and-forget (returns the server, not a promise); await the
			// actual close so the port is freed before teardown to avoid cross-test flakes.
			await new Promise<void>((resolve) => srv.close(() => resolve()));
		}
	});

	it('destroy is idempotent when called twice and after never starting', async () => {
		const id = `sb-idempotent-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		const sb = compute.create(id);
		await expect(sb.destroy()).resolves.toBeUndefined();
		await expect(sb.destroy()).resolves.toBeUndefined();
	});

	it('exposePort ignores the app-provided hostname (kernel host is the configured host)', async () => {
		// Documents that the local backend serves the kernel on its own host and does
		// NOT honour the hostname passed for cross-origin isolation (dev-only backend).
		const sb = newSandbox();
		const { url } = await sb.exposePort(2718, { hostname: 'kernels.example.com' });
		expect(url).not.toContain('kernels.example.com');
		expect(url.startsWith('http://localhost:')).toBe(true);
	});
});

describe('LocalCompute registry & teardown', () => {
	it('returns the same instance for the same id', () => {
		const id = `sb-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		created.push(id);
		expect(compute.create(id)).toBe(compute.create(id));
	});

	it('destroy kills processes and removes the temp root', async () => {
		const id = `sb-destroy-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		const sb = compute.create(id);
		await sb.writeFiles([{ path: '/workspace/notebook.py', content: 'x' }]);
		const proc = await sb.startProcess(SERVER_CMD, { cwd: '/workspace' });
		await proc.waitForPort(2718, { timeout: 15_000 });
		const { url } = await sb.exposePort(2718, { hostname: '' });

		await sb.destroy();

		// Port no longer served.
		await expect(fetch(url)).rejects.toThrow();
	});

	it('proxy is a no-op', async () => {
		expect(await compute.proxy()).toBeNull();
	});

	it('disposes every sandbox and rejects later creates', async () => {
		const local = new LocalCompute();
		try {
			const first = local.create('sb-dispose-first' as SandboxId);
			const second = local.create('sb-dispose-second' as SandboxId);
			const firstProcess = await first.startProcess(SERVER_CMD, { cwd: '/workspace' });
			const secondProcess = await second.startProcess(SERVER_CMD, { cwd: '/workspace' });
			await Promise.all([
				firstProcess.waitForPort(2718, { timeout: 15_000 }),
				secondProcess.waitForPort(2718, { timeout: 15_000 }),
			]);
			const urls = await Promise.all([
				first.exposePort(2718, { hostname: '' }),
				second.exposePort(2718, { hostname: '' }),
			]);

			await local[Symbol.asyncDispose]();
			await expect(local[Symbol.asyncDispose]()).resolves.toBeUndefined();

			for (const { url } of urls) await expect(fetch(url)).rejects.toThrow();
			await expect(first.startProcess(SERVER_CMD)).rejects.toThrow(/destroyed/);
			expect(() => local.create('sb-after-dispose' as SandboxId)).toThrow(/disposed/);
		} finally {
			await local[Symbol.asyncDispose]();
		}
	});
});

describe('LocalCompute listActive', () => {
	it('reports only sandboxes with a live kernel process', async () => {
		// A created-but-not-started sandbox has no live children → not listed.
		const idleId = `sb-idle-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		created.push(idleId);
		compute.create(idleId);
		expect((await compute.listActive()).map((s) => s.id)).not.toContain(idleId);

		// A sandbox with a running process IS listed.
		const runningId = `sb-run-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		created.push(runningId);
		const sb = compute.create(runningId);
		const proc = await sb.startProcess(SERVER_CMD, { cwd: '/workspace' });
		await proc.waitForPort(2718, { timeout: 15_000 });

		let active = await compute.listActive();
		expect(active.map((s) => s.id)).toContain(runningId);
		expect(active.find((s) => s.id === runningId)?.createdAt).toBeTruthy();

		// After destroy it drops out.
		await sb.destroy();
		active = await compute.listActive();
		expect(active.map((s) => s.id)).not.toContain(runningId);
	});
});

describe('LocalCompute process hygiene', () => {
	it('execStream does not deadlock when the command floods stderr', async () => {
		const sb = newSandbox();
		const stream = await sb.execStream(
			`node -e "process.stderr.write('e'.repeat(256 * 1024)); process.stdout.write('done')"`,
		);
		expect(await new Response(stream).text()).toBe('done');
	}, 15_000);

	it('destroy kills a live execStream child', async () => {
		const sb = newSandbox();
		const stream = await sb.execStream('sleep 30');
		const drained = new Response(stream).text();
		await sb.destroy();
		await expect(drained).resolves.toBe('');
	}, 10_000);

	it('cancelling an execStream kills the child', async () => {
		const sb = newSandbox();
		const stream = await sb.execStream('echo $$ > direct.pid; sleep 30');
		const pid = await waitForPid(sb, 'direct.pid');
		expect(processIsAlive(pid)).toBe(true);
		await stream.cancel();
		await expect.poll(() => processIsAlive(pid), { timeout: 5000, interval: 20 }).toBe(false);
	}, 10_000);

	it('cancelling an execStream reader kills the process group', async () => {
		const sb = newSandbox();
		const stream = await sb.execStream('sleep 30 & echo $! > descendant.pid; wait');
		const reader = stream.getReader();
		const pid = await waitForPid(sb, 'descendant.pid');
		expect(processIsAlive(pid)).toBe(true);
		await reader.cancel();
		await expect.poll(() => processIsAlive(pid), { timeout: 5000, interval: 20 }).toBe(false);
	}, 10_000);

	it('exec retains only the trailing output', async () => {
		const sb = newSandbox();
		const res = await sb.exec(`node -e "process.stdout.write('a'.repeat(300 * 1024))"`);
		expect(res.success).toBe(true);
		expect(res.stdout.length).toBeLessThanOrEqual(64 * 1024);
		expect(res.stdout.endsWith('a')).toBe(true);
	});

	it('exec decodes multi-byte UTF-8 split across chunks', async () => {
		const sb = newSandbox();
		const res = await sb.exec(
			`node -e "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 100)"`,
		);
		expect(res.success).toBe(true);
		expect(res.stdout).toBe('é');
	});

	it('startProcess logs are capped to the trailing output', async () => {
		const sb = newSandbox();
		const proc = await sb.startProcess(
			`node -e "process.stdout.write('b'.repeat(300 * 1024)); setInterval(() => {}, 1000)"`,
			{ cwd: '/workspace' },
		);
		let logs = { stdout: '', stderr: '' };
		for (let i = 0; i < 50; i++) {
			logs = await proc.getLogs();
			if (logs.stdout.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(logs.stdout.length).toBeGreaterThan(0);
		expect(logs.stdout.length).toBeLessThanOrEqual(64 * 1024);
		await proc.kill();
	});

	it('destroy evicts the instance so the id maps to a fresh one', async () => {
		const id = `sb-evict-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		created.push(id);
		const sb = compute.create(id);
		expect(compute.create(id)).toBe(sb);
		await sb.destroy();
		expect(compute.create(id)).not.toBe(sb);
	});

	it('a stale destroy does not evict a replacement instance', async () => {
		const id = `sb-stale-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
		created.push(id);
		const first = compute.create(id);
		await first.destroy();
		const second = compute.create(id);
		await first.destroy();
		expect(compute.create(id)).toBe(second);
	});
});

computeContract('LocalCompute', () => new LocalCompute(), {
	mountFallsBack: true,
	semantics: {
		failingCommand: 'false',
		absentFile: { path: '/workspace/contract-absent.txt', code: 'NOT_FOUND' },
		hiddenFiles: {
			dir: '/workspace',
			seed: (inst) =>
				inst.writeFiles([
					{ path: `/workspace/${CONTRACT_VISIBLE_FILE}`, content: 'v' },
					{ path: `/workspace/${CONTRACT_HIDDEN_FILE}`, content: 'h' },
				]),
		},
		envProbe: (name) => `printenv ${name}`,
		preexistingEnv: {
			name: 'MH_CONTRACT_ENV_PREEXISTING',
			value: 'host',
			setup: async () => {
				const previous = process.env.MH_CONTRACT_ENV_PREEXISTING;
				process.env.MH_CONTRACT_ENV_PREEXISTING = 'host';
				return () => {
					if (previous === undefined) delete process.env.MH_CONTRACT_ENV_PREEXISTING;
					else process.env.MH_CONTRACT_ENV_PREEXISTING = previous;
				};
			},
		},
	},
});

afterAll(async () => {
	await new LocalCompute().create(CONTRACT_SANDBOX_ID).destroy();
});

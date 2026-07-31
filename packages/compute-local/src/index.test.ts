import { access, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SandboxId } from '@marimo-hub/core';
import { afterEach, describe, expect, it } from 'vitest';
import { expectFileResult } from '@marimo-hub/core/testing';
import { LocalCompute, prepareMarimoCommand, rewriteWorkspace } from './index';

const compute = new LocalCompute();
const created: SandboxId[] = [];

function newSandbox() {
	const id = `sb-${Math.random().toString(36).slice(2, 10)}` as SandboxId;
	created.push(id);
	return compute.create(id);
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

	it('returns success:false reading a missing file', async () => {
		const sb = newSandbox();
		const read = await sb.readFile('/workspace/nope.py');
		expectFileResult(read, { success: false });
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
		expect(await sb.listFiles('/workspace/does-not-exist')).toEqual({ success: false, files: [] });
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

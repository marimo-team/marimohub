/**
 * Local (dev) compute backend.
 *
 * Runs a marimo kernel as a child process ON THE HOST and exposes it directly
 * at `http://<host>:<port>` for the browser to iframe — no cloud account, no
 * container. It implements the same `SandboxProvider`/`SandboxInstance` ports as
 * the Modal and Cloudflare adapters, so the API, provisioner, and frontend are
 * unchanged.
 *
 * Requirements: `uv` (and Python) must be installed on the host PATH — that is
 * what `uv run marimo edit …` needs. This backend is for local development only;
 * it has no isolation and is not safe for shared/production use.
 *
 * Two impedance mismatches with the provider-agnostic core are handled here:
 *  - core hardcodes the workspace at `/workspace`; each sandbox gets a private
 *    temp root and `/workspace` is rewritten to `<root>/workspace`.
 *  - core hardcodes `--port 2718`; we allocate a real free port per sandbox and
 *    map the logical port (2718) → the real port so multiple kernels coexist.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
	buildGitCloneCommand,
	mapWithConcurrency,
	pollUntilReady,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core';
import type {
	ActiveSandbox,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	FileInfo,
	GitCheckoutOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';

const WORKSPACE = '/workspace';

export interface PortRange {
	start: number;
	end: number;
}

/** True if a TCP port can be bound on `host` (i.e. it is currently free). */
function portIsFree(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.unref();
		srv.once('error', () => resolve(false));
		srv.listen(port, host, () => srv.close(() => resolve(true)));
	});
}

/** Reserve an ephemeral TCP port by briefly binding it, then return the number. */
function allocateEphemeral(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.once('error', reject);
		srv.listen(0, host, () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Pick a free port. With no range, use an ephemeral OS-assigned port (host
 * mode). With a range, scan it — required in Docker, where only a fixed,
 * published set of ports is reachable from the browser.
 */
async function allocatePort(host: string, range?: PortRange): Promise<number> {
	if (!range) return allocateEphemeral(host);
	for (let p = range.start; p <= range.end; p++) {
		if (await portIsFree(p, host)) return p;
	}
	throw new Error(`no free port in range ${range.start}-${range.end}`);
}

/** Resolve once a TCP listener accepts a connection on the port, or true/false. */
function tcpReady(port: number, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect({ port, host });
		sock.once('connect', () => {
			sock.destroy();
			resolve(true);
		});
		sock.once('error', () => {
			sock.destroy();
			resolve(false);
		});
	});
}

/** Rewrite `/workspace` references in a shell command to a sandbox's real root. */
export function rewriteWorkspace(cmd: string, root: string): string {
	return cmd.replaceAll(WORKSPACE, path.join(root, WORKSPACE));
}

/**
 * Adjust a `uv run … marimo …` command for local execution. Pure (no `this`) so
 * the branchy rewrite logic is unit-testable:
 *  - inject `--with marimo` so marimo is available even if the notebook's
 *    pyproject.toml doesn't declare it (installed into an ephemeral env);
 *  - append `--host <bindHost>` when binding a non-default interface (Docker:
 *    0.0.0.0), so the kernel is reachable through the published port.
 * Non-`uv run` commands and already-configured ones pass through unchanged.
 */
export function prepareMarimoCommand(cmd: string, bindHost: string): string {
	if (!cmd.startsWith('uv run ')) return cmd;
	let out = cmd;
	if (!out.includes('--with marimo')) {
		out = out.replace(/^uv run /, 'uv run --with marimo ');
	}
	if (bindHost !== '127.0.0.1' && out.includes('marimo') && !out.includes('--host')) {
		out = `${out} --host ${bindHost}`;
	}
	return out;
}

export interface LocalComputeOptions {
	/** Host the exposed kernel URL points at (what the browser hits). Default `localhost`. */
	host?: string;
	/**
	 * Interface marimo binds to. Default `127.0.0.1` (host mode). In Docker set
	 * `0.0.0.0` so the kernel is reachable through a published container port.
	 */
	bindHost?: string;
	/**
	 * Restrict kernel ports to this inclusive range. Required in Docker, where
	 * only a fixed published range is reachable; omit on the host for ephemeral
	 * ports.
	 */
	ports?: PortRange;
}

class LocalSandboxInstance implements SandboxInstance {
	private readonly root: string;
	private readonly host: string;
	private readonly bindHost: string;
	private readonly ports?: PortRange;
	private readonly children = new Set<ChildProcess>();
	/** Logical port (as named in core, e.g. 2718) → real allocated host port. */
	private readonly portMap = new Map<number, number>();
	private env: Record<string, string> = {};
	/** ISO timestamp the instance was constructed — surfaced via listActive(). */
	readonly createdAt = new Date().toISOString();

	/** True while at least one kernel child process is still running. */
	hasLiveChildren(): boolean {
		return this.children.size > 0;
	}

	constructor(
		id: SandboxId,
		opts: Required<Pick<LocalComputeOptions, 'host' | 'bindHost'>> &
			Pick<LocalComputeOptions, 'ports'>,
	) {
		this.root = path.join(os.tmpdir(), `marimohub-sandbox-${id}`);
		this.host = opts.host;
		this.bindHost = opts.bindHost;
		this.ports = opts.ports;
	}

	/**
	 * Resolve an absolute sandbox path (e.g. /workspace/...) under this sandbox
	 * root, or `null` if it would escape the root. path.join normalizes, so a `..`
	 * in a notebook-controlled path could otherwise read/write anywhere the server
	 * user can.
	 */
	private resolveContained(p: string): string | null {
		const abs = path.join(this.root, p);
		const rootPrefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
		if (abs !== this.root && !abs.startsWith(rootPrefix)) return null;
		return abs;
	}

	/** Map a sandbox path under the root, throwing if it escapes. */
	private mapPath(p: string): string {
		const abs = this.resolveContained(p);
		if (abs === null) throw new Error(`sandbox path escapes the sandbox root: ${p}`);
		return abs;
	}

	/** Rewrite `/workspace` references in a shell command to the real root. */
	private rewriteCmd(cmd: string): string {
		return rewriteWorkspace(cmd, this.root);
	}

	/** Adjust a `uv run … marimo …` command for local execution (see {@link prepareMarimoCommand}). */
	private prepareMarimoCmd(cmd: string): string {
		return prepareMarimoCommand(cmd, this.bindHost);
	}

	private async ensureRoot(): Promise<void> {
		await mkdir(this.root, { recursive: true });
	}

	async exec(cmd: string): Promise<ExecResult> {
		await this.ensureRoot();
		return new Promise((resolve) => {
			const child = spawn('sh', ['-c', this.rewriteCmd(cmd)], { cwd: this.root });
			let stdout = '';
			let stderr = '';
			child.stdout?.on('data', (d) => (stdout += d.toString()));
			child.stderr?.on('data', (d) => (stderr += d.toString()));
			child.on('error', (err) => resolve({ success: false, stdout, stderr: stderr + String(err) }));
			child.on('close', (code) => resolve({ success: code === 0, stdout, stderr }));
		});
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		await this.ensureRoot();
		const child = spawn('sh', ['-c', this.rewriteCmd(cmd)], { cwd: this.root });
		return Readable.toWeb(child.stdout ?? Readable.from([])) as ReadableStream;
	}

	async readFile(p: string): Promise<ReadFileResult> {
		try {
			const content = await readFile(this.mapPath(p), 'utf-8');
			return { success: true, content, encoding: 'utf-8' };
		} catch {
			return { success: false, content: '' };
		}
	}

	async listFiles(p: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		try {
			const base = this.mapPath(p);
			const entries = await readdir(base, { withFileTypes: true });
			const files: FileInfo[] = [];
			for (const e of entries) {
				if (!options?.includeHidden && e.name.startsWith('.')) continue;
				const abs = path.join(base, e.name);
				let size = 0;
				try {
					size = (await stat(abs)).size;
				} catch {
					// ignore — best effort
				}
				files.push({
					name: e.name,
					absolutePath: abs,
					relativePath: path.join(p, e.name),
					type: e.isDirectory()
						? 'directory'
						: e.isSymbolicLink()
							? 'symlink'
							: e.isFile()
								? 'file'
								: 'other',
					size,
				});
			}
			return { success: true, files };
		} catch {
			return { success: false, files: [] };
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		// Local writes are cheap (no round-trip), so a plain bounded loop is enough.
		await mapWithConcurrency(files, WRITE_CONCURRENCY, async (f) => {
			const abs = this.resolveContained(f.path);
			if (abs === null) {
				console.warn(`writeFiles: skipping path outside sandbox root: ${f.path}`);
				return;
			}
			await mkdir(path.dirname(abs), { recursive: true });
			// `encoding` applies to string content only; bytes are written verbatim.
			await writeFile(abs, f.content, typeof f.content === 'string' ? 'utf-8' : null);
		});
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		// shellQuote'd args (via buildGitCloneCommand) close the injection hole the
		// previous raw interpolation left open.
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>): Promise<void> {
		this.env = { ...this.env, ...vars };
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// Intentional: no FUSE locally. Throwing makes SandboxProvisioner fall
		// back to copying notebook files into the workspace.
		throw new Error('local compute uses file copy, not bucket mount');
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// No-op: nothing was mounted.
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		await this.ensureRoot();

		// Map the logical port in the command (e.g. 2718) to a real free port so
		// concurrent sandboxes don't collide on the same host.
		const logicalMatch = cmd.match(/--port\s+(\d+)/);
		let command = this.prepareMarimoCmd(this.rewriteCmd(cmd));
		if (logicalMatch) {
			const logical = Number(logicalMatch[1]);
			const real = await allocatePort(this.bindHost, this.ports);
			this.portMap.set(logical, real);
			command = command.replace(/--port\s+\d+/, `--port ${real}`);
		}

		const cwd = options?.cwd ? this.mapPath(options.cwd) : this.root;
		await mkdir(cwd, { recursive: true });

		const child = spawn('sh', ['-c', command], {
			cwd,
			env: { ...process.env, ...this.env, ...options?.env },
			detached: true,
		});
		this.children.add(child);

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d) => (stdout += d.toString()));
		child.stderr?.on('data', (d) => (stderr += d.toString()));

		let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		child.on('exit', (code, signal) => {
			exitInfo = { code, signal };
			this.children.delete(child);
		});

		const portMap = this.portMap;
		const id = String(child.pid ?? `proc-${this.children.size}`);

		const proc: SandboxProcess = {
			id,
			command,
			async kill(signal?: string) {
				try {
					if (child.pid) process.kill(-child.pid, (signal as NodeJS.Signals) ?? 'SIGTERM');
				} catch {
					child.kill((signal as NodeJS.Signals) ?? 'SIGTERM');
				}
			},
			async waitForPort(port: number, opts?: WaitForPortOptions) {
				const real = portMap.get(port) ?? port;
				const timeout = opts?.timeout ?? 30_000;
				await pollUntilReady(
					() => {
						// A process that exited before the port opened is unrecoverable —
						// throw to abort the wait immediately (pollUntilReady won't retry).
						if (exitInfo) {
							throw new Error(
								`process exited (code ${exitInfo.code}) before port ${port} was ready.\n${stderr || stdout}`,
							);
						}
						return tcpReady(real);
					},
					{
						timeoutMs: timeout,
						intervalMs: 200,
						timeoutMessage: () =>
							`timed out waiting for port ${port} after ${timeout}ms.\n${stderr || stdout}`,
					},
				);
			},
			async getLogs() {
				return { stdout, stderr };
			},
		};
		return proc;
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		const real = this.portMap.get(port) ?? port;
		return { url: `http://${this.host}:${real}` };
	}

	async destroy(): Promise<void> {
		for (const child of this.children) {
			try {
				if (child.pid) process.kill(-child.pid, 'SIGKILL');
			} catch {
				child.kill('SIGKILL');
			}
		}
		this.children.clear();
		this.portMap.clear();
		await rm(this.root, { recursive: true, force: true });
	}
}

export class LocalCompute implements SandboxProvider {
	private readonly host: string;
	private readonly bindHost: string;
	private readonly ports?: PortRange;
	// The kernel child process lives in THIS Node process, so we must hand back
	// the same instance when the (stateless) API re-resolves a sandbox by id for
	// teardown — otherwise destroy() couldn't find the running kernel to kill it.
	private readonly instances = new Map<SandboxId, LocalSandboxInstance>();

	constructor(options?: LocalComputeOptions) {
		this.host = options?.host || 'localhost';
		this.bindHost = options?.bindHost || '127.0.0.1';
		this.ports = options?.ports;
	}

	create(id: SandboxId): SandboxInstance {
		let instance = this.instances.get(id);
		if (!instance) {
			instance = new LocalSandboxInstance(id, {
				host: this.host,
				bindHost: this.bindHost,
				ports: this.ports,
			});
			this.instances.set(id, instance);
		}
		return instance;
	}

	async proxy(): Promise<Response | null> {
		// The browser reaches the kernel directly at http://host:port; nothing to proxy.
		return null;
	}

	async listActive(): Promise<ActiveSandbox[]> {
		// A local sandbox is "live" only while its kernel child process is running;
		// a destroyed (or never-started) instance is dropped so the reconciler sees
		// the same truth the host process holds.
		const active: ActiveSandbox[] = [];
		for (const [id, instance] of this.instances) {
			if (instance.hasLiveChildren()) {
				active.push({ id, createdAt: instance.createdAt });
			}
		}
		return active;
	}
}

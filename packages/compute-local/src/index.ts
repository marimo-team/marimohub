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
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { Utf8TailBuffer } from '@marimo-hub/compute-commons/node';
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
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';

// Kernel processes can run for hours; diagnostics only need their recent output.
const OUTPUT_TAIL_CHARS = 64 * 1024;

function captureOutput(child: ChildProcess) {
	const stdout = new Utf8TailBuffer(OUTPUT_TAIL_CHARS);
	const stderr = new Utf8TailBuffer(OUTPUT_TAIL_CHARS);
	child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
	child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
	return { stdout, stderr };
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

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
 * Scan from `start` for the end of the current shell command, i.e. the first
 * top-level (outside single/double quotes) separator — `&&`, `||`, `|`, `;`, or
 * a backgrounding `&`. Returns `cmd.length` if none. Not a full shell parser:
 * it tracks quoting so an `&&` inside a quoted argument is not mistaken for a
 * separator, which is enough for the launch commands we rewrite.
 */
function commandSegmentEnd(cmd: string, start: number): number {
	let quote: '"' | "'" | null = null;
	for (let i = start; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ';' || ch === '|' || ch === '&') return i;
	}
	return cmd.length;
}

/**
 * Adjust a `uv run … marimo …` command for local execution. Pure (no `this`) so
 * the branchy rewrite logic is unit-testable:
 *  - inject `--with marimo` so marimo is available even if the notebook's
 *    pyproject.toml doesn't declare it (installed into an ephemeral env);
 *  - append `--host <bindHost>` when binding a non-default interface (Docker:
 *    0.0.0.0), so the kernel is reachable through the published port.
 * Commands without a `uv run` launch segment and already-configured ones pass
 * through unchanged.
 */
export function prepareMarimoCommand(cmd: string, bindHost: string): string {
	const uvRunPrefix = /(^|&&\s*)uv run (?=[^&]*\bmarimo\b)/;
	const match = uvRunPrefix.exec(cmd);
	if (!match) return cmd;
	// Localize edits to the launch segment (`uv run … marimo …`), which runs from
	// `uv run` to the next top-level separator (or end of string). Flags injected
	// outside it would land on an unrelated setup/teardown command.
	const launchStart = match.index + match[1].length;
	const launchEnd = commandSegmentEnd(cmd, launchStart);
	let segment = cmd.slice(launchStart, launchEnd);
	if (!segment.includes('--with marimo')) {
		segment = segment.replace(/^uv run /, 'uv run --with marimo ');
	}
	if (bindHost !== '127.0.0.1' && !segment.includes('--host')) {
		segment = segment.replace(/\s*$/, ` --host ${bindHost}$&`);
	}
	return cmd.slice(0, launchStart) + segment + cmd.slice(launchEnd);
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
	readonly supportsBucketMount = false;
	private readonly root: string;
	private readonly host: string;
	private readonly bindHost: string;
	private readonly ports?: PortRange;
	private readonly children = new Set<ChildProcess>();
	/** Logical port (as named in core, e.g. 2718) → real allocated host port. */
	private readonly portMap = new Map<number, number>();
	private readonly pendingWrites = new Set<Promise<unknown>>();
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};
	private destroyPromise?: Promise<void>;
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
		private readonly onDestroyed?: () => void,
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
		this.assertActive();
		await mkdir(this.root, { recursive: true });
		this.assertActive();
	}

	private assertActive(): void {
		if (this.destroyPromise) throw new Error('local sandbox has been destroyed');
	}

	private spawnShell(
		command: string,
		options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {},
	): ChildProcess {
		this.assertActive();
		// Spawn env entries are forced; guarded defaults defer to the inherited host env.
		return spawn('sh', ['-c', withEnvPrefix(command, {}, this.envDefaults)], {
			cwd: options.cwd ?? this.root,
			env: { ...process.env, ...this.env, ...options.env },
			detached: options.detached,
		});
	}

	private trackChild(child: ChildProcess): ChildProcess {
		this.children.add(child);
		const forget = () => this.children.delete(child);
		child.once('exit', forget);
		child.once('error', forget);
		return child;
	}

	async exec(cmd: string): Promise<ExecResult> {
		await this.ensureRoot();
		return new Promise((resolve) => {
			const child = this.trackChild(this.spawnShell(this.rewriteCmd(cmd), { detached: true }));
			const { stdout, stderr } = captureOutput(child);
			child.on('error', (err) => {
				resolve(
					execResult(false, stdout.toString(), stderr.toString() + String(err), 'SPAWN_FAILED'),
				);
			});
			child.on('close', (code) => {
				resolve(execResult(code === 0, stdout.toString(), stderr.toString()));
			});
		});
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		await this.ensureRoot();
		const child = this.trackChild(this.spawnShell(this.rewriteCmd(cmd), { detached: true }));
		// An undrained stderr pipe can fill and block the child before stdout completes.
		child.stderr?.resume();
		const stdout = child.stdout ?? Readable.from([]);
		stdout.once('close', () => {
			if (stdout.readableAborted) killProcessGroup(child, 'SIGKILL');
		});
		return Readable.toWeb(stdout) as ReadableStream;
	}

	async readFile(p: string): Promise<ReadFileResult> {
		try {
			const content = await readFile(this.mapPath(p), 'utf-8');
			return { success: true, content, encoding: 'utf-8' };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			return readFileFailure(code === 'ENOENT' || code === 'ENOTDIR' ? 'NOT_FOUND' : 'READ_FAILED');
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
			return listFilesFailure();
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		this.assertActive();
		// Local writes are cheap (no round-trip), so a plain bounded loop is enough.
		const pending = mapWithConcurrency(files, WRITE_CONCURRENCY, async (f) => {
			const abs = this.resolveContained(f.path);
			if (abs === null) {
				console.warn(`writeFiles: skipping path outside sandbox root: ${f.path}`);
				return;
			}
			await mkdir(path.dirname(abs), { recursive: true });
			// `encoding` applies to string content only; bytes are written verbatim.
			await writeFile(abs, f.content, typeof f.content === 'string' ? 'utf-8' : null);
		});
		this.pendingWrites.add(pending);
		try {
			await pending;
		} finally {
			this.pendingWrites.delete(pending);
		}
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		// shellQuote'd args (via buildGitCloneCommand) close the injection hole the
		// previous raw interpolation left open.
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
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
		this.assertActive();

		const child = this.trackChild(
			this.spawnShell(command, {
				cwd,
				env: options?.env,
				detached: true,
			}),
		);

		const { stdout, stderr } = captureOutput(child);

		let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		child.on('exit', (code, signal) => {
			exitInfo = { code, signal };
		});

		const portMap = this.portMap;
		const id = String(child.pid ?? `proc-${this.children.size}`);

		const proc: SandboxProcess = {
			id,
			command,
			async kill(signal?: string) {
				killProcessGroup(child, (signal as NodeJS.Signals) ?? 'SIGTERM');
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
								`process exited (code ${exitInfo.code}) before port ${port} was ready.\n${stderr.toString() || stdout.toString()}`,
							);
						}
						return tcpReady(real);
					},
					{
						timeoutMs: timeout,
						intervalMs: 200,
						timeoutMessage: () =>
							`timed out waiting for port ${port} after ${timeout}ms.\n${stderr.toString() || stdout.toString()}`,
					},
				);
			},
			async getLogs() {
				return { stdout: stdout.toString(), stderr: stderr.toString() };
			},
		};
		return proc;
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		const real = this.portMap.get(port) ?? port;
		return { url: `http://${this.host}:${real}` };
	}

	async destroy(): Promise<void> {
		if (this.destroyPromise) return this.destroyPromise;
		for (const child of this.children) killProcessGroup(child, 'SIGKILL');
		this.children.clear();
		this.portMap.clear();
		this.destroyPromise = Promise.allSettled(this.pendingWrites)
			.then(() => rm(this.root, { recursive: true, force: true }))
			.then(() => {
				this.onDestroyed?.();
			});
		return this.destroyPromise;
	}
}

export class LocalCompute implements SandboxProvider {
	private readonly host: string;
	private readonly bindHost: string;
	private readonly ports?: PortRange;
	// Re-resolution must return the same live instance so teardown can find its
	// child process; destroy evicts it so a later create gets fresh state.
	private readonly instances = new Map<SandboxId, LocalSandboxInstance>();
	private disposePromise?: Promise<void>;

	constructor(options?: LocalComputeOptions) {
		this.host = options?.host || 'localhost';
		this.bindHost = options?.bindHost || '127.0.0.1';
		this.ports = options?.ports;
	}

	create(id: SandboxId): SandboxInstance {
		if (this.disposePromise) throw new Error('local compute has been disposed');
		let instance = this.instances.get(id);
		if (!instance) {
			const next = new LocalSandboxInstance(
				id,
				{
					host: this.host,
					bindHost: this.bindHost,
					ports: this.ports,
				},
				() => {
					if (this.instances.get(id) === next) this.instances.delete(id);
				},
			);
			instance = next;
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

	private async destroyInstances(): Promise<void> {
		await Promise.all([...this.instances.values()].map((instance) => instance.destroy()));
	}

	[Symbol.asyncDispose](): Promise<void> {
		return (this.disposePromise ??= this.destroyInstances());
	}
}

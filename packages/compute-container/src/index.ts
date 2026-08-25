/**
 * Shared CLI container adapter used by the Docker and Podman compute providers.
 * State stays in the selected engine, so operations re-resolve containers by name
 * and teardown continues to work across server restarts.
 */
import { spawn } from 'node:child_process';
import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	classifyListFilesFailure,
	mapWithConcurrency,
	parseFindFilesOutput,
	pollUntilReady,
	shellQuote,
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { SandboxId } from '@marimo-hub/core';
import type {
	ActiveSandbox,
	ComputeResources,
	CreateSandboxOptions,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
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
	SetEnvVarsOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';

/** marimo's kernel port (matches SandboxProvisioner's MARIMO_PORT). */
const KERNEL_PORT = 2718;
const NAME_PREFIX = 'marimohub-sbx-';
const DEFAULT_LABEL_KEY = 'marimohub.sandbox';
const DEFAULT_IMAGE = 'ghcr.io/marimo-team/marimo:latest';
const EXEC_TIMEOUT_GRACE_MS = 100;
const EXEC_TIMEOUT_SUPERVISOR = `import os, signal, subprocess, sys
process = subprocess.Popen(['sh', '-lc', sys.argv[2]], start_new_session=True)
try:
	code = process.wait(timeout=float(sys.argv[1]) / 1000)
except subprocess.TimeoutExpired:
	os.killpg(process.pid, signal.SIGKILL)
	process.wait()
	code = 124
sys.exit(code)`;

export interface ContainerRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * The slice of a container CLI used by the adapter. Injecting it keeps tests
 * hermetic while production spawns the selected engine binary on PATH.
 */
export interface ContainerRunner {
	run(
		args: string[],
		options?: { stdin?: string | Uint8Array; timeout?: number },
	): Promise<ContainerRunResult>;
}

export function spawnContainerRunner(bin: string): ContainerRunner {
	return {
		run(args, options) {
			return new Promise((resolve) => {
				const child = spawn(bin, args);
				let stdout = '';
				let stderr = '';
				let timedOut = false;
				const timer =
					options?.timeout !== undefined && options.timeout > 0
						? setTimeout(() => {
								timedOut = true;
								child.kill('SIGKILL');
							}, options.timeout)
						: undefined;
				timer?.unref();
				child.stdout?.on('data', (d) => (stdout += d.toString()));
				child.stderr?.on('data', (d) => (stderr += d.toString()));
				child.on('error', (err) => {
					clearTimeout(timer);
					resolve({ stdout, stderr: stderr + String(err), exitCode: 127 });
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					resolve({
						stdout,
						stderr: timedOut
							? [stderr, `command timed out after ${options?.timeout}ms`].filter(Boolean).join('\n')
							: stderr,
						exitCode: timedOut ? 124 : (code ?? 1),
					});
				});
				if (options?.stdin !== undefined) {
					child.stdin?.end(options.stdin);
				} else {
					child.stdin?.end();
				}
			});
		},
	};
}

export interface ContainerConfig {
	/** Image with marimo + uv + python. Default `ghcr.io/marimo-team/marimo:latest`. */
	image?: string;
	/** Hostname the returned kernel URL points at (what the browser hits). Default `localhost`. */
	host?: string;
	/** Host interface the container port is published on. Default `127.0.0.1`. */
	bindHost?: string;
	/** Optional container network to attach sandboxes to. */
	network?: string;
	/** Label key used to tag + enumerate our containers. Default `marimohub.sandbox`. */
	labelKey?: string;
}

type ResolvedConfig = Required<Omit<ContainerConfig, 'network'>> &
	Pick<ContainerConfig, 'network'> & { engine: string };

export function containerResourceArgs(resources: ComputeResources = {}): string[] {
	return [
		...(resources.cpu !== undefined ? ['--cpus', String(resources.cpu)] : []),
		...(resources.memoryBytes !== undefined ? ['--memory', String(resources.memoryBytes)] : []),
	];
}

let procSeq = 0;

class ContainerSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private readonly name: string;
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};
	/** Cached host port for the published kernel port, once known. */
	private hostPort?: number;

	constructor(
		private readonly id: SandboxId,
		private readonly config: ResolvedConfig,
		private readonly runner: ContainerRunner,
		private readonly resources: ComputeResources,
	) {
		this.name = `${NAME_PREFIX}${id}`;
	}

	/** Ensure the container exists and is running; create it (idempotently) if not. */
	private async ensure(): Promise<void> {
		const inspect = await this.runner.run(['inspect', '-f', '{{.State.Running}}', this.name]);
		if (inspect.exitCode === 0 && inspect.stdout.trim() === 'true') return;

		// A stopped container with our name would make `run --name` fail — clear it.
		if (inspect.exitCode === 0) {
			await this.runner.run(['rm', '-f', this.name]);
		}

		const args = [
			'run',
			'-d',
			'--name',
			this.name,
			'--label',
			`${this.config.labelKey}=${this.id}`,
			// Publish the kernel port to an OS-assigned host port on bindHost.
			'-p',
			`${this.config.bindHost}::${KERNEL_PORT}`,
		];
		args.push(...containerResourceArgs(this.resources));
		if (this.config.network) args.push('--network', this.config.network);
		args.push(this.config.image, 'sleep', 'infinity');

		const res = await this.runner.run(args);
		if (res.exitCode !== 0) {
			throw new Error(
				`${this.config.engine} run failed for sandbox ${this.id}: ${res.stderr || res.stdout}`,
			);
		}
	}

	/** Prefix accumulated env vars onto a shell command. */
	private withEnv(cmd: string): string {
		return withEnvPrefix(cmd, this.env, this.envDefaults);
	}

	private async dexec(
		cmd: string,
		flags: string[] = [],
		options?: ExecOptions,
	): Promise<ContainerRunResult> {
		await this.ensure();
		const command =
			options?.timeout !== undefined && options.timeout > 0
				? [
						'python3',
						'-c',
						EXEC_TIMEOUT_SUPERVISOR,
						String(
							Math.max(1, options.timeout - Math.min(EXEC_TIMEOUT_GRACE_MS, options.timeout / 10)),
						),
						this.withEnv(cmd),
					]
				: ['sh', '-lc', this.withEnv(cmd)];
		return this.runner.run(['exec', ...flags, this.name, ...command], {
			timeout: options?.timeout,
		});
	}

	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const res = await this.dexec(cmd, [], options);
		return execResult(res.exitCode === 0, res.stdout, res.stderr);
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		// Best-effort: run to completion, then surface stdout as a single-chunk stream.
		const res = await this.exec(cmd);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(res.stdout));
				controller.close();
			},
		});
	}

	async readFile(path: string): Promise<ReadFileResult> {
		const res = await this.dexec(`cat ${shellQuote(path)}`);
		if (res.exitCode !== 0) return readFileFailure('READ_FAILED');
		return { success: true, content: res.stdout, encoding: 'utf-8' };
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		const res = await this.dexec(buildFindFilesCommand(path, options));
		if (res.exitCode !== 0) {
			return listFilesFailure(classifyListFilesFailure(res));
		}
		return { success: true, files: parseFindFilesOutput(res.stdout, path, options) };
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		await this.ensure();
		// One mkdir for every parent (deduped) instead of one per file, then stream
		// each payload to its file via stdin so arbitrary bytes (quotes, newlines,
		// non-UTF-8) are written verbatim rather than interpolated into the command.
		const dirs = new Set(files.map((f) => f.path.replace(/\/[^/]*$/, '') || '/'));
		const mk = await this.dexec(`mkdir -p ${[...dirs].map(shellQuote).join(' ')}`);
		if (mk.exitCode !== 0) {
			throw new Error(`writeFiles mkdir failed: ${mk.stderr || mk.stdout}`);
		}
		await mapWithConcurrency(files, WRITE_CONCURRENCY, async (f) => {
			const res = await this.runner.run(
				['exec', '-i', this.name, 'sh', '-c', `cat > ${shellQuote(f.path)}`],
				{ stdin: f.content },
			);
			if (res.exitCode !== 0) {
				throw new Error(`writeFile failed for ${f.path}: ${res.stderr || res.stdout}`);
			}
		});
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
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
		// No FUSE mount — throwing makes SandboxProvisioner fall back to copying
		// notebook files in/out (the intended path, like local/modal/coreweave).
		throw new Error(`${this.config.engine} compute uses file copy, not bucket mount`);
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// No-op: nothing was mounted.
	}

	/** Read the OS-assigned host port mapped to the container's kernel port. */
	private async resolveHostPort(): Promise<number> {
		if (this.hostPort) return this.hostPort;
		const res = await this.runner.run(['port', this.name, `${KERNEL_PORT}/tcp`]);
		if (res.exitCode !== 0) {
			throw new Error(
				`${this.config.engine} port failed for ${this.name}: ${res.stderr || res.stdout}`,
			);
		}
		// Output lines look like `0.0.0.0:49153` / `[::]:49153`; take the first port.
		const match = res.stdout.match(/:(\d+)\s*$/m);
		if (!match) throw new Error(`could not parse host port from: ${res.stdout}`);
		this.hostPort = Number(match[1]);
		return this.hostPort;
	}

	/** True once a process inside the container is listening on 127.0.0.1:port. */
	private async probePort(port: number): Promise<boolean> {
		// python3 ships in the marimo image (it's required to run marimo); mirrors
		// the CoreWeave adapter's in-sandbox probe.
		const probe =
			`python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); ` +
			`sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)"`;
		return (await this.dexec(probe)).exitCode === 0;
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		await this.ensure();
		const logPath = `/tmp/marimohub-proc-${++procSeq}.log`;
		// Run detached inside the container; redirect to a log file we can tail.
		// `sh -lc` has no cwd flag, so cd into the working dir first when requested.
		const prefix = options?.cwd ? `cd ${shellQuote(options.cwd)} && ` : '';
		const res = await this.dexec(`${prefix}${cmd} > ${logPath} 2>&1 &`, ['-d']);
		if (res.exitCode !== 0) {
			throw new Error(`startProcess failed: ${res.stderr || res.stdout}`);
		}
		const probeInside = (port: number) => this.probePort(port);
		const readLogs = () => this.dexec(`cat ${logPath} 2>/dev/null || true`);
		const id = `${this.config.engine}-proc-${procSeq}`;
		const containerName = this.name;
		const runner = this.runner;

		return {
			id,
			command: cmd,
			async kill(_signal?: string): Promise<void> {
				// No tracked PID for a detached exec; best-effort kill of the kernel.
				await runner.run(['exec', containerName, 'pkill', '-f', 'marimo']).catch(() => {});
			},
			async waitForPort(port: number, opts?: WaitForPortOptions): Promise<void> {
				const timeout = opts?.timeout ?? 30_000;
				// Probe inside the container because a port forwarder may accept host
				// connections before the application has bound its container port.
				await pollUntilReady(() => probeInside(port), {
					timeoutMs: timeout,
					intervalMs: 500,
					timeoutMessage: async () =>
						`timed out waiting for port ${port} after ${timeout}ms.\n${(await readLogs()).stdout}`,
				});
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				const logs = await readLogs();
				return { stdout: logs.stdout, stderr: '' };
			},
		};
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		const hostPort = port === KERNEL_PORT ? await this.resolveHostPort() : port;
		return { url: `http://${this.config.host}:${hostPort}` };
	}

	async destroy(): Promise<void> {
		await this.runner.run(['rm', '-f', '-v', this.name]);
		this.hostPort = undefined;
	}
}

export class ContainerCompute implements SandboxProvider {
	private readonly config: ResolvedConfig;

	constructor(
		engine: string,
		config: ContainerConfig = {},
		private readonly runner: ContainerRunner = spawnContainerRunner(engine),
	) {
		this.config = {
			engine,
			image: config.image || DEFAULT_IMAGE,
			host: config.host || 'localhost',
			bindHost: config.bindHost || '127.0.0.1',
			labelKey: config.labelKey || DEFAULT_LABEL_KEY,
			network: config.network,
		};
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		const config = options?.image ? { ...this.config, image: options.image } : this.config;
		return new ContainerSandboxInstance(id, config, this.runner, options?.resources ?? {});
	}

	async proxy(_request: Request): Promise<Response | null> {
		// The browser reaches the kernel directly at http://host:port; nothing to proxy.
		return null;
	}

	async healthCheck(): Promise<void> {
		const res = await this.runner.run(['info']);
		if (res.exitCode === 0) return;

		const detail = (res.stderr || res.stdout).trim();
		// spawnContainerRunner collapses every spawn failure to exit 127, so key off the OS
		// error in stderr instead: ENOENT is a missing binary, EACCES one that can't execute.
		// "not reachable" stays engine-neutral (Podman is daemonless in the common setup).
		if (/\bENOENT\b/.test(detail)) {
			throw new Error(`${this.config.engine} CLI is not installed or is not on PATH`);
		}
		if (/\bEACCES\b/.test(detail)) {
			throw new Error(`${this.config.engine} CLI is not executable (permission denied)`);
		}
		throw new Error(`${this.config.engine} is not reachable${detail ? `: ${detail}` : ''}`);
	}

	async listActive(): Promise<ActiveSandbox[]> {
		const res = await this.runner.run([
			'ps',
			'--filter',
			`label=${this.config.labelKey}`,
			'--format',
			'{{.Names}}',
		]);
		if (res.exitCode !== 0) return [];
		const active: ActiveSandbox[] = [];
		for (const name of res.stdout.split('\n')) {
			const trimmed = name.trim();
			if (trimmed.startsWith(NAME_PREFIX)) {
				const id = trimmed.slice(NAME_PREFIX.length);
				if (SandboxId.is(id)) active.push({ id });
			}
		}
		return active;
	}
}

/**
 * Shared CLI container adapter used by the Docker and Podman compute providers.
 * State stays in the selected engine, so operations re-resolve containers by name
 * and teardown continues to work across server restarts.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { START_PROCESS, KILL_PROCESS } from './process';
import {
	readBoundedFile,
	buildFindFilesCommand,
	buildGitCloneCommand,
	buildLaunchCommand,
	classifyListFilesFailure,
	LAUNCH_MARKER_GRACE_MS,
	launchOutcomeResult,
	launchTimeoutResult,
	mapWithConcurrency,
	parseLaunchOutput,
	parseFindFilesOutput,
	pollUntilReady,
	removeUndefined,
	setupCompleteMarker,
	shellQuote,
	transportFailureResult,
	ShellEnvironment,
	privateEnvironmentWriteCommand,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { SandboxId } from '@marimo-hub/core/ids';
import type {
	BoundedReadOptions,
	ActiveSandbox,
	ComputeResources,
	CreateSandboxOptions,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	GitCheckoutOptions,
	LaunchProcessOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxLaunchResult,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	StartProcessOptions,
	SetEnvVarsOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports/sandbox';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports/sandbox';

/** marimo's kernel port (matches SandboxProvisioner's MARIMO_PORT). */
const KERNEL_PORT = 2718;
const NAME_PREFIX = 'marimohub-sbx-';
const SANDBOX_LABEL = 'marimohub.sandbox';
const OWNER_LABEL = 'marimohub.owner';
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
const LAUNCH_LOG_WAITER = `import sys, time
path, prefix, timeout_arg = sys.argv[1:]
timeout = float(timeout_arg) / 1000
deadline = None if timeout == 0 else time.monotonic() + timeout
terminal_events = ("ready", "setup_exit", "setup_timeout", "kernel_exit", "readiness_timeout")
while True:
    try:
        with open(path, errors="replace") as launch_log:
            data = launch_log.read()
    except FileNotFoundError:
        data = ""
    if any(prefix + '{"event":"' + event + '"' in data for event in terminal_events):
        sys.stdout.write(data)
        sys.exit(0)
    if deadline is not None and time.monotonic() >= deadline:
        sys.stdout.write(data)
        sys.exit(124)
    time.sleep(0.05)`;

export interface ContainerRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface ContainerSandboxProcess extends SandboxProcess {
	waitForLaunch(nonce: string, timeoutMs: number): Promise<ContainerRunResult>;
}

/**
 * The slice of a container CLI used by the adapter. Injecting it keeps tests
 * hermetic while production spawns the selected engine binary on PATH.
 */
export interface ContainerRunner {
	run(
		args: string[],
		options?: { stdin?: string | Uint8Array; timeout?: number; maxOutputBytes?: number },
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
				let bytes = 0;
				let overflow = false;
				const append = (chunk: Buffer, output: 'stdout' | 'stderr') => {
					if (overflow || timedOut) return;
					bytes += chunk.length;
					if (options?.maxOutputBytes !== undefined && bytes > options.maxOutputBytes) {
						overflow = true;
						child.kill('SIGKILL');
						return;
					}
					if (output === 'stdout') stdout += chunk.toString();
					else stderr += chunk.toString();
				};
				child.stdout?.on('data', (d) => append(d, 'stdout'));
				child.stderr?.on('data', (d) => append(d, 'stderr'));
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
						exitCode: timedOut || overflow ? 124 : (code ?? 1),
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
	/** Secondary ports to publish when creating each container. */
	surfacePorts?: readonly number[];
	/**
	 * Labels containers `marimohub.owner=<tag>` and scopes discovery to it, so hubs
	 * sharing a daemon never reap each other's sandboxes. Unset keeps the untagged
	 * pre-owner behaviour, which sees every hub's sandboxes.
	 */
	ownerTag?: string;
}

type ResolvedConfig = Required<Omit<ContainerConfig, 'network' | 'ownerTag'>> &
	Pick<ContainerConfig, 'network' | 'ownerTag'> & { engine: string };

export function containerResourceArgs(resources: ComputeResources = {}): string[] {
	return [
		...(resources.cpu !== undefined ? ['--cpus', String(resources.cpu)] : []),
		...(resources.memoryBytes !== undefined ? ['--memory', String(resources.memoryBytes)] : []),
	];
}

function isTcpPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

let procSeq = 0;

class ContainerSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private readonly name: string;
	private readonly hostPorts = new Map<number, number>();

	constructor(
		private readonly id: SandboxId,
		private readonly config: ResolvedConfig,
		private readonly runner: ContainerRunner,
		private readonly resources: ComputeResources,
		private readonly existingOnly = false,
	) {
		this.name = `${NAME_PREFIX}${id}`;
	}

	/** Ensure the container exists and is running; create it (idempotently) if not. */
	private async ensure(): Promise<void> {
		const inspect = await this.runner.run(['inspect', '-f', '{{.State.Running}}', this.name]);
		if (inspect.exitCode === 0 && inspect.stdout.trim() === 'true') return;
		if (this.existingOnly) {
			throw new Error(`Existing sandbox ${this.id} is not running or cannot be inspected`);
		}

		this.environment.invalidate();
		this.hostPorts.clear();

		// A stopped container with our name would make `run --name` fail — clear it.
		if (inspect.exitCode === 0) {
			await this.runner.run(['rm', '-f', this.name]);
		}

		const args = [
			'run',
			'-d',
			// Reap detached editor processes so surface stop checks do not see zombies.
			'--init',
			'--name',
			this.name,
			'--label',
			`${SANDBOX_LABEL}=${this.id}`,
			...(this.config.ownerTag ? ['--label', `${OWNER_LABEL}=${this.config.ownerTag}`] : []),
			...[KERNEL_PORT, ...this.config.surfacePorts].flatMap((port) => [
				'-p',
				`${this.config.bindHost}::${port}`,
			]),
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

	private readonly environment = new ShellEnvironment(async (path, content) => {
		const result = await this.runner.run(
			['exec', '-i', this.name, 'sh', '-c', privateEnvironmentWriteCommand(path)],
			{ stdin: content, timeout: 10_000, maxOutputBytes: 64 * 1024 },
		);
		if (result.exitCode !== 0) throw new Error('Could not prepare sandbox environment');
	});

	private async dexec(
		cmd: string,
		flags: string[] = [],
		options?: ExecOptions,
		prepared = false,
	): Promise<ContainerRunResult> {
		await this.ensure();
		const script = prepared ? cmd : await this.environment.command(cmd);
		const command =
			options?.timeout !== undefined && options.timeout > 0
				? [
						'python3',
						'-c',
						EXEC_TIMEOUT_SUPERVISOR,
						String(
							Math.max(1, options.timeout - Math.min(EXEC_TIMEOUT_GRACE_MS, options.timeout / 10)),
						),
						script,
					]
				: ['sh', '-lc', script];
		return this.runner.run(['exec', ...flags, this.name, ...command], {
			timeout: options?.timeout,
			maxOutputBytes: options?.maxOutputBytes,
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

	async readFileBounded(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		return readBoundedFile(path, options, (command, limits) => this.exec(command, limits));
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
		this.environment.setEnvVars(vars, options);
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// No FUSE mount — throwing makes SandboxProvisioner fall back to copying
		// notebook files in/out (the intended path, like local/modal/coreweave).
		throw new Error(`${this.config.engine} compute uses file copy, not bucket mount`);
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// No-op: nothing was mounted.
	}

	private async resolveHostPort(port: number): Promise<number> {
		const cached = this.hostPorts.get(port);
		if (cached !== undefined) return cached;
		const res = await this.runner.run(['port', this.name, `${port}/tcp`]);
		if (res.exitCode !== 0) {
			throw new Error(
				`${this.config.engine} port failed for ${this.name}: ${res.stderr || res.stdout}`,
			);
		}
		// Output lines look like `0.0.0.0:49153` / `[::]:49153`; take the first port.
		const match = res.stdout.match(/:(\d+)\s*$/m);
		const hostPort = Number(match?.[1]);
		if (!isTcpPort(hostPort)) throw new Error(`could not parse host port from: ${res.stdout}`);
		this.hostPorts.set(port, hostPort);
		return hostPort;
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

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<ContainerSandboxProcess> {
		await this.ensure();
		const processPath = `/tmp/marimohub-proc-${randomUUID()}`;
		const logPath = `${processPath}.log`;
		const pidPath = `${processPath}.pid`;
		const prefix = options?.cwd ? `cd ${shellQuote(options.cwd)} && ` : '';
		const processCommand = await this.environment.command(cmd, removeUndefined(options?.env ?? {}));
		const launch = ['python3', '-c', START_PROCESS, pidPath, logPath, `${prefix}${processCommand}`]
			.map(shellQuote)
			.join(' ');
		const res = await this.dexec(launch, [], undefined, true);
		if (res.exitCode !== 0) {
			throw new Error(`startProcess failed: ${res.stderr || res.stdout}`);
		}
		const probeInside = (port: number) => this.probePort(port);
		const readLogs = () => this.dexec(`cat ${logPath} 2>/dev/null || true`);
		const waitForLaunch = (nonce: string, timeoutMs: number) =>
			this.dexec(
				[
					'python3',
					'-c',
					LAUNCH_LOG_WAITER,
					logPath,
					`__MARIMOHUB_LAUNCH_${nonce}__`,
					String(timeoutMs),
				]
					.map(shellQuote)
					.join(' '),
			);
		const id = options?.processId ?? `${this.config.engine}-proc-${++procSeq}`;
		const containerName = this.name;
		const runner = this.runner;

		return {
			id,
			command: cmd,
			async kill(signal = 'SIGTERM'): Promise<void> {
				const result = await runner.run([
					'exec',
					containerName,
					'python3',
					'-c',
					KILL_PROCESS,
					pidPath,
					signal,
				]);
				if (result.exitCode !== 0) {
					throw new Error(`Could not stop sandbox process: ${result.stderr || result.stdout}`);
				}
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
			waitForLaunch,
		};
	}

	async launchProcess(cmd: string, options: LaunchProcessOptions): Promise<SandboxLaunchResult> {
		const built = buildLaunchCommand({
			setup: options.setup,
			command: cmd,
			port: options.port,
			startupTimeout: options.startupTimeout,
		});
		const launchStarted = Date.now();
		let process: ContainerSandboxProcess;
		try {
			process = await this.startProcess(built.command, {
				cwd: options.cwd,
				env: options.env,
				processId: options.processId,
			});
		} catch (error) {
			return transportFailureResult(error, {
				setup: 0,
				start: Math.max(0, Date.now() - launchStarted),
				waitport: 0,
			});
		}

		const start = Math.max(0, Date.now() - launchStarted);
		const waitStarted = Date.now();
		const waitTimeout =
			options.startupTimeout === 0
				? 0
				: Math.max(0, options.startupTimeout - start) + LAUNCH_MARKER_GRACE_MS;
		let waited: ContainerRunResult;
		try {
			waited = await process.waitForLaunch(built.nonce, waitTimeout);
		} catch (error) {
			await process.kill().catch(() => {});
			return transportFailureResult(error, {
				setup: 0,
				start,
				waitport: Math.max(0, Date.now() - waitStarted),
			});
		}

		const parsed = parseLaunchOutput({ stdout: waited.stdout, stderr: '' }, built.nonce);
		const terminal = parsed.outcome;
		if (terminal?.kind === 'ready') {
			return {
				success: true,
				timings: { setup: terminal.setupMs, start, waitport: terminal.waitportMs },
				process: {
					id: process.id,
					command: cmd,
					kill: (signal) => process.kill(signal),
					waitForPort: (port, waitOptions) =>
						port === options.port ? Promise.resolve() : process.waitForPort(port, waitOptions),
					async getLogs() {
						const logs = parseLaunchOutput(await process.getLogs(), built.nonce);
						return { stdout: logs.stdout, stderr: logs.stderr };
					},
				},
			};
		}
		if (terminal) {
			return launchOutcomeResult(terminal.kind, terminal, parsed, start);
		}

		await process.kill().catch(() => {});
		if (waited.exitCode !== 124) {
			return {
				success: false,
				reason: 'transport_failure',
				stdout: parsed.stdout,
				stderr: [parsed.stderr, waited.stderr || 'launch monitor exited without a terminal marker']
					.filter(Boolean)
					.join('\n'),
				timings: { setup: 0, start, waitport: Math.max(0, Date.now() - waitStarted) },
			};
		}

		return launchTimeoutResult({
			setup: Boolean(options.setup),
			setupCompleted: waited.stdout.includes(setupCompleteMarker(built.nonce)),
			startupTimeout: options.startupTimeout,
			output: parsed,
			start,
			waitport: Math.max(0, Date.now() - waitStarted),
		});
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		if (port !== KERNEL_PORT && !this.config.surfacePorts.includes(port)) {
			throw new Error(`${this.config.engine} sandbox port ${port} was not reserved at creation`);
		}
		const hostPort = await this.resolveHostPort(port);
		return { url: `http://${this.config.host}:${hostPort}` };
	}

	async destroy(): Promise<void> {
		const result = await this.runner.run(['rm', '-f', '-v', this.name]);
		if (result.exitCode !== 0 && !/\bno such container\b/i.test(result.stderr)) {
			throw new Error(
				`${this.config.engine} remove failed for sandbox ${this.id}: ${result.stderr || result.stdout}`,
			);
		}
		this.hostPorts.clear();
	}
}

export class ContainerCompute implements SandboxProvider {
	readonly capabilities: { multiPort: boolean };
	private readonly config: ResolvedConfig;

	constructor(
		engine: string,
		config: ContainerConfig = {},
		private readonly runner: ContainerRunner = spawnContainerRunner(engine),
	) {
		const surfacePorts = [...new Set(config.surfacePorts ?? [])].filter(
			(port) => port !== KERNEL_PORT,
		);
		for (const port of surfacePorts) {
			if (!isTcpPort(port)) {
				throw new Error(`Invalid ${engine} surface port: ${port}`);
			}
		}
		this.capabilities = { multiPort: surfacePorts.length > 0 };
		this.config = {
			engine,
			image: config.image || DEFAULT_IMAGE,
			host: config.host || 'localhost',
			bindHost: config.bindHost || '127.0.0.1',
			network: config.network,
			surfacePorts,
			ownerTag: config.ownerTag || undefined,
		};
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		const config = options?.image ? { ...this.config, image: options.image } : this.config;
		return new ContainerSandboxInstance(id, config, this.runner, options?.resources ?? {});
	}

	connectExisting(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return new ContainerSandboxInstance(
			id,
			this.config,
			this.runner,
			options?.resources ?? {},
			true,
		);
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
			`label=${SANDBOX_LABEL}`,
			...(this.config.ownerTag ? ['--filter', `label=${OWNER_LABEL}=${this.config.ownerTag}`] : []),
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

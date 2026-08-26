import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
	ModalClient,
	NotFoundError as ModalNotFoundError,
	SandboxFilesystemNotADirectoryError,
} from 'modal';
import {
	buildLaunchCommand,
	buildGitCloneCommand,
	errorMessage,
	LAUNCH_MARKER_GRACE_MS,
	launchOutcomeResult,
	launchTimeoutResult,
	mapWithConcurrency,
	OutputTail,
	parseLaunchOutput,
	setupCompleteMarker,
	shellQuote,
	transportFailureResult,
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import type { LaunchProtocolOutcome } from '@marimo-hub/compute-commons';
import { NotFoundError, SandboxId } from '@marimo-hub/core';
import type {
	ActiveSandbox,
	ComputeResources,
	CreateSandboxOptions,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	FileInfo,
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
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';

export interface ModalConfig {
	tokenId: string;
	tokenSecret: string;
	/** Registry image containing marimo, uv, and Python. */
	image: string;
	/** Modal API endpoint override. */
	apiBase?: string;
	/** Modal environment that contains the app and sandboxes. */
	environment?: string;
	/** Modal app name that owns the sandboxes. */
	appName?: string;
	/** Provider-side fallback, set later than marimohub's graceful idle deadline. */
	idleFallbackMs?: number;
}

export interface ModalProcessLike {
	stdout: ReadableStream<string>;
	stderr: ReadableStream<string>;
	wait(): Promise<number>;
}

export interface ModalFileInfoLike {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'symlink';
	size: number;
}

export interface ModalSandboxLike {
	filesystem: {
		readText(path: string): Promise<string>;
		writeText(content: string, path: string): Promise<void>;
		writeBytes(content: Uint8Array, path: string): Promise<void>;
		listFiles(path: string): Promise<ModalFileInfoLike[]>;
	};
	exec(
		command: string[],
		options?: {
			mode?: 'text';
			workdir?: string;
			timeoutMs?: number;
			env?: Record<string, string>;
			pty?: boolean;
		},
	): Promise<ModalProcessLike>;
	getTags(): Promise<Record<string, string>>;
	terminate(): Promise<void>;
	tunnels(timeoutMs?: number): Promise<Record<number, { url: string }>>;
}

export interface ModalClientLike {
	apps: {
		fromName(name: string, options?: { createIfMissing?: boolean }): Promise<{ appId: string }>;
	};
	images: {
		fromRegistry(image: string): unknown;
	};
	sandboxes: {
		create(
			app: unknown,
			image: unknown,
			options: {
				name: string;
				command: string[];
				tags: Record<string, string>;
				encryptedPorts: number[];
				timeoutMs: number;
				idleTimeoutMs?: number;
				cpu?: number;
				memoryMiB?: number;
				gpu?: string;
			},
		): Promise<ModalSandboxLike>;
		fromName(appName: string, name: string): Promise<ModalSandboxLike>;
		list(options: { appId: string; tags: Record<string, string> }): AsyncIterable<ModalSandboxLike>;
	};
}

const DEFAULT_APP_NAME = 'marimohub';
const KERNEL_PORT = 2718;
const MAX_SANDBOX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const OWNER_TAG = 'marimohub.owner';
const SANDBOX_ID_TAG = 'marimohub.sandbox-id';

export function modalProfileResources(resources: ComputeResources | undefined): {
	cpu?: number;
	memoryMiB?: number;
	gpu?: string;
} {
	return {
		...(resources?.cpu !== undefined ? { cpu: resources.cpu } : {}),
		...(resources?.memoryBytes !== undefined
			? { memoryMiB: Math.ceil(resources.memoryBytes / 1024 ** 2) }
			: {}),
		...(resources?.gpu !== undefined ? { gpu: resources.gpu } : {}),
	};
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof ModalNotFoundError ||
		(error instanceof Error && error.name === 'NotFoundError')
	);
}

function isNotADirectory(error: unknown): boolean {
	return (
		error instanceof SandboxFilesystemNotADirectoryError ||
		(error instanceof Error && error.name === 'SandboxFilesystemNotADirectoryError')
	);
}

function definedEnv(
	values: Record<string, string | undefined> | undefined,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values ?? {}).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
	const reader = stream.getReader();
	let output = '';
	for (;;) {
		const next = await reader.read();
		if (next.done) return output;
		output += next.value;
	}
}

async function consumeStream(
	stream: ReadableStream<string>,
	onChunk: (chunk: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	for (;;) {
		const next = await reader.read();
		if (next.done) return;
		onChunk(next.value);
	}
}

async function runProcess(process: ModalProcessLike): Promise<ExecResult> {
	const [stdout, stderr, exitCode] = await Promise.all([
		readStream(process.stdout),
		readStream(process.stderr),
		process.wait(),
	]);
	return execResult(exitCode === 0, stdout, stderr);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

let processSequence = 0;

class ModalLaunchTimeoutError extends Error {
	override readonly name = 'ModalLaunchTimeoutError';
}

class ModalSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private sandboxPromise?: Promise<ModalSandboxLike>;
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};

	constructor(
		private readonly id: SandboxId,
		private readonly config: ModalConfig,
		private readonly client: ModalClientLike,
		private readonly resources: ReturnType<typeof modalProfileResources>,
		private readonly reuse: boolean,
	) {}

	private createSandbox(): Promise<ModalSandboxLike> {
		const appName = this.config.appName ?? DEFAULT_APP_NAME;
		return this.client.apps.fromName(appName, { createIfMissing: true }).then((app) =>
			this.client.sandboxes.create(app, this.client.images.fromRegistry(this.config.image), {
				name: this.id,
				// Pin an idle main process. With no command the SDK sends empty
				// entrypointArgs and Modal boots the image's ENTRYPOINT — a marimo
				// that grabs the kernel port before the provisioner's `setup && start`
				// exec, which then rewrites /opt/venv under the live server (#103).
				command: ['sleep', 'infinity'],
				tags: {
					[OWNER_TAG]: appName,
					[SANDBOX_ID_TAG]: this.id,
				},
				encryptedPorts: [KERNEL_PORT],
				timeoutMs: MAX_SANDBOX_LIFETIME_MS,
				...(this.config.idleFallbackMs !== undefined
					? { idleTimeoutMs: this.config.idleFallbackMs }
					: {}),
				...this.resources,
			}),
		);
	}

	private getSandbox(createIfMissing = true): Promise<ModalSandboxLike> {
		if (this.sandboxPromise) return this.sandboxPromise;
		if (!this.reuse) {
			if (!createIfMissing) {
				return Promise.reject(new NotFoundError(`Sandbox ${this.id} was not created`));
			}
			this.sandboxPromise = this.createSandbox();
			return this.sandboxPromise;
		}

		const appName = this.config.appName ?? DEFAULT_APP_NAME;
		this.sandboxPromise = this.client.sandboxes.fromName(appName, this.id).catch((error) => {
			if (createIfMissing && isNotFound(error)) return this.createSandbox();
			throw error;
		});
		return this.sandboxPromise;
	}

	private async spawn(
		command: string[],
		options?: {
			cwd?: string;
			env?: Record<string, string | undefined>;
			timeout?: number;
			pty?: boolean;
		},
	): Promise<ModalProcessLike> {
		const sandbox = await this.getSandbox();
		return sandbox.exec(command, {
			mode: 'text',
			...(options?.cwd ? { workdir: options.cwd } : {}),
			...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
			env: { ...this.env, ...definedEnv(options?.env) },
			...(options?.pty ? { pty: true } : {}),
		});
	}

	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		return runProcess(
			await this.spawn(['sh', '-lc', this.withDefaults(cmd)], { timeout: options?.timeout }),
		);
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		const process = await this.spawn(['sh', '-lc', this.withDefaults(cmd)], {
			timeout: options?.timeout,
		});
		void readStream(process.stderr).catch(() => {});
		void process.wait().catch(() => {});
		return process.stdout;
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const content = await (await this.getSandbox()).filesystem.readText(path);
			return { success: true, content, encoding: 'utf-8' };
		} catch {
			return readFileFailure('READ_FAILED');
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const filesystem = (await this.getSandbox()).filesystem;
		await mapWithConcurrency(files, WRITE_CONCURRENCY, async (file) => {
			if (typeof file.content === 'string') {
				await filesystem.writeText(file.content, file.path);
			} else {
				await filesystem.writeBytes(file.content, file.path);
			}
		});
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		try {
			const filesystem = (await this.getSandbox()).filesystem;
			const files: FileInfo[] = [];
			const visit = async (directory: string): Promise<void> => {
				for (const file of await filesystem.listFiles(directory)) {
					if (!options?.includeHidden && file.name.startsWith('.')) continue;
					files.push({
						name: file.name,
						absolutePath: file.path,
						relativePath: posix.relative(path, file.path),
						type: file.type,
						size: file.size,
					});
					if (options?.recursive && file.type === 'directory') await visit(file.path);
				}
			};
			await visit(path);
			return { success: true, files };
		} catch (error) {
			return listFilesFailure(isNotADirectory(error) ? 'NOT_A_DIRECTORY' : 'BACKEND_ERROR');
		}
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const result = await this.exec(buildGitCloneCommand(repo, options));
		if (!result.success) throw new Error(`git checkout failed: ${result.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
	}

	// Forced vars ride the exec `env` option; defaults can't (that channel always
	// overwrites), so they go in as a guarded shell prefix instead.
	private withDefaults(cmd: string): string {
		return withEnvPrefix(cmd, {}, this.envDefaults);
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		throw new Error('mountBucket is not supported on the Modal backend; using file copy fallback');
	}

	async unmountBucket(_mountPath: string): Promise<void> {}

	private async startProcessWithOutput(
		cmd: string,
		options?: StartProcessOptions,
		onOutput?: (logs: { stdout: string; stderr: string }) => void,
	): Promise<{ process: SandboxProcess; completed: Promise<void> }> {
		const pidPath = `/tmp/marimohub-process-${randomUUID()}.pid`;
		const trackedCommand = [
			'stat=$(cat /proc/$$/stat)',
			'stat=${stat##*) }',
			'set -- $stat',
			`printf '%s %s\\n' "$$" "\${20}" > ${shellQuote(pidPath)}`,
			`exec sh -lc ${shellQuote(cmd)}`,
		].join('; ');
		const modalProcess = await this.spawn(['sh', '-lc', this.withDefaults(trackedCommand)], {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
		});
		const stdoutTail = new OutputTail();
		const stderrTail = new OutputTail();
		let exitCode: number | undefined;
		let settled = false;
		const execInSandbox = (command: string) => this.exec(command);
		const stdoutDone = consumeStream(modalProcess.stdout, (chunk) => {
			stdoutTail.append(chunk);
			onOutput?.({ stdout: stdoutTail.text, stderr: stderrTail.text });
		});
		const stderrDone = consumeStream(modalProcess.stderr, (chunk) => {
			stderrTail.append(chunk);
			onOutput?.({ stdout: stdoutTail.text, stderr: stderrTail.text });
		});
		const exited = modalProcess
			.wait()
			.then((code) => {
				exitCode = code;
				return code;
			})
			.finally(() => {
				settled = true;
				void execInSandbox(`rm -f ${shellQuote(pidPath)}`).catch(() => {});
			});
		const completed = Promise.all([stdoutDone, stderrDone, exited]).then(() => {});

		const sandboxProcess: SandboxProcess = {
			id: options?.processId ?? `modal-process-${++processSequence}`,
			command: cmd,
			async kill(signal?: string): Promise<void> {
				if (settled) return;
				const normalized = /^SIG[A-Z0-9]+$/.test(signal ?? '') ? signal!.slice(3) : 'TERM';
				await execInSandbox(
					`read -r pid started < ${shellQuote(pidPath)} && ` +
						`case "$pid" in ''|*[!0-9]*) exit 1;; esac && ` +
						`case "$started" in ''|*[!0-9]*) exit 1;; esac && ` +
						`stat=$(cat "/proc/$pid/stat" 2>/dev/null) && ` +
						`stat=\${stat##*) } && ` +
						`set -- $stat && ` +
						`[ "\${20}" = "$started" ] && ` +
						`kill -${normalized} -- "$pid"`,
				).catch(() => {});
			},
			async waitForPort(port: number, waitOptions?: WaitForPortOptions): Promise<void> {
				const timeout = waitOptions?.timeout ?? 30_000;
				const deadline = Date.now() + timeout;
				while (Date.now() < deadline) {
					if (exitCode !== undefined) {
						await Promise.allSettled([stdoutDone, stderrDone]);
						throw new Error(
							`process exited (code ${exitCode}) before port ${port} was ready.\n${stderrTail.text || stdoutTail.text}`,
						);
					}
					const probe = await execInSandbox(
						`python -c ${shellQuote(
							`import socket; s=socket.create_connection(('127.0.0.1', ${port}), 1); s.close()`,
						)}`,
					);
					if (probe.success) return;
					await delay(250);
				}
				throw new Error(
					`timed out waiting for port ${port} after ${timeout}ms.\n${stderrTail.text || stdoutTail.text}`,
				);
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				if (exitCode !== undefined) await completed.catch(() => {});
				return { stdout: stdoutTail.text, stderr: stderrTail.text };
			},
		};
		return { process: sandboxProcess, completed };
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		return (await this.startProcessWithOutput(cmd, options)).process;
	}

	async launchProcess(cmd: string, options: LaunchProcessOptions): Promise<SandboxLaunchResult> {
		const built = buildLaunchCommand({
			setup: options.setup,
			command: cmd,
			port: options.port,
			startupTimeout: options.startupTimeout,
		});
		const launchStarted = Date.now();
		let settled = false;
		let resolveOutcome!: (outcome: LaunchProtocolOutcome) => void;
		let rejectOutcome!: (error: unknown) => void;
		const outcome = new Promise<LaunchProtocolOutcome>((resolve, reject) => {
			resolveOutcome = resolve;
			rejectOutcome = reject;
		});
		const inspect = (logs: { stdout: string; stderr: string }) => {
			if (settled) return;
			const terminal = parseLaunchOutput(logs, built.nonce).outcome;
			if (terminal) {
				settled = true;
				resolveOutcome(terminal);
			}
		};

		let started: Awaited<ReturnType<ModalSandboxInstance['startProcessWithOutput']>>;
		try {
			started = await this.startProcessWithOutput(
				built.command,
				{
					cwd: options.cwd,
					env: options.env,
					processId: options.processId,
				},
				inspect,
			);
		} catch (error) {
			return transportFailureResult(error, {
				setup: 0,
				start: Math.max(0, Date.now() - launchStarted),
				waitport: 0,
			});
		}

		const start = Math.max(0, Date.now() - launchStarted);
		const waitStarted = Date.now();
		void started.completed.then(
			() => {
				if (!settled) {
					settled = true;
					rejectOutcome(new Error('Modal launch stream ended before reporting readiness'));
				}
			},
			(error) => {
				if (!settled) {
					settled = true;
					rejectOutcome(error);
				}
			},
		);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOutcome =
			options.startupTimeout === 0
				? outcome
				: Promise.race([
						outcome,
						new Promise<LaunchProtocolOutcome>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new ModalLaunchTimeoutError()),
								Math.max(0, options.startupTimeout - start) + LAUNCH_MARKER_GRACE_MS,
							);
						}),
					]);

		let terminal: LaunchProtocolOutcome;
		try {
			terminal = await timedOutcome;
		} catch (error) {
			settled = true;
			const logs = await started.process.getLogs();
			const parsed = parseLaunchOutput(logs, built.nonce);
			if (!(error instanceof ModalLaunchTimeoutError)) {
				await started.process.kill().catch(() => {});
				return {
					success: false,
					reason: 'transport_failure',
					stdout: parsed.stdout,
					stderr: [parsed.stderr, errorMessage(error)].filter(Boolean).join('\n'),
					timings: { setup: 0, start, waitport: Math.max(0, Date.now() - waitStarted) },
				};
			}

			await started.process.kill().catch(() => {});
			const setupCompleted = `${logs.stdout}\n${logs.stderr}`.includes(
				setupCompleteMarker(built.nonce),
			);
			return launchTimeoutResult({
				setup: Boolean(options.setup),
				setupCompleted,
				startupTimeout: options.startupTimeout,
				output: parsed,
				start,
				waitport: Math.max(0, Date.now() - waitStarted),
			});
		} finally {
			if (timer) clearTimeout(timer);
		}

		const timings = { setup: terminal.setupMs, start, waitport: terminal.waitportMs };
		if (terminal.kind === 'ready') {
			const process = started.process;
			return {
				success: true,
				timings,
				process: {
					id: process.id,
					command: cmd,
					kill: (signal) => process.kill(signal),
					waitForPort: (port, waitOptions) =>
						port === options.port ? Promise.resolve() : process.waitForPort(port, waitOptions),
					async getLogs() {
						const parsed = parseLaunchOutput(await process.getLogs(), built.nonce);
						return { stdout: parsed.stdout, stderr: parsed.stderr };
					},
				},
			};
		}

		await started.completed.catch(() => {});
		const parsed = parseLaunchOutput(await started.process.getLogs(), built.nonce);
		return launchOutcomeResult(terminal.kind, terminal, parsed, start);
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		const tunnel = (await (await this.getSandbox()).tunnels())[port];
		if (!tunnel?.url) throw new Error(`Modal sandbox ${this.id} has no tunnel for port ${port}`);
		return { url: tunnel.url };
	}

	async destroy(): Promise<void> {
		try {
			await (await this.getSandbox(false)).terminate();
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
}

export class ModalCompute implements SandboxProvider {
	private readonly client: ModalClientLike;

	constructor(
		private readonly config: ModalConfig,
		client?: ModalClientLike,
	) {
		this.client =
			client ??
			// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the SDK class implements this injected seam
			(new ModalClient({
				tokenId: config.tokenId,
				tokenSecret: config.tokenSecret,
				environment: config.environment,
				...(config.apiBase ? { endpoint: config.apiBase } : {}),
			}) as unknown as ModalClientLike);
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		const config = options?.image ? { ...this.config, image: options.image } : this.config;
		return new ModalSandboxInstance(
			id,
			config,
			this.client,
			modalProfileResources(options?.resources),
			options?.reuse ?? true,
		);
	}

	async proxy(_request: Request): Promise<Response | null> {
		return null;
	}

	async listActive(): Promise<ActiveSandbox[]> {
		const appName = this.config.appName ?? DEFAULT_APP_NAME;
		let app: { appId: string };
		try {
			app = await this.client.apps.fromName(appName);
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}

		const active: ActiveSandbox[] = [];
		for await (const sandbox of this.client.sandboxes.list({
			appId: app.appId,
			tags: { [OWNER_TAG]: appName },
		})) {
			const id = (await sandbox.getTags())[SANDBOX_ID_TAG];
			if (SandboxId.is(id)) active.push({ id });
		}
		return active;
	}
}

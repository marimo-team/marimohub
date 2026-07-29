import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { ModalClient, NotFoundError } from 'modal';
import {
	buildGitCloneCommand,
	mapWithConcurrency,
	shellQuote,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { SandboxId } from '@marimo-hub/core';
import type {
	ActiveSandbox,
	ComputeResources,
	CreateSandboxOptions,
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
	WaitForPortOptions,
} from '@marimo-hub/core/ports';

export interface ModalConfig {
	tokenId: string;
	tokenSecret: string;
	/** Registry image containing marimo, uv, and Python. */
	image: string;
	/** Modal API endpoint override. */
	apiBase?: string;
	/** Modal app name that owns the sandboxes. */
	appName?: string;
	/** Idle timeout before Modal auto-stops the sandbox (e.g. `20m`). */
	idleTimeout?: string;
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
				tags: Record<string, string>;
				encryptedPorts: number[];
				timeoutMs: number;
				idleTimeoutMs?: number;
				cpu?: number;
				memoryMiB?: number;
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
} {
	return {
		...(resources?.cpu !== undefined ? { cpu: resources.cpu } : {}),
		...(resources?.memoryBytes !== undefined
			? { memoryMiB: Math.ceil(resources.memoryBytes / 1024 ** 2) }
			: {}),
	};
}

export function parseModalDuration(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
	if (!match) throw new Error(`Invalid Modal idle timeout ${JSON.stringify(value)}`);
	const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
	const duration = Number(match[1]) * multipliers[match[2] as keyof typeof multipliers];
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error(`Modal idle timeout must be positive, got ${JSON.stringify(value)}`);
	}
	return Math.round(duration);
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof NotFoundError || (error instanceof Error && error.name === 'NotFoundError')
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
	return { success: exitCode === 0, stdout, stderr };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let processSequence = 0;

class ModalSandboxInstance implements SandboxInstance {
	private sandboxPromise?: Promise<ModalSandboxLike>;
	private env: Record<string, string> = {};

	constructor(
		private readonly id: SandboxId,
		private readonly config: ModalConfig,
		private readonly client: ModalClientLike,
		private readonly resources: ReturnType<typeof modalProfileResources>,
		private readonly reuse: boolean,
		private readonly idleTimeoutMs: number | undefined,
	) {}

	private createSandbox(): Promise<ModalSandboxLike> {
		const appName = this.config.appName ?? DEFAULT_APP_NAME;
		return this.client.apps.fromName(appName, { createIfMissing: true }).then((app) =>
			this.client.sandboxes.create(app, this.client.images.fromRegistry(this.config.image), {
				name: this.id,
				tags: {
					[OWNER_TAG]: appName,
					[SANDBOX_ID_TAG]: this.id,
				},
				encryptedPorts: [KERNEL_PORT],
				timeoutMs: MAX_SANDBOX_LIFETIME_MS,
				...(this.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.idleTimeoutMs } : {}),
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

	async exec(cmd: string): Promise<ExecResult> {
		return runProcess(await this.spawn(['sh', '-lc', cmd]));
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		const process = await this.spawn(['sh', '-lc', cmd], {
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
			return { success: false, content: '' };
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
			const files: ListFilesResult['files'] = [];
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
		} catch {
			return { success: false, files: [] };
		}
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const result = await this.exec(buildGitCloneCommand(repo, options));
		if (!result.success) throw new Error(`git checkout failed: ${result.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>): Promise<void> {
		this.env = { ...this.env, ...vars };
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		throw new Error('mountBucket is not supported on the Modal backend; using file copy fallback');
	}

	async unmountBucket(_mountPath: string): Promise<void> {}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const pidPath = `/tmp/marimohub-process-${randomUUID()}.pid`;
		const trackedCommand = [
			'stat=$(cat /proc/$$/stat)',
			'stat=${stat##*) }',
			'set -- $stat',
			`printf '%s %s\\n' "$$" "\${20}" > ${shellQuote(pidPath)}`,
			`exec sh -lc ${shellQuote(cmd)}`,
		].join('; ');
		const process = await this.spawn(['sh', '-lc', trackedCommand], {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
		});
		let stdout = '';
		let stderr = '';
		let exitCode: number | undefined;
		let settled = false;
		const execInSandbox = (command: string) => this.exec(command);
		const stdoutDone = consumeStream(process.stdout, (chunk) => {
			stdout += chunk;
		});
		const stderrDone = consumeStream(process.stderr, (chunk) => {
			stderr += chunk;
		});
		const exited = process
			.wait()
			.then((code) => {
				exitCode = code;
				return code;
			})
			.finally(() => {
				settled = true;
				void execInSandbox(`rm -f ${shellQuote(pidPath)}`).catch(() => {});
			});

		return {
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
							`process exited (code ${exitCode}) before port ${port} was ready.\n${stderr || stdout}`,
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
					`timed out waiting for port ${port} after ${timeout}ms.\n${stderr || stdout}`,
				);
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				if (exitCode !== undefined) await Promise.allSettled([stdoutDone, stderrDone, exited]);
				return { stdout, stderr };
			},
		};
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
	private readonly idleTimeoutMs: number | undefined;

	constructor(
		private readonly config: ModalConfig,
		client?: ModalClientLike,
	) {
		this.idleTimeoutMs = parseModalDuration(config.idleTimeout);
		this.client =
			client ??
			(new ModalClient({
				tokenId: config.tokenId,
				tokenSecret: config.tokenSecret,
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
			this.idleTimeoutMs,
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

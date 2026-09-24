import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
import {
	readBoundedFile,
	validateOutputBudget,
	waitWithSignal,
	base64Encode,
	buildFindFilesCommand,
	buildGitCloneCommand,
	classifyListFilesFailure,
	launchWithProcess,
	mapWithConcurrency,
	parseFindFilesOutput,
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core/ids';
import type {
	BoundedReadOptions,
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
	SetEnvVarsOptions,
	StartProcessOptions,
} from '@marimo-hub/core/ports/sandbox';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports/sandbox';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SandboxType = Sandbox<any>;

const SLEEP_AFTER = '20m';

// Quick-tunnel readiness. A `*.trycloudflare.com` host isn't resolvable the instant
// `tunnels.get()` returns, so we briefly poll the URL before handing it to the client
// — otherwise the browser can show "server IP address could not be found". Negligible
// on the happy path (the first probe answers); capped so a slow tunnel never blocks.
const TUNNEL_READY_CAP_MS = 10_000;
const TUNNEL_READY_INTERVAL_MS = 500;
const TUNNEL_READY_PROBE_MS = 3_000;

async function waitForTunnelReady(url: string): Promise<void> {
	const deadline = Date.now() + TUNNEL_READY_CAP_MS;
	for (;;) {
		try {
			const res = await fetch(url, {
				method: 'GET',
				redirect: 'manual',
				signal: AbortSignal.timeout(TUNNEL_READY_PROBE_MS),
			});
			// Any non-5xx response means DNS resolved and the tunnel is serving.
			if (res.status < 500) return;
		} catch {
			// DNS not resolvable yet / connection refused — keep polling until the cap.
		}
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => {
			setTimeout(resolve, TUNNEL_READY_INTERVAL_MS);
		});
	}
}

async function collectExecOutput(
	stream: ReadableStream<Uint8Array>,
	maxOutputBytes: number,
	signal: AbortSignal,
): Promise<ExecResult> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	// Allow JSON escaping, repeated completion output, and 128 framing bytes per
	// single-byte output event. Empty/control events share the fixed allowance.
	let wireRemaining = Math.min(Number.MAX_SAFE_INTEGER, maxOutputBytes * (12 + 128) + 64 * 1024);
	const frameLimit = Math.min(Number.MAX_SAFE_INTEGER, maxOutputBytes * 6 + 64 * 1024);
	let frameBytes = 0;
	let outputRemaining = maxOutputBytes;
	let pending = '';
	let stdout = '';
	let stderr = '';
	let success = false;
	try {
		for (;;) {
			const { done, value } = await waitWithSignal(reader.read(), signal);
			if (done) break;
			wireRemaining -= value.byteLength;
			if (wireRemaining < 0) throw new Error('Sandbox SSE wire limit exceeded');
			for (let offset = 0; offset < value.byteLength; ) {
				const newline = value.indexOf(10, offset);
				const end = newline === -1 ? value.byteLength : newline + 1;
				frameBytes += end - offset;
				if (frameBytes > frameLimit) throw new Error('Sandbox SSE frame limit exceeded');
				pending += decoder.decode(value.subarray(offset, end), { stream: true });
				offset = end;
				if (newline === -1) continue;
				const line = pending.slice(0, -1);
				pending = '';
				frameBytes = 0;
				if (!line.startsWith('data:')) continue;
				const event = JSON.parse(line.slice(5)) as {
					type: string;
					data?: unknown;
					exitCode?: unknown;
				};
				if (event.type === 'stdout' || event.type === 'stderr') {
					if (typeof event.data !== 'string') throw new Error('Malformed sandbox output event');
					outputRemaining -= encoder.encode(event.data).byteLength;
					if (outputRemaining < 0) throw new Error('Sandbox output limit exceeded');
					if (event.type === 'stdout') stdout += event.data;
					else stderr += event.data;
				} else if (event.type === 'complete') {
					if (!Number.isInteger(event.exitCode))
						throw new Error('Malformed sandbox completion event');
					success = event.exitCode === 0;
				} else if (event.type === 'error') {
					throw new Error('Sandbox command failed');
				}
			}
		}
		if ((pending + decoder.decode()).trim()) throw new Error('Incomplete sandbox output event');
		return execResult(success, stdout, stderr);
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

class CloudflareSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = true;
	private sandbox: SandboxType;
	private useTunnel: boolean;
	private envDefaults: Record<string, string> = {};

	constructor(sandbox: SandboxType, useTunnel = false) {
		this.sandbox = sandbox;
		this.useTunnel = useTunnel;
	}

	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const command = this.withDefaults(cmd);
		if (options?.maxOutputBytes !== undefined) {
			validateOutputBudget(options.maxOutputBytes);
			const timeout = options.timeout ?? 10_000;
			if (
				Number.isNaN(timeout) ||
				timeout < 0 ||
				(Number.isFinite(timeout) && timeout > 2 ** 31 - 1)
			)
				throw new RangeError('Sandbox output timeout exceeds timer range');
			const delay = Math.ceil(timeout);
			const signal =
				timeout > 0 && Number.isFinite(timeout)
					? AbortSignal.timeout(delay)
					: new AbortController().signal;
			const stream = await this.sandbox.execStream(command, {
				timeout: options.timeout === undefined ? undefined : delay,
				signal,
			});
			return collectExecOutput(stream, options.maxOutputBytes, signal);
		}
		const res =
			options?.timeout === undefined
				? await this.sandbox.exec(command)
				: await this.sandbox.exec(command, { timeout: options.timeout });
		return execResult(res.success, res.stdout, res.stderr);
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		return this.sandbox.execStream(this.withDefaults(cmd), {
			timeout: options?.timeout,
		});
	}

	async readFileBounded(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		return readBoundedFile(path, options, (command, limits) => this.exec(command, limits));
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const res = await this.sandbox.readFile(path);
			return res.success
				? { success: true, content: res.content, encoding: res.encoding }
				: readFileFailure('READ_FAILED');
		} catch (error) {
			return readFileFailure(
				error instanceof Error && error.name === 'FileNotFoundError' ? 'NOT_FOUND' : 'READ_FAILED',
			);
		}
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		const result = await this.exec(buildFindFilesCommand(path, options));
		if (!result.success) {
			return listFilesFailure(classifyListFilesFailure(result));
		}
		return { success: true, files: parseFindFilesOutput(result.stdout, path, options) };
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		// No multi-file API on the SDK, so loop. Its writeFile takes text (the stream
		// overload throws on the HTTP and WebSocket transports), so bytes go over it
		// base64-armored — `encoding` tells the container to decode before writing.
		await mapWithConcurrency(files, WRITE_CONCURRENCY, async (f) => {
			if (typeof f.content === 'string') {
				await this.sandbox.writeFile(f.path, f.content);
				return;
			}
			await this.sandbox.writeFile(f.path, base64Encode(f.content), { encoding: 'base64' });
		});
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		// Via exec rather than the SDK's gitCheckout so the env-defaults prefix
		// applies to the clone, like every other adapter.
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		if (options?.onlyIfUnset) {
			// The SDK's session-level setEnvVars always overwrites, so defaults are
			// applied as a guarded shell prefix on each command instead.
			this.envDefaults = { ...this.envDefaults, ...vars };
			return;
		}
		await this.sandbox.setEnvVars(vars);
	}

	private withDefaults(cmd: string): string {
		return withEnvPrefix(cmd, {}, this.envDefaults);
	}

	async mountBucket(options: MountBucketOptions): Promise<void> {
		if (options.endpoint) {
			await this.sandbox.mountBucket(options.bucketName, options.mountPath, {
				endpoint: options.endpoint,
				prefix: options.prefix,
				credentials: options.credentials,
				credentialProxy: true,
			});
			return;
		}
		// No endpoint → mount by Worker R2 binding name with no credentials in the
		// container (egress interception). `bucketName` is the binding name; requires
		// the entrypoint to `export { ContainerProxy }`.
		await this.sandbox.mountBucket(options.bucketName, options.mountPath, {
			prefix: options.prefix,
		});
	}

	async unmountBucket(mountPath: string): Promise<void> {
		await this.sandbox.unmountBucket(mountPath);
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const proc = await this.sandbox.startProcess(this.withDefaults(cmd), {
			processId: options?.processId,
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
		});
		return {
			get id() {
				return proc.id;
			},
			get command() {
				return proc.command;
			},
			kill: (signal?: string) => proc.kill(signal),
			waitForPort: (port, opts) => proc.waitForPort(port, opts),
			getLogs: () => proc.getLogs(),
		};
	}

	async launchProcess(cmd: string, options: LaunchProcessOptions): Promise<SandboxLaunchResult> {
		return launchWithProcess({
			setup: options.setup,
			command: cmd,
			port: options.port,
			startupTimeout: options.startupTimeout,
			waitForPort: options.waitForPort,
			start: (command) =>
				this.startProcess(command, {
					cwd: options.cwd,
					env: options.env,
					processId: options.processId,
				}),
		});
	}

	async exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		if (this.useTunnel) {
			// `options.hostname` is unused — Cloudflare assigns the tunnel host. Tunnels
			// are RPC-only, which getSandbox() provides.
			const tunnel = await this.sandbox.tunnels.get(port);
			// Don't return the URL until it's actually resolvable (see waitForTunnelReady).
			await waitForTunnelReady(tunnel.url);
			return { url: tunnel.url };
		}
		const result = await this.sandbox.exposePort(port, options);
		return { url: result.url };
	}

	async destroy(): Promise<void> {
		await this.sandbox.destroy();
	}
}

export interface CloudflareSandboxProviderOptions {
	/**
	 * Expose kernels via zero-config quick tunnels (`sandbox.tunnels.get`, random
	 * `*.trycloudflare.com`) instead of `exposePort` on a configured sandbox domain.
	 * Lets a deployment skip SANDBOX_HOSTNAME entirely; the random tunnel host is
	 * cross-origin + unguessable, so kernels stay isolated from the app. Off by
	 * default (the reference deployment uses an explicit sandbox domain).
	 */
	useTunnel?: boolean;
}

export class CloudflareSandboxProvider implements SandboxProvider {
	readonly capabilities = { multiPort: true } as const;
	private namespace: DurableObjectNamespace<SandboxType>;
	private useTunnel: boolean;

	constructor(
		namespace: DurableObjectNamespace<SandboxType>,
		options: CloudflareSandboxProviderOptions = {},
	) {
		this.namespace = namespace;
		this.useTunnel = options.useTunnel ?? false;
	}

	create(id: SandboxId): SandboxInstance {
		return new CloudflareSandboxInstance(
			getSandbox(this.namespace, id, {
				sleepAfter: SLEEP_AFTER,
				// Quick tunnels are RPC-only; the default route-based (http) transport
				// doesn't implement them. Subdomain exposure keeps the http default.
				transport: this.useTunnel ? 'rpc' : 'http',
			}),
			this.useTunnel,
		);
	}

	async proxy(request: Request): Promise<Response | null> {
		// proxyToSandbox reads `env.Sandbox` (see SandboxEnv); the key must be
		// `Sandbox` regardless of the wrangler binding name (`SANDBOX`).
		return proxyToSandbox(request, { Sandbox: this.namespace });
	}
}

// Re-export the Sandbox Durable Object class for wrangler to discover.
export { Sandbox } from '@cloudflare/sandbox';
// Entrypoints must also export ContainerProxy to enable credential-less R2 binding
// mounts (the SDK intercepts the container's S3 egress through it).
export { ContainerProxy } from '@cloudflare/sandbox';

import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
import { base64Encode, mapWithConcurrency, WRITE_CONCURRENCY } from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core';
import type {
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
} from '@marimo-hub/core/ports';

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
		await new Promise((resolve) => setTimeout(resolve, TUNNEL_READY_INTERVAL_MS));
	}
}

class CloudflareSandboxInstance implements SandboxInstance {
	private sandbox: SandboxType;
	private useTunnel: boolean;

	constructor(sandbox: SandboxType, useTunnel = false) {
		this.sandbox = sandbox;
		this.useTunnel = useTunnel;
	}

	async exec(cmd: string): Promise<ExecResult> {
		const res = await this.sandbox.exec(cmd);
		return { success: res.success, stdout: res.stdout, stderr: res.stderr };
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		return this.sandbox.execStream(cmd, {
			timeout: options?.timeout,
		});
	}

	async readFile(path: string): Promise<ReadFileResult> {
		const res = await this.sandbox.readFile(path);
		return { success: res.success, content: res.content, encoding: res.encoding };
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		const res = await this.sandbox.listFiles(path, options);
		return {
			success: res.success,
			files: res.files.map((f) => ({
				name: f.name,
				absolutePath: f.absolutePath,
				relativePath: f.relativePath,
				type: f.type,
				size: f.size,
			})),
		};
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
		await this.sandbox.gitCheckout(repo, options);
	}

	async setEnvVars(vars: Record<string, string>): Promise<void> {
		await this.sandbox.setEnvVars(vars);
	}

	async mountBucket(options: MountBucketOptions): Promise<void> {
		if (options.endpoint) {
			await this.sandbox.mountBucket(options.bucketName, options.mountPath, {
				endpoint: options.endpoint,
				prefix: options.prefix,
				credentials: options.credentials,
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
		const proc = await this.sandbox.startProcess(cmd, {
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

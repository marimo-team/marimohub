/**
 * CoreWeave Sandbox compute adapter — a `SandboxProvider` backed by CoreWeave
 * Sandboxes via the `@coreweave/cwsandbox` SDK (Node gRPC transport, vendored at
 * `vendor/cwsandbox`). Like the Modal adapter, this targets the Node/Kubernetes
 * control plane (`apps/server`); the SDK transport is gRPC, so it is NOT usable
 * from a Workers runtime, and `proxy()` is a no-op (the SPA hits the kernel's
 * public-ingress URL directly).
 *
 * Bridging the port to the SDK (the SDK is shaped quite differently):
 *  - `create(id)` is synchronous and id-addressed, but the SDK creates sandboxes
 *    asynchronously and assigns its OWN `sandboxId`. We return a lazy instance and
 *    resolve the real sandbox on first use (`ensure()`): cache → reconnect to the
 *    sandbox tagged with our id → else create one. We tag every sandbox with
 *    `idTag(ourId)` so the API can re-resolve an instance for teardown
 *    (`compute.create(id).destroy()`) and so file-copy teardown reconnects to the
 *    SAME sandbox before saving notebook files back.
 *  - Ports/network are CREATE-time options, but the provisioner exposes the kernel
 *    port (2718) only later. `ensure()` declares `ports:[kernelPort]` with public
 *    ingress at create so the later `exposePort` is reachable.
 *  - The sandbox MAIN process is the SDK keep-alive; marimo runs as a streamed
 *    COMMAND (`commands.start`), not the main process.
 *  - The SDK has no `waitForPort`, so we poll an in-sandbox TCP probe via `exec`.
 *
 * `listActive()` is intentionally NOT implemented. The SDK list response
 * (`SandboxInfo`) returns only CoreWeave's `sandboxId` + status — it does NOT echo
 * tags, so the provider cannot map a CoreWeave sandbox back to the `sandbox_id` our
 * session records store. Returning CoreWeave ids would make the reconciler's
 * provider-truth check terminate every live session, so we omit the method
 * (`SandboxProvider.listActive` is optional; the reconciler skips provider-truth
 * reconciliation and the record-only sweep still runs). For orphan protection,
 * set `maxLifetimeSeconds` so CoreWeave hard-caps sandbox lifetime.
 *
 * INTEGRATION SURFACE (validate against the live CoreWeave API before production,
 * same caveat the Modal adapter carries): the network `ingressMode`/`egressMode`
 * names are backend/profile specific; the public kernel URL is CONSTRUCTED from a
 * hostname template (the SDK exposes no ingress-URL accessor); and the
 * `waitForPort` probe assumes `python3` is on the image PATH.
 */
import { CWSandboxNotFoundError } from '@coreweave/cwsandbox';
import type {
	CommandProcess,
	FileContent,
	ListSandboxesResult,
	ProcessResult,
	ResourceOptions,
	SandboxInfo,
	SandboxRunOptions,
} from '@coreweave/cwsandbox';
import { createSandboxClient, DEFAULT_CONTAINER_IMAGE } from '@coreweave/cwsandbox/node';
import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	iterableToStream,
	parseFindFilesOutput,
	pollUntilReady,
	shellQuote,
	withEnvPrefix,
} from '@marimo-hub/compute-commons';
import type { SandboxId, Seconds } from '@marimo-hub/core';
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
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';

/** marimo's hardcoded kernel port (see `SandboxProvisioner`'s `MARIMO_PORT`). */
const DEFAULT_KERNEL_PORT = 2718;
/** Default tag marking sandboxes THIS deployment owns (for manual discovery/cleanup). */
const DEFAULT_OWNER_TAG = 'marimohub';
/** Prefix for the per-sandbox tag that encodes our `SandboxId`. */
const ID_TAG_PREFIX = 'mh-sbx-';

export interface CoreWeaveConfig {
	/** CoreWeave Sandbox API key (`CWSANDBOX_API_KEY`). */
	apiKey: string;
	/** API base URL (`CWSANDBOX_BASE_URL`); defaults to the SDK's production endpoint. */
	baseUrl?: string;
	/** Container image with marimo + uv + python. Defaults to the SDK's `python:3.11`. */
	image?: string;
	/** Port marimo binds inside the sandbox; declared public at create. Default 2718. */
	kernelPort?: number;
	/** Tag applied to every sandbox we own (manual discovery/cleanup). Default `marimohub`. */
	ownerTag?: string;
	/** CoreWeave network ingress mode (backend/profile specific). Default `public`. */
	ingressMode?: string;
	/** CoreWeave network egress mode (backend/profile specific). Default `internet`. */
	egressMode?: string;
	/**
	 * Sandbox profile name(s) to apply at create. The profile defines the named
	 * exposure levels (`ingressMode`) and egress modes the sandbox selects from.
	 * Omit to use the runner's default profile.
	 */
	profileNames?: readonly string[];
	/**
	 * Template for the public kernel URL. `{sandboxId}`, `{port}`, and `{host}` are
	 * substituted. Default `https://{sandboxId}-{port}.{host}` where `{host}` is the
	 * `hostname` the provisioner passes (`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`).
	 */
	hostnameTemplate?: string;
	/** Optional CPU/memory request (and limit) for each sandbox. */
	resources?: ResourceOptions;
	/**
	 * Hard cap on sandbox lifetime. Belt-and-suspenders orphan protection.
	 * The CoreWeave SDK takes seconds directly (unlike e2b, which wants ms).
	 */
	maxLifetimeSeconds?: Seconds;
	/**
	 * Enable CoreWeave-native filesystem snapshots (full-env restore on the next
	 * session). Off by default. Currently INERT: the capture/restore implementation
	 * lands once the vendored `@coreweave/cwsandbox` is refreshed to a version
	 * exposing the snapshot API (see `vendor/cwsandbox/UPSTREAM.md`).
	 */
	filesystemSnapshot?: boolean;
}

/**
 * The slice of the SDK's `SandboxClient` this adapter uses. Declaring it as an
 * interface (rather than depending on the concrete class) is the injection seam:
 * tests pass a fake, production passes the real client.
 */
export interface CoreWeaveClient {
	create(options?: SandboxRunOptions): Promise<CoreWeaveSandbox>;
	fromId(sandboxId: string): Promise<CoreWeaveSandbox>;
	list(options?: {
		tags?: readonly string[];
		includeStopped?: boolean;
		pageSize?: number;
		pageToken?: string;
	}): Promise<ListSandboxesResult>;
	delete(sandboxId: string): Promise<void>;
}

/** The slice of the SDK's `Sandbox` handle this adapter uses. */
export interface CoreWeaveSandbox {
	readonly sandboxId: string;
	readonly commands: {
		run(command: readonly string[], options?: { cwd?: string }): Promise<ProcessResult>;
		start(command: readonly string[], options?: { cwd?: string }): Promise<CommandProcess>;
	};
	readonly files: {
		readText(path: string): Promise<string>;
		write(path: string, content: FileContent): Promise<void>;
	};
	delete(): Promise<void>;
}

/** A CoreWeave status that means the sandbox is gone (not a reconnect/teardown target). */
function isDeadStatus(status: SandboxInfo['status']): boolean {
	return status === 'terminated' || status === 'failed' || status === 'completed';
}

let PROC_SEQ = 0;

class CoreWeaveSandboxInstance implements SandboxInstance {
	private readonly idTag: string;
	private readonly kernelPort: number;
	private sandbox?: CoreWeaveSandbox;
	private env: Record<string, string> = {};

	constructor(
		private readonly id: SandboxId,
		private readonly config: CoreWeaveConfig,
		private readonly client: CoreWeaveClient,
	) {
		this.idTag = ID_TAG_PREFIX + id;
		this.kernelPort = config.kernelPort ?? DEFAULT_KERNEL_PORT;
	}

	/**
	 * Resolve the underlying CoreWeave sandbox, creating it on first use. Reconnect
	 * (rather than create) when a sandbox already carries our id tag — required so a
	 * re-resolved instance (teardown's `compute.create(id)`) operates on the SAME
	 * sandbox, e.g. to read notebook files back before destroy.
	 */
	private async ensure(): Promise<CoreWeaveSandbox> {
		if (this.sandbox) return this.sandbox;
		// Split timing of the lazy resolve (the provisioner's `reachable` = this + the
		// first command): find_ms is the tag-list reconnect lookup (wasted on a fresh
		// provision); create_ms is create + waitUntilRunning (cold-start + image pull).
		const t0 = Date.now();
		const existing = await this.findByOurId();
		const t1 = Date.now();
		this.sandbox = existing
			? await this.client.fromId(existing.sandboxId)
			: await this.client.create(this.createOptions());
		const t2 = Date.now();
		console.warn(
			JSON.stringify({
				ts: new Date().toISOString(),
				event: 'coreweave_ensure',
				sandbox_id: this.id,
				reconnected: Boolean(existing),
				find_ms: t1 - t0,
				create_ms: t2 - t1,
			}),
		);
		return this.sandbox;
	}

	/** Find a live sandbox tagged with our id (tags are a request-side filter only). */
	private async findByOurId(): Promise<SandboxInfo | undefined> {
		const { sandboxes } = await this.client.list({
			tags: [this.idTag],
			includeStopped: false,
		});
		return sandboxes.find((s) => !isDeadStatus(s.status));
	}

	private createOptions(): SandboxRunOptions {
		return {
			containerImage: this.config.image ?? DEFAULT_CONTAINER_IMAGE,
			ports: [this.kernelPort],
			network: {
				ingressMode: this.config.ingressMode ?? 'public',
				egressMode: this.config.egressMode ?? 'internet',
				exposedPorts: [this.kernelPort],
			},
			tags: [this.config.ownerTag ?? DEFAULT_OWNER_TAG, this.idTag],
			...(this.config.profileNames?.length ? { profileNames: this.config.profileNames } : {}),
			...(this.config.resources ? { resources: this.config.resources } : {}),
			...(this.config.maxLifetimeSeconds
				? { maxLifetimeSeconds: this.config.maxLifetimeSeconds }
				: {}),
			waitUntilRunning: true,
		};
	}

	/** Prefix accumulated env vars onto a shell command (the SDK has no per-command env). */
	private withEnv(cmd: string): string {
		return withEnvPrefix(cmd, this.env);
	}

	async exec(cmd: string): Promise<ExecResult> {
		const sandbox = await this.ensure();
		const res = await sandbox.commands.run(['sh', '-lc', this.withEnv(cmd)]);
		return { success: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr };
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		const sandbox = await this.ensure();
		const proc = await sandbox.commands.start(['sh', '-lc', this.withEnv(cmd)]);
		return iterableToStream(proc.stdout);
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const sandbox = await this.ensure();
			const content = await sandbox.files.readText(path);
			return { success: true, content, encoding: 'utf-8' };
		} catch {
			return { success: false, content: '' };
		}
	}

	async writeFile(path: string, content: string): Promise<void> {
		const sandbox = await this.ensure();
		// The SDK's files.write does not create parent dirs; mkdir -p first so nested
		// paths (e.g. injected `<xdg>/marimo/marimo.toml`) don't fail with a transport
		// error. Matches the contract the docker/k8s adapters already honor.
		const dir = path.slice(0, path.lastIndexOf('/'));
		if (dir) await this.exec(`mkdir -p ${shellQuote(dir)}`);
		await sandbox.files.write(path, content);
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		// Best-effort: the SDK files namespace has no list, so shell out via `find`.
		// Used by `captureWorkspace` on teardown to enumerate the working dir under
		// PERSIST_WORKSPACE=workspace.
		try {
			const res = await this.exec(buildFindFilesCommand(path, options));
			if (!res.success) return { success: false, files: [] };
			return { success: true, files: parseFindFilesOutput(res.stdout, path, options) };
		} catch {
			return { success: false, files: [] };
		}
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		// shellQuote'd args (via buildGitCloneCommand) close the injection hole the
		// previous raw interpolation left open.
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>): Promise<void> {
		// Stored and applied as a shell prefix by withEnv(); the SDK sets env only at
		// create time, and the provisioner never calls this on the hot path.
		this.env = { ...this.env, ...vars };
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// No FUSE mount — throwing makes SandboxProvisioner fall back to copying
		// notebook files in/out (the intended path for this backend, like Modal/local).
		throw new Error(
			'mountBucket is not supported on the CoreWeave backend; using file copy fallback',
		);
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// no-op: nothing was mounted.
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const sandbox = await this.ensure();
		const proc = await sandbox.commands.start(['sh', '-lc', this.withEnv(cmd)], {
			cwd: options?.cwd,
		});

		// marimo runs as a streamed command (not the sandbox main process), so drain
		// its output in the background to back getLogs() and to surface errors if the
		// port never opens.
		let stdout = '';
		let stderr = '';
		const pump = async (stream: AsyncIterable<string>, sink: (chunk: string) => void) => {
			try {
				for await (const chunk of stream) sink(chunk);
			} catch {
				// stream cancelled/ended — best effort.
			}
		};
		void pump(proc.stdout, (c) => (stdout += c));
		void pump(proc.stderr, (c) => (stderr += c));

		const exec = this.exec.bind(this);
		return {
			id: `cw-proc-${++PROC_SEQ}`,
			command: cmd,
			async kill(_signal?: string): Promise<void> {
				// The SDK streaming protocol has no remote signal; cancel the stream.
				try {
					await proc.cancel();
				} catch {
					// already gone — best effort.
				}
			},
			async waitForPort(port: number, opts?: WaitForPortOptions): Promise<void> {
				const timeout = opts?.timeout ?? 30_000;
				// In-sandbox TCP probe (the SDK exposes no waitForPort). Mirrors the
				// local adapter's tcpReady poll, run via exec.
				const probe =
					`python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); ` +
					`sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)"`;
				await pollUntilReady(async () => (await exec(probe)).success, {
					timeoutMs: timeout,
					intervalMs: 500,
					timeoutMessage: () =>
						`timed out waiting for port ${port} after ${timeout}ms.\n${stderr || stdout}`,
				});
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				return { stdout, stderr };
			},
		};
	}

	async exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		// The SDK has no ingress-URL accessor; construct the public URL from a template
		// (the kernel port was declared `public` at create). Integration surface — the
		// exact ingress hostname scheme is CoreWeave backend/profile specific.
		const sandbox = await this.ensure();
		const template = this.config.hostnameTemplate ?? 'https://{sandboxId}-{port}.{host}';
		const url = template
			.replaceAll('{sandboxId}', sandbox.sandboxId)
			.replaceAll('{port}', String(port))
			.replaceAll('{host}', options.hostname)
			.replaceAll('{token}', options.token ?? '');
		return { url };
	}

	async destroy(): Promise<void> {
		if (this.sandbox) {
			await this.deleteTolerant(() => this.sandbox!.delete());
			this.sandbox = undefined;
			return;
		}
		// Re-resolved instance (no cached handle): delete every sandbox tagged with our
		// id. Tolerate "already gone" so teardown is idempotent.
		const { sandboxes } = await this.client.list({ tags: [this.idTag], includeStopped: false });
		for (const info of sandboxes) {
			await this.deleteTolerant(() => this.client.delete(info.sandboxId));
		}
	}

	private async deleteTolerant(del: () => Promise<void>): Promise<void> {
		try {
			await del();
		} catch (err) {
			if (err instanceof CWSandboxNotFoundError) return; // already gone
			throw err;
		}
	}
}

export class CoreWeaveCompute implements SandboxProvider {
	private client?: CoreWeaveClient;

	constructor(
		private readonly config: CoreWeaveConfig,
		client?: CoreWeaveClient,
	) {
		this.client = client;
	}

	private getClient(): CoreWeaveClient {
		if (!this.client) {
			// The real SDK client exposes the CoreWeaveClient surface at runtime; one
			// controlled cast at the construction boundary avoids overload-variance
			// friction between the SDK's broad signatures and our narrow seam.
			this.client = createSandboxClient({
				apiKey: this.config.apiKey,
				...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
			}) as unknown as CoreWeaveClient;
		}
		return this.client;
	}

	create(id: SandboxId): SandboxInstance {
		return new CoreWeaveSandboxInstance(id, this.config, this.getClient());
	}

	async proxy(_request: Request): Promise<Response | null> {
		// CoreWeave kernels are reached directly via their public-ingress URL; nothing
		// to proxy at the control-plane edge (same as the Modal backend).
		return null;
	}

	// listActive() is intentionally omitted — see the file header. The SDK list
	// response does not echo tags, so the provider cannot map a CoreWeave sandbox
	// back to our session's sandbox_id; the reconciler skips provider-truth
	// reconciliation for providers without listActive.
}

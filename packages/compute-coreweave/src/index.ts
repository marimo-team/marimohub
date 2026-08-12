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
	CommandProcessStatus,
	FileWrites,
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
	portWaitCommand,
	removeUndefined,
	shellQuote,
	withEnvPrefix,
} from '@marimo-hub/compute-commons';
import type {
	ComputeResources,
	SandboxId,
	SandboxUserHome,
	Seconds,
	Timings,
} from '@marimo-hub/core';
import type {
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
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';

/** marimo's hardcoded kernel port (see `SandboxProvisioner`'s `MARIMO_PORT`). */
const DEFAULT_KERNEL_PORT = 2718;
/** Default tag marking sandboxes THIS deployment owns (for manual discovery/cleanup). */
const DEFAULT_OWNER_TAG = 'marimohub';
/** Prefix for the per-sandbox tag that encodes our `SandboxId`. */
const ID_TAG_PREFIX = 'mh-sbx-';
/** Fixed profile mount; a bootstrap symlink exposes it at `/mnt/<email>`. */
const USER_HOME_MOUNT_PATH = '/var/run/marimohub/user-home';
const USER_HOME_KEY_ENV = 'MARIMOHUB_USER_HOME_KEY';

/** Longest a single in-sandbox port wait may block before we re-issue it. */
const PORT_WAIT_CHUNK_MS = 30_000;
/** First such chunk, kept short so a kernel that dies on launch is caught quickly. */
const PORT_WAIT_FIRST_CHUNK_MS = 2_000;
/**
 * How often to poll a fresh sandbox for `running`. The SDK's own default is 1s,
 * which rounds every boot up to the next second; each poll is one control-plane
 * round-trip, so this trades a few extra polls for that rounding.
 */
const BOOT_POLL_INTERVAL_MS = 100;

/**
 * Process states a kernel never comes back from. `failed` is a stream fault (a
 * transient gRPC reset shows up here), `cancelled` a teardown mid-wait; neither
 * carries an exit code, so only the status distinguishes them from `running`.
 */
const TERMINAL_PROCESS_STATUSES = new Set<CommandProcessStatus>(['exited', 'failed', 'cancelled']);

/**
 * CAIOS rejects path-style requests, and boto3 defaults to path style for a
 * custom endpoint with no env var to change it — only the AWS config file works.
 * Runs once per fresh create and leaves an image-supplied config alone. This
 * snippet is best-effort and must not short-circuit the command it precedes.
 */
const AWS_CONFIG_BOOTSTRAP =
	'if [ -n "${AWS_ENDPOINT_URL_S3:-}" ] && [ ! -e "$HOME/.aws/config" ]; then' +
	' mkdir -p "$HOME/.aws" &&' +
	' printf \'[default]\\ns3 =\\n    addressing_style = virtual\\n\' > "$HOME/.aws/config";' +
	' fi;';

export function coreWeaveProfileResources(
	resources: ComputeResources | undefined,
): ResourceOptions | undefined {
	if (!resources || (resources.cpu === undefined && resources.memoryBytes === undefined)) {
		return undefined;
	}
	const values = {
		...(resources.cpu !== undefined ? { cpu: String(resources.cpu) } : {}),
		...(resources.memoryBytes !== undefined
			? { memory: `${Math.ceil(resources.memoryBytes / 1024 ** 2)}Mi` }
			: {}),
	};
	return { requests: { ...values }, limits: { ...values } };
}

function mergeCoreWeaveResources(
	base: ResourceOptions | undefined,
	profile: ResourceOptions,
): ResourceOptions {
	const baseRequests = base && 'requests' in base ? base.requests : (base ?? {});
	const baseLimits = base && 'limits' in base ? base.limits : (base ?? {});
	const profileRequests = 'requests' in profile ? profile.requests : profile;
	const profileLimits = 'limits' in profile ? profile.limits : profile;
	return {
		requests: { ...baseRequests, ...profileRequests },
		limits: { ...baseLimits, ...profileLimits },
	};
}

export interface CoreWeaveConfig {
	/**
	 * CoreWeave Sandbox API key (`CWSANDBOX_API_KEY`). Optional only when a
	 * pre-authenticated client is injected (the W&B gateway path in `wandb.ts`
	 * authenticates via gRPC metadata instead).
	 */
	apiKey?: string;
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
	/** Profile containing the per-user VAST/PVC mount. */
	userHomeProfileNames?: readonly string[];
	/**
	 * Template for the public kernel URL. `{sandboxId}`, `{port}`, and `{host}` are
	 * substituted. Default `https://{sandboxId}-{port}.{host}` where `{host}` is the
	 * `hostname` the provisioner passes (`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`).
	 */
	hostnameTemplate?: string;
	/**
	 * Resolve the public kernel URL for a sandbox at expose time, for runners
	 * that assign per-sandbox addresses instead of a static hostname scheme
	 * (the W&B gateway vends a per-sandbox public IP). Wins over
	 * `hostnameTemplate` when set.
	 */
	resolveExposedUrl?: (sandboxId: string, port: number) => Promise<string>;
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
	/**
	 * CAIOS buckets every sandbox gets automatic credentials for: the Gateway
	 * mints a per-sandbox OIDC token and the runner injects a credential-vending
	 * sidecar with auto-refreshing S3 creds. Requires the org's wif-config on the
	 * Sandbox Gateway (creates fail with NOT_FOUND without it). The config layer
	 * disables hub-minted WIF when this is set — static `AWS_*` env would shadow
	 * the sidecar in the AWS credential chain.
	 */
	objectStorageBuckets?: readonly string[];
	/** Access level for `objectStorageBuckets`. Default `read-write`. */
	objectStoragePermission?: 'read' | 'read-write';
	/**
	 * S3 endpoint and region injected as `AWS_ENDPOINT_URL_S3` and `AWS_REGION`.
	 * These values do not require `objectStorageBuckets`. Pod Identity supplies
	 * credentials but not an endpoint. When buckets are set, the CoreWeave runner
	 * overrides `AWS_ENDPOINT_URL_S3` with `http://cwlota.com` (observed 2026-07).
	 */
	objectStorageEndpoint?: string;
	objectStorageRegion?: string;
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
	/** Block until the sandbox reaches `running`; see `BOOT_POLL_INTERVAL_MS`. */
	wait(options?: { intervalMs?: number }): Promise<unknown>;
	readonly commands: {
		run(command: readonly string[], options?: { cwd?: string }): Promise<ProcessResult>;
		start(command: readonly string[], options?: { cwd?: string }): Promise<CommandProcess>;
	};
	readonly files: {
		readText(path: string): Promise<string>;
		/** Multi-file form only — `writeFiles` is the port's single write path. */
		write(files: FileWrites): Promise<void>;
	};
	delete(): Promise<void>;
}

/** A CoreWeave status that means the sandbox is gone (not a reconnect/teardown target). */
function isDeadStatus(status: SandboxInfo['status']): boolean {
	return status === 'terminated' || status === 'failed' || status === 'completed';
}

let PROC_SEQ = 0;

class CoreWeaveSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private readonly idTag: string;
	private readonly kernelPort: number;
	private sandbox?: CoreWeaveSandbox;
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};
	private lastEnsureTimings?: Timings;
	/** Shell snippet to splice onto the next command; see `takeBootstrap`. */
	private pendingBootstrap?: string;
	/** Directories already `mkdir -p`'d in this sandbox, so re-issuing is skipped. */
	private readonly createdDirs = new Set<string>();
	/** Blocking commands sent to this sandbox — one wide-event field per provision. */
	private execCount = 0;

	constructor(
		private readonly id: SandboxId,
		private readonly config: CoreWeaveConfig,
		private readonly client: CoreWeaveClient,
		/** Reconnect-by-tag before creating. False on a fresh provision (skips a wasted list). */
		private readonly reuse = true,
		private readonly userHome?: SandboxUserHome,
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
		// find = the reconnect lookup, create = the API accepting the start request,
		// boot = reaching `running` (cold start + image pull). create and boot are
		// split because only that says whether the dominant startup cost is a real
		// container start or time spent waiting on a poll.
		const t0 = Date.now();
		const existing = this.reuse ? await this.findByOurId() : undefined;
		const t1 = Date.now();
		// Create-then-wait is what the SDK does internally for
		// `waitUntilRunning: true`, except its wait takes the default 1s poll
		// interval — which rounds every boot up to the next whole second.
		this.sandbox = existing
			? await this.client.fromId(existing.sandboxId)
			: await this.client.create(this.createOptions());
		const t2 = Date.now();
		if (!existing) await this.sandbox.wait({ intervalMs: BOOT_POLL_INTERVAL_MS });
		const t3 = Date.now();
		// Armed, not run: the snippet is spliced onto the first command we were going
		// to send anyway, so it costs no round-trip of its own.
		if (!existing) {
			this.pendingBootstrap = this.createBootstrap();
		}
		this.lastEnsureTimings = { find: t1 - t0, create: t2 - t1, boot: t3 - t2 };
		console.warn(
			JSON.stringify({
				ts: new Date().toISOString(),
				event: 'coreweave_ensure',
				sandbox_id: this.id,
				reconnected: Boolean(existing),
				find_ms: t1 - t0,
				create_ms: t2 - t1,
				boot_ms: t3 - t2,
				...(this.config.profileNames?.length ? { profile_names: this.config.profileNames } : {}),
				...(this.userHome ? { user_home_attached: true } : {}),
			}),
		);
		return this.sandbox;
	}

	/** Resolve the sandbox without spending a command round-trip to prove it is up. */
	async ready(): Promise<void> {
		await this.ensure();
	}

	drainTimings(): Timings {
		const t = this.lastEnsureTimings ?? {};
		this.lastEnsureTimings = undefined;
		return t;
	}

	drainCounters(): Record<string, number> {
		const counters = { execs: this.execCount };
		this.execCount = 0;
		return counters;
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
		const objectStorage = this.objectStorageOptions();
		const environmentVariables = {
			...objectStorage.environmentVariables,
			...(this.userHome ? { [USER_HOME_KEY_ENV]: this.userHome.key } : {}),
		};
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
			...objectStorage,
			...(Object.keys(environmentVariables).length > 0 ? { environmentVariables } : {}),
			// `ensure` runs the readiness wait itself, on a tighter poll interval than
			// the SDK's built-in one.
			waitUntilRunning: false,
		};
	}

	private objectStorageOptions(): Pick<
		SandboxRunOptions,
		'objectStorageAccess' | 'environmentVariables'
	> {
		const buckets = this.config.objectStorageBuckets;
		const env = removeUndefined({
			AWS_ENDPOINT_URL_S3: this.config.objectStorageEndpoint,
			AWS_REGION: this.config.objectStorageRegion,
		});
		return {
			...(buckets?.length
				? {
						objectStorageAccess: {
							buckets,
							permission: this.config.objectStoragePermission ?? 'read-write',
						},
					}
				: {}),
			...(Object.keys(env).length > 0 ? { environmentVariables: env } : {}),
		};
	}

	private needsAwsConfigBootstrap(): boolean {
		return Boolean(this.config.objectStorageBuckets?.length || this.config.objectStorageEndpoint);
	}

	private createBootstrap(): string | undefined {
		const snippets: string[] = [];
		if (this.needsAwsConfigBootstrap()) snippets.push(AWS_CONFIG_BOOTSTRAP);
		if (this.userHome) {
			const parent = this.userHome.path.slice(0, this.userHome.path.lastIndexOf('/')) || '/';
			const mountMissing = `marimohub: user-home profile mount missing at ${USER_HOME_MOUNT_PATH}`;
			const linkFailed = `marimohub: cannot prepare user home at ${this.userHome.path}`;
			snippets.push(
				`if [ ! -d ${shellQuote(USER_HOME_MOUNT_PATH)} ]; then ` +
					`echo ${shellQuote(mountMissing)} >&2; exit 1; fi; ` +
					`if ! mkdir -p ${shellQuote(parent)}; then ` +
					`echo ${shellQuote(linkFailed)} >&2; exit 1; fi; ` +
					`if [ ! -e ${shellQuote(this.userHome.path)} ] && ` +
					`! ln -s ${shellQuote(USER_HOME_MOUNT_PATH)} ${shellQuote(this.userHome.path)}; then ` +
					`echo ${shellQuote(linkFailed)} >&2; exit 1; fi;`,
			);
		}
		return snippets.length > 0 ? snippets.join(' ') : undefined;
	}

	/**
	 * Claim the armed bootstrap (at most once) and splice it ahead of `cmd`. It
	 * needs a shell to resolve `$HOME` or prepare the personal-storage link, so it
	 * rides a command instead of being written as a file, costing no round-trip.
	 */
	private takeBootstrap(cmd: string): string {
		const bootstrap = this.pendingBootstrap;
		if (!bootstrap) return cmd;
		this.pendingBootstrap = undefined;
		return `${bootstrap} ${cmd}`;
	}

	/** Prefix accumulated env vars onto a shell command (the SDK has no per-command env). */
	private withEnv(cmd: string): string {
		return withEnvPrefix(this.takeBootstrap(cmd), this.env, this.envDefaults);
	}

	async exec(cmd: string): Promise<ExecResult> {
		const sandbox = await this.ensure();
		this.execCount++;
		const res = await sandbox.commands.run(['sh', '-lc', this.withEnv(cmd)]);
		return execResult(res.exitCode === 0, res.stdout, res.stderr);
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
			return readFileFailure('READ_FAILED');
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const sandbox = await this.ensure();
		// The SDK's files.write does not create parent dirs, so mkdir first — once for
		// every parent, not per file. Its multi-file write is Promise.all over per-file
		// RPCs, so collapsing these execs (not the writes) is what removes round-trips.
		// Dirs already created in this sandbox are skipped, so a workspace restored in
		// N byte-bounded batches pays one mkdir rather than N.
		const dirs = new Set<string>();
		for (const f of files) {
			const dir = f.path.slice(0, f.path.lastIndexOf('/'));
			if (dir && !this.createdDirs.has(dir)) dirs.add(dir);
		}
		if (dirs.size > 0) {
			await this.exec(`mkdir -p ${[...dirs].map(shellQuote).join(' ')}`);
			for (const dir of dirs) this.createdDirs.add(dir);
		}
		// The SDK's FileContent is `string | Uint8Array`, so bytes pass straight through.
		await sandbox.files.write(files.map((f) => ({ path: f.path, content: f.content })));
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		// Best-effort: the SDK files namespace has no list, so shell out via `find`.
		// Used by `captureWorkspace` on teardown to enumerate the working dir under
		// PERSIST_WORKSPACE=workspace.
		try {
			const res = await this.exec(buildFindFilesCommand(path, options));
			if (!res.success) return listFilesFailure();
			return { success: true, files: parseFindFilesOutput(res.stdout, path, options) };
		} catch {
			return listFilesFailure('BACKEND_ERROR');
		}
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		// shellQuote'd args (via buildGitCloneCommand) close the injection hole the
		// previous raw interpolation left open.
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		// Stored and applied as a shell prefix by withEnv(); the SDK sets env only at
		// create time, and the provisioner never calls this on the hot path.
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
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
				// The SDK exposes no waitForPort, so probe in-sandbox — and loop there
				// too: probing from here cost a command round-trip per attempt on top of
				// the poll interval, quantizing the wait to that grid.
				//
				// Chunked rather than one command spanning the whole timeout, because
				// the gateway's per-command cap is unverified (see INTEGRATION SURFACE
				// above) and each boundary is where a dead kernel gets noticed — the
				// first chunk is short so a launch that fails outright reports fast.
				// `attempts` bounds the loop if the waiter itself returns instantly.
				const deadline = Date.now() + timeout;
				const attempts = Math.ceil(timeout / PORT_WAIT_CHUNK_MS) + 1;
				let chunkMs = PORT_WAIT_FIRST_CHUNK_MS;
				for (let i = 0; i < attempts && Date.now() < deadline; i++) {
					// Status, not poll(): the SDK sets an exit code only on a clean exit,
					// so a stream fault (`failed`) or a cancel leaves poll() undefined and
					// would otherwise burn the whole timeout before reporting.
					if (TERMINAL_PROCESS_STATUSES.has(proc.status)) {
						throw new Error(
							`process ${proc.status} before port ${port} opened.\n${stderr || stdout}`.trim(),
						);
					}
					const seconds = Math.max(1, Math.ceil(Math.min(chunkMs, deadline - Date.now()) / 1000));
					chunkMs = PORT_WAIT_CHUNK_MS;
					if ((await exec(portWaitCommand(port, seconds))).success) return;
				}
				throw new Error(
					`timed out waiting for port ${port} after ${timeout}ms.\n${stderr || stdout}`,
				);
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				return { stdout, stderr };
			},
		};
	}

	async exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		const sandbox = await this.ensure();
		if (this.config.resolveExposedUrl) {
			return { url: await this.config.resolveExposedUrl(sandbox.sandboxId, port) };
		}
		// Without a resolver, construct the public URL from a template (the kernel
		// port was declared `public` at create). Integration surface — the exact
		// ingress hostname scheme is CoreWeave backend/profile specific.
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
			if (!this.config.apiKey) {
				throw new Error(
					'CoreWeaveCompute requires either an apiKey in its config or an injected client',
				);
			}
			// The real SDK client exposes the CoreWeaveClient surface at runtime; one
			// controlled cast at the construction boundary avoids overload-variance
			// friction between the SDK's broad signatures and our narrow seam.
			// oxlint-disable-next-line anti-slop/no-chained-type-assertions
			this.client = createSandboxClient({
				apiKey: this.config.apiKey,
				...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
			}) as unknown as CoreWeaveClient;
		}
		return this.client;
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		if (options?.userHome && !this.config.userHomeProfileNames?.length) {
			throw new Error('A CoreWeave user-home profile is required for personal storage');
		}
		const resources = coreWeaveProfileResources(options?.resources);
		const config =
			options?.image || resources || options?.userHome
				? {
						...this.config,
						...(options?.image ? { image: options.image } : {}),
						...(options?.userHome ? { profileNames: this.config.userHomeProfileNames } : {}),
						...(resources
							? { resources: mergeCoreWeaveResources(this.config.resources, resources) }
							: {}),
					}
				: this.config;
		return new CoreWeaveSandboxInstance(
			id,
			config,
			this.getClient(),
			options?.reuse ?? true,
			options?.userHome,
		);
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

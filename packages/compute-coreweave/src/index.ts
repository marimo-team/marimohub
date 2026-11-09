/**
 * CoreWeave Sandbox compute adapter — a `SandboxProvider` backed by CoreWeave
 * Sandboxes via the published `@coreweave/cwsandbox` SDK (Sandbox v1, Node gRPC
 * transport). Like the Modal adapter, this targets the Node/Kubernetes
 * control plane (`apps/server`); the SDK transport is gRPC, so it is NOT usable
 * from a Workers runtime, and `proxy()` is a no-op (the SPA hits the kernel's
 * public-ingress URL directly).
 *
 * Bridging the port to the SDK (the SDK is shaped quite differently):
 *  - `create(id)` is synchronous and id-addressed, but the SDK creates sandboxes
 *    asynchronously and assigns its OWN `sandboxId`. We return a lazy instance and
 *    resolve the real sandbox on first use (`ensure()`): cached handle → Get by a
 *    provider id this process saw running → reconnect to the sandbox tagged with
 *    our id → else create one. We tag every sandbox with
 *    `idTag(ourId)` so the API can re-resolve an instance for teardown
 *    (`compute.create(id).destroy()`) and so file-copy teardown reconnects to the
 *    SAME sandbox before saving notebook files back.
 *  - Ports/network are CREATE-time options, but the provisioner exposes the kernel
 *    port (2718) only later. `ensure()` declares a public `services` entry for the
 *    kernel port at create so the later `exposePort` is reachable.
 *  - The sandbox MAIN process is the SDK keep-alive; marimo runs as a streamed
 *    COMMAND (`commands.start`), not the main process.
 *  - The SDK has no `waitForPort`. Combined launch detects readiness inside its
 *    command stream; the compatibility `startProcess` path probes via `exec`.
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
 * same caveat the Modal adapter carries): the kernel `services` declaration
 * (public visibility; a product endpoint only with `kernelEndpoint`, which the
 * managed serverless pool requires); the public kernel URL is CONSTRUCTED from a hostname template (inspect's
 * `serviceUrls` is assigned-not-edge-ready per the SDK docs); and the
 * `waitForPort` probe assumes `python3` is on the image PATH.
 *
 * Per-create targeting is an org-scoped **sandbox template**
 * (`runFromTemplate`): `templateId` selects the template every sandbox is
 * created from, and a sandbox with a `userHome` uses `userHomeTemplateId` (a
 * template mounting the per-user volume) instead. Without a template,
 * sandboxes run under the default policy of the runner named by `runnerId` —
 * a create with no runner ids schedules on the MANAGED SERVERLESS pool, not
 * the caller's cluster, so CKS deployments must keep `runnerId` set (the
 * config layer defaults it).
 */
import {
	CWSandboxConfigurationError,
	CWSandboxFailedError,
	CWSandboxNotFoundError,
	CWSandboxResourceExhaustedError,
	CWSandboxTerminatedError,
	CWSandboxTimeoutError,
	CWSandboxUnavailableError,
	CWSandboxValidationError,
} from '@coreweave/cwsandbox';
import type {
	CommandProcess,
	CommandProcessStatus,
	DataPlaneMode,
	Endpoint,
	FileWrites,
	ListSandboxesResult,
	ProcessResult,
	ResourceOptions,
	SandboxInfo,
	SandboxRunFromTemplateOptions,
	SandboxRunOptions,
	SandboxStatus,
	Service,
	ServiceUrl,
} from '@coreweave/cwsandbox';
import { forEachConcurrentUntilFailure, withDeadline } from '@marimo-hub/core/async';
import type { DeadlineOptions } from '@marimo-hub/core/async';
import { BoundedLruMap } from '@marimo-hub/core/cache';
import { Semaphore } from '@marimo-hub/core/concurrency';
import {
	createSandboxClient,
	DEFAULT_BASE_URL,
	DEFAULT_CONTAINER_IMAGE,
	DEFAULT_KEEP_ALIVE_COMMAND,
} from '@coreweave/cwsandbox/node';
import type { KernelIngressPublisher } from './kernelIngress';
import {
	batchFileWrites,
	encodeFileWriteBatch,
	WRITE_BATCH_COMMAND,
	readBoundedFile,
	collectBoundedOutput,
	LAUNCH_MARKER_GRACE_MS,
	launchTimeoutResult,
	buildFindFilesCommand,
	buildGitCloneCommand,
	buildLaunchCommand,
	classifyListFilesFailure,
	errorMessage,
	iterableToStream,
	launchOutcomeResult,
	LaunchProtocolTracker,
	OutputTail,
	parseLaunchOutput,
	parseFindFilesOutput,
	portWaitCommand,
	removeUndefined,
	shellQuote,
	transportFailureResult,
	LaunchSetupOutput,
	ShellEnvironment,
	privateEnvironmentWriteCommand,
} from '@marimo-hub/compute-commons';
import type { LaunchProtocolOutcome } from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core/ids';
import { logOperationalError } from '@marimo-hub/core/operational-log';
import { sleep } from '@marimo-hub/core/duration';
import type { Seconds } from '@marimo-hub/core/duration';
import type { Timings } from '@marimo-hub/core/timing';
import { logEvent } from '@marimo-hub/core/logs';
import type {
	BoundedReadOptions,
	ComputeResources,
	SandboxUserHome,
	CreateSandboxOptions,
	ConnectSandboxOptions,
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
	WaitForPortOptions,
} from '@marimo-hub/core/ports/sandbox';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports/sandbox';
import { instrumentCoreWeaveClient } from './tracing';

/** marimo's hardcoded kernel port (see `SandboxProvisioner`'s `MARIMO_PORT`). */
const DEFAULT_KERNEL_PORT = 2718;
/** Default tag marking sandboxes THIS deployment owns (for manual discovery/cleanup). */
const DEFAULT_OWNER_TAG = 'marimohub';
/** Prefix for the per-sandbox tag that encodes our `SandboxId`. */
const ID_TAG_PREFIX = 'mh-sbx-';
/** Fixed template mount; a bootstrap symlink exposes it at `/mnt/<email>`. */
const USER_HOME_MOUNT_PATH = '/var/run/marimohub/user-home';
const USER_HOME_KEY_ENV = 'MARIMOHUB_USER_HOME_KEY';

/** Longest a single in-sandbox port wait may block before we re-issue it. */
const PORT_WAIT_CHUNK_MS = 30_000;
/** First such chunk, kept short so a kernel that dies on launch is caught quickly. */
const PORT_WAIT_FIRST_CHUNK_MS = 2_000;
/**
 * A container start on a warm node is ~1–6 s. Above this, `boot` is almost
 * always the node pulling the sandbox image because the tag was not in its
 * cache (a cold registry pull of the ~650 MB image is 16–30 s), which the
 * operator fixes by pre-pulling the configured tags on the sandbox node pool.
 */
const SLOW_BOOT_MS = 10_000;
const SLOW_BOOT_HINT =
	'boot > 10 s usually means the node cold-pulled the sandbox image; pre-pull the configured image tags on the sandbox node pool';

const PROCESS_CANCEL_TIMEOUT_MS = 1_000;
/** Backoff for transient file transport or admission failures. */
const WRITE_RETRY_DELAYS_MS = [250, 1_000, 3_000];
const MAX_FILE_WRITE_RETRY_DELAY_MS = 10_000;

const GATEWAY_FILE_WRITE_SLOTS = 8;
// Leave direct admission headroom for commands alongside workspace/injection/bridge writes.
const DIRECT_FILE_WRITE_SLOTS = 2;

function fileWriteLimit(mode: DataPlaneMode | undefined): number {
	return mode === 'gateway' ? GATEWAY_FILE_WRITE_SLOTS : DIRECT_FILE_WRITE_SLOTS;
}
// Workspace files can be several MiB; the bound exists so a hung RPC releases its slot.
const FILE_WRITE_TIMEOUT_MS = 60_000;

interface FileWriteBatchState {
	dispatched: number;
	failed: boolean;
	retryCount: number;
	backoffMs: number;
	directAdmissionLimited: boolean;
}

function fileWriteRetryDelay(error: unknown, attempt: number): number | undefined {
	if (
		(!(error instanceof CWSandboxUnavailableError) &&
			!(error instanceof CWSandboxResourceExhaustedError)) ||
		attempt >= WRITE_RETRY_DELAYS_MS.length
	)
		return;
	const suggested = error.retryDelayMs;
	if (suggested === undefined || !Number.isFinite(suggested) || suggested < 0)
		return WRITE_RETRY_DELAYS_MS[attempt];
	// Do not ignore a long server cooldown or turn it into an unbounded sleep.
	if (suggested > MAX_FILE_WRITE_RETRY_DELAY_MS) return;
	return Math.max(WRITE_RETRY_DELAYS_MS[attempt], Math.ceil(suggested));
}

// The budget already covers retries; `retryable: false` stops core from spending it again.
function markRetryBudgetSpent<E extends Error>(error: E): E & { retryable: false } {
	return Object.assign(error, { retryable: false as const });
}

function fileWriteTimeout(sandboxId: string, filepath: string, cause?: unknown) {
	return markRetryBudgetSpent(
		new CWSandboxTimeoutError('File write retry budget expired', {
			operation: 'Write sandbox file',
			sandboxId,
			filepath,
			cause,
		}),
	);
}

function exhaustedFileWriteError(error: unknown): unknown {
	return error instanceof CWSandboxUnavailableError ||
		error instanceof CWSandboxResourceExhaustedError
		? markRetryBudgetSpent(error)
		: error;
}

/**
 * Keyed by provider sandbox ID so handles within one provider share the cap.
 * Other server processes still rely on runner admission and bounded retries.
 */
class SandboxFileWriteSlots {
	private readonly bySandbox = new Map<string, Semaphore>();

	constructor(private readonly limit: number) {}

	async run<T>(
		sandboxId: string,
		fn: () => Promise<T>,
		deadline?: Pick<DeadlineOptions, 'timeoutMs' | 'timeoutError'>,
	): Promise<T> {
		const slots = this.bySandbox.get(sandboxId) ?? new Semaphore(this.limit);
		this.bySandbox.set(sandboxId, slots);
		const controller = new AbortController();
		const timer = deadline
			? setTimeout(() => controller.abort(deadline.timeoutError()), deadline.timeoutMs)
			: undefined;
		try {
			return await slots.run(() => {
				clearTimeout(timer);
				return fn();
			}, controller.signal);
		} finally {
			clearTimeout(timer);
			if (slots.available === this.limit) this.bySandbox.delete(sandboxId);
		}
	}
}

/**
 * The SDK's `wait()` backs off from 200 ms by 1.5x to a 2 s cap, so it noticed `running` up
 * to 2 s late. A flat interval costs a few extra Gets per cold start.
 */
const READY_POLL_INTERVAL_MS = 250;
// The SDK `wait()` defaults this loop replaces: overall deadline, per-Get timeout, and the
// window in which transient Get failures are retried.
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_RPC_TIMEOUT_MS = 15_000;
const READY_POLL_RETRY_BUDGET_MS = 30_000;
const READY_POLL_MAX_RETRY_DELAY_MS = 2_000;
const READY_WAIT_OPERATION = 'Wait for sandbox';

const PROVIDER_ID_CACHE_LIMIT = 4096;

async function cancelLaunchProcess(proc: CommandProcess): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			proc.cancel(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new DOMException('Process cancellation timed out', 'TimeoutError')),
					PROCESS_CANCEL_TIMEOUT_MS,
				);
			}),
		]);
	} catch (error) {
		logOperationalError(
			'sandbox_process_cancel_failed',
			{ operation: 'coreweave.cancel_launch_process' },
			error,
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

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
	/** Defaults to auto, which allows Gateway fallback when a runner is unreachable. */
	dataPlaneMode?: DataPlaneMode;
	/** Container image with marimo + uv + python. Defaults to the SDK's `python:3.11`. */
	image?: string;
	/** Port marimo binds inside the sandbox; declared public at create. Default 2718. */
	kernelPort?: number;
	/** Tag applied to every sandbox we own (manual discovery/cleanup). Default `marimohub`. */
	ownerTag?: string;
	/**
	 * Runner (by operator-assigned id) sandboxes schedule on; supplying one
	 * makes creates target the caller's own CKS cluster. Omit only for the
	 * managed serverless pool.
	 */
	runnerId?: string;
	/**
	 * Visibility declared for the kernel service. `public` needs a runner with
	 * HTTPS endpoint routes; a CKS runner without them rejects it and instead
	 * exposes a `custom` service (reachable from the sources the sandbox
	 * template's `network.ingress` declares) as a bare ClusterIP Service, which
	 * `kernelIngress` then publishes. Default `public`.
	 */
	kernelVisibility?: 'public' | 'custom';
	/**
	 * Product endpoint requested on each service. The managed serverless pool
	 * rejects a bare `public` service and only assigns ingress through an HTTPS
	 * endpoint, whose URL then arrives on `serviceUrls`.
	 */
	kernelEndpoint?: Endpoint;
	/** Publishes each kernel's hostname (an Ingress in the sandbox namespace). */
	kernelIngress?: KernelIngressPublisher;
	/** Secondary-surface ports reserved when the sandbox is created. */
	extraPorts?: readonly number[];
	/**
	 * Org-scoped sandbox template every sandbox is created from (custom specs:
	 * GPU placement, egress rules, pod shape). Omit to use the runner's
	 * default policy.
	 */
	templateId?: string;
	/**
	 * Sandbox template mounting the per-user volume at `USER_HOME_MOUNT_PATH`
	 * (`subPathExpr` on the injected `MARIMOHUB_USER_HOME_KEY` env var). Used
	 * only for editor sandboxes carrying a `userHome`; must differ from
	 * `templateId` so apps and viewer sandboxes never receive the mount.
	 */
	userHomeTemplateId?: string;
	/**
	 * Template for the public kernel URL. `{sandboxId}`, `{port}`, and `{host}` are
	 * substituted. Default `https://{sandboxId}-{port}.{host}` where `{host}` is the
	 * `hostname` the provisioner passes (`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`).
	 */
	hostnameTemplate?: string;
	/**
	 * Resolve the public kernel URL for a sandbox at expose time, for runners
	 * that assign per-sandbox addresses instead of a static hostname scheme
	 * (the W&B gateway vends a per-sandbox URL). Wins over `hostnameTemplate`
	 * when set. Receives the live sandbox handle so a resolver can read
	 * `serviceUrls` off it without a Get round-trip.
	 */
	resolveExposedUrl?: (sandbox: CoreWeaveSandbox, port: number) => Promise<string>;
	/** Optional CPU/memory request (and limit) for each sandbox. */
	resources?: ResourceOptions;
	/**
	 * Hard cap on sandbox lifetime. Belt-and-suspenders orphan protection.
	 * The CoreWeave SDK takes seconds directly (unlike e2b, which wants ms).
	 */
	maxLifetimeSeconds?: Seconds;
	/**
	 * Enable CoreWeave-native filesystem snapshots (full-env restore on the next
	 * session). Off by default. Currently INERT: the SDK now exposes the
	 * snapshot API (`fileSystemSnapshot`/`snapshot()`), but the capture/restore
	 * implementation has not landed yet.
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
	runFromTemplate(
		templateId: string,
		options?: SandboxRunFromTemplateOptions,
	): Promise<CoreWeaveSandbox>;
	fromId(sandboxId: string): Promise<CoreWeaveSandbox>;
	list(options?: {
		tags?: readonly string[];
		showTerminated?: boolean;
		pageSize?: number;
		pageToken?: string;
	}): Promise<ListSandboxesResult>;
	delete(sandboxId: string): Promise<void>;
}

/** The slice of the SDK's `Sandbox` handle this adapter uses. */
export interface CoreWeaveSandbox {
	readonly sandboxId: string;
	/**
	 * Per-service public URLs from the handle's last metadata refresh (create,
	 * readiness polls, and reconnect Gets all update it) — readable without an
	 * extra round-trip by `resolveExposedUrl` implementations.
	 */
	readonly serviceUrls?: readonly ServiceUrl[] | undefined;
	/** Last observed status, from the same metadata refresh as `serviceUrls`. */
	readonly status?: SandboxStatus | undefined;
	/** One Get; it also refreshes `status` and `serviceUrls`. */
	getStatus(options?: { timeoutMs?: number }): Promise<SandboxStatus>;
	readonly commands: {
		run(
			command: readonly string[],
			options?: { cwd?: string; timeoutMs?: number },
		): Promise<ProcessResult>;
		start(
			command: readonly string[],
			options?: { cwd?: string; timeoutMs?: number; bufferedMaxKiB?: number; stdin?: boolean },
		): Promise<
			CommandProcess & {
				stdin?: {
					write(data: string | Uint8Array, options?: { timeoutMs?: number }): Promise<void>;
					close(options?: { timeoutMs?: number }): Promise<void>;
				};
			}
		>;
	};
	readonly files: {
		readText(path: string): Promise<string>;
		/** Multi-file form only — `writeFiles` is the port's single write path. */
		write(files: FileWrites, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
		writeStream?(
			path: string,
			source: Uint8Array,
			options?: { timeoutMs?: number; signal?: AbortSignal },
		): Promise<void>;
	};
	delete(): Promise<void>;
}

/** A CoreWeave status that means the sandbox is gone (not a reconnect/teardown target). */
function isDeadStatus(status: SandboxInfo['status']): boolean {
	return status === 'terminated' || status === 'failed' || status === 'completed';
}

function isTransientPollError(error: unknown): boolean {
	return (
		error instanceof CWSandboxUnavailableError ||
		error instanceof CWSandboxTimeoutError ||
		error instanceof CWSandboxResourceExhaustedError
	);
}

function readinessTimeout(sandboxId: string): CWSandboxTimeoutError {
	return new CWSandboxTimeoutError(
		`Timed out waiting for sandbox '${sandboxId}' to reach status 'running'.`,
		{ operation: READY_WAIT_OPERATION, sandboxId },
	);
}

/**
 * Poll until the sandbox leaves its boot states, with the SDK `wait()`'s deadline, transient
 * retry, and terminal-status errors. Returns the status that ended the wait.
 */
async function waitUntilRunning(
	sandbox: CoreWeaveSandbox,
	onPoll: () => void,
): Promise<SandboxStatus> {
	const { sandboxId } = sandbox;
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let retryUntil: number | undefined;
	let retries = 0;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw readinessTimeout(sandboxId);
		let status: SandboxStatus | undefined;
		try {
			onPoll();
			status = await sandbox.getStatus({
				timeoutMs: Math.min(READY_POLL_RPC_TIMEOUT_MS, remaining),
			});
		} catch (error) {
			if (Date.now() >= deadline) throw readinessTimeout(sandboxId);
			if (!isTransientPollError(error)) throw error;
			retryUntil ??= Date.now() + READY_POLL_RETRY_BUDGET_MS;
			if (Date.now() >= retryUntil) throw error;
		}
		let delay = READY_POLL_INTERVAL_MS;
		if (status === undefined) {
			delay = Math.min(READY_POLL_INTERVAL_MS * 2 ** retries++, READY_POLL_MAX_RETRY_DELAY_MS);
		} else {
			retryUntil = undefined;
			retries = 0;
			if (status === 'running' || status === 'paused' || status === 'completed') return status;
			// The SDK reads an unspecified status as completed.
			if (status === 'unspecified') return 'completed';
			if (status === 'failed') {
				throw new CWSandboxFailedError(`Sandbox '${sandboxId}' failed to start`, {
					operation: READY_WAIT_OPERATION,
					sandboxId,
				});
			}
			// The SDK's wait() keeps polling through terminating; it cannot come back, so fail fast.
			if (status === 'terminated' || status === 'terminating') {
				throw new CWSandboxTerminatedError(`Sandbox '${sandboxId}' was terminated`, {
					operation: READY_WAIT_OPERATION,
					sandboxId,
				});
			}
		}
		const wait = Math.min(delay, deadline - Date.now());
		if (wait > 0) await sleep(wait);
	}
}

let PROC_SEQ = 0;

function reconnectSandboxId(reference: string, hubId: SandboxId): string | undefined {
	try {
		if (reference.length > 4096) throw new Error('Reference exceeds size limit');
		const value: unknown = JSON.parse(reference);
		if (
			typeof value === 'object' &&
			value !== null &&
			!Array.isArray(value) &&
			Object.keys(value).length === 3 &&
			'kind' in value &&
			value.kind === 'coreweave-v1' &&
			'hubId' in value &&
			value.hubId === hubId &&
			'sandboxId' in value &&
			typeof value.sandboxId === 'string' &&
			value.sandboxId.length > 0 &&
			value.sandboxId.length <= 256
		)
			return value.sandboxId;
	} catch {
		// Never include the opaque record in errors or logs.
	}
	return undefined;
}

class CoreWeaveSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	readonly supportsLaunchSetupOutput = true;
	private readonly idTag: string;
	private readonly kernelPort: number;
	private sandbox?: CoreWeaveSandbox;
	private readonly reconnectId?: string;
	private readonly invalidReference: boolean = false;
	private lastEnsureTimings?: Timings;
	/** Shell snippet to splice onto the next command; see `takeBootstrap`. */
	private pendingBootstrap?: string;
	private packedWritesAvailable = true;
	/** Blocking commands sent to this sandbox — one wide-event field per provision. */
	private execCount = 0;
	private counters = {
		file_writes: 0,
		file_write_waves: 0,
		env_writes: 0,
		stream_execs: 0,
		status_polls: 0,
	};
	private firstDataplaneStarted = false;
	private dataplaneTimings: Timings = {};
	private readonly exposures = new Map<string, Promise<void>>();

	private async dataplane<T>(call: () => Promise<T>): Promise<T> {
		if (this.firstDataplaneStarted) return call();
		this.firstDataplaneStarted = true;
		const started = Date.now();
		try {
			return await call();
		} finally {
			this.dataplaneTimings.first_dataplane = Date.now() - started;
		}
	}

	constructor(
		private readonly id: SandboxId,
		private readonly config: CoreWeaveConfig,
		private readonly client: CoreWeaveClient,
		private readonly providerIds: BoundedLruMap<SandboxId, string>,
		/** Reconnect-by-tag before creating. False on a fresh provision (skips a wasted list). */
		private readonly reuse = true,
		private readonly userHome?: SandboxUserHome,
		private readonly existingOnly = false,
		reference?: string,
		private readonly fileWriteSlots = new SandboxFileWriteSlots(
			fileWriteLimit(config.dataPlaneMode),
		),
	) {
		this.idTag = ID_TAG_PREFIX + id;
		if (reference !== undefined) {
			this.reconnectId = reconnectSandboxId(reference, id);
			this.invalidReference = this.reconnectId === undefined;
		}
		this.kernelPort = config.kernelPort ?? DEFAULT_KERNEL_PORT;
	}

	get reconnectReference(): string | undefined {
		if (this.sandbox?.status !== 'running') return;
		return JSON.stringify({
			kind: 'coreweave-v1',
			hubId: this.id,
			sandboxId: this.sandbox.sandboxId,
		});
	}

	/**
	 * Resolve the underlying CoreWeave sandbox, creating it on first use. Reconnect
	 * (rather than create) when a sandbox already carries our id tag — required so a
	 * re-resolved instance (teardown's `compute.create(id)`) operates on the SAME
	 * sandbox, e.g. to read notebook files back before destroy.
	 */
	private async ensure(): Promise<CoreWeaveSandbox> {
		// Thrown on first use, not at attach, so warm-pool readiness reports it as reconnect_failed.
		this.assertValidReference();
		if (this.sandbox) return this.sandbox;
		this.environment.invalidate();
		// find = the reconnect lookup, create = the API accepting the start request,
		// boot = reaching `running` (cold start + image pull). create and boot are
		// split because only that says whether the dominant startup cost is a real
		// container start or time spent waiting on a poll.
		const t0 = Date.now();
		const cached = this.reconnectId || !this.reuse ? undefined : await this.fromCachedId();
		const existing =
			this.reconnectId || !this.reuse || cached ? undefined : await this.findByOurId();
		if (this.existingOnly && !this.reconnectId && !cached && existing?.status !== 'running') {
			throw new Error(`CoreWeave sandbox ${this.id} is no longer available`);
		}
		const t1 = Date.now();
		// Create-then-wait (rather than `waitUntilRunning: true`) keeps the create
		// and boot phases separately measurable for the wide event below.
		const sandbox =
			cached ??
			(this.reconnectId
				? await this.client.fromId(this.reconnectId)
				: existing
					? await this.client.fromId(existing.sandboxId)
					: this.config.templateId
						? await this.client.runFromTemplate(this.config.templateId, this.templateOptions())
						: await this.client.create(this.createOptions()));
		const t2 = Date.now();
		if (
			this.reconnectId &&
			(sandbox.sandboxId !== this.reconnectId || sandbox.status !== 'running')
		) {
			throw new Error('CoreWeave saved sandbox is no longer available');
		}
		this.sandbox = sandbox;
		const fresh = !this.reconnectId && !cached && !existing;
		// `wait()` semantics treat a `completed` sandbox as a satisfied running-wait.
		// For us the keep-alive exiting during boot is a failed provision — surface it
		// here with the real cause rather than as NOT_FOUND on the first command.
		if (
			fresh &&
			(await waitUntilRunning(sandbox, () => this.counters.status_polls++)) === 'completed'
		) {
			throw new Error(
				`CoreWeave sandbox ${sandbox.sandboxId} completed before running (main process exited during boot)`,
			);
		}
		const t3 = Date.now();
		// Armed, not run: the snippet is spliced onto the first command we were going
		// to send anyway, so it costs no round-trip of its own.
		if (fresh) {
			this.pendingBootstrap = this.createBootstrap();
		}
		if (sandbox.status === 'running') this.providerIds.set(this.id, sandbox.sandboxId);
		const byId = Boolean(this.reconnectId || cached);
		this.lastEnsureTimings = {
			find: byId ? 0 : t1 - t0,
			create: byId ? 0 : t2 - t1,
			...(byId ? { get: t2 - t0 } : {}),
			boot: byId ? 0 : t3 - t2,
		};
		logEvent(
			{
				event: 'coreweave_ensure',
				sandbox_id: this.id,
				reconnected: !fresh,
				...(this.reconnectId ? { reconnect_by_reference: true } : {}),
				...(cached ? { reconnect_by_cached_id: true } : {}),
				find_ms: byId ? 0 : t1 - t0,
				create_ms: byId ? 0 : t2 - t1,
				...(byId ? { get_ms: t2 - t0 } : {}),
				boot_ms: byId ? 0 : t3 - t2,
				...(t3 - t2 > SLOW_BOOT_MS ? { slow_boot_hint: SLOW_BOOT_HINT } : {}),
				...(this.config.templateId ? { template_id: this.config.templateId } : {}),
				...(this.userHome ? { user_home_attached: true } : {}),
			},
			{ channel: 'warn' },
		);
		return this.sandbox;
	}

	private assertValidReference(): void {
		if (this.invalidReference) {
			throw new CWSandboxConfigurationError('Invalid CoreWeave sandbox reconnect reference');
		}
	}

	/** Get the sandbox this process last saw running for our id; undefined means use the tag lookup. */
	private async fromCachedId(): Promise<CoreWeaveSandbox | undefined> {
		const providerId = this.providerIds.get(this.id);
		if (providerId === undefined) return;
		try {
			const sandbox = await this.client.fromId(providerId);
			if (sandbox.sandboxId === providerId && sandbox.status === 'running') return sandbox;
		} catch {
			// The tag lookup is authoritative and reports its own errors.
		}
		// Another instance may have cached a newer provider id meanwhile; keep it.
		if (this.providerIds.peek(this.id) === providerId) this.providerIds.delete(this.id);
	}

	/** Resolve the sandbox without spending a command round-trip to prove it is up. */
	async ready(): Promise<void> {
		await this.ensure();
	}

	drainTimings(): Timings {
		const t = { ...this.lastEnsureTimings, ...this.dataplaneTimings };
		this.dataplaneTimings = {};
		this.lastEnsureTimings = undefined;
		return t;
	}

	drainCounters(): Record<string, number> {
		const counters = { execs: this.execCount, ...this.counters };
		for (const key of Object.keys(this.counters) as (keyof typeof this.counters)[])
			this.counters[key] = 0;
		this.execCount = 0;
		return counters;
	}

	/** Find a live sandbox tagged with our id (tags are a request-side filter only). */
	private async findByOurId(): Promise<SandboxInfo | undefined> {
		// Listing is active-only by default (`showTerminated` opts in to more).
		const { sandboxes } = await this.client.list({ tags: [this.idTag] });
		return sandboxes.find((s) => !isDeadStatus(s.status));
	}

	/**
	 * Services request a product endpoint only when `kernelEndpoint` is set;
	 * otherwise exposure depends on the runner's network configuration.
	 */
	private kernelServices(): readonly Service[] {
		const visibility = this.config.kernelVisibility ?? 'public';
		const endpoint = this.config.kernelEndpoint ? { endpoint: this.config.kernelEndpoint } : {};
		return [
			{ name: 'kernel', port: this.kernelPort, protocol: 'tcp', visibility, ...endpoint },
			...(this.config.extraPorts ?? []).map((port) => ({
				// Names reach pod container-port names; keep them unique + DNS-safe.
				name: `port-${port}`,
				port,
				protocol: 'tcp' as const,
				visibility,
				...endpoint,
			})),
		];
	}

	private environmentVariables(): Record<string, string> {
		return {
			...this.objectStorageOptions().environmentVariables,
			...(this.userHome ? { [USER_HOME_KEY_ENV]: this.userHome.key } : {}),
		};
	}

	private createOptions(): SandboxRunOptions {
		const environmentVariables = this.environmentVariables();
		return {
			containerImage: this.config.image ?? DEFAULT_CONTAINER_IMAGE,
			services: this.kernelServices(),
			tags: [this.config.ownerTag ?? DEFAULT_OWNER_TAG, this.idTag],
			// Targets the caller's CKS cluster (the SDK co-emits CKS mode).
			// Without it a v1 create schedules on the managed serverless pool.
			...(this.config.runnerId ? { runnerIds: [this.config.runnerId] } : {}),
			...(this.config.resources ? { resources: this.config.resources } : {}),
			...(this.config.maxLifetimeSeconds
				? { maxLifetimeSeconds: this.config.maxLifetimeSeconds }
				: {}),
			...this.objectStorageOptions(),
			...(Object.keys(environmentVariables).length > 0 ? { environmentVariables } : {}),
			// `ensure` runs the readiness wait itself so create and boot time are
			// measured separately.
			waitUntilRunning: false,
		};
	}

	/**
	 * Overlay for a template create. Field semantics are replace-on-presence:
	 * our tags/services/env replace the template's (the id tag must win for
	 * reconnect), everything unspecified is inherited from the template.
	 */
	private templateOptions(): SandboxRunFromTemplateOptions {
		// The v1 template overlay has no object-storage field: with a template,
		// `objectStorageBuckets` only drives the AWS env/bootstrap below, and the
		// template itself must declare the matching `object_storage_access`.
		const environmentVariables = this.environmentVariables();
		return {
			// `containerImage` REPLACES the template's spec container, so the
			// keep-alive must be re-supplied (runFromTemplate injects no command).
			// Mounts declared in the template's admin `attachments` survive the
			// replacement (verified on CKS 2026-08-27), and the user-home path
			// depends on the overlay: `subPathExpr` needs MARIMOHUB_USER_HOME_KEY on
			// the container, which only a container overlay delivers.
			containerImage: this.config.image ?? DEFAULT_CONTAINER_IMAGE,
			command: DEFAULT_KEEP_ALIVE_COMMAND,
			...(this.config.resources ? { resources: this.config.resources } : {}),
			services: this.kernelServices(),
			tags: [this.config.ownerTag ?? DEFAULT_OWNER_TAG, this.idTag],
			...(this.config.runnerId ? { runnerIds: [this.config.runnerId] } : {}),
			...(this.config.maxLifetimeSeconds
				? { maxLifetimeSeconds: this.config.maxLifetimeSeconds }
				: {}),
			...(Object.keys(environmentVariables).length > 0 ? { environmentVariables } : {}),
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
			const mountMissing = `marimohub: user-home template mount missing at ${USER_HOME_MOUNT_PATH}`;
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

	private async runRaw(
		cmd: string,
		input: string | Uint8Array,
		options?: ExecOptions,
	): Promise<{ result: ExecResult; exitCode: number | undefined }> {
		const sandbox = await this.ensure();
		this.counters.stream_execs++;
		const process = await this.dataplane(() =>
			sandbox.commands.start(['sh', '-c', cmd], {
				stdin: true,
				timeoutMs: options?.timeout ?? 10_000,
				bufferedMaxKiB: 0,
			}),
		);
		try {
			if (!process.stdin) throw new Error('Sandbox command does not support stdin');
			const output = collectBoundedOutput(
				{
					stdout: iterableToStream(process.stdout),
					stderr: iterableToStream(process.stderr),
					wait: (signal) => process.wait({ signal }),
				},
				{ maxOutputBytes: options?.maxOutputBytes ?? 4096, timeout: options?.timeout ?? 10_000 },
			);
			output.catch(() => {});
			const stdin = process.stdin;
			const sending = (async () => {
				await stdin.write(input, { timeoutMs: options?.timeout ?? 10_000 });
				await stdin.close({ timeoutMs: options?.timeout ?? 10_000 });
			})();
			const [, { stdout, stderr, result }] = await Promise.all([
				sending.catch((error) => {
					// A missing receiver can exit before the SDK accepts stdin.
					if (process.poll() !== 127) throw error;
				}),
				output,
			]);
			return {
				result: execResult(result.exitCode === 0, stdout, stderr),
				exitCode: result.exitCode,
			};
		} finally {
			await cancelLaunchProcess(process);
		}
	}

	async execInput(cmd: string, input: Uint8Array, options?: ExecOptions): Promise<ExecResult> {
		await this.ensure();
		this.execCount++;
		const { result } = await this.runRaw(this.takeBootstrap(cmd), input, options);
		return result;
	}

	private readonly environment = new ShellEnvironment(async (path, content) => {
		this.counters.env_writes++;
		const { result } = await this.runRaw(privateEnvironmentWriteCommand(path), content);
		if (!result.success) throw new Error('Could not prepare sandbox environment');
	});

	private async withEnv(cmd: string, extra: Record<string, string> = {}): Promise<string> {
		const prefix = await this.environment.command('', extra);
		return `${prefix}${this.takeBootstrap(cmd)}`;
	}
	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const sandbox = await this.ensure();
		this.execCount++;
		if (options?.maxOutputBytes !== undefined) {
			const command = await this.withEnv(cmd);
			this.counters.stream_execs++;
			const proc = await this.dataplane(() =>
				sandbox.commands.start(['sh', '-lc', command], {
					timeoutMs: options.timeout,
					bufferedMaxKiB: 0,
				}),
			);
			try {
				const { stdout, stderr, result } = await collectBoundedOutput(
					{
						stdout: iterableToStream(proc.stdout),
						stderr: iterableToStream(proc.stderr),
						wait: (signal) => proc.wait({ signal }),
					},
					{ maxOutputBytes: options.maxOutputBytes, timeout: options.timeout },
				);
				return execResult(result.exitCode === 0, stdout, stderr);
			} finally {
				void cancelLaunchProcess(proc);
			}
		}
		const command = await this.withEnv(cmd);
		const res = await this.dataplane(() =>
			sandbox.commands.run(['sh', '-lc', command], {
				timeoutMs: options?.timeout,
			}),
		);
		return execResult(res.exitCode === 0, res.stdout, res.stderr);
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		const sandbox = await this.ensure();
		const command = await this.withEnv(cmd);
		this.counters.stream_execs++;
		const proc = await this.dataplane(() => sandbox.commands.start(['sh', '-lc', command]));
		return iterableToStream(proc.stdout);
	}

	async readFileBounded(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		return readBoundedFile(path, options, (command, limits) => this.exec(command, limits));
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const sandbox = await this.ensure();
			const content = await this.dataplane(() => sandbox.files.readText(path));
			return { success: true, content, encoding: 'utf-8' };
		} catch {
			return readFileFailure('READ_FAILED');
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		// Preserve the SDK batch's preflight validation before dispatching single-file calls.
		const batch = files.map(({ path, content }) => ({ path, content }));
		const paths = new Set<string>();
		for (const file of batch) {
			if (typeof file.path !== 'string' || !file.path.startsWith('/') || paths.has(file.path)) {
				throw new CWSandboxValidationError('File writes require unique absolute paths');
			}
			paths.add(file.path);
		}
		const sandbox = await this.ensure();
		// Use one stream when unary writes would need more than one wave.
		if (batch.length > fileWriteLimit(this.config.dataPlaneMode) && this.packedWritesAvailable) {
			// Serial batches fence later writes and keep the bootstrap ahead of every home write.
			let bootstrap = this.pendingBootstrap;
			let command = this.takeBootstrap(WRITE_BATCH_COMMAND);
			let written = 0;
			try {
				for (const packed of batchFileWrites(batch)) {
					let missingReceiver = false;
					for (let attempt = 0; ; attempt++) {
						try {
							const { result, exitCode } = await this.fileWriteSlots.run(
								sandbox.sandboxId,
								async () => {
									this.counters.file_write_waves++;
									return this.runRaw(command, encodeFileWriteBatch(packed), {
										timeout: FILE_WRITE_TIMEOUT_MS,
									});
								},
							);
							missingReceiver = exitCode === 127;
							if (!result.success && !missingReceiver)
								throw new Error('Could not write sandbox file batch');
							break;
						} catch (error) {
							const delay = fileWriteRetryDelay(error, attempt);
							if (delay === undefined) throw exhaustedFileWriteError(error);
							await sleep(delay);
						}
					}
					if (missingReceiver) {
						this.packedWritesAvailable = false;
						this.pendingBootstrap ??= bootstrap;
						await this.writeUnaryFiles(sandbox, batch.slice(written));
						return;
					}
					bootstrap = undefined;
					command = WRITE_BATCH_COMMAND;
					written += packed.length;
				}
			} catch (error) {
				this.pendingBootstrap ??= bootstrap;
				throw error;
			}
			return;
		}
		await this.writeUnaryFiles(sandbox, batch);
	}

	private async writeUnaryFiles(
		sandbox: CoreWeaveSandbox,
		batch: readonly SandboxFileWrite[],
	): Promise<void> {
		// AddFile creates parent directories itself. The bootstrap links the user
		// home into place, so a write beneath it must not race ahead of that.
		if (this.pendingBootstrap && this.writesUnderUserHome(batch)) {
			await this.exec('true');
		}
		// The SDK's array form serializes files in two-wide waves. Own concurrency
		// here, draining started uploads before a caller can retry or destroy the pod.
		const batchState: FileWriteBatchState = {
			dispatched: 0,
			failed: false,
			retryCount: 0,
			backoffMs: 0,
			directAdmissionLimited: false,
		};
		try {
			await forEachConcurrentUntilFailure({
				items: batch,
				concurrency: fileWriteLimit(this.config.dataPlaneMode),
				run: (file) => this.writeFile(sandbox, file, batchState),
			});
		} finally {
			if (batchState.backoffMs > 0) {
				const mode = this.config.dataPlaneMode ?? 'auto';
				logEvent(
					{
						level: 'warn',
						event: 'coreweave_file_upload_backoff',
						message: 'File uploads required backoff.',
						sandbox_id: this.id,
						data_plane_mode: mode,
						file_count: batch.length,
						retry_count: batchState.retryCount,
						total_backoff_ms: batchState.backoffMs,
						outcome: batchState.failed ? 'error' : 'success',
						direct_admission_limited: batchState.directAdmissionLimited,
						...(batchState.directAdmissionLimited && mode !== 'gateway'
							? {
									hint: 'If direct admission errors persist, consider MARIMOHUB_COMPUTE_COREWEAVE_DATA_PLANE_MODE=gateway.',
								}
							: {}),
					},
					{ channel: 'warn' },
				);
			}
		}
	}

	private async writeFile(
		sandbox: CoreWeaveSandbox,
		file: SandboxFileWrite,
		batchState: FileWriteBatchState,
	): Promise<void> {
		// Initial queueing is outside the budget; retries share the first RPC's deadline.
		let deadline: number | undefined;
		for (let attempt = 0; ; attempt++) {
			const retryDelay = await this.fileWriteSlots.run(
				sandbox.sandboxId,
				async () => {
					// Already-started uploads finish their retries after a sibling fails.
					if (batchState.failed && attempt === 0) return;
					deadline ??= Date.now() + FILE_WRITE_TIMEOUT_MS;
					const remaining = deadline - Date.now();
					if (remaining <= 0) {
						batchState.failed = true;
						throw fileWriteTimeout(sandbox.sandboxId, file.path);
					}
					if (attempt > 0) batchState.retryCount++;
					if (
						attempt === 0 &&
						batchState.dispatched++ % fileWriteLimit(this.config.dataPlaneMode) === 0
					)
						this.counters.file_write_waves++;
					this.counters.file_writes++;
					const content =
						typeof file.content === 'string'
							? new TextEncoder().encode(file.content)
							: file.content;
					try {
						await withDeadline(
							(signal) =>
								this.dataplane(() =>
									sandbox.files.writeStream && content.byteLength >= 4 * 1024 * 1024
										? sandbox.files.writeStream(file.path, content, {
												timeoutMs: remaining,
												signal,
											})
										: sandbox.files.write([{ path: file.path, content: file.content }], {
												timeoutMs: remaining,
												signal,
											}),
								),
							{
								timeoutMs: remaining,
								timeoutError: () => fileWriteTimeout(sandbox.sandboxId, file.path),
							},
						);
					} catch (error) {
						batchState.directAdmissionLimited ||=
							error instanceof CWSandboxResourceExhaustedError &&
							error.message.includes('Runner direct data-plane request limit reached');
						const delay = fileWriteRetryDelay(error, attempt);
						if (delay === undefined) {
							// Fence queued uploads before releasing this slot to another waiter.
							batchState.failed = true;
							throw exhaustedFileWriteError(error);
						}
						if (delay >= deadline - Date.now()) {
							batchState.failed = true;
							throw fileWriteTimeout(sandbox.sandboxId, file.path, error);
						}
						return delay;
					}
				},
				deadline === undefined
					? undefined
					: {
							timeoutMs: Math.max(0, deadline - Date.now()),
							timeoutError: () => {
								batchState.failed = true;
								return fileWriteTimeout(sandbox.sandboxId, file.path);
							},
						},
			);
			if (retryDelay === undefined) return;
			batchState.backoffMs += retryDelay;
			await sleep(retryDelay);
		}
	}

	private writesUnderUserHome(files: readonly SandboxFileWrite[]): boolean {
		const home = this.userHome?.path;
		if (!home) return false;
		const prefix = home.endsWith('/') ? home : `${home}/`;
		return files.some((f) => f.path === home || f.path.startsWith(prefix));
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		// Best-effort: the SDK files namespace has no list, so shell out via `find`.
		// Used by `captureWorkspace` on teardown to enumerate the working dir under
		// PERSIST_WORKSPACE=workspace.
		try {
			const res = await this.exec(buildFindFilesCommand(path, options));
			if (!res.success) {
				return listFilesFailure(classifyListFilesFailure(res));
			}
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
		this.environment.setEnvVars(vars, options);
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

	async launchProcess(cmd: string, options: LaunchProcessOptions): Promise<SandboxLaunchResult> {
		const built = buildLaunchCommand({
			setup: options.setup,
			command: cmd,
			port: options.port,
			startupTimeout: options.startupTimeout,
		});
		const startedAt = Date.now();
		let proc: CommandProcess;
		try {
			const sandbox = await this.ensure();
			const command = await this.withEnv(built.command);
			this.counters.stream_execs++;
			proc = await this.dataplane(() =>
				sandbox.commands.start(['sh', '-lc', command], {
					cwd: options.cwd,
				}),
			);
		} catch (error) {
			return transportFailureResult(error, {
				setup: 0,
				start: Math.max(0, Date.now() - startedAt),
				waitport: 0,
			});
		}
		const start = Date.now() - startedAt;
		const waitStartedAt = Date.now();
		const stdoutTail = new OutputTail();
		const stderrTail = new OutputTail();
		let settled = false;
		let resolveOutcome!: (outcome: LaunchProtocolOutcome) => void;
		let rejectOutcome!: (error: unknown) => void;
		const outcome = new Promise<LaunchProtocolOutcome>((resolve, reject) => {
			resolveOutcome = resolve;
			rejectOutcome = reject;
		});
		const logs = () =>
			parseLaunchOutput({ stdout: stdoutTail.text, stderr: stderrTail.text }, built.nonce);
		// Fed raw chunks so a marker evicted from the capped tails (e.g. by a huge
		// trailing burst in the same chunk) still classifies the launch.
		const tracker = new LaunchProtocolTracker(built.nonce);
		const setupOutput = new LaunchSetupOutput(built.nonce);
		const inspect = () => {
			if (settled) return;
			const terminal = tracker.outcome;
			const needsSetupOutput =
				terminal && ['ready', 'setup_exit', 'setup_timeout'].includes(terminal.kind);
			if (terminal && (!needsSetupOutput || !options.setup || setupOutput.complete)) {
				settled = true;
				resolveOutcome(terminal);
			}
		};
		const pump = async (
			stream: AsyncIterable<string>,
			name: 'stdout' | 'stderr',
			sink: OutputTail,
		) => {
			try {
				for await (const chunk of stream) {
					setupOutput.feed(name, chunk);
					tracker.feed(name, chunk);
					sink.append(chunk);
					inspect();
				}
				setupOutput.finish(name);
				inspect();
			} catch (error) {
				if (!settled) {
					settled = true;
					rejectOutcome(error);
				}
			}
		};
		const stdoutDone = pump(proc.stdout, 'stdout', stdoutTail);
		const stderrDone = pump(proc.stderr, 'stderr', stderrTail);
		void Promise.allSettled([stdoutDone, stderrDone]).then(() => {
			inspect();
			if (!settled) {
				settled = true;
				rejectOutcome(new Error('CoreWeave launch stream ended before reporting readiness'));
			}
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOutcome =
			options.startupTimeout === 0
				? outcome
				: Promise.race([
						outcome,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new DOMException('Launch timed out', 'TimeoutError')),
								Math.max(0, options.startupTimeout - start) + LAUNCH_MARKER_GRACE_MS,
							);
						}),
					]);

		let terminal: LaunchProtocolOutcome;
		try {
			terminal = await timedOutcome;
		} catch (error) {
			settled = true;
			const waitport = Math.max(0, Date.now() - waitStartedAt);
			await cancelLaunchProcess(proc);
			const parsed = logs();
			if (error instanceof DOMException && error.name === 'TimeoutError') {
				return launchTimeoutResult({
					setup: Boolean(options.setup),
					setupCompleted: tracker.setupCompleted,
					startupTimeout: options.startupTimeout,
					output: parsed,
					start,
					waitport,
				});
			}
			return {
				success: false,
				reason: 'transport_failure',
				stdout: parsed.stdout,
				stderr: [parsed.stderr, errorMessage(error)].filter(Boolean).join('\n'),
				timings: {
					setup: 0,
					start,
					waitport,
				},
			};
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		if (terminal.kind !== 'ready') {
			return launchOutcomeResult(
				terminal.kind,
				terminal,
				terminal.kind === 'setup_exit' || terminal.kind === 'setup_timeout'
					? setupOutput.output
					: logs(),
				start,
			);
		}

		const exec = this.exec.bind(this);
		return {
			success: true,
			setupOutput: setupOutput.output,
			timings: { setup: terminal.setupMs, start, waitport: terminal.waitportMs },
			process: {
				id: `cw-proc-${++PROC_SEQ}`,
				command: cmd,
				async kill(): Promise<void> {
					await proc.cancel().catch(() => {});
				},
				async waitForPort(port: number, waitOptions?: WaitForPortOptions): Promise<void> {
					if (port === options.port) return;
					const timeout = waitOptions?.timeout ?? 30_000;
					const result = await exec(portWaitCommand(port, Math.max(0.001, timeout / 1000)));
					if (!result.success) throw new Error(`timed out waiting for port ${port}`);
				},
				async getLogs(): Promise<{ stdout: string; stderr: string }> {
					const parsed = logs();
					return { stdout: parsed.stdout, stderr: parsed.stderr };
				},
			},
		};
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const sandbox = await this.ensure();
		const command = await this.withEnv(cmd, removeUndefined(options?.env ?? {}));
		this.counters.stream_execs++;
		const proc = await this.dataplane(() =>
			sandbox.commands.start(['sh', '-lc', command], { cwd: options?.cwd }),
		);

		// marimo runs as a streamed command (not the sandbox main process), so drain
		// its output in the background to back getLogs() and to surface errors if the
		// port never opens.
		const stdoutTail = new OutputTail();
		const stderrTail = new OutputTail();
		const pump = async (stream: AsyncIterable<string>, sink: OutputTail) => {
			try {
				for await (const chunk of stream) sink.append(chunk);
			} catch {
				// stream cancelled/ended — best effort.
			}
		};
		void pump(proc.stdout, stdoutTail);
		void pump(proc.stderr, stderrTail);

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
							`process ${proc.status} before port ${port} opened.\n${stderrTail.text || stdoutTail.text}`.trim(),
						);
					}
					const seconds = Math.max(1, Math.ceil(Math.min(chunkMs, deadline - Date.now()) / 1000));
					chunkMs = PORT_WAIT_CHUNK_MS;
					if ((await exec(portWaitCommand(port, seconds))).success) return;
				}
				throw new Error(
					`timed out waiting for port ${port} after ${timeout}ms.\n${stderrTail.text || stdoutTail.text}`,
				);
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				return { stdout: stdoutTail.text, stderr: stderrTail.text };
			},
		};
	}

	async prepareExposure(port: number, options: ExposePortOptions): Promise<void> {
		if (!this.config.kernelIngress || this.config.resolveExposedUrl) return;
		await this.exposePort(port, options);
	}

	async exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		const sandbox = await this.ensure();
		// Without a resolver, construct the public URL from a template (the kernel
		// port was declared `public` at create). Integration surface — the exact
		// ingress hostname scheme is CoreWeave backend/profile specific.
		const template = this.config.hostnameTemplate ?? 'https://{sandboxId}-{port}.{host}';
		const url = this.config.resolveExposedUrl
			? await this.config.resolveExposedUrl(sandbox, port)
			: template
					.replaceAll('{sandboxId}', sandbox.sandboxId)
					.replaceAll('{port}', String(port))
					.replaceAll('{host}', options.hostname)
					.replaceAll('{token}', options.token ?? '');
		// Reconnected sandboxes retain their create-time service configuration.
		// Reject incompatible URLs here so teardown can still recover notebook files.
		if (this.config.kernelEndpoint?.kind === 'https' && new URL(url).protocol !== 'https:') {
			throw new Error(
				`CoreWeave sandbox ${sandbox.sandboxId} has an incompatible service URL for port ${port}: ` +
					'expected HTTPS; save its files and recreate the sandbox',
			);
		}
		if (!this.config.resolveExposedUrl && this.config.kernelIngress) {
			const key = `${port}:${new URL(url).hostname}`;
			let publishing = this.exposures.get(key);
			if (!publishing) {
				publishing = this.config.kernelIngress
					.publish({
						sandboxId: sandbox.sandboxId,
						host: new URL(url).hostname,
						port,
					})
					.catch((error) => {
						if (this.exposures.get(key) === publishing) this.exposures.delete(key);
						throw error;
					});
				this.exposures.set(key, publishing);
			}
			await publishing;
		}
		return { url };
	}

	async destroy(): Promise<void> {
		this.providerIds.delete(this.id);
		if (this.sandbox) {
			await this.removeIngress(this.sandbox.sandboxId);
			await this.deleteTolerant(() => this.sandbox!.delete());
			this.sandbox = undefined;
			return;
		}
		// A bad reference must never fall through to tag discovery.
		this.assertValidReference();
		const reconnectId = this.reconnectId;
		if (reconnectId) {
			await this.removeIngress(reconnectId);
			await this.deleteTolerant(() => this.client.delete(reconnectId));
			return;
		}
		// Re-resolved instance (no cached handle): delete every sandbox tagged with our
		// id. Tolerate "already gone" so teardown is idempotent.
		const { sandboxes } = await this.client.list({ tags: [this.idTag] });
		for (const info of sandboxes) {
			await this.removeIngress(info.sandboxId);
			await this.deleteTolerant(() => this.client.delete(info.sandboxId));
		}
	}

	/** Best-effort: the Ingress is owner-referenced to the runner's Service anyway. */
	private async removeIngress(sandboxId: string): Promise<void> {
		if (!this.config.kernelIngress) return;
		try {
			await this.config.kernelIngress.remove(sandboxId);
		} catch (err) {
			logEvent(
				{
					event: 'coreweave_kernel_ingress_remove_failed',
					sandbox_id: sandboxId,
					error: String(err),
				},
				{ channel: 'warn' },
			);
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
	/**
	 * v1 sandbox ports are create-time only, so a second port (the VS Code
	 * surface) works exactly when it was pre-declared via `extraPorts`.
	 */
	readonly capabilities: { multiPort: boolean };
	private client?: CoreWeaveClient;
	private readonly fileWriteSlots: SandboxFileWriteSlots;
	/**
	 * Provider sandbox ids this process has seen running for a hub id, so a re-resolved instance
	 * can Get by id instead of paying the tag List. Entries are hints: every hit is validated, and
	 * a stale one is dropped in favor of the tag lookup.
	 */
	private readonly providerIds = new BoundedLruMap<SandboxId, string>(PROVIDER_ID_CACHE_LIMIT);

	constructor(
		private readonly config: CoreWeaveConfig,
		client?: CoreWeaveClient,
	) {
		this.client = client;
		this.fileWriteSlots = new SandboxFileWriteSlots(fileWriteLimit(config.dataPlaneMode));
		this.capabilities = { multiPort: (config.extraPorts?.length ?? 0) > 0 };
	}

	private getClient(): CoreWeaveClient {
		if (!this.client) {
			if (!this.config.apiKey) {
				throw new Error(
					'CoreWeaveCompute requires either an apiKey in its config or an injected client',
				);
			}
			const apiKey = this.config.apiKey.trim();
			if (!apiKey) throw new CWSandboxConfigurationError('CWSandbox API key is required.');
			const baseUrl = this.config.baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
			// The real SDK client exposes the CoreWeaveClient surface at runtime; one
			// controlled cast at the construction boundary avoids overload-variance
			// friction between the SDK's broad signatures and our narrow seam.
			// oxlint-disable-next-line anti-slop/no-chained-type-assertions
			const sdk = createSandboxClient({
				apiKey,
				baseUrl,
				dataPlaneMode: this.config.dataPlaneMode ?? 'auto',
			}) as unknown as CoreWeaveClient;
			this.client = instrumentCoreWeaveClient(sdk, baseUrl);
		}
		return this.client;
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.instance(id, options);
	}

	connectExisting(id: SandboxId, options?: ConnectSandboxOptions): SandboxInstance {
		return this.instance(id, { ...options, reuse: true }, true, options?.reconnectReference);
	}

	private instance(
		id: SandboxId,
		options?: CreateSandboxOptions,
		existingOnly = false,
		reference?: string,
	): SandboxInstance {
		if (options?.userHome && !this.config.userHomeTemplateId) {
			// Failing here beats provisioning an editor without its mount: the
			// bootstrap would abort in-sandbox, after the boot wait.
			throw new Error('A CoreWeave user-home template is required for personal storage');
		}
		const resources = coreWeaveProfileResources(options?.resources);
		const config =
			options?.image || resources || options?.userHome
				? {
						...this.config,
						...(options?.image ? { image: options.image } : {}),
						...(options?.userHome ? { templateId: this.config.userHomeTemplateId } : {}),
						...(resources
							? { resources: mergeCoreWeaveResources(this.config.resources, resources) }
							: {}),
					}
				: this.config;
		return new CoreWeaveSandboxInstance(
			id,
			config,
			this.getClient(),
			this.providerIds,
			options?.reuse ?? true,
			options?.userHome,
			existingOnly,
			reference,
			this.fileWriteSlots,
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

export { createKernelIngressPublisher, inClusterKubernetesApi } from './kernelIngress';
export type { KernelIngressPublisher, KubernetesApi } from './kernelIngress';

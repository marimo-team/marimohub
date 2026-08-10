/**
 * Kubernetes compute adapter — a `SandboxProvider` backed by NATIVE Kubernetes
 * resources (a Pod + Service + Ingress per session) created through the cluster
 * API with `@kubernetes/client-node`. Like the Modal and CoreWeave adapters, this
 * targets the Node control plane (`apps/server`); the client speaks the cluster
 * API over HTTP/websockets, so it is NOT usable from a Workers runtime.
 *
 * Why native k8s (and not the marimo-operator CRD): marimohub's `SandboxInstance`
 * port is imperative — the provisioner copies notebook files in and runs
 * `uv run marimo edit` itself (see `SandboxProvisioner`). That maps 1:1 onto a
 * plain Pod we can `exec` into; the operator's declarative `MarimoNotebook` CRD
 * exposes no exec/file API, so it would force a mandatory bucket mount with no
 * fallback. This adapter therefore mirrors the CoreWeave adapter's shape against
 * the raw cluster API.
 *
 * Bridging the port to the cluster:
 *  - `create(id)` is synchronous and id-addressed. We return a lazy instance and
 *    materialise the Pod/Service/Ingress on first use (`ensure()`), naming every
 *    resource deterministically `mh-<sanitized id>` and labelling it
 *    `app.kubernetes.io/managed-by=marimohub` so a re-resolved instance (teardown's
 *    `compute.create(id)`) reconnects to the SAME Pod and `listActive()` can map a
 *    Pod back to our `SandboxId` (stored verbatim in an annotation).
 *  - The Pod's container runs a keep-alive (`sleep`); marimo is started LATER as a
 *    detached in-pod process via `startProcess` (`exec` + `setsid … &`), exactly
 *    like the CoreWeave adapter runs marimo as a streamed command rather than the
 *    main process.
 *  - `exec`/`readFile`/`writeFiles`/`listFiles` all go through the Pod `exec`
 *    subresource, so `mountBucket` THROWS and the provisioner falls back to copying
 *    notebook files in/out (the intended path here, like Modal/CoreWeave/local).
 *  - The kernel is reached DIRECTLY at its Ingress host (`{id}.{host}`), so
 *    `proxy()` is a no-op and `exposePort` returns that URL. Websockets reach the
 *    Pod through the ingress controller, not through the Node process.
 *
 * INTEGRATION SURFACE (validate against a live cluster before production, the same
 * caveat the Modal/CoreWeave adapters carry): the Ingress host scheme and TLS are
 * cluster/ingress-controller specific (`ingressClassName`, a wildcard-cert
 * `tlsSecretName`, and a matching `*.{host}` DNS record are required for the
 * returned URL to resolve); marimo must run tokenless behind marimohub's own auth
 * (the provisioner passes `--no-token`); and the in-pod port wait assumes
 * `python3` is on the image PATH (see `portWaitCommand`).
 */
import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	mapWithConcurrency,
	parseFindFilesOutput,
	pollUntilReady,
	portWaitCommand,
	shellQuote,
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { Millis } from '@marimo-hub/core';
import type { SandboxId, Timings } from '@marimo-hub/core';
import { createK8sClient } from './client';
import type { K8sClient, K8sExecResult, K8sPodPhaseInfo, KubernetesConfig } from './shared';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';
export * from './shared';
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
	SetEnvVarsOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';

/** marimo's hardcoded kernel port (see `SandboxProvisioner`'s `MARIMO_PORT`). */
const DEFAULT_KERNEL_PORT = 2718;
/** Default marimo-capable image when `MARIMOHUB_COMPUTE_IMAGE` is unset. */
const DEFAULT_IMAGE = 'ghcr.io/marimo-team/marimo:latest';
/**
 * How often to poll a fresh Pod for `Running`. Each poll is one cheap pod GET;
 * a 1s interval would round every boot up to the next whole second (the same
 * quantization the CoreWeave adapter fixed with its tighter boot poll).
 */
const BOOT_POLL_INTERVAL_MS = 250;
/** Longest a single in-pod port wait may block before we re-issue it. */
const PORT_WAIT_CHUNK_MS = 30_000;
/** First such chunk, kept short so a kernel that dies on launch is caught quickly. */
const PORT_WAIT_FIRST_CHUNK_MS = 2_000;
/**
 * Cap on the one post-boot diagnostics read (the kubelet `Pulled` event; the
 * rest of the breakdown rides the boot poll for free). Best-effort — a slow
 * API server must never delay a sandbox that is already Running.
 */
const IMAGE_PULL_EVENT_TIMEOUT_MS = 250;

/**
 * Milliseconds from a kubelet `Pulled` event message — `Successfully pulled
 * image "…" in 2.096s (…)` parses the Go duration; `already present on machine`
 * means the pull cost nothing. `undefined` when the message is missing or from
 * a kubelet whose wording changed.
 */
export function parseImagePullMs(message: string | undefined): number | undefined {
	if (!message) return undefined;
	if (message.includes('already present')) return 0;
	const duration = message.match(/ in ([0-9.hms]+)/)?.[1];
	if (!duration) return undefined;
	let ms = 0;
	let matched = false;
	for (const [, value, unit] of duration.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
		matched = true;
		ms +=
			Number(value) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as 'ms' | 's' | 'm' | 'h'];
	}
	return matched && Number.isFinite(ms) ? Math.round(ms) : undefined;
}

export function kubernetesProfileResources(
	resources: ComputeResources | undefined,
): KubernetesConfig['resources'] {
	if (!resources || (resources.cpu === undefined && resources.memoryBytes === undefined)) {
		return undefined;
	}
	return {
		...(resources.cpu !== undefined ? { cpu: `${Math.ceil(resources.cpu * 1000)}m` } : {}),
		...(resources.memoryBytes !== undefined
			? { memory: `${Math.ceil(resources.memoryBytes / 1024 ** 2)}Mi` }
			: {}),
		profileLimits: {
			...(resources.cpu !== undefined ? { cpu: true } : {}),
			...(resources.memoryBytes !== undefined ? { memory: true } : {}),
		},
	};
}

/** Derive a DNS-1123-safe resource name from a `SandboxId`. */
export function resourceName(id: SandboxId): string {
	const slug = String(id)
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]/g, '-')
		.replaceAll(/^-+|-+$/g, '')
		.slice(0, 60);
	return `mh-${slug || 'sandbox'}`;
}

let PROC_SEQ = 0;

class KubernetesSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private readonly name: string;
	private readonly namespace: string;
	private readonly image: string;
	private readonly hostname: string;
	private readonly kernelPort: number;
	private resolved = false;
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};
	private execCount = 0;
	private lastEnsureTimings?: Timings;
	/** Latest Pod snapshot from the boot poll (uid + condition timestamps). */
	private bootInfo?: K8sPodPhaseInfo;

	constructor(
		private readonly id: SandboxId,
		private readonly config: KubernetesConfig,
		private readonly client: K8sClient,
	) {
		this.name = resourceName(id);
		this.namespace = config.namespace ?? 'default';
		this.image = config.image ?? DEFAULT_IMAGE;
		this.hostname = config.hostname ?? '';
		this.kernelPort = config.kernelPort ?? DEFAULT_KERNEL_PORT;
	}

	/** The per-session ingress host the rule should match (`{id}.{host}` by default). */
	private ingressHost(): string {
		if (!this.hostname) return '';
		// Reuse the URL template, then keep just its host component.
		return new URL(this.urlFrom(this.hostname, '')).host;
	}

	private urlFrom(hostname: string, token: string): string {
		const template = this.config.hostnameTemplate ?? 'https://{id}.{host}';
		return template
			.replaceAll('{id}', String(this.id))
			.replaceAll('{port}', String(this.kernelPort))
			.replaceAll('{host}', hostname)
			.replaceAll('{token}', token);
	}

	/**
	 * Materialise the Pod/Service/Ingress and block until the Pod is `Running`.
	 * Reconnect (idempotent create) rather than re-create when the resources already
	 * exist, so a re-resolved instance (teardown's `compute.create(id)`) operates on
	 * the SAME Pod, e.g. to read notebook files back before destroy. The Ingress host
	 * comes from deploy-time config (`hostname`), so it is known on first use.
	 */
	private async ensure(): Promise<void> {
		if (this.resolved) return;
		const t0 = Date.now();
		const { createdPod } = await this.client.ensure({
			name: this.name,
			sandboxId: this.id,
			host: this.ingressHost(),
			image: this.image,
			port: this.kernelPort,
			namespace: this.namespace,
			ingressClassName: this.config.ingressClassName,
			tlsSecretName: this.config.tlsSecretName,
			serviceAccountName: this.config.serviceAccountName,
			imagePullSecret: this.config.imagePullSecret,
			imagePullPolicy: this.config.imagePullPolicy,
			resources: this.config.resources,
		});
		const t1 = Date.now();
		await this.waitForRunning();
		this.resolved = true;
		await this.recordEnsure(createdPod, t1 - t0, Date.now() - t1);
	}

	/**
	 * Record where the boot went — the adapter-side create/boot waits plus the
	 * cluster-side schedule/pull/ready breakdown — into `drainTimings()` (folded
	 * into the `session_provision` wide event as `provision_reachable_*_ms`) and
	 * one structured `k8s_ensure` log line. The condition timestamps were
	 * captured by the boot poll itself; only the image-pull event needs a read
	 * here, and it is capped so it cannot hold up an already-Running sandbox.
	 */
	private async recordEnsure(createdPod: boolean, createMs: number, bootMs: number): Promise<void> {
		const timings: Timings = { create: createMs, boot: bootMs };
		let pullMessage: string | undefined;
		// A reconnect's Pod booted long ago — its conditions would report a stale
		// breakdown as if this provision paid for it.
		if (createdPod) {
			const info = this.bootInfo;
			pullMessage = await this.boundedImagePullMessage(info?.uid);
			const since = (from?: Date, to?: Date): number | undefined =>
				from && to && to.getTime() >= from.getTime() ? to.getTime() - from.getTime() : undefined;
			const schedule = since(info?.createdAt, info?.scheduledAt);
			const ready = since(info?.createdAt, info?.readyAt);
			const pull = parseImagePullMs(pullMessage);
			if (schedule !== undefined) timings.schedule = schedule;
			if (ready !== undefined) timings.pod_ready = ready;
			if (pull !== undefined) timings.image_pull = pull;
		}
		this.lastEnsureTimings = timings;
		console.warn(
			JSON.stringify({
				ts: new Date().toISOString(),
				event: 'k8s_ensure',
				sandbox_id: this.id,
				pod: this.name,
				namespace: this.namespace,
				created: createdPod,
				create_ms: createMs,
				boot_ms: bootMs,
				...(timings.schedule !== undefined ? { schedule_ms: timings.schedule } : {}),
				...(timings.image_pull !== undefined ? { image_pull_ms: timings.image_pull } : {}),
				...(timings.pod_ready !== undefined ? { pod_ready_ms: timings.pod_ready } : {}),
				...(pullMessage ? { image_pull_event: pullMessage } : {}),
			}),
		);
	}

	/** The one post-`Running` diagnostics read, capped so it cannot delay readiness. */
	private async boundedImagePullMessage(uid: string | undefined): Promise<string | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const gaveUp = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), IMAGE_PULL_EVENT_TIMEOUT_MS);
		});
		try {
			return await Promise.race([this.client.getImagePullMessage(this.name, uid), gaveUp]);
		} finally {
			clearTimeout(timer);
		}
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

	async ready(): Promise<void> {
		await this.ensure();
	}

	private async waitForRunning(): Promise<void> {
		const timeout = this.config.podReadyTimeout ?? Millis.minutes(2);
		await pollUntilReady(
			async () => {
				const info = await this.client.getPhase(this.name);
				// Keep the snapshot: the boot breakdown (uid, schedule/ready times)
				// comes from this poll, so no extra read holds up readiness later.
				this.bootInfo = info ?? this.bootInfo;
				const phase = info?.phase;
				// A terminal phase is unrecoverable — throw to abort the wait at once.
				if (phase === 'Failed' || phase === 'Succeeded') {
					throw new Error(`pod ${this.name} entered terminal phase ${phase} before becoming ready`);
				}
				return phase === 'Running';
			},
			{
				timeoutMs: timeout,
				intervalMs: BOOT_POLL_INTERVAL_MS,
				timeoutMessage: async () => {
					const schedulingFailure = await this.client.getSchedulingFailure(this.name);
					return `timed out waiting for pod ${this.name} to reach Running after ${timeout}ms${
						schedulingFailure ? `: ${schedulingFailure}` : ''
					}`;
				},
			},
		);
	}

	/** Prefix accumulated env vars onto a shell command (exec carries no env). */
	private withEnv(cmd: string): string {
		return withEnvPrefix(cmd, this.env, this.envDefaults);
	}

	/**
	 * Run a shell command in the Pod, counting the round-trip.
	 *
	 * `login` splits two contracts: commands that run user/notebook code (exec,
	 * git, the kernel itself, the port probe) get a login shell so an image that
	 * exposes `uv`/`python3` via profile scripts keeps working; adapter-internal
	 * protocol commands whose stdout we parse (readFile's cat, the launch PID
	 * echo) get a plain `sh -c`, because profile output on stdout would corrupt
	 * the result — and they only use shell builtins/coreutils, so they need no
	 * profile PATH.
	 */
	private execInPod(
		cmd: string,
		opts?: { login?: boolean; stdin?: string | Uint8Array },
	): Promise<K8sExecResult> {
		this.execCount++;
		return this.client.exec(this.name, ['sh', opts?.login ? '-lc' : '-c', cmd], opts?.stdin);
	}

	async exec(cmd: string): Promise<ExecResult> {
		await this.ensure();
		const res = await this.execInPod(this.withEnv(cmd), { login: true });
		return execResult(res.exitCode === 0, res.stdout, res.stderr);
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		// The exec seam is request/response, not streaming; buffer then emit once.
		// Off the provision/teardown hot path (the provisioner uses exec/startProcess).
		const res = await this.exec(cmd);
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(res.stdout));
				controller.close();
			},
		});
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			await this.ensure();
			const res = await this.execInPod(`cat -- ${shellQuote(path)}`);
			if (res.exitCode !== 0) return readFileFailure('READ_FAILED');
			return { success: true, content: res.stdout, encoding: 'utf-8' };
		} catch {
			return readFileFailure('BACKEND_ERROR');
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		await this.ensure();
		// Pod exec has no multi-file write, so loop — but each exec inlines its own
		// mkdir and streams content over stdin, so bytes are never interpolated.
		await mapWithConcurrency(files, WRITE_CONCURRENCY, async (f) => {
			const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
			const res = await this.execInPod(
				`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(f.path)}`,
				{ stdin: f.content },
			);
			if (res.exitCode !== 0) throw new Error(`writeFile ${f.path} failed: ${res.stderr}`);
		});
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		// Best-effort via `find` (no native files API). Used by `captureWorkspace`
		// on teardown to enumerate the working dir under PERSIST_WORKSPACE=workspace.
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
		// Stored and applied as a shell prefix by withEnv(); the Pod env is fixed at
		// create time and the provisioner never calls this on the hot path.
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// No FUSE mount — throwing makes SandboxProvisioner fall back to copying
		// notebook files in/out via exec (the intended path, like Modal/CoreWeave).
		throw new Error(
			'mountBucket is not supported on the kubernetes backend; using file copy fallback',
		);
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// no-op: nothing was mounted.
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		await this.ensure();
		const logFile = `/tmp/mh-proc-${++PROC_SEQ}.log`;
		const cwd = options?.cwd ? `cd ${shellQuote(options.cwd)}; ` : '';
		// Launch marimo detached so it outlives this exec session (the kernel must keep
		// serving after startProcess returns). setsid + redirect + background; echo PID.
		// The OUTER shell is non-login (its stdout is the PID we parse); the inner
		// detached shell is a login shell so profile-provided env reaches the kernel
		// (its output goes to the log file, where profile noise is harmless).
		const launch = `${cwd}setsid sh -lc ${shellQuote(this.withEnv(cmd))} >${logFile} 2>&1 </dev/null & echo $!`;
		const started = await this.execInPod(launch);
		const pid = started.stdout.trim();

		const execIn = (c: string) => this.execInPod(c);
		const execLogin = (c: string) => this.execInPod(c, { login: true });
		const readLog = async () => (await execIn(`cat ${logFile} 2>/dev/null || true`)).stdout;
		const name = this.name;
		return {
			id: `k8s-proc-${pid || PROC_SEQ}`,
			command: cmd,
			async kill(signal?: string): Promise<void> {
				if (!pid) return;
				const sig = signal ? `-${signal}` : '-TERM';
				try {
					await execIn(`kill ${sig} ${pid} 2>/dev/null || true`);
				} catch {
					// already gone — best effort.
				}
			},
			async waitForPort(port: number, opts?: WaitForPortOptions): Promise<void> {
				const timeout = opts?.timeout ?? 30_000;
				// Loop IN-POD rather than probing from here: every exec is a fresh
				// websocket through the API server plus a python3 spawn, so an external
				// poll quantizes the wait to that round-trip + interval grid. Chunked
				// (mirroring the CoreWeave adapter) so each boundary is where a dead
				// kernel gets noticed; the first chunk is short so a launch that fails
				// outright reports fast. `attempts` bounds the loop if the in-pod
				// waiter itself returns instantly (e.g. python3 missing).
				const deadline = Date.now() + timeout;
				const attempts = 1 + Math.ceil(timeout / PORT_WAIT_CHUNK_MS);
				let chunkMs = PORT_WAIT_FIRST_CHUNK_MS;
				for (let i = 0; i < attempts; i++) {
					const remainingMs = deadline - Date.now();
					if (remainingMs <= 0) break;
					// Fractional seconds: the in-pod waiter runs a monotonic ms-precision
					// deadline, so the chunks sum to the full timeout — no whole-second
					// rounding in either direction.
					const seconds = Number((Math.min(chunkMs, remainingMs) / 1000).toFixed(2));
					chunkMs = PORT_WAIT_CHUNK_MS;
					if ((await execLogin(portWaitCommand(port, seconds))).exitCode === 0) return;
					// The chunk elapsed with the port closed. A dead kernel never opens
					// it, so check liveness before spending another chunk — and word the
					// error so the provisioner classifies it as a crash, not a timeout.
					if (pid && (await execIn(`kill -0 ${pid} 2>/dev/null`)).exitCode !== 0) {
						throw new Error(
							`process exited before port ${port} opened.\n${await readLog()}`.trim(),
						);
					}
				}
				throw new Error(
					`timed out waiting for port ${port} on pod ${name} after ${timeout}ms.\n${await readLog()}`,
				);
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				return { stdout: await readLog(), stderr: '' };
			},
		};
	}

	async exposePort(_port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		// The kernel is reached directly at its Ingress host (created in ensure()).
		// Build the public URL from the template; nothing to expose at request time.
		// Prefer the deploy-time hostname (what the Ingress rule matches); the
		// provisioner passes the same value as options.hostname.
		await this.ensure();
		return { url: this.urlFrom(this.hostname || options.hostname, options.token ?? '') };
	}

	async destroy(): Promise<void> {
		await this.client.delete(this.name);
		this.resolved = false;
	}
}

export class KubernetesCompute implements SandboxProvider {
	private client?: K8sClient;

	constructor(
		private readonly config: KubernetesConfig,
		client?: K8sClient,
	) {
		this.client = client;
	}

	private getClient(): K8sClient {
		if (!this.client) {
			this.client = createK8sClient(this.config);
		}
		return this.client;
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		const profileResources = kubernetesProfileResources(options?.resources);
		const config =
			options?.image || profileResources
				? {
						...this.config,
						...(options?.image ? { image: options.image } : {}),
						...(profileResources
							? {
									resources: {
										...this.config.resources,
										...profileResources,
										profileLimits: {
											...this.config.resources?.profileLimits,
											...profileResources.profileLimits,
										},
									},
								}
							: {}),
					}
				: this.config;
		return new KubernetesSandboxInstance(id, config, this.getClient());
	}

	async proxy(_request: Request): Promise<Response | null> {
		// Kernels are reached directly via their per-session Ingress host; nothing to
		// proxy at the control-plane edge (same as the Modal/CoreWeave backends).
		return null;
	}

	async listActive(): Promise<ActiveSandbox[]> {
		// Pods this deployment owns, scoped by the managed-by label. The returned id
		// is the verbatim SandboxId read from the annotation, so the reconciler can
		// match a Pod back to its session record.
		const infos = await this.getClient().list();
		return infos
			.filter((i) => i.phase !== 'Failed' && i.phase !== 'Succeeded')
			.map((i) => ({ id: i.sandboxId, createdAt: i.createdAt }));
	}
}

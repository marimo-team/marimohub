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
 * (the provisioner passes `--no-token`); and the in-pod port probe assumes
 * `python3` is on the image PATH.
 */
import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	mapWithConcurrency,
	parseFindFilesOutput,
	pollUntilReady,
	shellQuote,
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { Millis } from '@marimo-hub/core';
import type { SandboxId } from '@marimo-hub/core';
import { createK8sClient } from './client';
import type { K8sClient, KubernetesConfig } from './shared';
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
	WaitForPortOptions,
} from '@marimo-hub/core/ports';

/** marimo's hardcoded kernel port (see `SandboxProvisioner`'s `MARIMO_PORT`). */
const DEFAULT_KERNEL_PORT = 2718;
/** Default marimo-capable image when `MARIMOHUB_COMPUTE_IMAGE` is unset. */
const DEFAULT_IMAGE = 'ghcr.io/marimo-team/marimo:latest';

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
	private readonly name: string;
	private readonly namespace: string;
	private readonly image: string;
	private readonly hostname: string;
	private readonly kernelPort: number;
	private ready = false;
	private env: Record<string, string> = {};

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
		if (this.ready) return;
		await this.client.ensure({
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
			resources: this.config.resources,
		});
		await this.waitForRunning();
		this.ready = true;
	}

	private async waitForRunning(): Promise<void> {
		const timeout = this.config.podReadyTimeout ?? Millis.minutes(2);
		await pollUntilReady(
			async () => {
				const phase = await this.client.getPhase(this.name);
				// A terminal phase is unrecoverable — throw to abort the wait at once.
				if (phase === 'Failed' || phase === 'Succeeded') {
					throw new Error(`pod ${this.name} entered terminal phase ${phase} before becoming ready`);
				}
				return phase === 'Running';
			},
			{
				timeoutMs: timeout,
				intervalMs: 1000,
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
		return withEnvPrefix(cmd, this.env);
	}

	async exec(cmd: string): Promise<ExecResult> {
		await this.ensure();
		const res = await this.client.exec(this.name, ['sh', '-lc', this.withEnv(cmd)]);
		return { success: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr };
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
			const res = await this.client.exec(this.name, ['sh', '-lc', `cat -- ${shellQuote(path)}`]);
			if (res.exitCode !== 0) return { success: false, content: '' };
			return { success: true, content: res.stdout, encoding: 'utf-8' };
		} catch {
			return { success: false, content: '' };
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		await this.ensure();
		// Pod exec has no multi-file write, so loop — but each exec inlines its own
		// mkdir and streams content over stdin, so bytes are never interpolated.
		await mapWithConcurrency(files, WRITE_CONCURRENCY, async (f) => {
			const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
			const res = await this.client.exec(
				this.name,
				['sh', '-lc', `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(f.path)}`],
				f.content,
			);
			if (res.exitCode !== 0) throw new Error(`writeFile ${f.path} failed: ${res.stderr}`);
		});
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		// Best-effort via `find` (no native files API). Used by `captureWorkspace`
		// on teardown to enumerate the working dir under PERSIST_WORKSPACE=workspace.
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
		// Stored and applied as a shell prefix by withEnv(); the Pod env is fixed at
		// create time and the provisioner never calls this on the hot path.
		this.env = { ...this.env, ...vars };
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
		const launch = `${cwd}setsid sh -lc ${shellQuote(this.withEnv(cmd))} >${logFile} 2>&1 </dev/null & echo $!`;
		const started = await this.client.exec(this.name, ['sh', '-lc', launch]);
		const pid = started.stdout.trim();

		const execIn = (c: string) => this.client.exec(this.name, ['sh', '-lc', c]);
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
				// In-pod TCP probe (mirrors the CoreWeave/local adapters), run via exec.
				const probe =
					`python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); ` +
					`sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)"`;
				await pollUntilReady(async () => (await execIn(probe)).exitCode === 0, {
					timeoutMs: timeout,
					intervalMs: 500,
					timeoutMessage: async () =>
						`timed out waiting for port ${port} on pod ${name} after ${timeout}ms.\n${(await execIn(`cat ${logFile} 2>/dev/null || true`)).stdout}`,
				});
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				const log = await execIn(`cat ${logFile} 2>/dev/null || true`);
				return { stdout: log.stdout, stderr: '' };
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
		this.ready = false;
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

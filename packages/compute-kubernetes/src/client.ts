/**
 * Production `K8sClient` — the integration seam to a real cluster via
 * `@kubernetes/client-node`. This is the INTEGRATION SURFACE the adapter header
 * warns about: the manifests below (keep-alive Pod, ClusterIP Service, per-session
 * Ingress) and the `exec`-subresource plumbing must be validated against a live
 * cluster + ingress controller. It is intentionally kept out of `index.ts` so the
 * adapter's orchestration logic stays unit-testable with an injected fake.
 *
 * `@kubernetes/client-node` is a heavyweight, optional, BRING-YOUR-OWN dependency
 * (like the `e2b` SDK): the type-only imports below are erased at build, and the
 * runtime module is loaded via a `import()` of a variable specifier so it is NEVER
 * bundled into the lean server image. To use this backend, install the client and
 * bake it into your image (`pnpm add @kubernetes/client-node`).
 */
import { Readable, Writable } from 'node:stream';
import type * as K8s from '@kubernetes/client-node';
import type {
	V1Container,
	V1Ingress,
	V1IngressTLS,
	V1Pod,
	V1Service,
	V1Status,
} from '@kubernetes/client-node';
import { SandboxId } from '@marimo-hub/core';
import {
	defaultImagePullPolicy,
	MANAGED_BY_LABEL,
	MANAGED_BY_VALUE,
	resolveIngressTlsMode,
	SANDBOX_ID_ANNOTATION,
	validateIngressAnnotations,
} from './shared';
import type {
	EnsureSandboxOptions,
	K8sClient,
	K8sExecOptions,
	K8sExecResult,
	K8sPodPhaseInfo,
	K8sSandboxInfo,
	KubernetesConfig,
} from './shared';

/** Per-session label the Service selector matches (unique per sandbox). */
const SANDBOX_NAME_LABEL = 'marimohub.io/sandbox-name';
/** The single container name in each kernel Pod (the exec target). */
const CONTAINER_NAME = 'marimo';

interface ExecSocket {
	on?(event: 'close' | 'error', listener: (event?: unknown) => void): void;
	addEventListener?(event: 'close' | 'error', listener: (event?: unknown) => void): void;
	close(): void;
}

function addExecSocketListener(
	socket: ExecSocket,
	event: 'close' | 'error',
	listener: (value?: unknown) => void,
): void {
	if (socket.on) {
		socket.on(event, listener);
		return;
	}
	if (socket.addEventListener) {
		socket.addEventListener(event, listener);
		return;
	}
	throw new Error('exec WebSocket does not support event listeners');
}

function execSocketError(value: unknown): Error {
	if (value instanceof Error) return value;
	if (typeof value === 'object' && value !== null) {
		const event = value as { error?: unknown; message?: unknown };
		if (event.error instanceof Error) return event.error;
		if (typeof event.message === 'string' && event.message) return new Error(event.message);
		if (typeof event.error === 'string' && event.error) return new Error(event.error);
		return new Error('exec WebSocket error');
	}
	return new Error(String(value));
}

/** True when an error is a k8s API error with the given HTTP status code. */
function hasCode(err: unknown, code: number): boolean {
	return typeof err === 'object' && (err as { code?: unknown })?.code === code;
}

function buildResources(r: EnsureSandboxOptions['resources']): V1Container['resources'] {
	if (!r) return undefined;
	const requests: Record<string, string> = {};
	const limits: Record<string, string> = {};
	if (r.cpu) requests.cpu = r.cpu;
	if (r.memory) requests.memory = r.memory;
	if (r.profileLimits?.cpu && r.cpu) limits.cpu = r.cpu;
	if (r.profileLimits?.memory && r.memory) limits.memory = r.memory;
	// GPUs are integer, non-overcommittable resources: they go in limits only.
	if (r.gpu) limits['nvidia.com/gpu'] = r.gpu;
	const out: V1Container['resources'] = {};
	if (Object.keys(requests).length > 0) out.requests = requests;
	if (Object.keys(limits).length > 0) out.limits = limits;
	return Object.keys(out).length > 0 ? out : undefined;
}

function podManifest(o: EnsureSandboxOptions): V1Pod {
	return {
		metadata: {
			name: o.name,
			namespace: o.namespace,
			labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [SANDBOX_NAME_LABEL]: o.name },
			annotations: { [SANDBOX_ID_ANNOTATION]: String(o.sandboxId) },
		},
		spec: {
			restartPolicy: 'Never',
			// The keep-alive `sleep` ignores SIGTERM, so the k8s default 30s grace
			// would leave every deleted Pod Terminating (still holding its resources,
			// still phase Running) for 30s. Nothing in the Pod needs a graceful stop —
			// session state is captured before destroy — so keep the window short.
			terminationGracePeriodSeconds: 5,
			serviceAccountName: o.serviceAccountName,
			imagePullSecrets: o.imagePullSecret ? [{ name: o.imagePullSecret }] : undefined,
			containers: [
				{
					name: CONTAINER_NAME,
					image: o.image,
					imagePullPolicy: o.imagePullPolicy ?? defaultImagePullPolicy(o.image),
					// Keep-alive: the Pod idles while we exec marimo into it (see
					// startProcess). Mirrors the CoreWeave "main process is keep-alive".
					command: ['sh', '-c', 'sleep infinity'],
					ports: [{ containerPort: o.port }],
					resources: buildResources(o.resources),
				},
			],
		},
	};
}

function serviceManifest(o: EnsureSandboxOptions): V1Service {
	return {
		metadata: {
			name: o.name,
			namespace: o.namespace,
			labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
		},
		spec: {
			selector: { [SANDBOX_NAME_LABEL]: o.name },
			ports: [{ port: o.port, targetPort: o.port, protocol: 'TCP' }],
		},
	};
}

function ingressTls(o: EnsureSandboxOptions): V1IngressTLS[] | undefined {
	const mode = resolveIngressTlsMode(o.ingressTlsMode, o.tlsSecretName);
	if (mode === 'disabled') return undefined;
	if (mode === 'default') return [{}];
	if (!o.tlsSecretName) throw new Error('Ingress TLS mode "secret" requires a TLS secret name');
	return [{ hosts: [o.host], secretName: o.tlsSecretName }];
}

function ingressManifest(o: EnsureSandboxOptions): V1Ingress {
	return {
		metadata: {
			name: o.name,
			namespace: o.namespace,
			labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
			annotations: validateIngressAnnotations(o.ingressAnnotations),
		},
		spec: {
			ingressClassName: o.ingressClassName,
			tls: ingressTls(o),
			rules: [
				{
					host: o.host,
					http: {
						paths: [
							{
								path: '/',
								pathType: 'Prefix',
								backend: { service: { name: o.name, port: { number: o.port } } },
							},
						],
					},
				},
			],
		},
	};
}

/** Map a terminal `V1Status` from an exec to a process exit code. */
function exitCodeFromStatus(status: V1Status | undefined): number {
	if (!status) return 0;
	if (status.status === 'Success') return 0;
	const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
	const code = cause?.message ? Number(cause.message) : Number.NaN;
	return Number.isNaN(code) ? 1 : code;
}

/** A `Writable` that accumulates everything written to it into a string. */
function collector(): { stream: Writable; text: () => string } {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.from(chunk));
			cb();
		},
	});
	return { stream, text: () => Buffer.concat(chunks).toString('utf-8') };
}

/** The lazily-loaded cluster API handles this client drives. */
interface Apis {
	core: K8s.CoreV1Api;
	net: K8s.NetworkingV1Api;
	exec: K8s.Exec;
}

/**
 * Load `@kubernetes/client-node` at runtime (never bundled) and build the API
 * handles. The variable specifier + the optional-dependency contract keep it out
 * of the server image; throw an actionable error when it isn't installed.
 */
async function loadApis(): Promise<Apis> {
	const moduleName = ['@kubernetes', 'client-node'].join('/');
	let k8s: typeof K8s;
	try {
		k8s = (await import(/* @vite-ignore */ moduleName)) as typeof K8s;
	} catch {
		throw new Error(
			"MARIMOHUB_COMPUTE_BACKEND=kubernetes requires the '@kubernetes/client-node' package. " +
				'Run `pnpm add @kubernetes/client-node` and bake it into the server image to use this backend.',
		);
	}
	const kc = new k8s.KubeConfig();
	// Prefer the in-cluster service account (production); fall back to the local
	// kubeconfig (dev). loadFromCluster throws off-cluster, so guard it.
	try {
		kc.loadFromCluster();
	} catch {
		kc.loadFromDefault();
	}
	return {
		core: kc.makeApiClient(k8s.CoreV1Api),
		net: kc.makeApiClient(k8s.NetworkingV1Api),
		exec: new k8s.Exec(kc),
	};
}

export function createK8sClient(config: KubernetesConfig): K8sClient {
	const namespace = config.namespace ?? 'default';

	// Load the SDK + API handles once, lazily, on first use.
	let apisPromise: Promise<Apis> | undefined;
	const apis = (): Promise<Apis> => (apisPromise ??= loadApis());

	/** True when the resource was created now, false when it already existed. */
	async function createTolerant(create: () => Promise<unknown>): Promise<boolean> {
		try {
			await create();
			return true;
		} catch (err) {
			if (hasCode(err, 409)) return false; // already exists — idempotent
			throw err;
		}
	}

	async function deleteTolerant(del: () => Promise<unknown>): Promise<void> {
		try {
			await del();
		} catch (err) {
			if (hasCode(err, 404)) return; // already gone — idempotent
			throw err;
		}
	}

	async function reconcileIngress(net: K8s.NetworkingV1Api, desired: V1Ingress): Promise<void> {
		try {
			await net.createNamespacedIngress({ namespace, body: desired });
			return;
		} catch (err) {
			if (!hasCode(err, 409)) throw err;
		}

		const metadata = desired.metadata;
		const name = metadata?.name;
		if (!metadata || !name) throw new Error('Cannot reconcile an Ingress without a name');
		const desiredLabels = metadata.labels;
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await net.readNamespacedIngress({ name, namespace });
			if (existing.metadata?.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
				throw new Error(`Refusing to replace unmanaged Ingress "${name}"`);
			}
			const resourceVersion = existing.metadata.resourceVersion;
			if (!resourceVersion) throw new Error(`Ingress "${name}" has no resourceVersion`);
			metadata.resourceVersion = resourceVersion;
			metadata.labels = { ...existing.metadata.labels, ...desiredLabels };
			metadata.finalizers = existing.metadata.finalizers;
			metadata.ownerReferences = existing.metadata.ownerReferences;
			try {
				await net.replaceNamespacedIngress({ name, namespace, body: desired });
				return;
			} catch (err) {
				if (!hasCode(err, 409) || attempt === 2) throw err;
			}
		}
	}

	return {
		async ensure(o: EnsureSandboxOptions): Promise<{ createdPod: boolean }> {
			const pod = podManifest(o);
			const service = serviceManifest(o);
			const ingress = o.host ? ingressManifest(o) : undefined;
			const { core, net } = await apis();
			// Order-independent: k8s is declarative (a Service's selector / an
			// Ingress's backend need not pre-exist), so the creates fan out.
			const [createdPod] = await Promise.all([
				createTolerant(() => core.createNamespacedPod({ namespace, body: pod })),
				createTolerant(() => core.createNamespacedService({ namespace, body: service })),
				// No host configured → no Ingress (the URL will be unroutable; documented).
				ingress ? reconcileIngress(net, ingress) : undefined,
			]);
			return { createdPod };
		},

		async getPhase(name: string): Promise<K8sPodPhaseInfo | undefined> {
			const { core } = await apis();
			try {
				const pod = await core.readNamespacedPod({ name, namespace });
				const transition = (type: string) =>
					pod.status?.conditions?.find((c) => c.type === type && c.status === 'True')
						?.lastTransitionTime;
				return {
					phase: pod.status?.phase,
					uid: pod.metadata?.uid,
					createdAt: pod.metadata?.creationTimestamp,
					scheduledAt: transition('PodScheduled'),
					readyAt: transition('Ready'),
				};
			} catch (err) {
				if (hasCode(err, 404)) return undefined;
				throw err;
			}
		},

		async getSchedulingFailure(name: string): Promise<string | undefined> {
			const { core } = await apis();
			try {
				const events = await core.listNamespacedEvent({
					namespace,
					fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${name}`,
				});
				const failures = events.items
					.filter(
						(event) =>
							event.reason === 'FailedScheduling' ||
							event.message?.toLowerCase().includes('unschedulable'),
					)
					.filter((event) => Boolean(event.message))
					.sort((a, b) => {
						const aTime =
							a.series?.lastObservedTime ??
							a.lastTimestamp ??
							a.eventTime ??
							a.metadata?.creationTimestamp ??
							a.firstTimestamp;
						const bTime =
							b.series?.lastObservedTime ??
							b.lastTimestamp ??
							b.eventTime ??
							b.metadata?.creationTimestamp ??
							b.firstTimestamp;
						return (aTime?.getTime() ?? 0) - (bTime?.getTime() ?? 0);
					});
				return failures.at(-1)?.message;
			} catch {
				return undefined;
			}
		},

		async getImagePullMessage(name: string, uid?: string): Promise<string | undefined> {
			const { core } = await apis();
			try {
				const events = await core.listNamespacedEvent({
					namespace,
					fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${name}`,
				});
				// Events are name-scoped, and names are deterministic per sandbox — match
				// the current Pod's UID so a recreated Pod never picks up an old event.
				return events.items.find(
					(e) => e.reason === 'Pulled' && (!uid || e.involvedObject?.uid === uid),
				)?.message;
			} catch {
				// Diagnostics only — never fail a boot because the event was unreadable.
				return undefined;
			}
		},

		async exec(
			name: string,
			command: string[],
			stdin?: string | Uint8Array,
			options?: K8sExecOptions,
		): Promise<K8sExecResult> {
			const { exec } = await apis();
			const out = collector();
			const errc = collector();
			// objectMode: false — the default would emit a Uint8Array as a single
			// object chunk instead of streaming its bytes to the pod's stdin.
			const stdinStream =
				stdin !== undefined ? Readable.from([stdin], { objectMode: false }) : null;

			return new Promise<K8sExecResult>((resolve, reject) => {
				let status: V1Status | undefined;
				let settled = false;
				let socket: ExecSocket | undefined;
				const finish = (result: K8sExecResult) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(result);
				};
				const fail = (error: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(execSocketError(error));
				};
				const timer =
					options?.timeout !== undefined && options.timeout > 0
						? setTimeout(() => {
								stdinStream?.destroy();
								fail(new Error(`command timed out after ${options.timeout}ms`));
								socket?.close();
							}, options.timeout)
						: undefined;
				timer?.unref();
				exec
					.exec(
						namespace,
						name,
						CONTAINER_NAME,
						command,
						out.stream,
						errc.stream,
						stdinStream,
						false,
						(s) => {
							status = s;
						},
					)
					.then((connectedSocket: ExecSocket) => {
						socket = connectedSocket;
						if (settled) {
							connectedSocket.close();
							return;
						}
						addExecSocketListener(connectedSocket, 'close', () =>
							finish({
								stdout: out.text(),
								stderr: errc.text(),
								exitCode: exitCodeFromStatus(status),
							}),
						);
						addExecSocketListener(connectedSocket, 'error', fail);
					})
					.catch(fail);
			});
		},

		async delete(name: string): Promise<void> {
			const { core, net } = await apis();
			await Promise.all([
				deleteTolerant(() => net.deleteNamespacedIngress({ name, namespace })),
				deleteTolerant(() => core.deleteNamespacedService({ name, namespace })),
				deleteTolerant(() => core.deleteNamespacedPod({ name, namespace })),
			]);
		},

		async list(): Promise<K8sSandboxInfo[]> {
			const { core } = await apis();
			const pods = await core.listNamespacedPod({
				namespace,
				labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
			});
			const infos: K8sSandboxInfo[] = [];
			for (const pod of pods.items) {
				const sandboxId = pod.metadata?.annotations?.[SANDBOX_ID_ANNOTATION];
				if (!SandboxId.is(sandboxId)) continue;
				infos.push({
					sandboxId,
					phase: pod.status?.phase,
					createdAt: pod.metadata?.creationTimestamp
						? new Date(pod.metadata.creationTimestamp).toISOString()
						: undefined,
				});
			}
			return infos;
		},
	};
}

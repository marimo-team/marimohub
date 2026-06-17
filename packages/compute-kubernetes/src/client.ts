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
import type { V1Container, V1Ingress, V1Pod, V1Service, V1Status } from '@kubernetes/client-node';
import { SandboxId } from '@marimo-hub/core';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, SANDBOX_ID_ANNOTATION } from './shared';
import type {
	EnsureSandboxOptions,
	K8sClient,
	K8sExecResult,
	K8sSandboxInfo,
	KubernetesConfig,
} from './shared';

/** Per-session label the Service selector matches (unique per sandbox). */
const SANDBOX_NAME_LABEL = 'marimohub.io/sandbox-name';
/** The single container name in each kernel Pod (the exec target). */
const CONTAINER_NAME = 'marimo';

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
			serviceAccountName: o.serviceAccountName,
			imagePullSecrets: o.imagePullSecret ? [{ name: o.imagePullSecret }] : undefined,
			containers: [
				{
					name: CONTAINER_NAME,
					image: o.image,
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

function ingressManifest(o: EnsureSandboxOptions): V1Ingress {
	return {
		metadata: {
			name: o.name,
			namespace: o.namespace,
			labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
		},
		spec: {
			ingressClassName: o.ingressClassName,
			tls: o.tlsSecretName ? [{ hosts: [o.host], secretName: o.tlsSecretName }] : undefined,
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

	async function createTolerant(create: () => Promise<unknown>): Promise<void> {
		try {
			await create();
		} catch (err) {
			if (hasCode(err, 409)) return; // already exists — idempotent
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

	return {
		async ensure(o: EnsureSandboxOptions): Promise<void> {
			const { core, net } = await apis();
			await createTolerant(() => core.createNamespacedPod({ namespace, body: podManifest(o) }));
			await createTolerant(() =>
				core.createNamespacedService({ namespace, body: serviceManifest(o) }),
			);
			// No host configured → no Ingress (the URL will be unroutable; documented).
			if (o.host) {
				await createTolerant(() =>
					net.createNamespacedIngress({ namespace, body: ingressManifest(o) }),
				);
			}
		},

		async getPhase(name: string): Promise<string | undefined> {
			const { core } = await apis();
			try {
				const pod = await core.readNamespacedPod({ name, namespace });
				return pod.status?.phase;
			} catch (err) {
				if (hasCode(err, 404)) return undefined;
				throw err;
			}
		},

		async exec(name: string, command: string[], stdin?: string): Promise<K8sExecResult> {
			const { exec } = await apis();
			const out = collector();
			const errc = collector();
			const stdinStream = stdin !== undefined ? Readable.from([stdin]) : null;

			return new Promise<K8sExecResult>((resolve, reject) => {
				let status: V1Status | undefined;
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
					.then((socket) => {
						socket.on('close', () =>
							resolve({
								stdout: out.text(),
								stderr: errc.text(),
								exitCode: exitCodeFromStatus(status),
							}),
						);
						socket.on('error', reject);
					})
					.catch(reject);
			});
		},

		async delete(name: string): Promise<void> {
			const { core, net } = await apis();
			await deleteTolerant(() => net.deleteNamespacedIngress({ name, namespace }));
			await deleteTolerant(() => core.deleteNamespacedService({ name, namespace }));
			await deleteTolerant(() => core.deleteNamespacedPod({ name, namespace }));
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

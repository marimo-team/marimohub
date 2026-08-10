/**
 * Constants and the cluster-API interface shared by the adapter orchestration
 * (`index.ts`) and the production client (`client.ts`). Kept in its own module so
 * the two can depend on it without forming an import cycle.
 */
import type { Millis, SandboxId } from '@marimo-hub/core';

/** Label marking resources THIS deployment owns (selection + discovery/cleanup). */
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'marimohub';
/** Annotation that carries the verbatim `SandboxId` for `listActive()` mapping. */
export const SANDBOX_ID_ANNOTATION = 'marimohub.io/sandbox-id';

/** `imagePullPolicy` for the kernel container. See `defaultImagePullPolicy`. */
export type ImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

/**
 * Tag-sensitive pull-policy default, mirroring Kubernetes' own: `Always` for a
 * mutable `:latest`/untagged image (correctness — a cached stale image would
 * otherwise be served forever), `IfNotPresent` for a pinned tag or digest
 * (performance — skips the per-start registry round-trip, which `Always`
 * costs even when the image is cached). Pinning the image is what unlocks the
 * fast path; an explicit `imagePullPolicy` config overrides this.
 */
export function defaultImagePullPolicy(image: string): ImagePullPolicy {
	if (image.includes('@')) return 'IfNotPresent'; // digest-pinned, immutable
	// The tag is after the last ':' only when that ':' follows the last '/'
	// (otherwise it's a registry port, e.g. `registry:5000/img`).
	const lastSegment = image.slice(image.lastIndexOf('/') + 1);
	const tag = lastSegment.includes(':') ? lastSegment.slice(lastSegment.indexOf(':') + 1) : '';
	return !tag || tag === 'latest' ? 'Always' : 'IfNotPresent';
}

export interface KubernetesResources {
	/** CPU request/limit (e.g. `1`, `500m`). */
	cpu?: string;
	/** Memory request/limit (e.g. `2Gi`). */
	memory?: string;
	/** GPU count, mapped to `nvidia.com/gpu` (e.g. `1`). */
	gpu?: string;
	profileLimits?: { cpu?: boolean; memory?: boolean };
}

export interface KubernetesConfig {
	/** Namespace the kernel Pod/Service/Ingress are created in. Default `default`. */
	namespace?: string;
	/** Container image with marimo + uv + python. Default `ghcr.io/marimo-team/marimo:latest`. */
	image?: string;
	/**
	 * Public hostname kernels are exposed under (`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`).
	 * REQUIRED for routing: each session gets a `{id}.{hostname}` Ingress host. When
	 * empty, no Ingress is created and the returned URL is unroutable.
	 */
	hostname?: string;
	/** Port marimo binds inside the Pod. Default 2718. */
	kernelPort?: number;
	/**
	 * Template for the public kernel URL. `{id}`, `{port}`, `{host}`, and `{token}`
	 * are substituted. Default `https://{id}.{host}` (a per-session subdomain routed
	 * by the per-session Ingress), where `{host}` is the `hostname` the provisioner
	 * passes (`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`).
	 */
	hostnameTemplate?: string;
	/** `ingressClassName` for the per-session Ingress (e.g. `traefik`, `nginx`). */
	ingressClassName?: string;
	/** TLS secret (typically a wildcard cert for `*.{host}`) for the Ingress. */
	tlsSecretName?: string;
	/** ServiceAccount the kernel Pod runs as. Omit for the namespace default. */
	serviceAccountName?: string;
	/** `imagePullSecrets` name for pulling a private kernel image. */
	imagePullSecret?: string;
	/** Kernel-container pull policy. Default: see `defaultImagePullPolicy`. */
	imagePullPolicy?: ImagePullPolicy;
	/** CPU/memory/GPU requested for each kernel Pod. */
	resources?: KubernetesResources;
	/** How long to wait for the Pod to reach `Running`. Default 2 minutes. */
	podReadyTimeout?: Millis;
}

/** Result of running a command in a Pod via the `exec` subresource. */
export interface K8sExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Everything `ensure()` needs to materialise a session's Pod/Service/Ingress. */
export interface EnsureSandboxOptions {
	/** Deterministic resource name (`mh-<sanitized id>`); also the Pod name for exec. */
	name: string;
	/** Verbatim `SandboxId`, stored in an annotation for `listActive()` mapping. */
	sandboxId: SandboxId;
	/** Ingress host for the kernel (`{id}.{host}`); the Ingress routes it to the Pod. */
	host: string;
	image: string;
	port: number;
	namespace: string;
	ingressClassName?: string;
	tlsSecretName?: string;
	serviceAccountName?: string;
	imagePullSecret?: string;
	imagePullPolicy?: ImagePullPolicy;
	resources?: KubernetesResources;
}

/**
 * Pod phase plus the boot timestamps that ride along on the same read. The
 * boot poll GETs the Pod every interval anyway, so capturing these there costs
 * no extra API call and keeps the startup breakdown off the readiness path.
 * Timestamps come from conditions with `status=True` only — a transient
 * `Ready=False` must not be reported as readiness.
 */
export interface K8sPodPhaseInfo {
	/** Pod phase (`Pending` | `Running` | `Succeeded` | `Failed` | `Unknown`). */
	phase?: string;
	/** UID of this Pod incarnation (a recreated Pod reuses the name, not the UID). */
	uid?: string;
	/** Pod `creationTimestamp`. */
	createdAt?: Date;
	/** `PodScheduled=True` transition time. */
	scheduledAt?: Date;
	/** `Ready=True` transition time. */
	readyAt?: Date;
}

export interface K8sSandboxInfo {
	/** Verbatim `SandboxId` read back from the Pod's annotation. */
	sandboxId: SandboxId;
	/** Pod phase (`Pending` | `Running` | `Succeeded` | `Failed` | `Unknown`). */
	phase?: string;
	/** ISO creation timestamp from the Pod metadata. */
	createdAt?: string;
}

/**
 * The slice of the cluster API this adapter uses. Declaring it as an interface
 * (rather than depending on `@kubernetes/client-node` directly) is the injection
 * seam: tests pass an in-memory fake, production passes the real client.
 */
export interface K8sClient {
	/**
	 * Create the Pod + Service + Ingress for a session if they don't already
	 * exist. `createdPod` is false when the Pod pre-existed (a reconnect).
	 */
	ensure(options: EnsureSandboxOptions): Promise<{ createdPod: boolean }>;
	/** Pod phase + boot timestamps, or `undefined` if the Pod does not exist. */
	getPhase(name: string): Promise<K8sPodPhaseInfo | undefined>;
	/** Latest scheduler rejection for the Pod, when one exists. */
	getSchedulingFailure(name: string): Promise<string | undefined>;
	/**
	 * Kubelet `Pulled` event message for the Pod incarnation `uid` — either
	 * `Successfully pulled image "…" in 1.2s …` or `Container image "…" already
	 * present on machine`. Best-effort: `undefined` on any failure.
	 */
	getImagePullMessage(name: string, uid?: string): Promise<string | undefined>;
	/** Run a command in the Pod; `stdin` is piped to the process when provided. */
	exec(name: string, command: string[], stdin?: string | Uint8Array): Promise<K8sExecResult>;
	/** Delete the Pod + Service + Ingress for a session. Idempotent (tolerates 404). */
	delete(name: string): Promise<void>;
	/** List sandboxes THIS deployment owns (label-scoped), for the reconciler. */
	list(): Promise<K8sSandboxInfo[]>;
}

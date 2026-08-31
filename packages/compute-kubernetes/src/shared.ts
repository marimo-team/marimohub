/**
 * Constants and the cluster-API interface shared by the adapter orchestration
 * (`index.ts`) and the production client (`client.ts`). Kept in its own module so
 * the two can depend on it without forming an import cycle.
 */
import type { Millis, SandboxExposureMode, SandboxId } from '@marimo-hub/core';

/** Label marking resources THIS deployment owns (selection + discovery/cleanup). */
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'marimohub';
/** Annotation that carries the verbatim `SandboxId` for `listActive()` mapping. */
export const SANDBOX_ID_ANNOTATION = 'marimohub.io/sandbox-id';

/** `imagePullPolicy` for the kernel container. See `defaultImagePullPolicy`. */
export type ImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

export type IngressTlsMode = 'disabled' | 'default' | 'controller-default' | 'secret';
export type ResolvedIngressTlsMode = Exclude<IngressTlsMode, 'default'>;

const ANNOTATION_NAME = /^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const MAX_ANNOTATIONS_SIZE_BYTES = 256 * 1024;

function validateAnnotationKey(key: string): void {
	const parts = key.split('/');
	if (parts.length > 2) throw new Error(`invalid annotation key "${key}"`);
	const name = parts.at(-1) ?? '';
	if (name.length > 63 || !ANNOTATION_NAME.test(name)) {
		throw new Error(`invalid annotation name in "${key}"`);
	}
	const prefix = parts.length === 2 ? parts[0] : undefined;
	if (
		prefix !== undefined &&
		(prefix.length > 253 ||
			prefix.split('.').some((label) => label.length > 63 || !DNS_LABEL.test(label)))
	) {
		throw new Error(`invalid DNS prefix in annotation key "${key}"`);
	}
}

export function validateIngressAnnotations(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected an object with string values');
	}
	const entries = Object.entries(value);
	let size = 0;
	for (const [key, annotationValue] of entries) {
		if (typeof annotationValue !== 'string') throw new Error('annotation values must be strings');
		validateAnnotationKey(key);
		size += Buffer.byteLength(key) + Buffer.byteLength(annotationValue);
	}
	if (size > MAX_ANNOTATIONS_SIZE_BYTES) {
		throw new Error('annotations exceed the Kubernetes 256 KiB limit');
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function parseIngressAnnotations(
	raw: string | undefined,
): Record<string, string> | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('expected valid JSON');
	}
	return validateIngressAnnotations(parsed);
}

export function resolveIngressTlsMode(
	mode: string | undefined,
	tlsSecretName?: string,
): ResolvedIngressTlsMode {
	const normalized = mode?.trim().toLowerCase();
	if (!normalized) return tlsSecretName ? 'secret' : 'controller-default';
	if (!['disabled', 'default', 'controller-default', 'secret'].includes(normalized)) {
		throw new Error(
			`invalid ingress TLS mode "${mode}" (expected disabled, controller-default, default, or secret)`,
		);
	}
	const resolved = normalized === 'default' ? 'controller-default' : normalized;
	if (resolved === 'secret' && !tlsSecretName) {
		throw new Error('ingress TLS mode "secret" requires a TLS secret name');
	}
	if (resolved !== 'secret' && tlsSecretName) {
		throw new Error(`ingress TLS mode "${normalized}" conflicts with a TLS secret name`);
	}
	return resolved as ResolvedIngressTlsMode;
}

export function validateIngressTlsHostnameTemplate(
	template: string,
	tlsMode: ResolvedIngressTlsMode,
): void {
	const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(template)?.[1]?.toLowerCase();
	if (tlsMode === 'disabled' && scheme !== 'http') {
		throw new Error('Disabled Kubernetes ingress TLS requires an http:// hostname template');
	}
	if (tlsMode !== 'disabled' && scheme !== 'https') {
		throw new Error('Kubernetes ingress TLS requires an https:// hostname template');
	}
}

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
	/** How the kernel is exposed. Proxy mode routes through the internal Service. */
	exposureMode?: SandboxExposureMode;
	/** Namespace the kernel Pod/Service and optional Ingress are created in. Default `default`. */
	namespace?: string;
	/** Container image with marimo + uv + python. Default `ghcr.io/marimo-team/marimo:latest`. */
	image?: string;
	/**
	 * Public hostname kernels are exposed under (`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`).
	 * In subdomain exposure, each session gets a `{id}.{hostname}` Ingress host.
	 * Proxy exposure ignores this value and does not create an Ingress.
	 */
	hostname?: string;
	/** Port marimo binds inside the Pod. Default 2718. */
	kernelPort?: number;
	/**
	 * Template for the kernel URL. `{id}`, `{name}`, `{namespace}`, `{port}`, `{host}`,
	 * and `{token}` are substituted. Subdomain exposure defaults to
	 * `https://{id}.{host}`. Proxy exposure defaults to the in-cluster Service URL.
	 */
	hostnameTemplate?: string;
	/** `ingressClassName` for the per-session Ingress (e.g. `traefik`, `nginx`). */
	ingressClassName?: string;
	/** Deployment-controlled annotations copied to every per-session Ingress. */
	ingressAnnotations?: Record<string, string>;
	/** TLS declaration mode. Plaintext exposure requires an explicit `disabled` value. */
	ingressTlsMode?: IngressTlsMode;
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

/** Everything `ensure()` needs to materialise a session's Pod/Service and optional Ingress. */
export interface EnsureSandboxOptions {
	/** Deterministic resource name (`mh-<sanitized id>`); also the Pod name for exec. */
	name: string;
	/** Verbatim `SandboxId`, stored in an annotation for `listActive()` mapping. */
	sandboxId: SandboxId;
	/** Ingress host for the kernel (`{id}.{host}`); the Ingress routes it to the Pod. */
	host: string;
	image: string;
	port: number;
	brokeredPorts?: readonly number[];
	namespace: string;
	ingressClassName?: string;
	ingressAnnotations?: Record<string, string>;
	ingressTlsMode?: IngressTlsMode;
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

export interface K8sExecOptions {
	timeout?: number;
}

/**
 * The slice of the cluster API this adapter uses. Declaring it as an interface
 * (rather than depending on `@kubernetes/client-node` directly) is the injection
 * seam: tests pass an in-memory fake, production passes the real client.
 */
export interface K8sClient {
	/**
	 * Create the Pod + Service and optional Ingress for a session if they don't already
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
	exec(
		name: string,
		command: string[],
		stdin?: string | Uint8Array,
		options?: K8sExecOptions,
	): Promise<K8sExecResult>;
	/** Delete the managed resources for a session. Idempotent (tolerates 404). */
	delete(name: string, options: { ingress: boolean }): Promise<void>;
	/** List sandboxes THIS deployment owns (label-scoped), for the reconciler. */
	list(): Promise<K8sSandboxInfo[]>;
}

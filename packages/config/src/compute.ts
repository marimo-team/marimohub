import { Millis, Seconds } from '@marimo-hub/core';
import type { SandboxProvider } from '@marimo-hub/core';
import { LocalCompute } from '@marimo-hub/compute-local';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { CoreWeaveCompute } from '@marimo-hub/compute-coreweave';
import { createWandbCompute } from '@marimo-hub/compute-coreweave/wandb';
import { DockerCompute } from '@marimo-hub/compute-container/docker';
import { PodmanCompute } from '@marimo-hub/compute-container/podman';
import { E2bCompute } from '@marimo-hub/compute-e2b';
import { KubernetesCompute } from '@marimo-hub/compute-kubernetes';
import { parseBool, parseEnum, parseIntEnv, parseList, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import { CONFIG_SPEC } from './spec';

/** The selectable compute backends, from the spec (the docs/wizard source of truth). */
const COMPUTE_BACKENDS = (
	CONFIG_SPEC.find((g) => g.selector === 'MARIMOHUB_COMPUTE_BACKEND')?.backends ?? []
)
	.map((b) => b.selectorValue)
	.filter(Boolean)
	.join(', ');

const COMPUTE_BACKEND_VALUES = [
	...(CONFIG_SPEC.find((g) => g.selector === 'MARIMOHUB_COMPUTE_BACKEND')?.backends ?? [])
		.map((b) => b.selectorValue)
		.filter((v): v is string => Boolean(v)),
	// Wiring-level aliases the registry does not list as first-class backends.
	'noop',
	'cloudflare',
];

export function computeBackend(env: Env): string | undefined {
	return parseEnum(env, 'MARIMOHUB_COMPUTE_BACKEND', {
		allowed: COMPUTE_BACKEND_VALUES,
		remediation: `Set it to one of: ${COMPUTE_BACKENDS}.`,
		docs: 'docs/configuration.md',
	});
}

/** Parse a `"start-end"` port range (e.g. `2718-2723`); undefined if unset. */
function parsePortRange(value: string | undefined): { start: number; end: number } | undefined {
	if (!value) return undefined;
	const m = value.match(/^(\d+)-(\d+)$/);
	if (!m)
		throw new ConfigError(
			`Invalid MARIMOHUB_COMPUTE_LOCAL_PORTS: ${value} (expected "start-end")`,
			{
				variable: 'MARIMOHUB_COMPUTE_LOCAL_PORTS',
				remediation: 'Use a numeric range like 2718-2723.',
			},
		);
	const start = Number(m[1]);
	const end = Number(m[2]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 1 ||
		end > 65_535 ||
		start > end
	) {
		throw new ConfigError(
			`Invalid MARIMOHUB_COMPUTE_LOCAL_PORTS: ${value} (ports must be 1-65535 and start must not exceed end)`,
			{
				variable: 'MARIMOHUB_COMPUTE_LOCAL_PORTS',
				remediation: 'Use an ascending TCP port range like 2718-2723.',
			},
		);
	}
	return { start, end };
}

const computeVar = (env: Env, key: string, backend: string) =>
	requiredVar(env, key, {
		remediation: `Required for the ${backend} compute backend.`,
		docs: 'docs/configuration.md#compute',
	});

export interface ComputeOptions {
	/**
	 * The marimohub-owned session TTL (seconds) the record-driven lifecycle sweep
	 * enforces with a graceful save + teardown. Providers with a hard lifetime cap
	 * (CoreWeave, E2B) default that cap to 2× this — an orphan backstop only — and
	 * reject an explicit cap below it.
	 */
	sessionMaxLifetimeSeconds?: Seconds;
	/** Effective marimohub idle deadline; Modal uses 1.5× this as a fallback. */
	sessionIdleTimeoutMs?: Millis;
}

/**
 * Resolve a provider's hard sandbox-lifetime cap. Unset → 2× the session TTL, so
 * the provider only ever kills sandboxes the lifecycle sweep has lost track of.
 * An explicit value below the session TTL is a misconfiguration that would
 * SIGKILL active sessions (losing edits) before marimohub can save them — throw.
 */
export function resolveLifetimeBackstop(
	env: Env,
	key: string,
	sessionMaxLifetimeSeconds?: Seconds,
): Seconds | undefined {
	const explicit = parseIntEnv(env, key);
	if (explicit === undefined) {
		return sessionMaxLifetimeSeconds ? Seconds.of(sessionMaxLifetimeSeconds * 2) : undefined;
	}
	if (sessionMaxLifetimeSeconds && explicit < sessionMaxLifetimeSeconds) {
		throw new ConfigError(
			`${key} (${explicit}) must be >= the session TTL ` +
				`(MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS = ${sessionMaxLifetimeSeconds}): a smaller ` +
				`provider cap hard-kills the sandbox (SIGKILL, no save) before marimohub can tear it ` +
				`down gracefully.`,
			{
				variable: key,
				remediation: 'Leave it unset to default to 2× the session TTL.',
				docs: 'docs/configuration.md#compute',
			},
		);
	}
	return Seconds.of(explicit);
}

/**
 * The deployment's selectable sandbox images, in order — `MARIMOHUB_COMPUTE_IMAGE`
 * parsed as a comma-separated list; the first entry is the default every notebook
 * uses unless it stores a `base_image` choice. For e2b the selectable values are
 * template ids, so `MARIMOHUB_COMPUTE_E2B_TEMPLATE` takes precedence. Empty for
 * backends with no image concept (local/none/noop).
 */
export function resolveSandboxImages(env: Env): string[] {
	switch (computeBackend(env)) {
		case undefined:
		case 'local':
		case 'none':
		case 'noop':
			return [];
		case 'e2b':
			return (
				parseList(env.MARIMOHUB_COMPUTE_E2B_TEMPLATE) ??
				parseList(env.MARIMOHUB_COMPUTE_IMAGE) ??
				[]
			);
		default:
			return parseList(env.MARIMOHUB_COMPUTE_IMAGE) ?? [];
	}
}

/**
 * True when the coreweave backend vends per-sandbox CAIOS creds itself
 * (sandbox-native WIF via `object_storage_access`). `makeWif` consults this:
 * hub-minted static `AWS_*` env would shadow the sidecar's auto-refreshing
 * creds in the AWS credential chain, so the two are mutually exclusive.
 */
export function usesSandboxNativeObjectStorage(env: Env): boolean {
	return (
		computeBackend(env) === 'coreweave' &&
		parseList(env.MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS) !== undefined
	);
}

function parseObjectStoragePermission(env: Env): 'read' | 'read-write' | undefined {
	const raw = env.MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION;
	if (raw === undefined || raw === 'read' || raw === 'read-write') return raw;
	throw new ConfigError(
		`Invalid MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION: ${raw} (expected read or read-write)`,
		{ variable: 'MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION' },
	);
}

export function makeCompute(env: Env, opts?: ComputeOptions): SandboxProvider {
	const backend = computeBackend(env);
	if (!backend) {
		throw new ConfigError('Missing required env var: MARIMOHUB_COMPUTE_BACKEND', {
			variable: 'MARIMOHUB_COMPUTE_BACKEND',
			remediation: `Set it to one of: ${COMPUTE_BACKENDS}.`,
			docs: 'docs/configuration.md',
		});
	}
	// Each provider is constructed with the DEFAULT image (first of the list); a
	// notebook's non-default choice rides in per-create via CreateSandboxOptions.
	const defaultImage = parseList(env.MARIMOHUB_COMPUTE_IMAGE)?.[0];
	switch (backend) {
		case 'modal': {
			const tokenId = computeVar(env, 'MARIMOHUB_COMPUTE_MODAL_TOKEN_ID', 'modal');
			const tokenSecret = computeVar(env, 'MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET', 'modal');
			computeVar(env, 'MARIMOHUB_COMPUTE_IMAGE', 'modal');
			if (!defaultImage)
				throw new ConfigError('MARIMOHUB_COMPUTE_IMAGE must contain at least one image', {
					variable: 'MARIMOHUB_COMPUTE_IMAGE',
					remediation: 'Set an image reference, or a comma-separated list of them.',
					docs: 'docs/configuration.md#compute',
				});
			return new ModalCompute({
				tokenId,
				tokenSecret,
				image: defaultImage,
				// App name scopes reconciler enumeration (listActive) to sandboxes this
				// deployment owns, so it never reaps co-tenant sandboxes in the workspace.
				appName: env.MARIMOHUB_COMPUTE_MODAL_APP_NAME,
				...(opts?.sessionIdleTimeoutMs !== undefined
					? { idleFallbackMs: Math.ceil(opts.sessionIdleTimeoutMs * 1.5) }
					: {}),
			});
		}
		case 'coreweave':
			// CoreWeave Sandboxes via the vendored @coreweave/cwsandbox SDK (Node gRPC).
			// A marimo-capable image (marimo + uv + python) should be supplied via
			// MARIMOHUB_COMPUTE_IMAGE; the kernel is reached at its public-ingress URL,
			// whose hostname scheme is CoreWeave backend/profile specific — set
			// MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (and, if needed, a HOSTNAME_TEMPLATE).
			return new CoreWeaveCompute({
				apiKey: computeVar(env, 'MARIMOHUB_COMPUTE_COREWEAVE_API_KEY', 'coreweave'),
				baseUrl: env.MARIMOHUB_COMPUTE_COREWEAVE_BASE_URL,
				image: defaultImage,
				ownerTag: env.MARIMOHUB_COMPUTE_COREWEAVE_OWNER_TAG,
				hostnameTemplate: env.MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE,
				// Profile + exposure modes are CoreWeave-side concepts; the profile names
				// the exposure levels (`ingressMode`) and egress modes a sandbox selects.
				// Defaults (`public`/`internet`) match the canonical CoreWeave profile.
				profileNames: parseList(env.MARIMOHUB_COMPUTE_COREWEAVE_PROFILE),
				userHomeProfileNames: parseList(env.MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_PROFILE),
				ingressMode: env.MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MODE,
				egressMode: env.MARIMOHUB_COMPUTE_COREWEAVE_EGRESS_MODE,
				maxLifetimeSeconds: resolveLifetimeBackstop(
					env,
					'MARIMOHUB_COMPUTE_COREWEAVE_MAX_LIFETIME_SECONDS',
					opts?.sessionMaxLifetimeSeconds,
				),
				// Off by default; do NOT enable alongside MARIMOHUB_PERSIST_WORKSPACE=workspace,
				// which would double-persist the same state.
				filesystemSnapshot: parseBool(env, 'MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT'),
				objectStorageBuckets: parseList(env.MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS),
				objectStoragePermission: parseObjectStoragePermission(env),
				objectStorageEndpoint: env.MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_ENDPOINT,
				objectStorageRegion: env.MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_REGION,
			});
		case 'wandb':
			// CoreWeave Sandboxes via the W&B gateway — the same adapter and endpoint as
			// `coreweave`, authenticated with a W&B API key (gRPC metadata) instead of a
			// CoreWeave key. The option surface is deliberately restricted: the gateway
			// does not support profile/placement overrides, GPU requests, or non-default
			// egress modes, and CAIOS vending is unconfirmed through it (use hub-minted
			// WIF for bucket access). Kernel URLs need no hostname config: the managed
			// runner assigns each sandbox a public IP the adapter resolves at expose time.
			return createWandbCompute({
				apiKey: computeVar(env, 'MARIMOHUB_COMPUTE_WANDB_API_KEY', 'wandb'),
				entity: env.MARIMOHUB_COMPUTE_WANDB_ENTITY,
				project: env.MARIMOHUB_COMPUTE_WANDB_PROJECT,
				baseUrl: env.MARIMOHUB_COMPUTE_WANDB_BASE_URL,
				image: defaultImage,
				ownerTag: env.MARIMOHUB_COMPUTE_WANDB_OWNER_TAG,
				maxLifetimeSeconds: resolveLifetimeBackstop(
					env,
					'MARIMOHUB_COMPUTE_WANDB_MAX_LIFETIME_SECONDS',
					opts?.sessionMaxLifetimeSeconds,
				),
			});
		case 'docker':
			// Each kernel runs in a container on a Docker daemon (local socket or a
			// remote DOCKER_HOST), reached directly at http://<host>:<published-port>.
			// Good for single-host self-hosting; `proxy()` is a no-op like local.
			return new DockerCompute({
				image: defaultImage,
				host: env.MARIMOHUB_COMPUTE_DOCKER_HOST,
				bindHost: env.MARIMOHUB_COMPUTE_DOCKER_BIND_HOST,
				network: env.MARIMOHUB_COMPUTE_DOCKER_NETWORK,
			});
		case 'podman':
			return new PodmanCompute({
				image: defaultImage,
				host: env.MARIMOHUB_COMPUTE_PODMAN_HOST,
				bindHost: env.MARIMOHUB_COMPUTE_PODMAN_BIND_HOST,
				network: env.MARIMOHUB_COMPUTE_PODMAN_NETWORK,
			});
		case 'e2b':
			// E2B sandboxes (e2b.dev): per-session sandbox with a public per-port URL
			// (https://<port>-<id>.e2b.app). The `e2b` SDK is an optional, bring-your-own
			// dependency — install it and bake it into the image to use this backend.
			// MARIMOHUB_COMPUTE_E2B_TEMPLATE is an E2B template (with marimo + uv), NOT a
			// container image; it falls back to MARIMOHUB_COMPUTE_IMAGE for convenience.
			return new E2bCompute({
				apiKey: computeVar(env, 'MARIMOHUB_COMPUTE_E2B_API_KEY', 'e2b'),
				template: parseList(env.MARIMOHUB_COMPUTE_E2B_TEMPLATE)?.[0] ?? defaultImage,
				domain: env.MARIMOHUB_COMPUTE_E2B_DOMAIN,
				ownerTag: env.MARIMOHUB_COMPUTE_E2B_OWNER_TAG,
				maxLifetimeSeconds: resolveLifetimeBackstop(
					env,
					'MARIMOHUB_COMPUTE_E2B_MAX_LIFETIME_SECONDS',
					opts?.sessionMaxLifetimeSeconds,
				),
			});
		case 'local':
			// Dev backend: spawns `uv run marimo edit` as a host subprocess and
			// serves the kernel at http://<host>:<port> for the browser to iframe.
			// Requires `uv` + Python on the host; not for shared/production use.
			// In Docker, set BIND_HOST=0.0.0.0 + PORTS to a published range.
			return new LocalCompute({
				host: env.MARIMOHUB_COMPUTE_LOCAL_HOST,
				bindHost: env.MARIMOHUB_COMPUTE_LOCAL_BIND_HOST,
				ports: parsePortRange(env.MARIMOHUB_COMPUTE_LOCAL_PORTS),
			});
		case 'kubernetes': {
			// Native Kubernetes: one keep-alive Pod + Service + Ingress per session,
			// created via @kubernetes/client-node and exec'd into to run marimo. The
			// kernel is reached directly at its `{id}.{host}` Ingress host, so set
			// MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME and provide an ingress class + a
			// wildcard-cert TLS secret. `proxy()` is a no-op like local/coreweave.
			const resources = {
				cpu: env.MARIMOHUB_COMPUTE_KUBERNETES_CPU,
				memory: env.MARIMOHUB_COMPUTE_KUBERNETES_MEMORY,
				gpu: env.MARIMOHUB_COMPUTE_KUBERNETES_GPU,
			};
			const hasResources = resources.cpu || resources.memory || resources.gpu;
			const podReadySeconds = parseIntEnv(
				env,
				'MARIMOHUB_COMPUTE_KUBERNETES_POD_READY_TIMEOUT_SECONDS',
			);
			const pullPolicy = env.MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY;
			if (pullPolicy && !['Always', 'IfNotPresent', 'Never'].includes(pullPolicy)) {
				throw new ConfigError(
					`Invalid MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY: ${pullPolicy}`,
					{
						variable: 'MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY',
						remediation: 'Use Always, IfNotPresent, or Never.',
					},
				);
			}
			return new KubernetesCompute({
				namespace: env.MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE,
				image: defaultImage,
				hostname: env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME,
				hostnameTemplate: env.MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE,
				ingressClassName: env.MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS,
				tlsSecretName: env.MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET,
				serviceAccountName: env.MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT,
				imagePullSecret: env.MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET,
				imagePullPolicy: pullPolicy as 'Always' | 'IfNotPresent' | 'Never' | undefined,
				resources: hasResources ? resources : undefined,
				podReadyTimeout:
					podReadySeconds === undefined ? undefined : Millis.seconds(podReadySeconds),
			});
		}
		case 'cloudflare':
			throw new ConfigError(
				'MARIMOHUB_COMPUTE_BACKEND=cloudflare requires a Workers Durable Object binding; wire it in examples/cloudflare-worker.',
				{ variable: 'MARIMOHUB_COMPUTE_BACKEND' },
			);
		case 'none':
		case 'noop':
			// No compute: storage/auth/API work and notebooks are browsable, but
			// provisioning a kernel session fails. Useful for local dev without Modal.
			return {
				create() {
					throw new Error(
						'No compute backend configured (MARIMOHUB_COMPUTE_BACKEND=none). Set it to "modal" to run kernels.',
					);
				},
				async proxy() {
					return null;
				},
			};
		default:
			throw new ConfigError(`Unknown MARIMOHUB_COMPUTE_BACKEND: ${backend}`, {
				variable: 'MARIMOHUB_COMPUTE_BACKEND',
				remediation: `Supported backends: ${COMPUTE_BACKENDS}.`,
				docs: 'docs/configuration.md#compute',
			});
	}
}

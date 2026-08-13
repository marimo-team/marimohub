/**
 * Metadata for the `MARIMOHUB_*` environment surface. `createFromEnv` (index.ts)
 * owns the wiring; this file owns the descriptions/defaults/examples. `spec.test.ts`
 * keeps the two in sync, and `configDocs.ts` renders this into docs/configuration.md.
 * Pure data — imports no adapters.
 */

export interface ConfigVar {
	/** The environment variable name, e.g. `MARIMOHUB_STORAGE_S3_BUCKET`. */
	id: string;
	/** Human-readable label, e.g. `S3 bucket`. */
	name: string;
	/** One-line explanation of what the variable controls. */
	description: string;
	/** Illustrative value (never a real secret). */
	example?: string;
	/** Only emit this variable from the setup wizard when the user supplies a value. */
	optIn?: boolean;
	/** Documented default, in string form, when the variable is unset. */
	default?: string;
	/** Whether the variable is required when its backend is selected. */
	required?: boolean;
	/** Whether the value is sensitive (rendered with a 🔒 marker). */
	secret?: boolean;
}

export interface ConfigBackend {
	/** Human-readable backend name, e.g. `S3`, `CoreWeave Sandbox`. */
	name: string;
	/**
	 * The `*_BACKEND` selector value that selects this backend (e.g. `s3`).
	 * Omitted for the pseudo-backends that group shared / server-wide vars.
	 */
	selectorValue?: string;
	/** Optional note shown under the backend heading. */
	description?: string;
	/** Whether this compute backend applies per-sandbox CPU and memory requests. */
	supportsComputeProfiles?: boolean;
	/** Whether this compute backend applies GPU requests from compute profiles. */
	supportsGpuProfiles?: boolean;
	vars: ConfigVar[];
}

export interface ConfigGroup {
	/** Category name, e.g. `Storage`, `Compute`, `Auth`, `Server / API`. */
	name: string;
	/** The selector env var that picks a backend, e.g. `MARIMOHUB_STORAGE_BACKEND`. */
	selector?: string;
	/** Default selector value when the selector is unset, if any. */
	selectorDefault?: string;
	/** Optional note shown under the category heading. */
	description?: string;
	backends: ConfigBackend[];
}

export const CONFIG_SPEC: ConfigGroup[] = [
	{
		name: 'Storage',
		selector: 'MARIMOHUB_STORAGE_BACKEND',
		selectorDefault: 's3',
		description:
			'Where all notebooks and state are stored. `s3`, `gcs`, and `azure` are the durable backends for self-hosted servers; `fs` is durable on a single node; `r2` is Workers-only and `memory` is for dev/tests.',
		backends: [
			{
				name: 'S3 / S3-compatible',
				selectorValue: 's3',
				description:
					'Any S3-compatible store: CoreWeave CAIOS, AWS S3, MinIO, Tigris, Ceph, or Cloudflare R2 via its S3 endpoint. Point `*_S3_ENDPOINT` at the provider.',
				vars: [
					{
						id: 'MARIMOHUB_STORAGE_S3_BUCKET',
						name: 'S3 bucket',
						description: 'Name of the bucket that backs the hub.',
						example: 'orgname-marimohub',
						required: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_S3_ENDPOINT',
						name: 'S3 endpoint',
						description:
							'Custom endpoint for non-AWS providers (MinIO, Tigris, Ceph, R2-via-S3). Omit for AWS.',
						example: 'https://s3.us-east-1.amazonaws.com',
					},
					{
						id: 'MARIMOHUB_STORAGE_S3_REGION',
						name: 'S3 region',
						description: 'AWS region for the bucket.',
						example: 'us-east-1',
						default: 'auto (SDK default)',
					},
					{
						id: 'MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID',
						name: 'S3 access key id',
						description:
							'Access key id. Set both key id and secret together to use static credentials, or neither to use the SDK default credential chain. Setting only one is rejected at startup.',
						secret: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY',
						name: 'S3 secret access key',
						description: 'Secret access key (paired with the access key id above).',
						secret: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_S3_FORCE_PATH_STYLE',
						name: 'Force path-style addressing',
						description: 'Use path-style bucket addressing (required by MinIO/Ceph).',
						example: 'true',
						default: 'false',
					},
				],
			},
			{
				name: 'Google Cloud Storage',
				selectorValue: 'gcs',
				description:
					'Native GCS via its JSON API; uses object generations for the atomic conditional writes marimohub requires. Authenticate with a service-account key or a static access token.',
				vars: [
					{
						id: 'MARIMOHUB_STORAGE_GCS_BUCKET',
						name: 'GCS bucket',
						description: 'Name of the GCS bucket that backs the hub.',
						example: 'orgname-marimohub',
						required: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_GCS_SA_KEY',
						name: 'GCS service-account key',
						description:
							'Service-account key JSON (the file contents). Minted into short-lived access tokens. Provide this OR a static access token.',
						secret: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_GCS_ACCESS_TOKEN',
						name: 'GCS access token',
						description:
							'Static OAuth2 access token, as an alternative to a service-account key (e.g. when an external process supplies tokens).',
						secret: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_GCS_API_ENDPOINT',
						name: 'GCS API endpoint',
						description:
							'Override the JSON API base URL — e.g. to target a fake-gcs-server emulator.',
						example: 'https://storage.googleapis.com',
						default: 'https://storage.googleapis.com',
					},
				],
			},
			{
				name: 'Azure Blob Storage',
				selectorValue: 'azure',
				description:
					'Native Azure Blob Storage using ETags for atomic conditional writes. Uses DefaultAzureCredential with an account URL, or a connection string for local and legacy deployments.',
				vars: [
					{
						id: 'MARIMOHUB_STORAGE_AZURE_CONTAINER',
						name: 'Azure container',
						description: 'Name of the Blob Storage container that backs the hub.',
						example: 'orgname-marimohub',
						required: true,
					},
					{
						id: 'MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL',
						name: 'Azure Blob service URL',
						description:
							'Blob service account URL used with DefaultAzureCredential. Required unless a connection string is set.',
						example: 'https://account.blob.core.windows.net',
					},
					{
						id: 'MARIMOHUB_STORAGE_AZURE_CONNECTION_STRING',
						name: 'Azure Storage connection string',
						description:
							'Connection string for local or legacy deployments. Do not set it with the account URL.',
						secret: true,
					},
				],
			},
			{
				name: 'Filesystem',
				selectorValue: 'fs',
				description:
					'Local-disk object store rooted at a host directory. Durable (as durable as the disk), zero external dependencies — for single-replica self-hosting. Conditional writes are enforced per-process, so never point two hub replicas at one directory.',
				vars: [
					{
						id: 'MARIMOHUB_STORAGE_FS_ROOT',
						name: 'Filesystem storage root',
						description:
							'Host directory that holds all hub state. Created if missing; must stay on a single filesystem (writes rely on atomic renames).',
						example: '/var/lib/marimohub/storage',
						required: true,
					},
				],
			},
			{
				name: 'Memory (dev/tests only)',
				selectorValue: 'memory',
				description:
					'Non-durable in-memory bucket — all state is lost on restart. Gated behind an explicit opt-in so it can never back a real deployment by accident.',
				vars: [
					{
						id: 'MARIMOHUB_ALLOW_EPHEMERAL_STORAGE',
						name: 'Allow ephemeral storage',
						description:
							'Safety gate: must be `true` to use the non-durable memory backend (dev/tests only).',
						example: 'true',
						default: 'false',
						required: true,
					},
				],
			},
			{
				name: 'R2 (Cloudflare Workers only)',
				selectorValue: 'r2',
				description:
					'Requires a Cloudflare R2 binding; wired by hand in `examples/cloudflare-worker`, not via env credentials.',
				vars: [],
			},
		],
	},
	{
		name: 'Compute',
		selector: 'MARIMOHUB_COMPUTE_BACKEND',
		description: 'Where notebook kernels run. The shared variables apply across compute backends.',
		backends: [
			{
				name: 'Shared',
				description: 'Read regardless of the selected compute backend.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_IMAGE',
						name: 'Sandbox image',
						description:
							'Container image with marimo + uv + python, or a comma-separated list of such images: the first is the default and the rest are selectable per notebook as base images. Required by the `modal` backend; recommended for `coreweave`.',
						example: 'ghcr.io/orgname/marimo-sandbox:latest',
					},
					{
						id: 'MARIMOHUB_COMPUTE_PROFILES',
						name: 'Compute profiles',
						description:
							'Ordered named CPU, memory, and optional GPU profiles (`name:cpu=<cores>;mem=<Mi|Gi|Ti>;gpu=<type>[:<count>]`, with a maximum GPU count of 8). The first is the default; supported backends apply the notebook choice when overrides are enabled. Modal applies GPU requests; other backends ignore them with a startup warning.',
						example: 'small:cpu=1;mem=2Gi,gpu-large:cpu=8;mem=32Gi;gpu=A100',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_PROFILE_OVERRIDE',
						name: 'Compute profile override',
						description:
							'Whether editors may choose a non-default compute profile per notebook (`none` or `editors`).',
						example: 'editors',
						default: 'none',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME',
						name: 'Sandbox hostname',
						description: 'Public hostname used to expose kernel ports.',
						example: 'hub.example.com',
						default: "'' (empty)",
					},
					{
						id: 'MARIMOHUB_COMPUTE_WORKDIR',
						name: 'Sandbox working directory',
						description:
							'Working directory inside the sandbox where notebook files land and marimo runs.',
						default: '/workspace',
					},
					{
						id: 'MARIMOHUB_COMPUTE_ASSET_URL',
						name: 'Frontend asset URL',
						description:
							'Base URL for marimo frontend assets (e.g. a CDN). Omit to use the bundled assets.',
						example: 'https://cdn.jsdelivr.net/npm/@marimo-team/frontend@{version}/dist',
					},
					{
						id: 'MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS',
						name: 'Sandbox startup timeout (seconds)',
						description:
							'How long a session start waits for the marimo kernel to come up before failing. Generous by default because a cold sandbox may resolve + download the notebook environment on first boot. Served on `/api/v1/capabilities` so the client bounds its own startup wait with the same value.',
						default: '120',
					},
				],
			},
			{
				name: 'CoreWeave Sandbox',
				selectorValue: 'coreweave',
				supportsComputeProfiles: true,
				description: 'CoreWeave Sandboxes via the vendored `@coreweave/cwsandbox` SDK.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_API_KEY',
						name: 'CoreWeave API key',
						description: 'CoreWeave Sandbox API key.',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_BASE_URL',
						name: 'CoreWeave base URL',
						description: 'Override the CoreWeave Sandbox API base URL.',
						default: 'https://api.cwsandbox.com (SDK default)',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_OWNER_TAG',
						name: 'CoreWeave owner tag',
						description: 'Tag applied to owned sandboxes for discovery and cleanup.',
						default: 'marimohub',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_HOSTNAME_TEMPLATE',
						name: 'CoreWeave hostname template',
						description:
							'Template for the public kernel URL. Substitutes `{sandboxId}`, `{port}`, `{host}`, `{token}`.',
						default: 'https://{sandboxId}-{port}.{host}',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_PROFILE',
						name: 'CoreWeave profile names',
						description:
							"Comma-separated CoreWeave sandbox profile name(s) applied at create (the `profile_name` of a runner binding). Omit to use the runner's default profile.",
						example: 'marimohub',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_PROFILE',
						name: 'CoreWeave user-home profile names',
						description:
							'Comma-separated CoreWeave profile name(s) used only for editor-or-higher edit sandboxes. These names must not overlap `MARIMOHUB_COMPUTE_COREWEAVE_PROFILE`. The profile must mount the selected PVC subdirectory at `/var/run/marimohub/user-home` with `subPathExpr: $(MARIMOHUB_USER_HOME_KEY)` and provide a writable `/mnt`. Requires `MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive`; apps and viewer sandboxes continue to use the normal profile.',
						example: 'marimohub-user-home',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MODE',
						name: 'CoreWeave ingress mode',
						description: 'Network ingress mode (backend/profile specific).',
						default: 'public',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_EGRESS_MODE',
						name: 'CoreWeave egress mode',
						description: 'Network egress mode (backend/profile specific).',
						default: 'internet',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_MAX_LIFETIME_SECONDS',
						name: 'CoreWeave max lifetime (seconds)',
						description:
							'Hard provider-side sandbox lifetime cap (SIGKILL, no save) — an orphan backstop behind the graceful session lifetime (`MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS`). Must be >= the session lifetime; leave unset to default to 2x it.',
						default: '2x MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS',
						example: '28800',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS',
						name: 'CoreWeave object-storage buckets',
						description:
							'Comma-separated CAIOS bucket names every sandbox gets automatic, auto-refreshing credentials for (vended in-sandbox by a CoreWeave sidecar). Requires the org wif-config on the Sandbox Gateway; creates fail with NOT_FOUND without it. Setting this disables hub-minted WIF. See docs/workload-identity-federation.md, "CoreWeave Object Storage (Automatic)".',
						example: 'my-org-data,my-org-models',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION',
						name: 'CoreWeave object-storage permission',
						description:
							'Access level for the buckets above: `read` or `read-write`. Capped by the org WIF config `max_permission`.',
						default: 'read-write',
						example: 'read',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_ENDPOINT',
						name: 'CoreWeave object-storage endpoint',
						description:
							'Injects the S3 endpoint into sandboxes as `AWS_ENDPOINT_URL_S3`. If Pod Identity supplies the credentials, set this variable without a bucket list.',
						example: 'https://cwobject.com',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_REGION',
						name: 'CoreWeave object-storage region',
						description:
							'Injects the region into sandboxes as `AWS_REGION`. This value does not require a bucket list.',
						example: 'us-east-04a',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT',
						name: 'CoreWeave filesystem snapshots',
						description:
							'Capture the whole sandbox filesystem (venv, packages, caches) as a native snapshot on teardown and restore it on the next session — full-state fidelity and fast cold-start. Off by default. NOT recommended alongside `MARIMOHUB_PERSIST_WORKSPACE=workspace`: the two double-persist state and waste storage.',
						default: 'false',
						example: 'true',
					},
				],
			},
			{
				name: 'W&B Sandboxes',
				selectorValue: 'wandb',
				supportsComputeProfiles: true,
				description:
					'CoreWeave Sandboxes via the W&B (Weights & Biases) gateway — the `coreweave` backend authenticated with a W&B API key. Kernel URLs are resolved automatically: the managed runner assigns each sandbox a public IP served over plain HTTP, so no sandbox hostname is needed. Profile/placement overrides, GPU requests, egress overrides, and CAIOS vending are not available through the gateway; use hub-minted WIF (docs/workload-identity-federation.md) for bucket access.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_WANDB_API_KEY',
						name: 'W&B API key',
						description: 'W&B API key (from wandb.ai user settings).',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_WANDB_ENTITY',
						name: 'W&B entity',
						description: 'W&B entity (team or user) sandboxes are attributed to.',
						example: 'my-team',
					},
					{
						id: 'MARIMOHUB_COMPUTE_WANDB_PROJECT',
						name: 'W&B project',
						description: 'W&B project sandboxes are attributed to.',
						example: 'sandbox',
					},
					{
						id: 'MARIMOHUB_COMPUTE_WANDB_BASE_URL',
						name: 'W&B sandbox gateway URL',
						description: 'Override the sandbox gateway URL.',
						default: 'https://api.cwsandbox.com',
					},
					{
						id: 'MARIMOHUB_COMPUTE_WANDB_OWNER_TAG',
						name: 'W&B owner tag',
						description: 'Tag applied to owned sandboxes for discovery and cleanup.',
						default: 'marimohub',
					},
					{
						id: 'MARIMOHUB_COMPUTE_WANDB_MAX_LIFETIME_SECONDS',
						name: 'W&B max lifetime (seconds)',
						description:
							'Hard provider-side sandbox lifetime cap (SIGKILL, no save) — an orphan backstop behind the graceful session lifetime (`MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS`). Must be >= the session lifetime; leave unset to default to 2x it.',
						default: '2x MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS',
						example: '28800',
					},
				],
			},
			{
				name: 'Modal',
				selectorValue: 'modal',
				supportsComputeProfiles: true,
				supportsGpuProfiles: true,
				description: 'Modal sandboxes.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_MODAL_TOKEN_ID',
						name: 'Modal token id',
						description: 'Modal API token id.',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET',
						name: 'Modal token secret',
						description: 'Modal API token secret.',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_MODAL_ENVIRONMENT',
						name: 'Modal environment',
						description:
							'Runs Modal apps and sandboxes in this named environment instead of the workspace default.',
						example: 'notebooks',
					},
					{
						id: 'MARIMOHUB_COMPUTE_MODAL_APP_NAME',
						name: 'Modal app name',
						description:
							'Limits cleanup to sandboxes this deployment created, so it never stops others sharing the same Modal workspace.',
						example: 'marimohub',
					},
				],
			},
			{
				name: 'Docker',
				selectorValue: 'docker',
				supportsComputeProfiles: true,
				description:
					'Runs each kernel in a container on a Docker daemon (local socket or remote `DOCKER_HOST`). Uses the shared `MARIMOHUB_COMPUTE_IMAGE`.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_DOCKER_HOST',
						name: 'Docker kernel host',
						description: 'Hostname the returned kernel URL points at (what the browser hits).',
						default: 'localhost',
					},
					{
						id: 'MARIMOHUB_COMPUTE_DOCKER_BIND_HOST',
						name: 'Docker bind host',
						description: 'Host interface the container port is published on.',
						default: '127.0.0.1',
					},
					{
						id: 'MARIMOHUB_COMPUTE_DOCKER_NETWORK',
						name: 'Docker network',
						description: 'Optional Docker network to attach sandboxes to.',
						example: 'marimohub',
					},
				],
			},
			{
				name: 'Podman',
				selectorValue: 'podman',
				supportsComputeProfiles: true,
				description:
					'Runs each kernel in a container through the Podman CLI. Supports local, rootless, or remote Podman when the server user has a configured connection. Uses the shared `MARIMOHUB_COMPUTE_IMAGE`.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_PODMAN_HOST',
						name: 'Podman kernel host',
						description: 'Hostname the returned kernel URL points at (what the browser hits).',
						default: 'localhost',
					},
					{
						id: 'MARIMOHUB_COMPUTE_PODMAN_BIND_HOST',
						name: 'Podman bind host',
						description: 'Host interface the container port is published on.',
						default: '127.0.0.1',
					},
					{
						id: 'MARIMOHUB_COMPUTE_PODMAN_NETWORK',
						name: 'Podman network',
						description: 'Optional Podman network to attach sandboxes to.',
						example: 'marimohub',
					},
				],
			},
			{
				name: 'E2B',
				selectorValue: 'e2b',
				description:
					'E2B sandboxes (e2b.dev). The `e2b` SDK is an optional, bring-your-own dependency — install it and bake it into the server image to use this backend.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_E2B_API_KEY',
						name: 'E2B API key',
						description: 'E2B API key.',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_E2B_TEMPLATE',
						name: 'E2B template',
						description:
							'E2B template id with marimo + uv + python, or a comma-separated list of template ids (first is the default, the rest are selectable per notebook). Falls back to `MARIMOHUB_COMPUTE_IMAGE`.',
						example: 'marimo',
					},
					{
						id: 'MARIMOHUB_COMPUTE_E2B_DOMAIN',
						name: 'E2B domain',
						description: 'Custom E2B domain (self-hosted/enterprise); defaults to `e2b.app`.',
					},
					{
						id: 'MARIMOHUB_COMPUTE_E2B_OWNER_TAG',
						name: 'E2B owner tag',
						description: 'Metadata tag applied to owned sandboxes for discovery and cleanup.',
						default: 'marimohub',
					},
					{
						id: 'MARIMOHUB_COMPUTE_E2B_MAX_LIFETIME_SECONDS',
						name: 'E2B max lifetime (seconds)',
						description:
							'Hard provider-side sandbox lifetime cap (E2B auto-kills past it, no save) — an orphan backstop behind the graceful session lifetime (`MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS`). Must be >= the session lifetime; leave unset to default to 2x it.',
						default: '2x MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS',
						example: '28800',
					},
				],
			},
			{
				name: 'Kubernetes',
				selectorValue: 'kubernetes',
				supportsComputeProfiles: true,
				description:
					'Native Kubernetes: one keep-alive Pod + Service + Ingress per session via `@kubernetes/client-node`. The kernel is reached directly at its `{id}.{host}` Ingress host, so set `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` and provide an ingress class + wildcard-cert TLS secret. marimohub runs in-cluster with RBAC on pods/services/ingresses.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE',
						name: 'Kubernetes namespace',
						description: 'Namespace the kernel Pod/Service/Ingress are created in.',
						example: 'marimo-kernels',
						default: 'default',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE',
						name: 'Kubernetes hostname template',
						description:
							'Template for the public kernel URL. Substitutes `{id}`, `{port}`, `{host}`, `{token}`.',
						default: 'https://{id}.{host}',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS',
						name: 'Kubernetes ingress class',
						description: '`ingressClassName` for the per-session Ingress.',
						example: 'traefik',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET',
						name: 'Kubernetes TLS secret',
						description:
							'TLS secret (typically a `*.{host}` wildcard cert) for the per-session Ingress.',
						example: 'marimo-kernels-wildcard-tls',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT',
						name: 'Kubernetes service account',
						description: 'ServiceAccount the kernel Pod runs as. Omit for the namespace default.',
						example: 'marimo-kernel',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET',
						name: 'Kubernetes image pull secret',
						description: '`imagePullSecrets` name for pulling a private kernel image.',
						example: 'regcred',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY',
						name: 'Kubernetes image pull policy',
						description:
							'Kernel-container `imagePullPolicy`: `Always`, `IfNotPresent`, or `Never`. Defaults like Kubernetes: `Always` for a `:latest`/untagged image, `IfNotPresent` for a pinned tag or digest. Pin the image to skip the per-start registry round-trip.',
						default: 'Always for :latest, else IfNotPresent',
						example: 'Always',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_CPU',
						name: 'Kubernetes CPU request',
						description: 'CPU requested for each kernel Pod (Kubernetes quantity).',
						example: '2',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_MEMORY',
						name: 'Kubernetes memory request',
						description: 'Memory requested for each kernel Pod (Kubernetes quantity).',
						example: '4Gi',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_GPU',
						name: 'Kubernetes GPU count',
						description: 'GPU count, mapped to the `nvidia.com/gpu` limit.',
						example: '1',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_POD_READY_TIMEOUT_SECONDS',
						name: 'Kubernetes pod-ready timeout (seconds)',
						description: 'How long to wait for the kernel Pod to reach `Running`.',
						default: '120',
					},
				],
			},
			{
				name: 'Local (dev only)',
				selectorValue: 'local',
				description:
					'Spawns `uv run marimo edit` as a host subprocess. Requires `uv` + Python on the host; not for shared/production use.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_LOCAL_HOST',
						name: 'Local host',
						description: 'Host the exposed kernel URL points to.',
						default: 'localhost',
					},
					{
						id: 'MARIMOHUB_COMPUTE_LOCAL_BIND_HOST',
						name: 'Local bind host',
						description: 'Interface marimo binds to (set `0.0.0.0` in Docker).',
						default: '127.0.0.1',
					},
					{
						id: 'MARIMOHUB_COMPUTE_LOCAL_PORTS',
						name: 'Local port range',
						description:
							'Published port range (`start-end`). Required in Docker; omit for ephemeral ports.',
						example: '2718-2723',
					},
				],
			},
			{
				name: 'None',
				selectorValue: 'none',
				description:
					'No compute (alias `noop`): notebooks are browsable but provisioning a kernel fails. Useful for local dev without Modal.',
				vars: [],
			},
		],
	},
	{
		name: 'Sandbox exposure',
		selector: 'MARIMOHUB_SANDBOX_EXPOSURE',
		selectorDefault: 'subdomain',
		description:
			"How running kernels are surfaced to the browser, agnostic of the compute backend. `subdomain` (default) reaches the kernel directly on its isolated `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` domain — true cross-origin isolation, not authenticated by the hub. `proxy` forwards all kernel traffic through the app at `…/proxy/<token>/`, so it passes through the hub's auth + per-session authorization, at the cost of serving untrusted code same-origin with the app (XSS-capable; trusted deployments only).",
		backends: [
			{
				name: 'Subdomain (direct, isolated domain)',
				selectorValue: 'subdomain',
				description:
					"The compute adapter's public kernel URL is used as-is. Set `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` to a domain separate from the app host.",
				vars: [],
			},
			{
				name: 'Proxy (through the app)',
				selectorValue: 'proxy',
				description:
					'All kernel traffic is forwarded through the app, authenticated like `/api/v1/*` and authorized per-session. Reuses `MARIMOHUB_AUTH_SESSION_SECRET` to sign routing tokens.',
				vars: [
					{
						id: 'MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED',
						name: 'Acknowledge untrusted same-origin',
						description:
							'Safety gate: must be `true` to boot in proxy mode, acknowledging that kernels then run untrusted code same-origin with the app (XSS-capable). Fails closed.',
						example: 'true',
						default: 'false',
						required: true,
					},
					{
						id: 'MARIMOHUB_APP_BASE_URL',
						name: 'App base URL',
						description:
							'Public origin used to build `…/proxy/<token>` client URLs, e.g. when the app sits behind a proxy that rewrites the host. Omit to derive it from the inbound request origin.',
						example: 'https://hub.example.com',
					},
				],
			},
		],
	},
	{
		name: 'Auth',
		selector: 'MARIMOHUB_AUTH_BACKEND',
		description:
			'Must be set explicitly (`oidc` | `cloudflare-access` | `dev`) — there is no default; an unset backend fails closed rather than falling back to the insecure dev bypass.',
		backends: [
			{
				name: 'OIDC',
				selectorValue: 'oidc',
				description: 'App-native OpenID Connect (the production backend).',
				vars: [
					{
						id: 'MARIMOHUB_AUTH_OIDC_ISSUER',
						name: 'OIDC issuer',
						description: 'Issuer URL (discovery via `/.well-known/openid-configuration`).',
						example: 'https://accounts.example.com',
						required: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_CLIENT_ID',
						name: 'OIDC client id',
						description: 'OAuth2 client id.',
						required: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_CLIENT_SECRET',
						name: 'OIDC client secret',
						description: 'OAuth2 client secret.',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_REDIRECT_URI',
						name: 'OIDC redirect URI',
						description: 'Absolute callback URL.',
						example: 'https://hub.example.com/api/auth/callback',
						required: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_AUDIENCE',
						name: 'OIDC audience (deprecated)',
						description:
							'Deprecated and ignored. The ID-token `aud` claim must contain the configured client ID.',
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_PROMPT',
						name: 'OIDC prompt',
						description:
							'OAuth `prompt` value. `select_account` displays the account chooser. Use `consent` to display consent again. Space-separated combinations are valid.',
						default: 'select_account',
						example: 'consent',
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_SCOPES',
						name: 'OIDC scopes',
						description:
							'Space-separated scopes. Must include `openid` and `email`. Add only scopes that the provider requires for group claims. `offline_access` is invalid because marimohub stores no refresh tokens.',
						default: 'openid email profile',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_EMAIL_VERIFICATION',
						name: 'Email verification policy',
						description:
							'Requires boolean `email_verified=true` by default. If a trusted issuer omits the claim, use `trusted-issuer`. Other present values are invalid.',
						default: 'required',
						example: 'trusted-issuer',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_SESSION_SECRET',
						name: 'Session secret',
						description: 'Secret that signs the session cookie (HS256; ≥32 bytes).',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_AUTH_SESSION_TTL_SECONDS',
						name: 'Auth session lifetime',
						description: 'Signed browser-session lifetime, from 300 to 86400 seconds.',
						default: '28800',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS',
						name: 'Allowed email domains',
						description:
							'Comma-separated email-domain allowlist. Set `*` to allow all domains. A single domain is also the Google `hd` hint.',
						example: 'example.com,example.org',
						required: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_GROUPS_CLAIM',
						name: 'Groups claim pointer',
						description:
							'RFC 6901 JSON Pointer to an array of exact provider group IDs. Required for group policy.',
						example: '/groups',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_ALLOWED_GROUPS',
						name: 'Allowed login groups',
						description:
							'Exact comma-separated group IDs. A user must belong to at least one. Missing or malformed group data fails closed.',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_SUPER_ADMIN_GROUPS',
						name: 'Super-admin groups',
						description: 'Exact comma-separated group IDs mapped to marimohub super-admin.',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_DEFAULT_VIEWER_GROUPS',
						name: 'Default viewer groups',
						description: 'Groups granted a deployment-wide default viewer role.',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_DEFAULT_EDITOR_GROUPS',
						name: 'Default editor groups',
						description: 'Groups granted a deployment-wide default editor role.',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_DEFAULT_MANAGER_GROUPS',
						name: 'Default manager groups',
						description: 'Groups granted a deployment-wide default project-manager role.',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_GROUP_SESSION_TTL_SECONDS',
						name: 'Group authorization lifetime',
						description:
							'Maximum group-session age, from 300 to 3600 seconds. This value limits the deprovisioning delay.',
						default: '3600',
						optIn: true,
					},
				],
			},
			{
				name: 'Dev bypass (local only)',
				selectorValue: 'dev',
				description: 'Fixed, unauthenticated identity for local development.',
				vars: [
					{
						id: 'MARIMOHUB_AUTH_DEV_USER_ID',
						name: 'Dev user id',
						description: 'Fixed dev user id.',
						default: 'user',
					},
					{
						id: 'MARIMOHUB_AUTH_DEV_EMAIL',
						name: 'Dev email',
						description: 'Fixed dev user email.',
						default: 'user@localhost',
					},
					{
						id: 'MARIMOHUB_AUTH_DEV_NAME',
						name: 'Dev name',
						description: 'Fixed dev user display name.',
						default: 'Local Dev',
					},
				],
			},
			{
				name: 'Cloudflare Access (Workers only)',
				selectorValue: 'cloudflare-access',
				description:
					'Wired by hand in `examples/cloudflare-worker` (reads unprefixed `AUTH_MODE` / `ACCESS_TEAM` / `ACCESS_AUD` from the Workers runtime — a separate deployment surface not covered here).',
				vars: [],
			},
		],
	},
	{
		name: 'Server / API',
		description: 'Server-wide settings; no backend selector.',
		backends: [
			{
				name: 'Server',
				vars: [
					{
						id: 'MARIMOHUB_EXPERIMENTS',
						name: 'Experiments',
						description:
							'Comma-separated experimental feature IDs. Unknown IDs fail startup. Current values: `duckdb-wasm-preview`.',
						example: 'duckdb-wasm-preview',
					},
					{
						id: 'PORT',
						name: 'HTTP port',
						description: 'Port the HTTP server listens on.',
						default: '3000',
					},
					{
						id: 'MARIMOHUB_STATIC_ROOT',
						name: 'Static root',
						description: "Directory containing the web UI's static files.",
						default: './public',
					},
					{
						id: 'MARIMOHUB_RUN_MAINTENANCE',
						name: 'Run maintenance',
						description:
							'Run background maintenance (expiring old sessions, cleaning up sandboxes) on this replica only.',
						example: 'true',
						default: 'false',
					},
					{
						id: 'MARIMOHUB_MAX_SESSIONS_PER_USER',
						name: 'Max sessions per user',
						description:
							'Per-user concurrent session cap (`0` = unlimited). Counts `edit` sessions, and separately bounds the apps a single user may have started — the cost ceiling a user cannot escape by fanning apps out across projects (apps are also capped per project via `MARIMOHUB_MAX_APPS_PER_PROJECT`).',
						default: '10',
					},
					{
						id: 'MARIMOHUB_MAX_APPS_PER_PROJECT',
						name: 'Max apps per project',
						description:
							'Concurrent app (`mode: app`) sessions per project (`0` = unlimited). Apps are shared per-notebook singletons, so this caps how many notebooks in a project can be served as apps at once.',
						default: '5',
					},
					{
						id: 'MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS',
						name: 'Session max lifetime (seconds)',
						description:
							'marimohub-owned hard session lifetime: the lifecycle sweep gracefully saves + tears the session down at this deadline (extending while editors are still connected). Provider-side caps (CoreWeave/E2B) default to 2x this as an orphan backstop.',
						default: '14400',
					},
					{
						id: 'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS',
						name: 'Session idle timeout (seconds)',
						description:
							'Reap a session (with a save) when it has no active editor connections AND its heartbeat has been stale this long. Modal receives a provider-side fallback at 1.5x this value.',
						default: '1800',
					},
					{
						id: 'MARIMOHUB_SESSION_SNAPSHOT_INTERVAL_SECONDS',
						name: 'Session snapshot interval (seconds)',
						description:
							'Periodic save cadence for live sessions — the durability floor bounding what a hard kill (backstop, node loss, OOM) can lose. Unchanged notebooks are deduped (no spurious versions). `0` disables periodic snapshots.',
						default: '120',
					},
					{
						id: 'MARIMOHUB_SESSION_LIFETIME_EXTENSION_SECONDS',
						name: 'Session lifetime extension (seconds)',
						description:
							'How far the session deadline slides each time the lifecycle sweep finds editors still connected at it.',
						default: '1800',
					},
					{
						id: 'MARIMOHUB_SESSION_CONNECTION_AWARE',
						name: 'Connection-aware reaping',
						description:
							'Ask the kernel for its active connection count before a lifetime/idle teardown, extending instead of reaping while editors are connected. Set `false` to reap strictly on schedule.',
						default: 'true',
					},
					{
						id: 'MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS',
						name: 'Session sweep interval (seconds)',
						description: 'How often the session-lifecycle sweep runs (on the maintenance replica).',
						default: '60',
					},
					{
						id: 'MARIMOHUB_ALLOWED_ORIGINS',
						name: 'Allowed origins',
						description:
							'Comma-separated extra Origins allowed for state-changing requests (CSRF; same-origin is always allowed).',
						example: 'https://app.example.com',
					},
					{
						id: 'MARIMOHUB_DEFAULT_ROLE',
						name: 'Default role',
						description:
							'Fallback role for any logged-in user who is not an explicit project member (viewer | editor | manager | none). `manager`/`editor`/`viewer` let everyone manage/edit/view every project; `none` hides projects a user does not own or belong to (they can still create their own). Project edit/delete requires manager.',
						example: 'editor',
						default: 'editor',
					},
					{
						id: 'MARIMOHUB_SUPER_ADMINS',
						name: 'Super admins',
						description:
							'Comma-separated user ids and/or emails granted implicit `admin` on every ' +
							'project, plus visibility of all projects in listings. An entry containing ' +
							'`@` matches only the login email, case-insensitively (trusting the email ' +
							'the auth provider asserts); any other entry matches only the user id, ' +
							'exactly. A personal access token minted by a super admin carries the same ' +
							'power. Super admins can suspend and reactivate users from the admin users ' +
							'page. Unset: no super admins.',
						example: 'admin@example.com,user_01HXY00000000000000000000',
					},
					{
						id: 'MARIMOHUB_VIEWER_MODE',
						name: 'Viewer mode',
						description:
							'What a user whose effective role is `viewer` gets ' +
							'(static | applications | ephemeral-sandbox); each tier is a superset of the ' +
							'previous. `static` serves the last captured HTML snapshot (no compute, no code ' +
							'execution); `applications` also lets viewers use notebooks running as shared ' +
							'apps (note: the app kernel runs with the project’s integration secrets/federated ' +
							'credentials, so only enable it for audiences you trust with the app’s ' +
							'outputs); `ephemeral-sandbox` additionally provisions a real edit kernel whose ' +
							'edits are discarded on teardown (no version, snapshot, or workspace ' +
							'write-back). Applies to any effective viewer — via `MARIMOHUB_DEFAULT_ROLE=viewer` ' +
							'or an explicit viewer membership. Editors and above are unaffected. ' +
							'See [Auth -> What viewers see](./auth.md#what-viewers-see-marimohub_viewer_mode).',
						example: 'applications',
						default: 'static',
					},
					{
						id: 'MARIMOHUB_EDITOR_SANDBOX_SHARING',
						name: 'Editor sandbox sharing',
						description:
							'Controls whether editors share one persistent sandbox per notebook (`shared`) or one editor owns it (`exclusive`). In `exclusive` mode, other editors can start temporary sandboxes or confirm a takeover. This setting does not affect apps or viewer sessions. See [Editor sessions](./editor-sessions.md).',
						example: 'exclusive',
						default: 'shared',
					},
					{
						id: 'MARIMOHUB_PERSIST_WORKSPACE',
						name: 'Persist workspace',
						description:
							'Which sandbox working-dir files survive a session (source | workspace). `source` persists only the source files (notebook.py + pyproject.toml); `workspace` also captures runtime files (e.g. generated data) into the notebook workspace on teardown and restores them on the next session.',
						example: 'workspace',
						default: 'source',
					},
					{
						id: 'MARIMOHUB_VERSION',
						name: 'Deployment version',
						description:
							'Build/deploy version (usually the short git SHA or release tag) shown in the UI footer and returned by `GET /api/v1/version`. Baked into the image at build time.',
						example: 'a1b2c3d',
						default: 'dev',
					},
					{
						id: 'MARIMOHUB_IMAGE',
						name: 'Deployment image',
						description:
							'Fully-qualified Docker image reference (`repo:tag`) the deployment runs, shown in the UI footer. Baked into the image at build time.',
						example: 'ghcr.io/marimo-team/marimohub:a1b2c3d',
					},
				],
			},
		],
	},
	{
		name: 'Workload Identity Federation',
		description:
			'Optional: let a notebook reach cloud resources (object storage, and for AWS any API the role allows) with NO long-lived key. The hub becomes an OIDC issuer and, per session, mints a short-lived project-scoped JWT and exchanges it server-side (via the selected broker) for temporary credentials, which it injects into the sandbox — the JWT itself never reaches the sandbox. Deployment-wide capability; each project opts in via its `federation` setting. All-or-nothing on the generic vars: set them to enable, or none to disable. See docs/workload-identity-federation.md.',
		backends: [
			{
				name: 'Issuer + target (generic)',
				vars: [
					{
						id: 'MARIMOHUB_WIF_SIGNING_KEY',
						name: 'WIF signing key',
						description:
							'RSA private key (PKCS8 PEM) the hub signs federation JWTs with — or its single-line base64 encoding, for secret stores synced as an env-file (e.g. Doppler → k8s Secret). The matching public key is published at /.well-known/jwks.json for the cloud to validate tokens.',
						example: '-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----',
						secret: true,
					},
					{
						id: 'MARIMOHUB_WIF_KID',
						name: 'WIF key id',
						description: 'Key id surfaced in the JWT header and the published JWKS.',
						example: 'wif-2026-06',
					},
					{
						id: 'MARIMOHUB_WIF_ISSUER_URL',
						name: 'WIF issuer URL',
						description:
							"The hub's public origin, used as the token `iss` and the OIDC discovery `issuer`. Must match the Issuer URL configured in the cloud's WIF config.",
						example: 'https://hub.example.com',
					},
					{
						id: 'MARIMOHUB_WIF_AUDIENCE',
						name: 'WIF audience',
						description:
							"Audience (`aud`) claim the consuming cloud expects; must match the Client ID / Audience in the cloud's WIF config.",
						example: 'coreweave-object-storage',
					},
					{
						id: 'MARIMOHUB_WIF_STORAGE_ENDPOINT',
						name: 'Federated S3 endpoint',
						description:
							'S3 endpoint for the federated bucket, injected as AWS_ENDPOINT_URL_S3. Set it for a non-AWS store (e.g. CoreWeave `cwobject.com`); omit for AWS S3. No fallback to MARIMOHUB_STORAGE_S3_ENDPOINT.',
						example: 'https://cwobject.com',
					},
					{
						id: 'MARIMOHUB_WIF_STORAGE_REGION',
						name: 'Federated S3 region',
						description:
							'Region injected into the sandbox as AWS_REGION. Set explicitly (no fallback to MARIMOHUB_STORAGE_S3_REGION).',
						example: 'us-east-1',
					},
				],
			},
			{
				name: 'Broker',
				vars: [
					{
						id: 'MARIMOHUB_WIF_BROKER',
						name: 'WIF broker',
						description:
							'Which credential broker exchanges the JWT for temporary creds. Required when WIF is enabled (no default, so the federated cloud is always explicit). Currently `coreweave` or `aws`; add an adapter implementing the core CredentialBroker port for more.',
						example: 'coreweave',
					},
					{
						id: 'MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL',
						name: 'CoreWeave exchange URL',
						description:
							'CoreWeave temporary-credentials endpoint (NOT the OIDC issuer URL). Required when the broker is `coreweave`. The hub exchanges the JWT here (JWT-only auth) for temporary S3 credentials.',
						example: 'https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<ORG-ID>',
					},
					{
						id: 'MARIMOHUB_WIF_AWS_ROLE_ARN',
						name: 'AWS role ARN',
						description:
							'IAM role assumed via STS `AssumeRoleWithWebIdentity`. Required when the broker is `aws`. The role trust policy must trust the hub as an IAM OIDC identity provider and pin the token `aud` to MARIMOHUB_WIF_AUDIENCE (and optionally `sub` to specific project ids). Leave MARIMOHUB_WIF_STORAGE_ENDPOINT unset for AWS S3.',
						example: 'arn:aws:iam::123456789012:role/marimohub-wif',
					},
					{
						id: 'MARIMOHUB_WIF_AWS_STS_URL',
						name: 'AWS STS endpoint',
						description:
							'STS endpoint the exchange POSTs to. Set a regional endpoint (recommended by AWS for latency and fault isolation) or leave unset for the global one.',
						default: 'https://sts.amazonaws.com',
						example: 'https://sts.us-east-1.amazonaws.com',
					},
				],
			},
		],
	},
	{
		name: 'Managed AI',
		selector: 'MARIMOHUB_AI_BACKEND',
		selectorDefault: 'none',
		description:
			'Optional: auto-configure the marimo AI assistant to use a managed provider, so it works with no user-supplied key. The hub injects a `marimo.toml` pointing at its own OpenAI-compatible proxy (`/api/ai/v1`) with a short-lived, session-scoped token; the proxy holds the real upstream key server-side and forwards requests. The real key is NEVER injected into a sandbox. Deployment-wide and default-on when configured. See docs/ai.md.',
		backends: [
			{
				name: 'Off',
				selectorValue: 'none',
				description:
					'No managed AI. The marimo assistant still works if a user supplies their own key in marimo settings.',
				vars: [],
			},
			{
				name: 'OpenAI-compatible upstream',
				selectorValue: 'openai-compatible',
				description:
					'Fronts any OpenAI-compatible upstream (OpenAI, OpenRouter, LiteLLM, or Anthropic’s OpenAI-compatible endpoint). Session tokens are signed with MARIMOHUB_AUTH_SESSION_SECRET.',
				vars: [
					{
						id: 'MARIMOHUB_AI_UPSTREAM_BASE_URL',
						name: 'Upstream base URL',
						description:
							'OpenAI-compatible upstream base URL; the proxy POSTs to `<base>/chat/completions`.',
						example: 'https://api.openai.com/v1',
						required: true,
					},
					{
						id: 'MARIMOHUB_AI_UPSTREAM_API_KEY',
						name: 'Upstream API key',
						description: 'The real upstream provider key. Held server-side; never injected.',
						example: 'sk-...',
						required: true,
						secret: true,
					},
					{
						id: 'MARIMOHUB_AI_UPSTREAM_PROJECT',
						name: 'Upstream project',
						description:
							'Optional `OpenAI-Project` header forwarded upstream — e.g. W&B Inference uses `entity/project` for usage attribution. Omit for providers that ignore it.',
						example: 'my-team/my-project',
					},
					{
						id: 'MARIMOHUB_AI_MODEL',
						name: 'Default model',
						description: 'Default upstream model id surfaced to marimo.',
						example: 'gpt-4o-mini',
						required: true,
					},
					{
						id: 'MARIMOHUB_AI_ALLOWED_MODELS',
						name: 'Allowed models',
						description:
							'Comma-separated allowlist of upstream model ids; off-list requests fall back to the default model. Unset allows any model.',
						example: 'gpt-4o-mini,gpt-4o',
					},
					{
						id: 'MARIMOHUB_AI_MAX_TOKENS',
						name: 'Max tokens',
						description: 'Optional `[ai] max_tokens` written into the injected notebook config.',
						example: '4096',
					},
					{
						id: 'MARIMOHUB_AI_RULES',
						name: 'Assistant rules',
						description: 'Optional `[ai] rules` (custom assistant instructions).',
						example: 'Prefer polars over pandas.',
					},
					{
						id: 'MARIMOHUB_AI_TOKEN_TTL_SECONDS',
						name: 'Session token TTL (seconds)',
						description: 'Per-session token lifetime in seconds.',
						default: '3600',
					},
				],
			},
		],
	},
	{
		name: 'Integration secret sources',
		description:
			'Configure secret fields with inline encryption or external references. Saving a reference validates its format and backend without fetching the value. Supported connection tests and new sessions resolve references. Resolution fails closed. See the [secret-source guide](./integration-secrets.md).',
		backends: [
			{
				name: 'Inline encrypted values',
				description: 'Encrypt marked secret fields before the hub writes an integration version.',
				vars: [
					{
						id: 'MARIMOHUB_SECRETS_KEK',
						name: 'Integration-secret KEK',
						description:
							'Generated 32-byte key in canonical base64 or hex encoding. The hub derives a per-object AES-256-GCM key. Marked secret fields contain ciphertext. Other fields remain plaintext. If unset, inline values are unavailable. If lost, existing inline values cannot be decrypted.',
						secret: true,
					},
					{
						id: 'MARIMOHUB_SECRETS_KEK_ID',
						name: 'KEK label',
						description:
							'Optional label for new envelopes. A KEK change then reports "unknown KEK" instead of a cipher error. The default is a KEK fingerprint.',
						optIn: true,
					},
				],
			},
			{
				name: 'AWS Secrets Manager references',
				description:
					'Resolve references with `backend: aws-sm`. The hub needs `secretsmanager:GetSecretValue` and does not write to AWS Secrets Manager. A locator uses `secret-id-or-arn[#json-key]`. Set a region or `MARIMOHUB_SECRETS_AWS=true` to enable the resolver.',
				vars: [
					{
						id: 'MARIMOHUB_SECRETS_AWS',
						name: 'Enable AWS Secrets Manager',
						description:
							'Set to `true` when the AWS environment supplies the region. A region variable also enables the resolver.',
						example: 'true',
					},
					{
						id: 'MARIMOHUB_SECRETS_AWS_REGION',
						name: 'AWS region',
						description:
							'AWS region of the secrets. Omit it only when the AWS environment supplies it.',
						example: 'us-east-1',
					},
					{
						id: 'MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID',
						name: 'AWS access key id',
						description:
							'Static credential for non-AWS deployments. Set it with the secret access key. Omit both to use the default AWS credential chain.',
						secret: true,
					},
					{
						id: 'MARIMOHUB_SECRETS_AWS_SECRET_ACCESS_KEY',
						name: 'AWS secret access key',
						description: 'Static credential paired with the access key ID.',
						secret: true,
					},
					{
						id: 'MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS',
						name: 'Resolve cache TTL (seconds)',
						description: 'Cache duration for resolved values. A value of `0` disables caching.',
						default: '0',
					},
				],
			},
		],
	},
	{
		name: 'Notifications',
		description:
			'Outbound notifications support several backends at the same time. `MARIMOHUB_NOTIFY_BACKENDS` is a comma-separated list. The hub sends notifications after it stores the related change. Delivery failures do not change the API response. See the [notifications guide](./notifications.md) for delivery and security details.',
		backends: [
			{
				name: 'Project alerts',
				description:
					'Project-scoped destinations are separate from deployment-wide notification backends. See the [project alerts guide](./project-alerts.md).',
				vars: [
					{
						id: 'MARIMOHUB_PROJECT_ALERTS',
						name: 'Project alerts',
						description:
							'Enable Node-only manager-configured Slack and signed-webhook destinations. Requires `MARIMOHUB_SECRETS_KEK`. Accepted values are `on` and `off`.',
						default: 'off',
						example: 'on',
					},
				],
			},
			{
				name: 'Shared',
				description: 'These variables control all notification backends.',
				vars: [
					{
						id: 'MARIMOHUB_NOTIFY_BACKENDS',
						name: 'Notification backends',
						description:
							'Comma-separated backends. Accepted values are `smtp`, `slack`, and `webhook`. An empty value disables notifications.',
						example: 'smtp,slack,webhook',
					},
					{
						id: 'MARIMOHUB_NOTIFY_KINDS',
						name: 'Notification kinds',
						description:
							'Default comma-separated allowlist for all notification backends. A blank value enables `member.invited`, `member.added`, and `session.takeover`. Set `none` to disable all kinds, including per-backend overrides. An unknown kind causes a startup error.',
						example: 'member.invited,member.added',
					},
				],
			},
			{
				name: 'SMTP',
				description:
					'Sends personal notifications to resolved recipients and broadcast notifications to administrator addresses.',
				vars: [
					{
						id: 'MARIMOHUB_NOTIFY_SMTP_URL',
						name: 'SMTP URL',
						description:
							'Required when `smtp` is enabled. The connection URL must include a hostname and use `smtp://` or `smtps://`. Treat this value as a secret because it often contains credentials.',
						example: 'smtps://user:password@smtp.example.com:465',
						secret: true,
					},
					{
						id: 'MARIMOHUB_NOTIFY_SMTP_FROM',
						name: 'SMTP sender',
						description: 'Required sender address when `smtp` is enabled.',
						example: 'marimohub <hub@example.com>',
					},
					{
						id: 'MARIMOHUB_NOTIFY_SMTP_ADMIN_TO',
						name: 'SMTP administrator recipients',
						description:
							'Optional comma-separated addresses for broadcast notifications. SMTP skips a personal notification when it has no resolved recipient. It does not send personal content to these addresses.',
						example: 'platform@example.com,security@example.com',
					},
					{
						id: 'MARIMOHUB_NOTIFY_SMTP_KINDS',
						name: 'SMTP notification kinds',
						description:
							'Exact comma-separated allowlist for SMTP. If unset or blank, it inherits `MARIMOHUB_NOTIFY_KINDS`. Set `none` to disable SMTP delivery.',
						example: 'member.invited,member.added',
					},
				],
			},
			{
				name: 'Slack',
				description:
					'Sends each enabled broadcast notification to one operator-managed incoming webhook.',
				vars: [
					{
						id: 'MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL',
						name: 'Slack webhook URL',
						description:
							'Required HTTPS incoming webhook URL when `slack` is enabled. The target channel receives every enabled broadcast notification.',
						example: 'https://hooks.slack.com/services/T000/B000/secret',
						secret: true,
					},
					{
						id: 'MARIMOHUB_NOTIFY_SLACK_KINDS',
						name: 'Slack notification kinds',
						description:
							'Exact comma-separated allowlist for Slack. If unset or blank, it inherits `MARIMOHUB_NOTIFY_KINDS`. Set `none` to disable Slack delivery. Slack sends broadcast variants only.',
						example: 'session.takeover',
					},
				],
			},
			{
				name: 'Webhook',
				description: 'Posts the complete notification as signed JSON.',
				vars: [
					{
						id: 'MARIMOHUB_NOTIFY_WEBHOOK_URL',
						name: 'Notification webhook URL',
						description:
							'Required HTTPS endpoint when `webhook` is enabled. It receives the complete notification object.',
						example: 'https://events.example.com/marimohub',
						secret: true,
					},
					{
						id: 'MARIMOHUB_NOTIFY_WEBHOOK_SECRET',
						name: 'Notification webhook secret',
						description:
							'Required HMAC-SHA256 key when `webhook` is enabled. It signs the `X-Marimohub-Signature` header.',
						secret: true,
					},
					{
						id: 'MARIMOHUB_NOTIFY_WEBHOOK_KINDS',
						name: 'Webhook notification kinds',
						description:
							'Exact comma-separated allowlist for webhooks. If unset or blank, it inherits `MARIMOHUB_NOTIFY_KINDS`. Set `none` to disable webhook delivery.',
						example: 'session.takeover',
					},
				],
			},
		],
	},
	{
		name: 'Integrations',
		selector: 'MARIMOHUB_INTEGRATIONS',
		selectorDefault: 'off',
		description: `Integrations provide versioned configuration for data sources and environment
variables. See the [integrations guide](./integrations.md) for supported kinds.
Project managers manage project integrations. Super admins manage organization
integrations.

New, non-ephemeral sessions receive the applicable configuration as environment
variables and files. The hub injects configuration, not Python libraries. Each
kind lists the packages to add to the notebook.

Enable this feature only after every replica can preserve unknown session
fields. Otherwise, an older replica can remove the integration audit pin during
a rolling deployment. See the two-phase policy in
\`development_docs/migrations.md\`. The feature requires only the deployment
bucket.

Secret fields use inline encryption or an external resolver. A rendering error
blocks session creation. Disable or override the integration to restore access.
See the [secret-source guide](./integration-secrets.md).`,
		backends: [
			{
				name: 'On',
				selectorValue: 'on',
				description: `Integration management and session injection are enabled. Project entries use
\`projects/{pid}/integrations/\`. Organization entries use
\`_system/integrations/\`.`,
				vars: [
					{
						id: 'MARIMOHUB_INTEGRATIONS_PROBE',
						name: 'Connection-test egress policy',
						description:
							'Policy for the "Test connection" probe, which makes server-side HTTP requests to manager-supplied addresses. `guarded` (default) allows public addresses only — private, loopback, link-local/metadata, and CGNAT ranges are rejected, redirects are never followed, and responses are size- and time-capped. `private` additionally permits private/loopback targets, for deployments whose catalogs/engines are on-prem. `off` disables testing entirely (kinds report `supports_test: false`).',
						default: 'guarded',
					},
					{
						id: 'MARIMOHUB_DATA_BROWSER',
						name: 'Data browser',
						description:
							'Controls read-only data browsing for editors and higher roles. `metadata` enables metadata browsing. `full` also enables explicit, audited row previews. Requires `MARIMOHUB_INTEGRATIONS=on` and an enabled integration probe. `off` disables browsing.',
						default: 'off',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_IMAGE',
						name: 'Data-preview image',
						description:
							'OCI image for sandbox previews. It must contain Python, PyIceberg, and PyArrow. The compute backend must support OCI image overrides. The local, E2B, none, and noop backends do not support these overrides. The hub verifies the image at startup.',
						example: 'ghcr.io/example/marimohub-data-preview:1',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_MAX_CONCURRENT',
						name: 'Max concurrent data previews',
						description: 'Maximum number of runtime-backed previews in this server process.',
						default: '4',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_MAX_CONCURRENT_PER_USER',
						name: 'Max data previews per user',
						description: 'Maximum number of runtime-backed previews for one user.',
						default: '1',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_STARTUP_TIMEOUT_SECONDS',
						name: 'Data-preview startup timeout',
						description: 'Maximum time to start and prepare a preview runtime.',
						default: '120',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS',
						name: 'Data-preview execution timeout',
						description: 'Maximum time for a DuckDB-Wasm or fixed PyIceberg preview.',
						default: '30',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_CONCURRENT',
						name: 'Max concurrent data queries',
						description: 'Maximum number of isolated SQL queries in this server process.',
						default: '4',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_CONCURRENT_PER_USER',
						name: 'Max data queries per user',
						description: 'Maximum number of isolated SQL queries for one user.',
						default: '1',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_ROWS',
						name: 'Data-query row limit',
						description: 'Maximum number of rows returned by one SQL query.',
						default: '10000',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_BYTES',
						name: 'Data-query response limit',
						description: 'Maximum serialized response size in bytes for one SQL query.',
						default: '2097152',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_TIMEOUT_SECONDS',
						name: 'Data-query timeout',
						description: 'Maximum execution time for one isolated SQL query.',
						default: '30',
					},
					{
						id: 'MARIMOHUB_DUCKDB_WASM_RUNTIME',
						name: 'DuckDB-Wasm runtime',
						description:
							'Runtime selected by the `duckdb-wasm-preview` experiment. `auto` uses a worker thread and falls back to inline only when workers are structurally unsupported. `worker` and `inline` force one mode.',
						default: 'auto',
					},
					{
						id: 'MARIMOHUB_DUCKDB_WASM_MEMORY_LIMIT_MB',
						name: 'DuckDB-Wasm memory limit',
						description:
							'DuckDB engine memory limit in MiB. This does not cap all WebAssembly and Arrow allocations.',
						default: '128',
					},
					{
						id: 'MARIMOHUB_DUCKDB_WASM_IDLE_TIMEOUT_SECONDS',
						name: 'DuckDB-Wasm idle timeout',
						description:
							'Maximum idle time before a warm DuckDB-Wasm engine is released. Set to 0 to keep warm engines until shutdown.',
						default: '300',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS',
						name: 'Allow server credentials for object browsing',
						description:
							'Allow editors to browse ambient-auth S3 integrations with the control-plane AWS identity when compatible project WIF credentials are unavailable. Keep this off unless that identity is intentionally available to project editors.',
						default: 'false',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_METADATA_TIMEOUT_SECONDS',
						name: 'Object-metadata timeout',
						description:
							'Maximum time for one object listing or metadata operation, including DNS resolution.',
						default: '30',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS',
						name: 'Object-preview timeout',
						description:
							'Maximum time for one bounded object preview, including DNS resolution and ranged reads.',
						default: '30',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_PREVIEW_MAX_BYTES',
						name: 'Object-preview source byte limit',
						description: 'Maximum source bytes read for CSV, JSON, JSON Lines, and text previews.',
						default: String(8 * 1024 * 1024),
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_INLINE_IMAGE_MAX_BYTES',
						name: 'Inline-image byte limit',
						description: 'Maximum size of a magic-byte-validated raster image shown inline.',
						default: String(10 * 1024 * 1024),
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_PARQUET_MAX_RANGED_BYTES',
						name: 'Parquet ranged-read byte limit',
						description:
							'Maximum total bytes fetched across ranged requests for one Parquet preview.',
						default: String(32 * 1024 * 1024),
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_SEARCH_MAX_KEYS',
						name: 'Object-search scan limit',
						description: 'Maximum keys scanned by one bounded object-name search request.',
						default: '5000',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS',
						name: 'Max concurrent object downloads',
						description: 'Maximum object content streams held by one server process.',
						default: '16',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS_PER_USER',
						name: 'Max object downloads per user',
						description: 'Maximum object content streams one user can hold on one server process.',
						default: '2',
					},
					{
						id: 'MARIMOHUB_OBJECT_BROWSER_DOWNLOAD_TIMEOUT_SECONDS',
						name: 'Object-download timeout',
						description: 'Maximum lifetime of one proxied object content stream.',
						default: '3600',
					},
				],
			},
			{
				name: 'Off',
				selectorValue: 'off',
				description: 'No integrations. The routes 404 and nothing is injected.',
				vars: [],
			},
		],
	},
];

/** Every env-var id the registry declares (backend vars only, no selectors). */
export const CONFIG_VAR_IDS: ReadonlySet<string> = new Set(
	CONFIG_SPEC.flatMap((g) => g.backends.flatMap((b) => b.vars.map((v) => v.id))),
);

/** The `*_BACKEND` selector ids the registry declares. */
export const CONFIG_SELECTOR_IDS: ReadonlySet<string> = new Set(
	CONFIG_SPEC.map((g) => g.selector).filter((s): s is string => Boolean(s)),
);

/**
 * Every env-var id the docs cover — backend vars plus selectors. The drift test
 * asserts this equals the set of `MARIMOHUB_*`/`PORT` literals the wiring reads.
 */
export const CONFIG_DOCUMENTED_IDS: ReadonlySet<string> = new Set([
	...CONFIG_SELECTOR_IDS,
	...CONFIG_VAR_IDS,
]);

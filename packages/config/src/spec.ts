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

const AUTH_ALLOWED_EMAIL_DOMAINS: ConfigVar = {
	id: 'MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS',
	name: 'Allowed email domains',
	description: 'Comma-separated email-domain allowlist. Set `*` to allow all domains.',
	example: 'example.com,example.org',
	required: true,
};

// Shared by every managed-AI backend (Bedrock, OpenAI-compatible); the config
// registry requires one definition per variable id.
const AI_MODEL: ConfigVar = {
	id: 'MARIMOHUB_AI_MODEL',
	name: 'Default model',
	description: 'Default model id surfaced to marimo.',
	example: 'gpt-4o-mini',
	required: true,
};

const AI_ALLOWED_MODELS: ConfigVar = {
	id: 'MARIMOHUB_AI_ALLOWED_MODELS',
	name: 'Allowed models',
	description:
		'Comma-separated allowlist of model ids; off-list requests fall back to the default model. Unset allows any model on OpenAI-compatible upstreams, or restricts Bedrock to MARIMOHUB_AI_MODEL.',
	example: 'gpt-4o-mini,gpt-4o',
};

const AI_MAX_TOKENS: ConfigVar = {
	id: 'MARIMOHUB_AI_MAX_TOKENS',
	name: 'Max tokens',
	description: 'Optional `[ai] max_tokens` written into the injected notebook config.',
	example: '4096',
};

const AI_RULES: ConfigVar = {
	id: 'MARIMOHUB_AI_RULES',
	name: 'Assistant rules',
	description: 'Optional `[ai] rules` (custom assistant instructions).',
	example: 'Prefer polars over pandas.',
};

const AI_TOKEN_TTL_SECONDS: ConfigVar = {
	id: 'MARIMOHUB_AI_TOKEN_TTL_SECONDS',
	name: 'Session token TTL (seconds)',
	description: 'Per-session token lifetime in seconds.',
	default: '3600',
};

export const CONFIG_SPEC: ConfigGroup[] = [
	{
		name: 'Storage',
		selector: 'MARIMOHUB_STORAGE_BACKEND',
		selectorDefault: 's3',
		description:
			'Stores all notebooks and state. Durable self-hosted backends are `s3`, `gcs`, `azure`, and single-node `fs`. `library` loads an external Node adapter. `r2` is Workers-only. `memory` is for development and tests.',
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
				name: 'External library (Node server only)',
				selectorValue: 'library',
				description:
					'Loads an external storage adapter from an npm package or ESM file at Node server startup. Cloudflare Workers do not support it.',
				vars: [
					{
						id: 'MARIMOHUB_STORAGE_LIBRARY',
						name: 'Storage adapter library',
						description:
							'npm package specifier or ESM path that default-exports a storage adapter manifest.',
						example: '/etc/marimohub/storage.mjs',
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
							'Ordered named CPU, memory, and optional GPU profiles. Use `name:cpu=<cores>;mem=<Mi|Gi|Ti>;gpu=<type>[:<count>]`. The maximum GPU count is 8. The first profile is the default. Supported backends apply the selected profile when overrides are enabled. The Modal backend applies GPU requests. Other backends ignore GPU values and log a startup warning.',
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
					{
						id: 'MARIMOHUB_SURFACES',
						name: 'Sandbox surfaces',
						description:
							'Comma-separated editor surfaces enabled in notebook sandboxes. `marimo` is always available; add `vscode`, `opencode`, or both.',
						default: 'marimo',
						example: 'marimo,vscode,opencode',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_VSCODE_FLAVOR',
						name: 'VS Code flavor',
						description:
							'Browser editor implementation (`code-server` or `openvscode`). `openvscode` is experimental: no published sandbox image ships it, and selecting it logs a warning at boot.',
						default: 'code-server',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_VSCODE_START',
						name: 'VS Code start policy',
						description: 'Start VS Code on demand or with every edit session.',
						default: 'on-demand',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_VSCODE_PORT',
						name: 'VS Code port',
						description:
							'Logical sandbox port used by the VS Code surface. Must differ from marimo port 2718.',
						default: '8443',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_VSCODE_EXTENSION_GALLERY',
						name: 'VS Code extension gallery',
						description:
							'Extension gallery (`openvsx`, `none`, or the HTTP(S) service URL of a mirror).',
						default: 'openvsx',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_VSCODE_SETTINGS_JSON',
						name: 'VS Code settings',
						description: 'JSON object merged over the safe browser-editor defaults.',
						default: '{}',
						example: '{"editor.fontSize":14}',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_VSCODE_EMBED',
						name: 'VS Code presentation',
						description: 'Open VS Code in an application tab or split view (`tab` or `iframe`).',
						default: 'tab',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_OPENCODE_START',
						name: 'OpenCode start policy',
						description: 'Start OpenCode on demand or with every authorized edit session.',
						default: 'on-demand',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_OPENCODE_PORT',
						name: 'OpenCode port',
						description:
							'Logical sandbox port used by OpenCode. Must differ from marimo port 2718 and all other enabled surface ports.',
						default: '4096',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SURFACE_OPENCODE_EMBED',
						name: 'OpenCode presentation',
						description: 'Open OpenCode in an application tab or split view (`tab` or `iframe`).',
						default: 'tab',
						optIn: true,
					},
				],
			},
			{
				name: 'CoreWeave Sandbox',
				selectorValue: 'coreweave',
				supportsComputeProfiles: true,
				description: 'CoreWeave Sandboxes via the `@coreweave/cwsandbox` SDK (Sandbox v1).',
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
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_RUNNER_ID',
						name: 'CoreWeave runner id',
						description:
							'Runner (by operator-assigned id) sandboxes schedule on — must name your CKS sandbox runner. A create without a runner id schedules on the CoreWeave-managed serverless pool, not your cluster. Set to an empty value to opt into serverless.',
						default: 'marimohub',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE',
						name: 'CoreWeave kernel Ingress namespace',
						description:
							"Namespace the sandbox runner creates kernel pods and Services in. Set it on a CKS runner without HTTPS endpoint routes: the kernel service is then declared with `custom` visibility (the sandbox template must declare `network.ingress` sources) and the hub creates a per-kernel Ingress there (hostname from `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` + the hostname template), owner-referenced to the runner's Service. Needs the chart's `sandboxIngress.namespace` RBAC. The Ingress carries no `tls` block or annotations, so Traefik must serve it from its default TLSStore (a wildcard certificate for the sandbox hostname). Omit on runners that publish `public` kernel services themselves.",
						example: 'org-ns-ab12cd',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_CLASS',
						name: 'CoreWeave kernel Ingress class',
						description:
							'IngressClass for hub-published kernel Ingresses. Only meaningful with `MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE` (rejected at boot without it); the default applies once that namespace is set.',
						default: 'traefik',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID',
						name: 'CoreWeave sandbox template id',
						description:
							"Org-scoped sandbox template every sandbox is created from — custom specs such as GPU placement, egress rules, or pod shape. Omit to use the runner's default policy.",
						example: 'tmpl-marimohub',
					},
					{
						id: 'MARIMOHUB_COMPUTE_COREWEAVE_USER_HOME_TEMPLATE_ID',
						name: 'CoreWeave user-home template id',
						description:
							'Sandbox template used only for editor-or-higher edit sandboxes; must differ from `MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID`. The template must mount the per-user volume at `/var/run/marimohub/user-home` (`subPathExpr: $(MARIMOHUB_USER_HOME_KEY)`) and provide a writable `/mnt`. Requires `MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive`; apps and viewer sandboxes use the normal template.',
						example: 'tmpl-marimohub-user-home',
						optIn: true,
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
							'Comma-separated CAIOS bucket names every sandbox gets automatic, auto-refreshing credentials for (vended in-sandbox by a CoreWeave sidecar). Requires the org wif-config on the Sandbox Gateway; creates fail with NOT_FOUND without it. Setting this disables hub-minted WIF. With `MARIMOHUB_COMPUTE_COREWEAVE_TEMPLATE_ID`, the create-time overlay cannot carry object-storage access — the sandbox template MUST declare a matching `object_storage_access` itself, or sandboxes get neither credential source. See docs/workload-identity-federation.md, "CoreWeave Object Storage (Automatic)".',
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
					'Native Kubernetes creates one keep-alive Pod and Service per session through `@kubernetes/client-node`. Subdomain exposure adds an Ingress for the direct `{id}.{host}` URL. It requires `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`, an ingress class, and TLS. Proxy exposure uses the internal Service URL and creates no Ingress. Plaintext subdomain exposure requires `disabled` TLS mode and an `http://` hostname template.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE',
						name: 'Kubernetes namespace',
						description: 'Namespace for each kernel Pod, Service, and optional Ingress.',
						example: 'marimo-kernels',
						default: 'default',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE',
						name: 'Kubernetes hostname template',
						description:
							'Kernel URL template. Supports `{id}`, `{name}`, `{namespace}`, `{port}`, `{host}`, and `{token}`. Proxy exposure defaults to the internal Service URL. Set this only for a different cluster DNS domain.',
						default: 'https://{id}.{host}',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS',
						name: 'Kubernetes ingress class',
						description:
							'`ingressClassName` for each subdomain-mode Ingress. Ignored in proxy mode.',
						example: 'traefik',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS',
						name: 'Kubernetes ingress annotations',
						description:
							'JSON string map for each subdomain-mode Ingress. Proxy mode ignores it. Keys must use Kubernetes annotation syntax. The total size cannot exceed 256 KiB.',
						example: '{"route.openshift.io/termination":"edge"}',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE',
						name: 'Kubernetes ingress TLS mode',
						description:
							'TLS mode for each subdomain-mode Ingress. `controller-default` emits `tls: [{}]`. `secret` uses `MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET`. `disabled` requires an `http://` hostname template. Proxy mode ignores this value. `default` aliases `controller-default`. When unset, a configured secret selects `secret`. Otherwise, the controller default applies.',
						default: 'secret when TLS secret is set, else controller-default',
						example: 'controller-default',
					},
					{
						id: 'MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET',
						name: 'Kubernetes TLS secret',
						description:
							'Wildcard TLS secret for each subdomain-mode Ingress. Proxy mode ignores it. This value requires `secret` mode and selects that mode when unset.',
						example: 'marimo-kernels-wildcard-tls',
						optIn: true,
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
					'Spawns `uv run marimo edit` as a host subprocess. Requires `uv` + Python on the host; not for shared/production use. Set the local root outside the OS temporary directory so marimo saves Hub-managed notebooks in place.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_LOCAL_ROOT',
						name: 'Local sandbox root',
						description:
							'Parent directory for local sandboxes. Set this outside the OS temporary directory to prevent marimo from treating notebooks as temporary files.',
						example: '/var/lib/marimohub/sandboxes',
						default: 'OS temporary directory',
					},
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
				name: 'External library (Node server only)',
				selectorValue: 'library',
				description:
					'Loads an external compute adapter from an npm package or ESM file at Node server startup. Cloudflare Workers do not support it.',
				vars: [
					{
						id: 'MARIMOHUB_COMPUTE_LIBRARY',
						name: 'Compute adapter library',
						description:
							'npm package specifier or ESM path that default-exports a compute adapter manifest.',
						example: '/etc/marimohub/compute.mjs',
						required: true,
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
				],
			},
		],
	},
	{
		name: 'Auth',
		selector: 'MARIMOHUB_AUTH_BACKEND',
		description:
			'Set this selector explicitly. An unset value fails closed and never enables dev auth.',
		backends: [
			{
				name: 'OIDC',
				selectorValue: 'oidc',
				description:
					'App-native OpenID Connect (the production backend). If the allowlist contains one domain, Google receives it as the `hd` hint.',
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
					AUTH_ALLOWED_EMAIL_DOMAINS,
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
						id: 'MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS',
						name: 'Project creation groups',
						description:
							'Exact comma-separated group IDs permitted to create projects. Setting it (even empty) restricts creation like `MARIMOHUB_PROJECT_CREATION=restricted`: unset allows all authenticated users, an empty value allows only super admins.',
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
					{
						id: 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_BACKEND',
						name: 'Login-policy backend',
						description:
							'Set `library` to load a trusted external login-policy module that maps validated OIDC claims to a login decision and entitlements. Mutually exclusive with the `MARIMOHUB_AUTH_OIDC_*GROUPS*` variables. `none` (or unset) disables it.',
						example: 'library',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_LIBRARY',
						name: 'Login-policy module',
						description:
							'The login-policy module: an npm package installed in the image, an ESM path, or a file URL. Required with the `library` login-policy backend. The module runs in-process with server privileges — load only trusted, pinned code.',
						example: '/etc/marimohub/oidc-login-policy.mjs',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_TIMEOUT_SECONDS',
						name: 'Login-policy timeout',
						description:
							'Login-policy evaluation timeout, from 1 to 30 seconds. A timeout denies the login.',
						default: '5',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_OIDC_LOGIN_POLICY_SESSION_TTL_SECONDS',
						name: 'Login-policy session lifetime',
						description:
							'Maximum age of a session created through the login policy, from 300 to 3600 seconds. This value limits the deprovisioning delay after a policy or attribute change.',
						default: '3600',
						optIn: true,
					},
				],
			},
			{
				name: 'Trusted proxy headers',
				selectorValue: 'proxy-header',
				description:
					'Reads trusted proxy headers or verifies a Google IAP JWT. Isolate header mode behind a proxy that removes client-supplied identity headers. Set `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS`. Use `*` to allow all domains.',
				vars: [
					AUTH_ALLOWED_EMAIL_DOMAINS,
					{
						id: 'MARIMOHUB_AUTH_PROXY_HEADER',
						name: 'Proxy identity header',
						description:
							'Header mode accepts an email header and optional user-ID header. Its defaults are `X-Forwarded-Email,X-Forwarded-User`. JWT mode accepts one assertion header and defaults to `X-Goog-IAP-JWT-Assertion`.',
						example: 'Tailscale-User-Login',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_PROXY_JWT_ISSUER',
						name: 'Proxy JWT issuer',
						description:
							'Expected issuer. This variable enables JWT mode and requires the audience.',
						default: 'https://cloud.google.com/iap',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE',
						name: 'Proxy JWT audience',
						description: 'Required audience for JWT mode. This variable also enables JWT mode.',
						example: '/projects/123456789/global/backendServices/987654321',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTH_PROXY_JWKS_URL',
						name: 'Proxy JWT JWKS URL',
						description:
							'HTTPS JWKS URL. This variable enables JWT mode and requires the audience.',
						default: 'https://www.gstatic.com/iap/verify/public_key-jwk',
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
							'Comma-separated experimental feature IDs. Unknown or graduated IDs (such as the removed `duckdb-wasm-preview`) are ignored with a startup warning. No experiment currently gates behavior.',
					},
					{
						id: 'PORT',
						name: 'HTTP port',
						description: 'Port the HTTP server listens on.',
						default: '3000',
					},
					{
						id: 'MARIMOHUB_APP_BASE_URL',
						name: 'App base URL',
						description:
							'Public URL for browser links and the Node SPA base path. When the app uses a path prefix, set this variable. If unset, links use the request origin and the SPA uses `/`.',
						example: 'https://hub.example.com/marimohub',
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
						id: 'MARIMOHUB_PROJECT_CREATION',
						name: 'Project creation',
						description:
							'Who may create projects (open | restricted). `open` lets every authenticated user ' +
							'create projects. `restricted` allows only super admins and holders of the ' +
							'`project-creator` entitlement (from an OIDC group mapping or login-policy module), ' +
							'on any auth backend. Setting `MARIMOHUB_AUTH_OIDC_PROJECT_CREATION_GROUPS` implies ' +
							'`restricted`; combining it with `open` is a configuration error.',
						example: 'restricted',
						default: 'open',
					},
					{
						id: 'MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER',
						name: 'Classification order',
						description:
							'Comma-separated classification order, lowest to highest. A subject context must ' +
							'include the required classification or a higher one, plus every required compartment. Labels ' +
							'only restrict access. If unset, new labels are rejected and existing labels fail closed.',
						example: 'PUBLIC,INTERNAL,CONFIDENTIAL,RESTRICTED',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND',
						name: 'Subject-context backend',
						description:
							'Set `library` to load a trusted subject-context provider. The provider resolves ' +
							'clearance and compartments for each principal. A classification order is required. ' +
							'`none` (or unset) runs without a provider, so all labeled resources are denied.',
						example: 'library',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY',
						name: 'Subject-context module',
						description:
							'The provider module as an npm package, ESM path, or file URL. This value is ' +
							'required for the `library` backend. The module runs with server privileges. ' +
							'Use only trusted, pinned code.',
						example: '/etc/marimohub/subject-context.mjs',
						optIn: true,
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
		name: 'Jobs',
		description:
			'Headless notebook runs on a cron schedule or on demand, with a durable run history. Off unless `MARIMOHUB_JOBS=on`. Jobs are dispatched by the maintenance replica (`MARIMOHUB_RUN_MAINTENANCE=true`); without one, runs stay queued. See [Notebook jobs](./jobs.md).',
		backends: [
			{
				name: 'Scheduler',
				vars: [
					{
						id: 'MARIMOHUB_JOBS',
						name: 'Notebook jobs',
						description:
							'Enable notebook jobs: the job API and UI, the scheduler loop on the maintenance replica, and the `job.*` project-alert kinds. Accepted values are `on` and `off`. The other `MARIMOHUB_JOBS_*` variables apply only when on.',
						default: 'off',
						example: 'on',
					},
					{
						id: 'MARIMOHUB_JOBS_TICK_SECONDS',
						name: 'Scheduler tick (seconds)',
						description:
							'How often the maintenance replica evaluates schedules, dispatches queued runs, and enforces run deadlines. Also bounds the start latency of a manual trigger.',
						default: '60',
					},
					{
						id: 'MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS',
						name: 'Max concurrent runs',
						description:
							'Deployment-wide cap on runs holding a sandbox (provisioning or running). Further runs wait in the queue.',
						default: '5',
					},
					{
						id: 'MARIMOHUB_JOBS_MAX_CONCURRENT_RUNS_PER_PROJECT',
						name: 'Max concurrent runs per project',
						description: 'Per-project slice of the deployment-wide run cap.',
						default: '2',
					},
					{
						id: 'MARIMOHUB_JOBS_MAX_PER_NOTEBOOK',
						name: 'Max jobs per notebook',
						description: 'Job definitions per notebook (`0` = unlimited).',
						default: '5',
					},
					{
						id: 'MARIMOHUB_JOBS_DEFAULT_TIMEOUT_SECONDS',
						name: 'Default run timeout (seconds)',
						description:
							'Run deadline when a job sets no `timeout_seconds`. The sandbox is destroyed and the run lands `timed_out` past it.',
						default: '1800',
					},
					{
						id: 'MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS',
						name: 'Max run timeout (seconds)',
						description: 'Ceiling on a job’s own `timeout_seconds`; larger values are rejected.',
						default: '14400',
					},
					{
						id: 'MARIMOHUB_JOBS_RUN_RETENTION_DAYS',
						name: 'Run retention (days)',
						description:
							'Run records and captured outputs older than this are pruned by the maintenance cycle.',
						default: '30',
					},
					{
						id: 'MARIMOHUB_JOBS_CATCHUP_WINDOW_SECONDS',
						name: 'Catch-up window (seconds)',
						description:
							'How stale a missed occurrence may be and still fire, once. After a longer outage only the latest missed occurrence runs — the gap is never backfilled.',
						default: '600',
						example: '900',
					},
				],
			},
		],
	},
	{
		name: 'Source control publishing',
		description:
			'Connect Git-synced notebooks to GitHub through the server. Editors can create pull sources without a CI workflow. They can also compare and sync either source mode with **Sync now**. Managers can publish session edits as draft pull requests.\n\nThe server stores credential-free Git metadata for pull sources. Provider credentials never enter a notebook sandbox. GitHub.com is the only supported provider in this release. See [Syncing from external sources](./syncing.md) for source modes and limits.',
		backends: [
			{
				name: 'GitHub App',
				description:
					'Create a GitHub App with Contents (read and write) and Pull requests (read and write) repository permissions. Install it only on repositories that marimohub can sync from or publish to. Then set both variables below. The integration does not require a webhook. Marimohub creates short-lived installation tokens for drift checks, syncs, and pull-request publishing.',
				vars: [
					{
						id: 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID',
						name: 'GitHub App id',
						description: 'Numeric app id from the GitHub App settings page.',
						example: '123456',
						optIn: true,
					},
					{
						id: 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY',
						name: 'GitHub App private key',
						description:
							'PKCS8 or PKCS1 PEM private key downloaded for the GitHub App, or its single-line base64 encoding. Held by the server and never injected into notebook sandboxes.',
						example: '-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----',
						optIn: true,
						secret: true,
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
			'Optional: auto-configure the marimo AI assistant to use a managed provider, so it works with no user-supplied credentials. The hub injects a `marimo.toml` pointing at its own OpenAI-compatible proxy (`/api/ai/v1`) with a short-lived, session-scoped token; the proxy authenticates upstream requests server-side. Provider credentials are NEVER injected into a sandbox. Deployment-wide and default-on when configured. See docs/ai.md.',
		backends: [
			{
				name: 'Off',
				selectorValue: 'none',
				description:
					'No managed AI. The marimo assistant still works if a user supplies their own key in marimo settings.',
				vars: [],
			},
			{
				name: 'Amazon Bedrock',
				selectorValue: 'bedrock',
				description:
					'Uses the Amazon Bedrock OpenAI-compatible endpoint and signs requests with the runtime AWS identity. No Bedrock API key or AWS credential is injected into a sandbox.',
				vars: [
					{
						id: 'MARIMOHUB_AI_AWS_REGION',
						name: 'AWS region',
						description: 'AWS region for Bedrock. Falls back to AWS_REGION or AWS_DEFAULT_REGION.',
						example: 'eu-west-1',
						required: true,
					},
					{ ...AI_MODEL, example: 'eu.anthropic.claude-opus-4-7' },
					AI_ALLOWED_MODELS,
					AI_MAX_TOKENS,
					AI_RULES,
					AI_TOKEN_TTL_SECONDS,
				],
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
					AI_MODEL,
					AI_ALLOWED_MODELS,
					AI_MAX_TOKENS,
					AI_RULES,
					AI_TOKEN_TTL_SECONDS,
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
					{
						id: 'MARIMOHUB_NOTIFY_ALLOW_PRIVATE',
						name: 'Allow private notification targets',
						description:
							'Allow Slack and webhook delivery to private, loopback, link-local, or reserved IP addresses. Enable only for operator-controlled internal destinations.',
						default: 'false',
						example: 'true',
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
		selectorDefault: 'on',
		description: `Integrations provide versioned configuration for data sources and environment
variables. See the [integrations guide](./integrations.md) for supported kinds.
Project managers manage project integrations. Super admins manage organization
integrations.

New, non-ephemeral sessions receive the applicable configuration as environment
variables and files. The hub injects configuration, not Python libraries. Each
kind lists the packages to add to the notebook.

Integrations are enabled by default. Set \`MARIMOHUB_INTEGRATIONS=off\` to
disable the management routes and session injection. The feature requires only
the deployment bucket.

Before upgrading, replace the former \`true\` and \`none\` aliases with \`on\`
and \`off\`. Those aliases are no longer accepted.

Secret fields use inline encryption or an external resolver. A rendering error
blocks session creation. Disable or override the integration to restore access.
See the [secret-source guide](./integration-secrets.md).`,
		backends: [
			{
				name: 'On',
				selectorValue: 'on',
				description: `Integration management and session injection are enabled by default. Project entries use
\`projects/{pid}/integrations/\`. Organization entries use
\`_system/integrations/\`.`,
				vars: [
					{
						id: 'MARIMOHUB_INTEGRATIONS_PROBE',
						name: 'Integration egress policy',
						description:
							'Policy for integration HTTP requests, including tests, browsing, and the DuckDB-Wasm broker. `guarded` (default) allows public addresses only. It rejects private, loopback, link-local, metadata, and CGNAT addresses. `private` also permits private and loopback targets for private deployments. Requests have time and size limits. Connection tests never follow redirects. The DuckDB broker authorizes each redirect. `off` disables connection tests and data browsing; an explicit `MARIMOHUB_DATA_BROWSER=metadata` or `full` setting then fails at startup.',
						default: 'guarded',
					},
					{
						id: 'MARIMOHUB_DATA_BROWSER',
						name: 'Data browser',
						description:
							'Controls read-only data browsing for editors and higher roles. `metadata` (default) enables metadata browsing. `full` also enables explicit, audited row previews and Run SQL. `off` disables browsing. The default yields silently when integrations or the probe are off; an explicit `metadata` or `full` setting then fails at startup instead.',
						default: 'metadata',
					},
					{
						id: 'MARIMOHUB_POSTGRES_DATA_ACCESS',
						name: 'PostgreSQL data access',
						description:
							'Enables PostgreSQL schema browsing. In full data-browser mode, it also enables row previews and Run SQL for every enabled compatible PostgreSQL integration. Disabled by default.',
						default: 'off',
					},
					{
						id: 'MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT',
						name: 'PostgreSQL insecure transport',
						description:
							'Allows PostgreSQL TLS modes that do not verify both the CA and hostname: `disable`, `prefer`, and `require`. Gates connection tests as well as browsing and Run SQL. Disabled by default.',
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
						id: 'MARIMOHUB_DATA_PREVIEW_EMBEDDED_RUNTIME',
						name: 'Embedded data-preview runtime',
						description:
							'Isolation mode for the embedded preview executor. `auto` and `worker` both require a worker thread; blocking inline execution is rejected because its deadline cannot preempt a query.',
						default: 'auto',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_EMBEDDED_MEMORY_LIMIT_MB',
						name: 'Embedded data-preview memory limit',
						description:
							'Engine memory limit in MiB for the embedded preview executor. This does not cap all runtime and result-buffer allocations.',
						default: '128',
					},
					{
						id: 'MARIMOHUB_DATA_PREVIEW_EMBEDDED_IDLE_TIMEOUT_SECONDS',
						name: 'Embedded data-preview idle timeout',
						description:
							'Maximum idle time before a warm embedded preview executor is released. Set to 0 to keep warm executors until shutdown.',
						default: '300',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_CONCURRENT',
						name: 'Max concurrent data queries',
						description: 'Maximum number of Run SQL workers in this server process.',
						default: '4',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_CONCURRENT_PER_USER',
						name: 'Max data queries per user',
						description: 'Maximum number of active Run SQL workers for one user.',
						default: '1',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_ROWS',
						name: 'Data-query row limit',
						description: 'Maximum rows returned by one Run SQL request.',
						default: '10000',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MAX_BYTES',
						name: 'Data-query response limit',
						description: 'Maximum serialized response bytes returned by one Run SQL request.',
						default: '2097152',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_TIMEOUT_SECONDS',
						name: 'Data-query timeout',
						description: 'Hard deadline for one Run SQL worker, including startup.',
						default: '30',
					},
					{
						id: 'MARIMOHUB_DATA_QUERY_MEMORY_LIMIT_MB',
						name: 'Data-query memory limit',
						description:
							'Engine memory limit in MiB for each Run SQL worker. The worker also has fixed V8 heap and stack limits.',
						default: '128',
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
							'Maximum time for one object listing, metadata, or catalog browse request, including DNS resolution.',
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

import type { Hono, MiddlewareHandler } from 'hono';
import type {
	Authenticator,
	AssignableRole,
	AuthUser,
	Bucket,
	BucketConfig,
	ComputeResources,
	createServices,
	EditorSandboxSharing,
	FederationTarget,
	ProjectIntegrationsService,
	KernelProbe,
	Millis,
	OrgIntegrationsService,
	PreflightReport,
	SandboxExposure,
	SandboxProvider,
	SandboxUserHome,
	Seconds,
	ViewerMode,
	WorkloadIdentityIssuer,
} from '@marimo-hub/core';

/** The service bundle produced by `createServices(bucket)` in @marimo-hub/core. */
export type Services = ReturnType<typeof createServices>;

/**
 * Workload Identity Federation capability, consolidated so it is
 * all-present-or-absent. The hub mints project-scoped OIDC tokens with `issuer`
 * and exchanges them via `target`; a project opts in via `ProjectFederationSchema`.
 * One target per deployment for now — promote to a keyed map when a second is real.
 */
export interface WifConfig {
	issuer: WorkloadIdentityIssuer;
	/** Public issuer URL: the token `iss` and the OIDC discovery `issuer`. */
	issuerUrl: string;
	/** The federation target (broker + audience + object store) sessions exchange against. */
	target: FederationTarget;
}

/**
 * The marimohub-owned session lifetime policy (config: `MARIMOHUB_SESSION_*`).
 * `expires_at` is stamped from `maxLifetimeMs` when a session goes running; the
 * server's lifecycle sweep (apps/server) enforces the rest. All durations in ms.
 */
export interface SessionLifetimeConfig {
	/** Hard session lifetime → graceful save + teardown by the lifecycle sweep. */
	maxLifetimeMs: Millis;
	/** Reap (with save) when no editors are connected AND the heartbeat is this stale. */
	idleTimeoutMs: Millis;
	/** Periodic save cadence for live sessions; 0 disables periodic snapshots. */
	snapshotIntervalMs: Millis;
	/** How far `expires_at` slides when editors are still connected at the deadline. */
	extensionMs: Millis;
	/** Consult the kernel's connection count before a lifetime/idle teardown. */
	connectionAware: boolean;
	/** How often the lifecycle sweep runs. */
	sweepIntervalMs: Millis;
}

export interface SandboxComputeProfile {
	name: string;
	resources: ComputeResources;
}

export interface SandboxUserHomeResolver {
	resolve(user: AuthUser): SandboxUserHome;
}

/** Everything about how a notebook sandbox is mounted, exposed, and persisted. */
export interface SandboxConfig {
	/** Bucket connection info the sandbox mounts for notebook files (was `c.env.R2_*`). */
	bucket: BucketConfig;
	/** Public hostname used when exposing kernel ports (was `c.env.SANDBOX_HOSTNAME`). */
	hostname: string;
	/**
	 * Working directory inside the sandbox where notebook files land and marimo
	 * runs. Must be writable by the sandbox image's user — e.g. the marimo OSS
	 * image runs as a non-root user with no `/workspace`. Config:
	 * MARIMOHUB_COMPUTE_WORKDIR. Defaults to `/workspace`.
	 */
	workdir: string;
	/**
	 * Optional base URL marimo loads its frontend assets from (passed to the kernel
	 * as `--asset-url`), e.g. a CDN. Config: MARIMOHUB_COMPUTE_ASSET_URL.
	 * Undefined = use the image's bundled assets.
	 */
	assetUrl?: string;
	/**
	 * How long a session provision waits for the marimo kernel to come up before
	 * failing the start (config: MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS).
	 * Undefined = the core default (2 minutes). Also served on
	 * `/api/v1/capabilities` so the client bounds its own startup wait with the
	 * same value.
	 */
	startupTimeoutMs?: Millis;
	/**
	 * How kernels are surfaced to the browser (config: MARIMOHUB_SANDBOX_EXPOSURE):
	 * `subdomain` (direct, isolated domain) or `proxy` (forwarded through the app at
	 * `…/proxy/<token>/`), independent of the compute backend. Optional — `createApi`
	 * defaults it to `subdomain` when omitted. A `ProxyExposure` carries its own
	 * routing-token signing secret, so no separate secret field is needed.
	 */
	exposure?: SandboxExposure;
	/**
	 * The app's public origin used to build `proxy`-mode client URLs
	 * (config: MARIMOHUB_APP_BASE_URL). Falls back to the inbound request origin at
	 * provision time when unset.
	 */
	appBaseUrl?: string;
	/**
	 * Whether a notebook's non-source runtime files survive a session
	 * (config: MARIMOHUB_PERSIST_WORKSPACE). `source` persists only the source
	 * files (`notebook.py` + `pyproject.toml`); `workspace` also captures the rest
	 * of the working dir into `workspace/` on teardown and restores it next session.
	 */
	persistWorkspace: 'source' | 'workspace';
	/**
	 * Session lifetime policy. Optional — absent (library/Workers wiring, tests)
	 * means sessions get no `expires_at` and no lifecycle sweep runs; the
	 * heartbeat reaper and provider caps are the only lifetime bounds.
	 */
	sessionLifetime?: SessionLifetimeConfig;
	/**
	 * Selectable sandbox images, in order — `images[0]` is the default every
	 * notebook uses unless it stores a `base_image` choice
	 * (config: MARIMOHUB_COMPUTE_IMAGE as a comma-separated list; template ids for
	 * e2b). Empty/absent = no picker; the compute adapter's own default applies.
	 */
	images?: string[];
	/** Resources from the deployment's default compute profile. */
	resources?: ComputeResources;
	/** Name of the default compute profile, persisted on newly-created sessions. */
	computeProfile?: string;
	/** Ordered profiles available to session provisioning; the first is the default. */
	computeProfiles?: SandboxComputeProfile[];
	/** Whether editors may persist a non-default profile on a notebook. */
	computeProfileOverride?: 'none' | 'editors';
	/** Resolve personal storage for owner-isolated editor sandboxes. */
	userHome?: SandboxUserHomeResolver;
}

/**
 * Managed-AI capability: the upstream provider the proxy fronts plus the secret it
 * signs/verifies session tokens with. Present enables auto-injection of marimo AI
 * config into every session and the `/api/ai/v1` proxy; absent disables both. The
 * upstream key lives here (server-side) and is NEVER injected into a sandbox.
 */
export interface AiProxyConfig {
	/** Upstream OpenAI-compatible base URL; the proxy POSTs to `<base>/chat/completions`. */
	upstreamBaseUrl: string;
	/** The real upstream provider key — server-side only. */
	upstreamApiKey: string;
	/**
	 * Optional `OpenAI-Project` header value sent upstream (e.g. W&B Inference uses
	 * it as `entity/project` for usage attribution). Omit for providers that ignore it.
	 */
	upstreamProject?: string;
	/** Default upstream model id surfaced to marimo (e.g. `gpt-4o-mini`). */
	model: string;
	/** Secret used to sign/verify the per-session token (the auth session secret). */
	signingSecret: string;
	/** Optional allowlist of upstream model ids; off-list requests fall back to `model`. */
	allowedModels?: string[];
	maxTokens?: number;
	rules?: string;
	/** Session-token lifetime in seconds. */
	tokenTtlSeconds?: Seconds;
}

/** Deployment-wide authorization / abuse-guard knobs. */
export interface PolicyConfig {
	/** How persistent edit sandboxes are shared between editors. */
	editorSandboxSharing?: EditorSandboxSharing;
	/**
	 * Deployment-wide fallback role (config: MARIMOHUB_DEFAULT_ROLE) granted to any
	 * authenticated user who is neither the project owner nor an explicit member.
	 * `editor` lets every logged-in user edit notebooks; undefined keeps writes
	 * members-only. Project edit/delete always requires `manager`, so a default of
	 * `editor` can never reach it.
	 */
	defaultRole?: AssignableRole;
	/**
	 * What an effective `viewer` gets (config: MARIMOHUB_VIEWER_MODE), each tier
	 * a superset of the last: `static` (the last captured HTML snapshot; sessions
	 * stay editor-only), `applications` (viewers may also use the shared notebook
	 * app), or `ephemeral-sandbox` (viewers additionally get a real edit kernel
	 * whose session is never written back). Optional — `createApi` defaults it to
	 * `static` so library/Workers wiring gets the safe mode without opting in.
	 */
	viewerMode?: ViewerMode;
	/**
	 * Extra Origins allowed for state-changing requests, beyond the deployment's
	 * own (same-origin is always allowed; requests with no Origin — non-browser
	 * clients — are not blocked). CSRF defense-in-depth for the cookie session.
	 */
	allowedOrigins?: string[];
	/**
	 * Max concurrent non-terminal sessions a single user may hold. A cost-DoS
	 * guard (each session is billable compute); the create-session route rejects
	 * with 429 past the cap. Counts `edit` sessions, and separately bounds the
	 * apps a single user has STARTED — without that, freely creatable projects
	 * would let one user escape the cost ceiling entirely via `maxAppsPerProject`
	 * slots. Unset/undefined = unlimited.
	 */
	maxConcurrentSessionsPerUser?: number;
	/**
	 * Max concurrent app sessions per project
	 * (config: MARIMOHUB_MAX_APPS_PER_PROJECT). Checked after reuse, so
	 * attaching to a running app never trips it. Unset/undefined = unlimited.
	 */
	maxAppsPerProject?: number;
	/**
	 * Deployment super admins (config: MARIMOHUB_SUPER_ADMINS): entries granted
	 * implicit `admin` on every project and visibility of all projects. An
	 * entry containing `@` matches only the login email (case-insensitive);
	 * any other entry matches only the user id (exact) — see
	 * `isSuperAdmin` in core. Static super-admin status also applies to PATs;
	 * session-only OIDC group entitlements do not. Unset = no super admins.
	 */
	superAdmins?: string[];
}

export interface ConfigSettingSummary {
	/** Env var id, e.g. `MARIMOHUB_AUTH_OIDC_ISSUER`. */
	key: string;
	/** Human-readable name from the config spec. */
	name: string;
	/** The configured (or default) value; always null when `secret`. */
	value: string | null;
	secret: boolean;
	/** Whether the env var is explicitly set in this deployment. */
	set: boolean;
}

/**
 * Read-only description of the deployment's configuration, served by the
 * super-admin `GET /api/v1/admin/config` route. Assembled by
 * `@marimo-hub/config` from its config spec — secret values are never copied
 * in, only whether they are set. Values reflect the serving replica's
 * environment at boot.
 */
export interface ConfigSummary {
	groups: {
		/** Spec group name, e.g. `Auth`, `Storage`. */
		name: string;
		/** The resolved backend selector for the group; null for selector-less groups. */
		backend: string | null;
		settings: ConfigSettingSummary[];
	}[];
}

/**
 * Everything the API needs, injected at composition time. This replaces the
 * Cloudflare-specific `Bindings: Env` coupling — routes read it from the Hono
 * context (`c.get('deps')`) instead of instantiating adapters from `c.env`.
 */
export interface ApiDeps {
	services: Services;
	/** Raw bucket handle (used by ensureInitialized + the sandbox copy fallback). */
	bucket: Bucket;
	compute: SandboxProvider;
	authenticator: Authenticator;
	/**
	 * Probe a reused `running` session's kernel on reconnect. A `dead` result (the
	 * sandbox is alive but marimo exited) retires the wedged session and provisions
	 * a fresh sandbox instead of serving a 502. Optional — `createApi` defaults it
	 * to a real network probe; absent, the reconnect path resumes the session as-is.
	 */
	kernelProbe?: KernelProbe;
	/**
	 * Optional sub-app contributing provider-specific auth routes — e.g. the
	 * app-native OIDC login/callback/logout flow. Mounted before the authN guard
	 * so those routes stay public.
	 */
	authRoutes?: Hono;
	/**
	 * Optional request-instrumentation middleware (e.g. @hono/otel: SERVER spans
	 * and/or RED metrics), registered ahead of every route — including the
	 * sandbox-proxy short-circuits. Absent (Workers, tests): no overhead.
	 */
	tracingMiddleware?: MiddlewareHandler;
	/** How the notebook sandbox is mounted, exposed, and persisted. */
	sandbox: SandboxConfig;
	/** Deployment-wide authorization / abuse-guard knobs. */
	policy: PolicyConfig;
	/**
	 * Probe downstream deps (storage/auth/compute/WIF). Built by `@marimo-hub/config`;
	 * logged once (non-fatal) at boot and served by `GET /api/health?deep=true`.
	 * Absent in library/Workers wiring, where the deep probe reports "unavailable".
	 */
	preflight?: () => Promise<PreflightReport>;
	/**
	 * Workload Identity Federation: the hub-as-OIDC-issuer + its exchange target.
	 * Absent disables WIF (discovery/JWKS routes 404, no credentials injected).
	 * Present is a deployment capability only; a project still opts in per `federation`.
	 */
	wif?: WifConfig;
	/**
	 * Managed AI: the upstream the `/api/ai/v1` proxy fronts. Absent disables managed
	 * AI (the proxy 404s, no AI config injected into sessions).
	 */
	ai?: AiProxyConfig;
	/**
	 * Configuration summary for the super-admin settings page. Absent
	 * (library/Workers wiring, tests): the route serves no groups, with the
	 * policy-derived fields still filled.
	 */
	configSummary?: ConfigSummary;
	/** Optional project integration service; absence disables its routes and injection. */
	integrations?: ProjectIntegrationsService;
	/**
	 * Org-scoped (deployment-wide) integrations, inherited by every project and
	 * managed by super admins only. Wired alongside `integrations` — present iff
	 * it is.
	 */
	orgIntegrations?: OrgIntegrationsService;
	/**
	 * Read-only data browsing over integrations (MARIMOHUB_DATA_BROWSER).
	 * Absent disables the browse routes (404). `preview` stays false until
	 * sandbox-executed row preview ships.
	 */
	dataBrowser?: { preview: boolean };
	/**
	 * Build/deploy identity surfaced read-only by `GET /api/v1/version` (the UI's
	 * footer info popover). Baked into the image at build time and read from env
	 * at composition. Undefined in dev and the Workers entrypoint, where the route
	 * reports `version: "dev"` and the rest as null/unknown.
	 */
	version?: {
		/** Deployment version — typically the short git SHA or a release tag. */
		version: string;
		/** Fully-qualified server Docker image reference (`repo:tag`), if known. */
		image?: string;
		/** The DEFAULT sandbox/kernel image (first of MARIMOHUB_COMPUTE_IMAGE); the full list is on /capabilities. */
		sandboxImage?: string;
		/** ISO timestamp this process started — i.e. when the pod last (re)started. */
		startedAt?: string;
		/** Replica identity — the pod/host name (k8s sets HOSTNAME to the pod name). */
		replica?: string;
		/** Node.js runtime version (e.g. `v24.3.0`); inferred at runtime. */
		node?: string;
		/** The resolved adapter selectors, for at-a-glance ops/debugging. */
		backends?: {
			storage: string;
			compute: string;
			auth: string;
		};
	};
}

export type HonoEnv = {
	Variables: {
		deps: ApiDeps;
		user: AuthUser;
		/**
		 * How the request authenticated, decided once in the authN middleware:
		 * `pat` (a personal access token) or `session` (cookie/SSO). Routes that
		 * must be session-only (token management) gate on this instead of re-parsing
		 * the Authorization header — two independent parses eventually disagree.
		 */
		authMethod: 'pat' | 'session';
		/** Per-request correlation id set by the `hono/request-id` middleware. */
		requestId: string;
	};
};
